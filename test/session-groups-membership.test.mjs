import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  consumeSessionGroupTransition,
  readSessionGroupMembershipFromFile,
  recordSessionGroupTransition,
  resolveSessionStartMembership,
} from "../extensions/session-groups/membership.ts";

const SOURCE_ID = "019cda47-9baf-7000-8000-000000000001";
const ACTIVE_ID = "019cda47-9baf-7000-8000-000000000002";
const STORED_ID = "019cda47-9baf-7000-8000-000000000003";
const membership = (groupId) => ({ version: 1, groupId });
const membershipLine = (groupId) => JSON.stringify({
  type: "custom",
  customType: "ventris-session-group-membership",
  data: membership(groupId),
});

function resolve(overrides) {
  return resolveSessionStartMembership({
    reason: "startup",
    destinationMembership: undefined,
    destinationIsExistingSession: false,
    destinationHasParent: false,
    sourceGroupId: null,
    activeGroupId: null,
    ...overrides,
  });
}

test("preserves stored membership on resume and reload", () => {
  assert.deepEqual(
    resolve({
      reason: "resume",
      destinationMembership: membership(STORED_ID),
      sourceGroupId: SOURCE_ID,
      activeGroupId: ACTIVE_ID,
    }),
    { groupId: STORED_ID, shouldAppend: false, origin: "stored" },
  );
  assert.deepEqual(
    resolve({
      reason: "reload",
      destinationMembership: membership(null),
      activeGroupId: ACTIVE_ID,
    }),
    { groupId: null, shouldAppend: false, origin: "ungrouped" },
  );
  assert.deepEqual(
    resolve({ reason: "resume", activeGroupId: ACTIVE_ID }),
    { groupId: null, shouldAppend: true, origin: "ungrouped" },
  );
});

test("uses active only for fresh startup and preserves old ungrouped sessions", () => {
  assert.deepEqual(resolve({ activeGroupId: ACTIVE_ID }), {
    groupId: ACTIVE_ID,
    shouldAppend: true,
    origin: "active",
  });
  assert.deepEqual(
    resolve({ destinationIsExistingSession: true, activeGroupId: ACTIVE_ID }),
    { groupId: null, shouldAppend: true, origin: "ungrouped" },
  );
  assert.deepEqual(
    resolve({
      destinationMembership: membership(STORED_ID),
      activeGroupId: ACTIVE_ID,
    }),
    { groupId: STORED_ID, shouldAppend: false, origin: "stored" },
  );
});

test("applies new, fork, clone, and startup-fork precedence", () => {
  assert.deepEqual(
    resolve({ reason: "new", sourceGroupId: SOURCE_ID, activeGroupId: ACTIVE_ID }),
    { groupId: ACTIVE_ID, shouldAppend: true, origin: "active" },
  );
  assert.deepEqual(resolve({ reason: "new", sourceGroupId: SOURCE_ID }), {
    groupId: SOURCE_ID,
    shouldAppend: true,
    origin: "inherited",
  });
  assert.deepEqual(
    resolve({ reason: "fork", sourceGroupId: SOURCE_ID, activeGroupId: ACTIVE_ID }),
    { groupId: SOURCE_ID, shouldAppend: true, origin: "inherited" },
  );
  assert.deepEqual(resolve({ reason: "fork", activeGroupId: ACTIVE_ID }), {
    groupId: ACTIVE_ID,
    shouldAppend: true,
    origin: "active",
  });
  assert.deepEqual(
    resolve({
      reason: "startup",
      destinationHasParent: true,
      destinationIsExistingSession: true,
      sourceGroupId: SOURCE_ID,
      activeGroupId: ACTIVE_ID,
    }),
    { groupId: SOURCE_ID, shouldAppend: true, origin: "inherited" },
  );
  assert.deepEqual(
    resolve({
      reason: "startup",
      destinationHasParent: true,
      activeGroupId: ACTIVE_ID,
    }),
    { groupId: ACTIVE_ID, shouldAppend: true, origin: "active" },
  );
});

test("hands off unflushed and in-memory source membership exactly once", () => {
  const manager = {};
  const sourceFile = "/tmp/source.jsonl";
  const targetFile = "/tmp/target.jsonl";
  const shutdown = { type: "session_shutdown", reason: "new", targetSessionFile: targetFile };
  const start = { type: "session_start", reason: "new", previousSessionFile: sourceFile };
  recordSessionGroupTransition(shutdown, sourceFile, SOURCE_ID, manager);
  assert.deepEqual(consumeSessionGroupTransition(start, targetFile, {}), membership(SOURCE_ID));
  assert.equal(consumeSessionGroupTransition(start, targetFile, {}), undefined);

  recordSessionGroupTransition(shutdown, sourceFile, SOURCE_ID, manager);
  assert.equal(consumeSessionGroupTransition({ reason: "new" }, undefined, {}), undefined);
  assert.deepEqual(consumeSessionGroupTransition(start, targetFile, {}), membership(SOURCE_ID));

  recordSessionGroupTransition({ reason: "fork" }, undefined, null, manager);
  assert.deepEqual(consumeSessionGroupTransition({ reason: "fork" }, undefined, manager), membership(null));
});

test("isolates concurrent in-memory forks by manager identity across awaits", async () => {
  const transition = async (groupId, delay) => {
    const manager = {};
    await (async () => {
      await Promise.resolve();
      recordSessionGroupTransition(
        { type: "session_shutdown", reason: "fork" },
        undefined,
        groupId,
        manager,
      );
    })();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    assert.equal(consumeSessionGroupTransition({ reason: "fork" }, undefined, {}), undefined);
    return consumeSessionGroupTransition(
      { type: "session_start", reason: "fork" },
      undefined,
      manager,
    );
  };

  const [first, second] = await Promise.all([
    transition(SOURCE_ID, 10),
    transition(ACTIVE_ID, 0),
  ]);
  assert.deepEqual(first, membership(SOURCE_ID));
  assert.deepEqual(second, membership(ACTIVE_ID));
});

test("rejects colliding target handoffs and cannot guess an ephemeral new runtime", () => {
  const target = "/tmp/ambiguous-session-group-target.jsonl";
  const shutdown = { reason: "new", targetSessionFile: target };
  recordSessionGroupTransition(shutdown, undefined, SOURCE_ID, {});
  recordSessionGroupTransition(shutdown, undefined, ACTIVE_ID, {});
  assert.equal(consumeSessionGroupTransition({ reason: "new" }, target, {}), undefined);
  recordSessionGroupTransition({ reason: "new" }, undefined, SOURCE_ID, {});
  assert.equal(consumeSessionGroupTransition({ reason: "new" }, undefined, {}), undefined);
  const sharedManager = {};
  recordSessionGroupTransition({ reason: "fork" }, undefined, SOURCE_ID, sharedManager);
  recordSessionGroupTransition({ reason: "fork" }, undefined, ACTIVE_ID, sharedManager);
  assert.equal(consumeSessionGroupTransition({ reason: "fork" }, undefined, sharedManager), undefined);
});

test("source scanning is read-only for empty, legacy and latest session-wide membership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-readonly-"));
  const path = join(directory, "source.jsonl");
  try {
    for (const content of [
      "",
      JSON.stringify({ type: "session", version: 1 }) + "\n",
      JSON.stringify({ type: "session", version: 2 }) + "\n" + membershipLine(SOURCE_ID),
      membershipLine(SOURCE_ID) + "\n" + membershipLine(null) + "\n{broken tail",
    ]) {
      await writeFile(path, content);
      const before = await lstat(path);
      const result = await readSessionGroupMembershipFromFile(path);
      assert.equal(await readFile(path, "utf8"), content);
      const after = await lstat(path);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(after.ino, before.ino);
      if (content.includes(membershipLine(null))) assert.deepEqual(result, membership(null));
      else if (content.includes(membershipLine(SOURCE_ID))) assert.deepEqual(result, membership(SOURCE_ID));
      else assert.equal(result, undefined);
    }
    // Earlier corrupt membership is irrelevant; the latest matching entry wins.
    const invalid = JSON.stringify({ type: "custom", customType: "ventris-session-group-membership", data: {} });
    await writeFile(path, invalid + "\n" + membershipLine(ACTIVE_ID));
    assert.deepEqual(await readSessionGroupMembershipFromFile(path), membership(ACTIVE_ID));
    await writeFile(path, membershipLine(SOURCE_ID) + "\n" + invalid);
    await assert.rejects(readSessionGroupMembershipFromFile(path), /Invalid.*membership/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source scanner crosses chunk boundaries and bounds individual JSONL lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-bounded-"));
  const path = join(directory, "source.jsonl");
  try {
    const unicodeEntry = JSON.stringify({ type: "message", text: "文".repeat(24_000) });
    await writeFile(path, membershipLine(SOURCE_ID) + "\n" + (unicodeEntry + "\n").repeat(140));
    assert.deepEqual(await readSessionGroupMembershipFromFile(path), membership(SOURCE_ID));
    await writeFile(path, membershipLine(SOURCE_ID) + "\n" + "x".repeat(8 * 1024 * 1024 + 1));
    await assert.rejects(readSessionGroupMembershipFromFile(path), /8 MiB inspection limit/);
    // A recent membership avoids reading even a giant historical record.
    await writeFile(path, "x".repeat(8 * 1024 * 1024 + 1) + "\n" + membershipLine(null));
    assert.deepEqual(await readSessionGroupMembershipFromFile(path), membership(null));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects symlinks and nonregular source files without creating missing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-filetype-"));
  try {
    const file = join(directory, "source");
    await writeFile(file, membershipLine(SOURCE_ID));
    const link = join(directory, "link");
    await symlink(file, link);
    await assert.rejects(readSessionGroupMembershipFromFile(link), /regular, non-symlink/);
    const subdir = join(directory, "directory");
    await mkdir(subdir);
    await assert.rejects(readSessionGroupMembershipFromFile(subdir), /regular, non-symlink/);
    const missing = join(directory, "missing");
    await assert.rejects(readSessionGroupMembershipFromFile(missing), { code: "ENOENT" });
    await assert.rejects(lstat(missing), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats a fresh named session as fresh despite its session-info entry", () => {
  const sessionInfoEntry = {
    type: "session_info",
    id: "named-session",
    parentId: null,
    timestamp: "2026-08-13T20:47:59.123Z",
    name: "Named fresh session",
  };
  assert.equal(sessionInfoEntry.type, "session_info");
  assert.deepEqual(
    resolve({
      destinationIsExistingSession: false,
      activeGroupId: ACTIVE_ID,
    }),
    { groupId: ACTIVE_ID, shouldAppend: true, origin: "active" },
  );
});

test("reads source membership from a persisted session file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-source-"));
  const sessionPath = join(directory, "source.jsonl");
  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "019cda47-9baf-7000-8000-000000000010",
          timestamp: "2026-08-13T20:47:59.123Z",
          cwd: directory,
        }),
        JSON.stringify({
          type: "custom",
          id: "abcdef12",
          parentId: null,
          timestamp: "2026-08-13T20:47:59.123Z",
          customType: "ventris-session-group-membership",
          data: membership(SOURCE_ID),
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    assert.deepEqual(await readSessionGroupMembershipFromFile(sessionPath), membership(SOURCE_ID));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
