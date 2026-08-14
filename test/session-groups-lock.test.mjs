import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getProcessIncarnation,
  SessionGroupLockBusyError,
  SessionGroupLockManager,
  SessionGroupLockOrderError,
} from "../extensions/session-groups/lock.ts";
import {
  SessionGroupAlreadyExistsError,
  SessionGroupContextConflictError,
  SessionGroupStore,
} from "../extensions/session-groups/store.ts";

const GROUP_ID = "019cda47-9baf-7000-8000-000000000001";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function installInterruptedEdit(store, groupId) {
  const before = await store.readContext(groupId);
  const beforeMetadata = await store.readMetadata(groupId);
  const changed = Buffer.from("# interrupted\n", "utf8");
  await writeFile(
    join(store.groupDirectory(groupId), ".context-edit-transaction.json"),
    `${JSON.stringify({
      version: 1,
      phase: "editing",
      ownerPid: 2_147_483_647,
      ownerIncarnation: "dead-process-incarnation",
      token: randomUUID(),
      groupId,
      createdAt: new Date().toISOString(),
      beforeMetadata,
      beforeContentBase64: Buffer.from(before.content, "utf8").toString("base64"),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(store.contextPath(groupId), changed, { mode: 0o600 });
  await writeFile(
    store.metadataPath(groupId),
    `${JSON.stringify({
      ...beforeMetadata,
      contextRevision: beforeMetadata.contextRevision + 1,
      contextSha256: digest(changed),
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return before;
}

async function insertLockRow(manager, owner) {
  await manager.withCatalogLock("catalog", async () => undefined);
  const database = new DatabaseSync(manager.databasePath);
  try {
    database
      .prepare(
        `INSERT INTO locks(
           lock_key, token, process_pid, process_incarnation,
           editor_pid, editor_incarnation, kind, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        owner.lockKey,
        owner.token,
        owner.processPid,
        owner.processIncarnation ?? "dead-incarnation",
        owner.editorPid,
        owner.editorIncarnation ?? null,
        owner.kind,
        owner.createdAt,
      );
  } finally {
    database.close();
  }
}

async function withLocks(run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-locks-"));
  const locksDirectory = join(directory, "locks");
  await mkdir(locksDirectory, { mode: 0o700 });
  try {
    await run({
      directory,
      locksDirectory,
      first: new SessionGroupLockManager(locksDirectory),
      second: new SessionGroupLockManager(locksDirectory),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("process incarnation is independent of the caller timezone", () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utc = getProcessIncarnation(process.pid);
    process.env.TZ = "America/New_York";
    const newYork = getProcessIncarnation(process.pid);
    assert.equal(utc, newYork);
    assert.equal(typeof utc, "string");
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("serializes managers and supports reentrant calls in one operation", async () => {
  await withLocks(async ({ first, second }) => {
    await first.withGroupLock(GROUP_ID, "agent-edit", async (outer) => {
      await first.withGroupLock(GROUP_ID, "context-read", async (inner) => {
        assert.equal(inner.path, outer.path);
      });
      await assert.rejects(
        second.withGroupLock(
          GROUP_ID,
          "agent-edit",
          async () => undefined,
          { waitMs: 0 },
        ),
        SessionGroupLockBusyError,
      );
    });

    await second.withGroupLock(
      GROUP_ID,
      "context-read",
      async () => undefined,
      { waitMs: 0 },
    );
  });
});

test("rejects parallel, detached, and inverted reentrant acquisition", async () => {
  await withLocks(async ({ first }) => {
    await first.withGroupLock(GROUP_ID, "agent-edit", async () => {
      let releaseNested;
      const nestedBarrier = new Promise((resolve) => {
        releaseNested = resolve;
      });
      const nested = first.withGroupLock(GROUP_ID, "context-read", async () => {
        await nestedBarrier;
      });
      await assert.rejects(
        first.withGroupLock(GROUP_ID, "context-read", async () => undefined),
        SessionGroupLockOrderError,
      );
      releaseNested();
      await nested;
      await assert.rejects(
        first.withCatalogLock("catalog", async () => undefined),
        SessionGroupLockOrderError,
      );
    });

    let detachedResolve;
    const detached = new Promise((resolve) => {
      detachedResolve = resolve;
    });
    let detachedAttempt;
    await first.withGroupLock(GROUP_ID, "agent-edit", async () => {
      detachedAttempt = detached.then(() =>
        first.withGroupLock(GROUP_ID, "context-read", async () => undefined),
      );
    });
    detachedResolve();
    await detachedAttempt;

    let releaseCatalogContinuation;
    const catalogContinuation = new Promise((resolve) => {
      releaseCatalogContinuation = resolve;
    });
    let invertedAttempt;
    await first.withCatalogLock("catalog", async () => {
      invertedAttempt = catalogContinuation.then(() =>
        first.withGroupLock(GROUP_ID, "context-read", async () =>
          first.withCatalogLock("catalog", async () => undefined),
        ),
      );
    });
    releaseCatalogContinuation();
    await assert.rejects(invertedAttempt, SessionGroupLockOrderError);
  });
});

test("keeps the physical lock until detached active reentrant work finishes", async () => {
  await withLocks(async ({ first, second }) => {
    let childStartedResolve;
    const childStarted = new Promise((resolve) => {
      childStartedResolve = resolve;
    });
    let childReleaseResolve;
    const childRelease = new Promise((resolve) => {
      childReleaseResolve = resolve;
    });
    let detached;
    const outer = first.withGroupLock(GROUP_ID, "agent-edit", async () => {
      detached = first.withGroupLock(GROUP_ID, "context-read", async () => {
        childStartedResolve();
        await childRelease;
      });
      await childStarted;
    });

    await childStarted;
    await assert.rejects(
      second.withGroupLock(
        GROUP_ID,
        "agent-edit",
        async () => undefined,
        { waitMs: 0 },
      ),
      SessionGroupLockBusyError,
    );
    childReleaseResolve();
    await detached;
    await outer;
  });
});

test("retains a lock while either Pi or its Zed process is alive", async () => {
  await withLocks(async ({ first, second }) => {
    await first.withGroupLock(GROUP_ID, "zed-edit", async (handle) => {
      await handle.setEditorPid(process.pid);
      await assert.rejects(
        second.withGroupLock(
          GROUP_ID,
          "context-read",
          async () => undefined,
          { waitMs: 0 },
        ),
        /editor/,
      );
      await handle.setEditorPid(null);
    });
  });
});

test("recovers a lock whose process and editor are both dead", async () => {
  await withLocks(async ({ second }) => {
    await insertLockRow(second, {
      lockKey: second.groupLockPath(GROUP_ID),
      token: "019cda47-9baf-7000-8000-000000000099",
      processPid: 2_147_483_647,
      editorPid: 2_147_483_646,
      kind: "zed-edit",
      createdAt: new Date().toISOString(),
    });
    await second.withGroupLock(
      GROUP_ID,
      "agent-edit",
      async () => undefined,
      { waitMs: 0 },
    );
  });
});

test("rejects a replaced lock database before another manager can acquire", async () => {
  await withLocks(async ({ locksDirectory, first, second }) => {
    const databasePath = join(locksDirectory, "locks.sqlite");
    const displacedPath = join(locksDirectory, "locks.displaced.sqlite");
    await first.withGroupLock(GROUP_ID, "agent-edit", async () => {
      await rename(databasePath, displacedPath);
      await writeFile(databasePath, "replacement", { mode: 0o600 });
      await assert.rejects(
        second.withGroupLock(GROUP_ID, "agent-edit", async () => undefined),
        /identity changed/,
      );
      await rm(databasePath);
      await rename(displacedPath, databasePath);
    });
  });
});

test("reclaims a live PID row whose process incarnation does not match", async () => {
  await withLocks(async ({ second }) => {
    await insertLockRow(second, {
      lockKey: second.groupLockPath(GROUP_ID),
      token: "019cda47-9baf-7000-8000-000000000098",
      processPid: process.pid,
      processIncarnation: "reused-process-incarnation",
      editorPid: null,
      kind: "agent-edit",
      createdAt: new Date().toISOString(),
    });
    await second.withGroupLock(
      GROUP_ID,
      "agent-edit",
      async () => undefined,
      { waitMs: 0 },
    );
  });
});

test("validates IDs before constructing lock keys", async () => {
  await withLocks(async ({ second }) => {
    assert.throws(
      () => second.groupLockPath("../../outside"),
      /Invalid session-group ID/,
    );
  });
});

test("serializes simultaneous stale-lock recovery and acquisition", async () => {
  await withLocks(async ({ first, second }) => {
    await insertLockRow(first, {
      lockKey: first.groupLockPath(GROUP_ID),
      token: "019cda47-9baf-7000-8000-000000000099",
      processPid: 2_147_483_647,
      editorPid: null,
      kind: "agent-edit",
      createdAt: new Date().toISOString(),
    });
    let active = 0;
    let maxActive = 0;
    const enter = (manager) =>
      manager.withGroupLock(GROUP_ID, "agent-edit", async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
      });
    await Promise.all([enter(first), enter(second)]);
    assert.equal(maxActive, 1);
  });
});

test("rejects a linked SQLite lock database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-lock-link-"));
  try {
    const locksDirectory = join(directory, "locks");
    const outsidePath = join(directory, "outside.sqlite");
    await mkdir(locksDirectory);
    await writeFile(outsidePath, "outside", "utf8");
    await symlink(outsidePath, join(locksDirectory, "locks.sqlite"));
    const manager = new SessionGroupLockManager(locksDirectory);
    await assert.rejects(
      manager.withCatalogLock("catalog", async () => undefined),
      /not a private regular file/,
    );
    assert.equal(await readFile(outsidePath, "utf8"), "outside");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers an identity publication interrupted before bootstrap completion", async () => {
  await withLocks(async ({ first, second }) => {
    await first.withCatalogLock("catalog", async () => undefined);
    const database = new DatabaseSync(first.databasePath);
    try {
      database
        .prepare("UPDATE lock_metadata SET value = '0' WHERE key = 'bootstrap_complete'")
        .run();
    } finally {
      database.close();
    }
    await rm(`${first.databasePath}.identity.json`);
    await second.withCatalogLock("catalog", async () => undefined);
    const identity = JSON.parse(
      await readFile(`${first.databasePath}.identity.json`, "utf8"),
    );
    assert.equal(identity.version, 1);
  });
});

test("fails closed when identity disappears after completed bootstrap", async () => {
  await withLocks(async ({ first, second }) => {
    await first.withCatalogLock("catalog", async () => undefined);
    await rm(`${first.databasePath}.identity.json`);
    await assert.rejects(
      second.withCatalogLock("catalog", async () => undefined),
      /identity is missing after completed bootstrap/,
    );
  });
});

test("serializes lock acquisition across real child processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-lock-process-"));
  const locksDirectory = join(directory, "locks");
  const logPath = join(directory, "events.log");
  const lockModule = new URL(
    "../extensions/session-groups/lock.ts",
    import.meta.url,
  ).href;
  try {
    await mkdir(locksDirectory);
    const script = `
      import { appendFile } from "node:fs/promises";
      import { SessionGroupLockManager } from ${JSON.stringify(lockModule)};
      const manager = new SessionGroupLockManager(process.env.LOCKS);
      await manager.withGroupLock(${JSON.stringify(GROUP_ID)}, "agent-edit", async () => {
        await appendFile(process.env.LOG, "start " + process.pid + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 25));
        await appendFile(process.env.LOG, "end " + process.pid + "\\n");
      }, { waitMs: 10_000 });
    `;
    const children = Array.from({ length: 8 }, () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-strip-types",
            "--input-type=module",
            "-e",
            script,
          ],
          {
            env: { ...process.env, LOCKS: locksDirectory, LOG: logPath },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve(undefined);
          else reject(new Error(`child exited ${code}: ${stderr}`));
        });
      }),
    );
    await Promise.all(children);
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    let active = 0;
    let maxActive = 0;
    for (const event of events) {
      if (event.startsWith("start ")) active++;
      else active--;
      maxActive = Math.max(maxActive, active);
    }
    assert.equal(events.length, 16);
    assert.equal(active, 0);
    assert.equal(maxActive, 1);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("initializes and resolves active membership while Zed owns the group lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-startup-lock-"));
  const rootDirectory = join(directory, "groups");
  try {
    const first = new SessionGroupStore({ rootDirectory });
    const group = await first.createGroup("partitioning");
    await first.setActiveGroup(group.id);
    await first.withGroupLock(group.id, "zed-edit", async () => {
      const second = new SessionGroupStore({ rootDirectory });
      await second.initialize();
      assert.equal((await second.getActiveGroup())?.id, group.id);
      assert.equal((await second.readMembershipMetadata(group.id)).id, group.id);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog lock makes concurrent same-name creation deterministic", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-create-lock-"));
  const rootDirectory = join(directory, "groups");
  try {
    const first = new SessionGroupStore({ rootDirectory });
    const second = new SessionGroupStore({ rootDirectory });
    const results = await Promise.allSettled([
      first.createGroup("partitioning"),
      second.createGroup("PARTITIONING"),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.equal(
      rejected.status === "rejected" &&
        rejected.reason instanceof SessionGroupAlreadyExistsError,
      true,
    );
    assert.equal((await first.listGroups()).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("renames one group while other groups exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-rename-lock-"));
  try {
    const store = new SessionGroupStore({ rootDirectory: join(directory, "groups") });
    const first = await store.createGroup("first");
    await store.createGroup("second");
    const renamed = await store.renameGroup(first.id, "renamed");
    assert.equal(renamed.name, "renamed");
    assert.equal((await store.listGroups()).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers abandoned transactions before metadata, rename, and delete operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-recover-lock-"));
  try {
    const store = new SessionGroupStore({ rootDirectory: join(directory, "groups") });
    const first = await store.createGroup("first");
    await store.createGroup("other");
    const before = await installInterruptedEdit(store, first.id);
    assert.equal((await store.readMetadata(first.id)).contextRevision, before.revision);

    await installInterruptedEdit(store, first.id);
    const renamed = await store.renameGroup(first.id, "renamed");
    assert.equal(renamed.name, "renamed");
    assert.equal((await store.readContext(first.id)).content, before.content);

    await installInterruptedEdit(store, first.id);
    await store.deleteGroup(first.id);
    assert.equal((await store.listGroups()).some(({ id }) => id === first.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent same-revision writers allow exactly one commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-edit-lock-"));
  const rootDirectory = join(directory, "groups");
  try {
    const first = new SessionGroupStore({ rootDirectory });
    const group = await first.createGroup("partitioning");
    const second = new SessionGroupStore({ rootDirectory });
    await second.initialize();
    const snapshot = await first.readContext(group.id);
    const results = await Promise.allSettled([
      first.editContext(group.id, snapshot.revision, snapshot.sha256, [
        { oldText: "## Notes\n", newText: "## Notes\n\n- first\n" },
      ]),
      second.editContext(group.id, snapshot.revision, snapshot.sha256, [
        { oldText: "## Notes\n", newText: "## Notes\n\n- second\n" },
      ]),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = results.find(({ status }) => status === "rejected");
    assert.equal(
      rejected.status === "rejected" &&
        rejected.reason instanceof SessionGroupContextConflictError,
      true,
    );
    assert.equal((await first.readContext(group.id)).revision, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
