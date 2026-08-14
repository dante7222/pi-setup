import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const sourceFile = "/tmp/source.jsonl";
  const targetFile = "/tmp/target.jsonl";
  recordSessionGroupTransition(
    { type: "session_shutdown", reason: "new", targetSessionFile: targetFile },
    sourceFile,
    SOURCE_ID,
  );

  assert.deepEqual(
    consumeSessionGroupTransition(
      {
        type: "session_start",
        reason: "new",
        previousSessionFile: sourceFile,
      },
      targetFile,
    ),
    membership(SOURCE_ID),
  );
  assert.equal(
    consumeSessionGroupTransition(
      {
        type: "session_start",
        reason: "new",
        previousSessionFile: sourceFile,
      },
      targetFile,
    ),
    undefined,
  );

  recordSessionGroupTransition(
    { type: "session_shutdown", reason: "new", targetSessionFile: targetFile },
    sourceFile,
    SOURCE_ID,
  );
  assert.equal(
    consumeSessionGroupTransition({ type: "session_start", reason: "new" }, undefined),
    undefined,
  );
  assert.deepEqual(
    consumeSessionGroupTransition(
      { type: "session_start", reason: "new", previousSessionFile: sourceFile },
      targetFile,
    ),
    membership(SOURCE_ID),
  );

  recordSessionGroupTransition(
    { type: "session_shutdown", reason: "fork" },
    undefined,
    null,
  );
  assert.deepEqual(
    consumeSessionGroupTransition({ type: "session_start", reason: "fork" }, undefined),
    membership(null),
  );
});

test("isolates concurrent in-memory handoffs by async runtime flow", async () => {
  const transition = async (groupId, delay) => {
    recordSessionGroupTransition(
      { type: "session_shutdown", reason: "new" },
      undefined,
      groupId,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    return consumeSessionGroupTransition(
      { type: "session_start", reason: "new" },
      undefined,
    );
  };

  const [first, second] = await Promise.all([
    transition(SOURCE_ID, 10),
    transition(ACTIVE_ID, 0),
  ]);
  assert.deepEqual(first, membership(SOURCE_ID));
  assert.deepEqual(second, membership(ACTIVE_ID));
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
    assert.deepEqual(readSessionGroupMembershipFromFile(sessionPath), membership(SOURCE_ID));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
