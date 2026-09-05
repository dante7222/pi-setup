import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
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
// A second module instance models reload without invoking Pi or user state.
import { SessionGroupLockManager as ReloadedLockManager } from "../extensions/session-groups/lock.ts?lock-reload-test";
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

async function withFailedRelease(manager, run) {
  await manager.withCatalogLock("catalog", async () => undefined);
  const writer = new DatabaseSync(manager.databasePath);
  let staleHandle;
  let startedAt;
  try {
    await assert.rejects(manager.withGroupLock(GROUP_ID, "agent-edit", async (handle) => {
      staleHandle = handle;
      startedAt = Date.now();
      writer.exec("BEGIN IMMEDIATE");
    }), /database is locked|SQLITE_BUSY/i);
    assert.ok(Date.now() - startedAt >= 2_000, "writer outlasted the release deadline");
    await run(writer, staleHandle);
  } finally {
    // Also rolls back if an assertion failed while the writer was held.
    writer.close();
  }
}

test("lock release recovers after writer contention exceeds two seconds without restarting Pi", async () => {
  await withLocks(async ({ first, locksDirectory }) => {
    const second = new ReloadedLockManager(locksDirectory);
    await withFailedRelease(first, async (writer, staleHandle) => {
      const row = writer.prepare("SELECT * FROM locks WHERE lock_key = ?")
        .get(first.groupLockPath(GROUP_ID));
      assert.equal(row.process_pid, process.pid);
      assert.equal(row.process_incarnation, getProcessIncarnation(process.pid));
      await assert.rejects(staleHandle.setEditorPid(process.pid), /no longer active/);

      // Cancellation of a subsequent cleanup wait must not forget ownership.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        await assert.rejects(first.withGroupLock(GROUP_ID, "context-read", async () => {
          assert.fail("cancelled cleanup must not enter the operation");
        }, { signal: controller.signal, waitMs: 10_000 }), { name: "AbortError" });
      } finally {
        clearTimeout(timer);
      }
      writer.exec("ROLLBACK");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(writer.prepare("SELECT token FROM locks WHERE lock_key = ?")
        .get(first.groupLockPath(GROUP_ID)).token, row.token,
      "no autonomous background cleanup");

      await withLocks(async ({ first: unrelated }) => {
        await insertLockRow(unrelated, {
          lockKey: row.lock_key, token: row.token,
          processPid: row.process_pid, processIncarnation: row.process_incarnation,
          editorPid: null, kind: row.kind, createdAt: row.created_at,
        });
        await assert.rejects(unrelated.withGroupLock(GROUP_ID, "agent-edit", async () => {},
          { waitMs: 0 }), SessionGroupLockBusyError,
        "retained cleanup authority is bound to its original database identity");
      });

      // Even a separately loaded module in this process retains cleanup authority.
      await second.withGroupLock(GROUP_ID, "agent-edit", async () => {
        await assert.rejects(first.withGroupLock(GROUP_ID, "agent-edit", async () => {},
          { waitMs: 0 }), SessionGroupLockBusyError);
        await assert.rejects(staleHandle.setEditorPid(null), /no longer active/);
      }, { waitMs: 0 });
      await first.withGroupLock(GROUP_ID, "context-read", async () => {}, { waitMs: 0 });
      assert.equal(writer.prepare("SELECT COUNT(*) AS count FROM locks").get().count, 0);
    });
  });
});

for (const [field, replacement] of [
  ["token", randomUUID()],
  ["process_pid", 2_147_483_647],
  ["process_incarnation", "different-incarnation"],
]) {
  test(`lock deferred cleanup cannot release a replacement ${field}`, async () => {
    await withLocks(async ({ first, second }) => {
      await withFailedRelease(first, async (writer) => {
        writer.exec("ROLLBACK");
        writer.prepare(`UPDATE locks SET ${field} = ? WHERE lock_key = ?`)
          .run(replacement, first.groupLockPath(GROUP_ID));
        // An unrelated operation retries cleanup, but has no stale-recovery
        // authority over this group. All three ownership predicates must match.
        await second.withCatalogLock("catalog", async () => {});
        assert.equal(writer.prepare(`SELECT ${field} FROM locks WHERE lock_key = ?`)
          .get(first.groupLockPath(GROUP_ID))[field], replacement);
        await first.withCatalogLock("catalog", async () => {}, { waitMs: 0 });
      });
    });
  });
}

test("lock cancellation prevents pre-aborted and waiting operations", async () => {
  await withLocks(async ({ first, second }) => {
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(first.withCatalogLock("catalog", async () => {
      assert.fail("pre-aborted operation ran");
    }, { signal: preAborted.signal }), { name: "AbortError" });
    await assert.rejects(readFile(first.databasePath), { code: "ENOENT" });

    await first.withGroupLock(GROUP_ID, "agent-edit", async () => {
      const controller = new AbortController();
      const startedAt = Date.now();
      const timer = setTimeout(() => controller.abort(), 20);
      try {
        await assert.rejects(second.withGroupLock(GROUP_ID, "agent-edit", async () => {
          assert.fail("waiting operation ran after abort");
        }, { signal: controller.signal, waitMs: 10_000 }), { name: "AbortError" });
        assert.ok(Date.now() - startedAt < 1_000);
      } finally {
        clearTimeout(timer);
      }
      await assert.rejects(first.withGroupLock(GROUP_ID, "context-read", async () => {
        assert.fail("pre-aborted reentrant operation ran");
      }, { signal: preAborted.signal }), { name: "AbortError" });
    });
    await second.withGroupLock(GROUP_ID, "context-read", async () => {}, { waitMs: 0 });
  });
});

test("lock bootstrap writer waits are cancellable and do not poison later initialization", async () => {
  await withLocks(async ({ first, second }) => {
    const writer = new DatabaseSync(first.databasePath);
    writer.exec("BEGIN IMMEDIATE");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    const startedAt = Date.now();
    try {
      await assert.rejects(first.withCatalogLock("catalog", async () => {
        assert.fail("bootstrap entered operation after abort");
      }, { signal: controller.signal, waitMs: 10_000 }), { name: "AbortError" });
      assert.ok(Date.now() - startedAt < 1_000);
    } finally {
      clearTimeout(timer);
      writer.close();
    }
    await Promise.all([
      first.withCatalogLock("catalog", async () => {}),
      second.withCatalogLock("catalog", async () => {}),
    ]);
  });
});

test("lock cancellation at acquisition boundary releases without entering operation", async (t) => {
  await withLocks(async ({ first, second }) => {
    const controller = new AbortController();
    const acquire = first.database.tryAcquire;
    // Inject abort exactly after the SQLite acquisition commit, before withLock
    // resumes. No timing-dependent race is needed to cover this boundary.
    t.mock.method(first.database, "tryAcquire", async function (...args) {
      const result = await acquire.apply(this, args);
      if (result.acquired) controller.abort();
      return result;
    });
    await assert.rejects(first.withGroupLock(GROUP_ID, "agent-edit", async () => {
      assert.fail("operation entered after acquisition-boundary abort");
    }, { signal: controller.signal }), { name: "AbortError" });
    await second.withGroupLock(GROUP_ID, "context-read", async () => {}, { waitMs: 0 });
  });
});

test("lock abort does not interrupt started operations, reentrant work, or contended release", async () => {
  await withLocks(async ({ first, second }) => {
    const controller = new AbortController();
    let detached;
    let writer;
    let releaseTimer;
    let childFinished = false;
    try {
      const result = await first.withGroupLock(GROUP_ID, "agent-edit", async () => {
        detached = first.withGroupLock(GROUP_ID, "context-read", async () => {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 20));
          await assert.rejects(second.withGroupLock(GROUP_ID, "agent-edit", async () => {},
            { waitMs: 0 }), SessionGroupLockBusyError);
          childFinished = true;
        });
        writer = new DatabaseSync(first.databasePath);
        writer.exec("BEGIN IMMEDIATE");
        releaseTimer = setTimeout(() => writer.exec("ROLLBACK"), 200);
        return "committed";
      }, { signal: controller.signal });
      await detached;
      assert.equal(result, "committed");
      assert.equal(childFinished, true);
      await second.withGroupLock(GROUP_ID, "context-read", async () => {}, { waitMs: 0 });
    } finally {
      clearTimeout(releaseTimer);
      writer?.close();
    }
  });
});

test("lock acquisition caches its own incarnation instead of repeatedly invoking ps", async () => {
  await withLocks(async ({ locksDirectory }) => {
    const script = `
      import childProcess from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { SessionGroupLockManager, getProcessIncarnation } from ${JSON.stringify(new URL(
        "../extensions/session-groups/lock.ts", import.meta.url,
      ).href)};
      let probes = 0;
      const originalPs = childProcess.execFileSync;
      childProcess.execFileSync = (...args) => {
        if (args[0] === "/bin/ps") probes++;
        return originalPs(...args);
      };
      const originalRead = fs.readFileSync;
      fs.readFileSync = (...args) => {
        if (args[0] === "/proc/" + process.pid + "/stat") probes++;
        return originalRead(...args);
      };
      syncBuiltinESMExports();
      const identity = getProcessIncarnation(process.pid);
      const manager = new SessionGroupLockManager(process.env.LOCKS);
      for (let i = 0; i < 30; i++) {
        await manager.withCatalogLock("catalog", async () => {});
        if (getProcessIncarnation(process.pid) !== identity) throw new Error("identity changed");
      }
      console.log(JSON.stringify({ probes }));
    `;
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning",
      "--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, LOCKS: locksDirectory }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).probes, 1);
  });
});

test("lock protects an external live Zed after Pi exits and reclaims only after Zed exits", async () => {
  await withLocks(async ({ first }) => {
    const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const exited = once(child, "close");
    const previousTimezone = process.env.TZ;
    try {
      await once(child.stdout, "data");
      process.env.TZ = "UTC";
      const incarnation = getProcessIncarnation(child.pid);
      process.env.TZ = "America/New_York";
      assert.equal(getProcessIncarnation(child.pid), incarnation,
        "uncached external process identity is timezone independent too");
      assert.equal(typeof incarnation, "string");
      await insertLockRow(first, {
        lockKey: first.groupLockPath(GROUP_ID), token: randomUUID(),
        processPid: 2_147_483_647, editorPid: child.pid,
        editorIncarnation: incarnation, kind: "zed-edit", createdAt: new Date().toISOString(),
      });
      await assert.rejects(first.withGroupLock(GROUP_ID, "context-read", async () => {},
        { waitMs: 0 }), /editor/);
      child.kill();
      await exited;
      await first.withGroupLock(GROUP_ID, "context-read", async () => {}, { waitMs: 0 });
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
      child.kill();
      await exited;
    }
  });
});

test("lock external identity probes run outside writer transactions and revalidate Zed changes", {
  skip: process.platform !== "darwin",
}, async (t) => {
  await withLocks(async ({ first, second }) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    let continueProbe;
    const probeStarted = Promise.withResolvers();
    const mock = t.mock.method(childProcess, "execFile", (_file, args, _options, callback) => {
      assert.equal(args.at(-1), String(child.pid));
      continueProbe = () => callback(null, "new-incarnation", "");
      probeStarted.resolve();
    });
    syncBuiltinESMExports();
    let acquiring;
    try {
      await insertLockRow(first, {
        lockKey: first.groupLockPath(GROUP_ID), token: randomUUID(),
        processPid: child.pid, processIncarnation: "old-incarnation",
        editorPid: null, kind: "zed-edit", createdAt: new Date().toISOString(),
      });
      acquiring = second.withGroupLock(GROUP_ID, "context-read", async () => {
        assert.fail("stale snapshot stole a newly Zed-protected lock");
      }, { waitMs: 0 });
      const rejected = assert.rejects(acquiring, SessionGroupLockBusyError);
      await probeStarted.promise;
      const writer = new DatabaseSync(first.databasePath);
      try {
        // This must succeed while the external probe is still pending.
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare("UPDATE locks SET editor_pid = ?, editor_incarnation = ? WHERE lock_key = ?")
          .run(process.pid, getProcessIncarnation(process.pid), first.groupLockPath(GROUP_ID));
        writer.exec("COMMIT");
      } finally {
        writer.close();
      }
      continueProbe();
      await rejected;
      await assert.rejects(first.withGroupLock(GROUP_ID, "agent-edit", async () => {},
        { signal: AbortSignal.abort(), waitMs: 0 }), { name: "AbortError" });
    } finally {
      continueProbe?.();
      await acquiring?.catch(() => {});
      mock.mock.restore();
      syncBuiltinESMExports();
      const exited = once(child, "close");
      child.kill();
      await exited;
    }
  });
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
        { oldText: "# partitioning\n", newText: "# partitioning\n\n- first\n" },
      ]),
      second.editContext(group.id, snapshot.revision, snapshot.sha256, [
        { oldText: "# partitioning\n", newText: "# partitioning\n\n- second\n" },
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
