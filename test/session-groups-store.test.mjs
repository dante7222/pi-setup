import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES,
  SESSION_GROUP_CHANGELOG_MAX_BYTES,
  SESSION_GROUP_CHANGELOG_TAIL_MAX_BYTES,
  SESSION_GROUP_CONTEXT_MAX_BYTES,
  SESSION_GROUPS_VERSION,
} from "../extensions/session-groups/contracts.ts";
import {
  applyExactSessionGroupContextEdits,
  SessionGroupAlreadyExistsError,
  SessionGroupChangelogEntryError,
  SessionGroupChangelogEncodingError,
  SessionGroupChangelogTooLargeError,
  SessionGroupContextConflictError,
  SessionGroupContextEditError,
  SessionGroupContextEncodingError,
  SessionGroupContextRevisionError,
  SessionGroupContextTooLargeError,
  SessionGroupNotFoundError,
  SessionGroupStore,
} from "../extensions/session-groups/store.ts";

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-groups-store-"));
  const rootDirectory = join(directory, "session-groups");
  const store = new SessionGroupStore({ rootDirectory });
  try {
    await run(store, rootDirectory);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

async function replaceContext(store, metadata, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  await writeFile(store.contextPath(metadata.id), bytes, { mode: 0o600 });
  await writeFile(
    store.metadataPath(metadata.id),
    `${JSON.stringify(
      {
        ...metadata,
        contextSha256: digest(bytes),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

test("initializes private global storage and creates a complete group atomically", async () => {
  await withStore(async (store, rootDirectory) => {
    await store.initialize();
    const metadata = await store.createGroup("partitioning");
    const snapshot = await store.readContext(metadata.id);
    const groups = await store.listGroups();

    assert.equal(snapshot.name, "partitioning");
    assert.match(snapshot.content, /^# partitioning\n\n## Objective/);
    assert.equal(snapshot.revision, 0);
    assert.equal(snapshot.sha256, metadata.contextSha256);
    assert.deepEqual(groups.map(({ id, name }) => ({ id, name })), [
      { id: metadata.id, name: "partitioning" },
    ]);

    if (process.platform !== "win32") {
      assert.equal((await stat(rootDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(store.groupDirectory(metadata.id))).mode & 0o777, 0o700);
      assert.equal((await stat(store.contextPath(metadata.id))).mode & 0o777, 0o600);
      assert.equal((await stat(store.metadataPath(metadata.id))).mode & 0o777, 0o600);
      assert.equal((await stat(store.statePath)).mode & 0o777, 0o600);
    }

    const rootEntries = await readdir(rootDirectory);
    const groupEntries = await readdir(store.groupDirectory(metadata.id));
    assert.deepEqual(rootEntries.sort(), ["groups", "locks", "state.json"]);
    assert.deepEqual(groupEntries.sort(), ["context.md", "metadata.json"]);
    assert.equal(groupEntries.some((entry) => entry.endsWith(".tmp")), false);
  });
});

test("creates and reads the optional changelog only on demand", async () => {
  await withStore(async (store) => {
    const group = await store.createGroup("partitioning");
    const absent = await store.readChangelogTail(group.id);
    assert.equal(absent.exists, false);
    assert.equal(
      (await readdir(store.groupDirectory(group.id))).includes("changelog.md"),
      false,
    );

    const path = await store.prepareChangelogForManualEdit(group.id);
    assert.equal(path, store.changelogPath(group.id));
    assert.equal(await readFile(path, "utf8"), "# Changelog\n\n");
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }

    const appended = await store.appendChangelog(
      group.id,
      "- Completed the monthly backfill.",
      "Partition table\nunsafe line",
    );
    assert.equal(appended.sessionName, "Partition table unsafe line");
    assert.match(appended.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    const tail = await store.readChangelogTail(group.id);
    assert.equal(tail.exists, true);
    assert.equal(tail.truncated, false);
    assert.match(tail.content, /Completed the monthly backfill/);
    assert.match(tail.content, /Partition table unsafe line/);
  });
});

test("bounds changelog entries, files, and UTF-8-safe recent reads", async () => {
  await withStore(async (store) => {
    const group = await store.createGroup("partitioning");
    await assert.rejects(
      store.appendChangelog(group.id, " ", "session"),
      SessionGroupChangelogEntryError,
    );
    await assert.rejects(
      store.appendChangelog(
        group.id,
        "é".repeat(SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES / 2 + 1),
        "session",
      ),
      SessionGroupChangelogEntryError,
    );

    const longValid = `# Changelog\n\n${"é".repeat(
      SESSION_GROUP_CHANGELOG_TAIL_MAX_BYTES / 2 + 200,
    )}`;
    await writeFile(store.changelogPath(group.id), longValid, { mode: 0o600 });
    const tail = await store.readChangelogTail(group.id);
    assert.equal(tail.truncated, true);
    assert.equal(tail.returnedBytes <= SESSION_GROUP_CHANGELOG_TAIL_MAX_BYTES, true);
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(tail.content, "utf8"),
    ));

    await writeFile(store.changelogPath(group.id), Buffer.from([0xc3, 0x28]));
    await assert.rejects(
      store.readChangelogTail(group.id),
      SessionGroupChangelogEncodingError,
    );
    await writeFile(
      store.changelogPath(group.id),
      Buffer.alloc(SESSION_GROUP_CHANGELOG_MAX_BYTES + 1, 0x61),
    );
    await assert.rejects(
      store.readChangelogTail(group.id),
      SessionGroupChangelogTooLargeError,
    );
  });
});

test("serializes concurrent changelog appends without losing entries", async () => {
  await withStore(async (store, rootDirectory) => {
    const group = await store.createGroup("partitioning");
    const second = new SessionGroupStore({ rootDirectory });
    await Promise.all([
      store.appendChangelog(group.id, "- First append.", "first session"),
      second.appendChangelog(group.id, "- Second append.", "second session"),
    ]);
    const content = await readFile(store.changelogPath(group.id), "utf8");
    assert.match(content, /First append/);
    assert.match(content, /Second append/);
  });
});

test("enforces unique normalized names and preserves stable IDs across rename", async () => {
  await withStore(async (store) => {
    const first = await store.createGroup("Partitioning");
    await assert.rejects(
      store.createGroup("ＰＡＲＴＩＴＩＯＮＩＮＧ"),
      SessionGroupAlreadyExistsError,
    );

    const renamed = await store.renameGroup(first.id, "Orders migration");
    assert.equal(renamed.id, first.id);
    assert.equal(renamed.name, "Orders migration");
    assert.equal((await store.resolveGroup("orders MIGRATION")).id, first.id);
    assert.equal((await store.readContext(first.id)).name, "Orders migration");
  });
});

test("sets and clears the global active group without retaining deleted context", async () => {
  await withStore(async (store) => {
    const group = await store.createGroup("partitioning");
    const initial = await store.readState();
    const active = await store.setActiveGroup(group.id);

    assert.equal(active.activeGroupId, group.id);
    assert.equal(active.revision, initial.revision + 1);
    assert.equal((await store.getActiveGroup()).id, group.id);
    await store.appendChangelog(group.id, "- Work completed.", "session");

    assert.deepEqual(await store.deleteGroup(group.id), {
      id: group.id,
      name: group.name,
    });
    assert.equal(await store.getActiveGroup(), null);
    assert.equal((await store.readState()).activeGroupId, null);
    assert.deepEqual(await store.listGroups(), []);
    await assert.rejects(store.readMetadata(group.id), SessionGroupNotFoundError);
    await assert.rejects(readFile(store.changelogPath(group.id)), /ENOENT/);
  });
});

test("enforces the UTF-8 byte limit and detects invalid or uncoordinated context", async () => {
  await withStore(async (store) => {
    const group = await store.createGroup("partitioning");
    const exactLimit = "é".repeat(SESSION_GROUP_CONTEXT_MAX_BYTES / 2);
    await replaceContext(store, group, exactLimit);
    const exactSnapshot = await store.readContext(group.id);
    assert.equal(exactSnapshot.bytes, SESSION_GROUP_CONTEXT_MAX_BYTES);

    const overLimit = Buffer.alloc(SESSION_GROUP_CONTEXT_MAX_BYTES + 1, 0x61);
    await replaceContext(store, group, overLimit);
    await assert.rejects(store.readContext(group.id), SessionGroupContextTooLargeError);

    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    await replaceContext(store, group, invalidUtf8);
    await assert.rejects(store.readContext(group.id), SessionGroupContextEncodingError);

    await replaceContext(store, group, "coordinated");
    await writeFile(store.contextPath(group.id), "changed directly", "utf8");
    await assert.rejects(store.readContext(group.id), SessionGroupContextRevisionError);
  });
});

test("fails loudly on corrupt catalog data and missing groups", async () => {
  await withStore(async (store) => {
    const group = await store.createGroup("partitioning");
    await assert.rejects(
      store.resolveGroup("missing"),
      SessionGroupNotFoundError,
    );
    await writeFile(
      store.metadataPath(group.id),
      `${JSON.stringify({
        version: SESSION_GROUPS_VERSION,
        id: group.id,
        name: group.name,
      })}\n`,
      "utf8",
    );
    await assert.rejects(store.listGroups(), /Invalid session-group metadata/);
  });
});

test("rejects symlinks instead of following storage paths outside the root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-groups-symlink-"));
  const outsideDirectory = join(directory, "outside");
  const linkedRoot = join(directory, "linked-root");
  try {
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, linkedRoot, "dir");
    const linkedStore = new SessionGroupStore({ rootDirectory: linkedRoot });
    await assert.rejects(linkedStore.initialize(), /not a real directory/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  await withStore(async (store, rootDirectory) => {
    const group = await store.createGroup("partitioning");
    const outsidePath = join(rootDirectory, "outside-context.md");
    await writeFile(outsidePath, "outside", "utf8");
    await rm(store.contextPath(group.id));
    await symlink(outsidePath, store.contextPath(group.id));

    await assert.rejects(store.readContext(group.id), /not a private regular file/);
    assert.equal(await readFile(outsidePath, "utf8"), "outside");

    const outsideChangelog = join(rootDirectory, "outside-changelog.md");
    await writeFile(outsideChangelog, "outside changelog", "utf8");
    await symlink(outsideChangelog, store.changelogPath(group.id));
    await assert.rejects(
      store.readChangelogTail(group.id),
      /not a private regular file/,
    );
    assert.equal(await readFile(outsideChangelog, "utf8"), "outside changelog");
  });

  await withStore(async (store, rootDirectory) => {
    await store.initialize();
    const realRoot = `${rootDirectory}-real`;
    const outsideDirectory = `${rootDirectory}-outside`;
    await mkdir(outsideDirectory);
    await rename(rootDirectory, realRoot);
    await symlink(outsideDirectory, rootDirectory, "dir");

    await assert.rejects(store.readState(), /not a real directory/);
  });
});

test("rejects malformed UTF-8 JSON and restores private modes on restart", async () => {
  await withStore(async (store, rootDirectory) => {
    const group = await store.createGroup("partitioning");
    await writeFile(store.metadataPath(group.id), Buffer.from([0xc3, 0x28]));
    await assert.rejects(store.readMetadata(group.id), /JSON is not valid UTF-8/);

    await replaceContext(store, group, "restored");
    if (process.platform !== "win32") {
      await chmod(store.groupDirectory(group.id), 0o755);
      await chmod(store.metadataPath(group.id), 0o644);
      await chmod(store.contextPath(group.id), 0o644);
      const restarted = new SessionGroupStore({ rootDirectory });
      await restarted.initialize();
      assert.equal((await stat(store.groupDirectory(group.id))).mode & 0o777, 0o700);
      assert.equal((await stat(store.metadataPath(group.id))).mode & 0o777, 0o600);
      assert.equal((await stat(store.contextPath(group.id))).mode & 0o777, 0o600);
    }
  });
});

test("recovers abandoned create, delete, and atomic-write artifacts", async () => {
  await withStore(async (store, rootDirectory) => {
    await store.initialize();
    const group = await store.createGroup("partitioning");
    const deadPid = 999_999;
    const createArtifact = `.create-${randomUUID()}-${deadPid}-${randomUUID()}`;
    const deleteArtifact = `.delete-${randomUUID()}-${deadPid}-${randomUUID()}`;
    const rootTemp = `.${randomUUID()}.${deadPid}.tmp`;
    const groupTemp = `.${randomUUID()}.${deadPid}.tmp`;
    const unrelatedDirectory = ".delete-important-not-an-internal-artifact";

    await mkdir(join(store.groupsDirectory, createArtifact));
    await writeFile(join(store.groupsDirectory, createArtifact, "context.md"), "secret");
    await mkdir(join(store.groupsDirectory, deleteArtifact));
    await writeFile(join(store.groupsDirectory, deleteArtifact, "context.md"), "secret");
    await writeFile(join(rootDirectory, rootTemp), "state");
    await writeFile(join(store.groupDirectory(group.id), groupTemp), "metadata");
    await mkdir(join(store.groupsDirectory, unrelatedDirectory));
    await writeFile(join(store.groupsDirectory, unrelatedDirectory, "keep"), "keep");

    const restarted = new SessionGroupStore({ rootDirectory });
    await restarted.initialize();
    const groupEntries = await readdir(store.groupsDirectory);
    const rootEntries = await readdir(rootDirectory);
    const activeGroupEntries = await readdir(store.groupDirectory(group.id));
    assert.equal(groupEntries.includes(createArtifact), false);
    assert.equal(groupEntries.includes(deleteArtifact), false);
    assert.equal(rootEntries.includes(rootTemp), false);
    assert.equal(activeGroupEntries.includes(groupTemp), false);
    assert.equal(groupEntries.includes(unrelatedDirectory), true);
  });
});

test("applies exact unique non-overlapping edits and rejects ambiguous edits", () => {
  assert.equal(
    applyExactSessionGroupContextEdits("alpha beta gamma", [
      { oldText: "alpha", newText: "one" },
      { oldText: "gamma", newText: "three" },
    ]),
    "one beta three",
  );
  assert.throws(
    () =>
      applyExactSessionGroupContextEdits("same same", [
        { oldText: "same", newText: "changed" },
      ]),
    SessionGroupContextEditError,
  );
  assert.throws(
    () =>
      applyExactSessionGroupContextEdits("abcdef", [
        { oldText: "abcd", newText: "one" },
        { oldText: "cdef", newText: "two" },
      ]),
    /overlap/,
  );
  assert.throws(
    () => applyExactSessionGroupContextEdits("abc", [{ oldText: "abc", newText: "abc" }]),
    /does not change/,
  );
  assert.throws(
    () =>
      applyExactSessionGroupContextEdits("abc", [
        { oldText: "a", newText: "" },
        { oldText: "bc", newText: "abc" },
      ]),
    /combined context edits do not change/,
  );
});

test("edits context with optimistic revision checks and enforces result byte limit", async () => {
  await withStore(async (store) => {
    const group = await store.createGroup("partitioning");
    const before = await store.readContext(group.id);
    const result = await store.editContext(
      group.id,
      before.revision,
      before.sha256,
      [{ oldText: "## Notes\n", newText: "## Notes\n\n- Shared note.\n" }],
    );
    assert.equal(result.after.revision, before.revision + 1);
    assert.notEqual(result.after.sha256, before.sha256);
    assert.match(result.after.content, /Shared note/);

    await assert.rejects(
      store.editContext(group.id, before.revision, before.sha256, [
        { oldText: "## Constraints\n", newText: "## Constraints\n\n- stale\n" },
      ]),
      SessionGroupContextConflictError,
    );

    const current = await store.readContext(group.id);
    await assert.rejects(
      store.editContext(group.id, current.revision, current.sha256, [
        {
          oldText: "## Notes\n",
          newText: `## Notes\n${"é".repeat(SESSION_GROUP_CONTEXT_MAX_BYTES / 2)}`,
        },
      ]),
      SessionGroupContextTooLargeError,
    );
  });
});

test("fails closed on an inconsistent context-edit transaction backup", async () => {
  await withStore(async (store, rootDirectory) => {
    const group = await store.createGroup("partitioning");
    const before = await store.readContext(group.id);
    const beforeMetadata = await store.readMetadata(group.id);
    const transactionPath = join(
      store.groupDirectory(group.id),
      ".context-edit-transaction.json",
    );
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        version: 1,
        phase: "editing",
        ownerPid: 2_147_483_647,
        ownerIncarnation: "dead-process-incarnation",
        token: randomUUID(),
        groupId: group.id,
        createdAt: new Date().toISOString(),
        beforeMetadata,
        beforeContentBase64: Buffer.from("wrong backup", "utf8").toString("base64"),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const restarted = new SessionGroupStore({ rootDirectory });
    await assert.rejects(
      restarted.readContext(group.id),
      /Invalid session-group context-edit transaction content/,
    );
    assert.equal(await readFile(store.contextPath(group.id), "utf8"), before.content);
    assert.equal(
      (await readdir(store.groupDirectory(group.id))).includes(
        ".context-edit-transaction.json",
      ),
      true,
    );
  });
});

test("rolls back an interrupted two-file context edit transaction", async () => {
  await withStore(async (store, rootDirectory) => {
    const group = await store.createGroup("partitioning");
    const before = await store.readContext(group.id);
    const beforeMetadata = await store.readMetadata(group.id);
    const changed = "# partitioning\n\ninterrupted change\n";
    const changedBytes = Buffer.from(changed, "utf8");
    const transactionPath = join(
      store.groupDirectory(group.id),
      ".context-edit-transaction.json",
    );
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        version: 1,
        phase: "editing",
        ownerPid: 2_147_483_647,
        ownerIncarnation: "dead-process-incarnation",
        token: randomUUID(),
        groupId: group.id,
        createdAt: new Date().toISOString(),
        beforeMetadata,
        beforeContentBase64: Buffer.from(before.content, "utf8").toString("base64"),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(store.contextPath(group.id), changedBytes, { mode: 0o600 });
    await writeFile(
      store.metadataPath(group.id),
      `${JSON.stringify({
        ...beforeMetadata,
        contextRevision: beforeMetadata.contextRevision + 1,
        contextSha256: digest(changedBytes),
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const restarted = new SessionGroupStore({ rootDirectory });
    const recovered = await restarted.readContext(group.id);
    assert.equal(recovered.content, before.content);
    assert.equal(recovered.revision, before.revision);
    assert.equal(recovered.sha256, before.sha256);
    assert.equal(
      (await readdir(store.groupDirectory(group.id))).includes(
        ".context-edit-transaction.json",
      ),
      false,
    );
  });
});

test("rolls back interrupted edits with the original UTF-8 BOM bytes", async () => {
  await withStore(async (store, rootDirectory) => {
    const group = await store.createGroup("partitioning");
    const original = await readFile(store.contextPath(group.id));
    const originalWithBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      original,
    ]);
    await writeFile(store.contextPath(group.id), originalWithBom, { mode: 0o600 });
    await store.reconcileContext(group.id);
    const beforeMetadata = await store.readMetadata(group.id);
    const transactionPath = join(
      store.groupDirectory(group.id),
      ".context-edit-transaction.json",
    );
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        version: 1,
        phase: "editing",
        ownerPid: 2_147_483_647,
        ownerIncarnation: "dead-process-incarnation",
        token: randomUUID(),
        groupId: group.id,
        createdAt: new Date().toISOString(),
        beforeMetadata,
        beforeContentBase64: originalWithBom.toString("base64"),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const changed = Buffer.from("# interrupted\n", "utf8");
    await writeFile(store.contextPath(group.id), changed, { mode: 0o600 });
    await writeFile(
      store.metadataPath(group.id),
      `${JSON.stringify({
        ...beforeMetadata,
        contextRevision: beforeMetadata.contextRevision + 1,
        contextSha256: digest(changed),
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const restarted = new SessionGroupStore({ rootDirectory });
    await restarted.readContext(group.id);
    assert.deepEqual(await readFile(store.contextPath(group.id)), originalWithBom);
    assert.equal(
      (await restarted.readMetadata(group.id)).contextSha256,
      digest(originalWithBom),
    );
  });
});

test("repairs an out-of-band stale active reference", async () => {
  await withStore(async (store) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await rm(store.groupDirectory(group.id), { recursive: true, force: true });

    assert.equal(await store.getActiveGroup(), null);
    const state = JSON.parse(await readFile(store.statePath, "utf8"));
    assert.equal(state.activeGroupId, null);
  });
});
