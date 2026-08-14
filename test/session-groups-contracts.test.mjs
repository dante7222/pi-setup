import assert from "node:assert/strict";
import test from "node:test";
import {
  createGroupContextTemplate,
  groupNameKey,
  normalizeGroupName,
  parseSessionGroupMembership,
  parseSessionGroupMetadata,
  parseSessionGroupPresentation,
  parseSessionGroupsState,
  parseSessionGroupToolState,
  SESSION_GROUP_CONTEXT_MAX_BYTES,
  SESSION_GROUPS_VERSION,
} from "../extensions/session-groups/contracts.ts";
import {
  publishSessionGroupPresentation,
  subscribeToSessionGroupPresentation,
} from "../extensions/session-groups/events.ts";

const GROUP_ID = "019cda47-9baf-7000-8000-000000000001";

test("normalizes group names and rejects ambiguous path-like names", () => {
  assert.equal(normalizeGroupName("  Table\tpartitioning  "), "Table partitioning");
  assert.equal(groupNameKey("ＰＡＲＴＩＴＩＯＮＩＮＧ"), "partitioning");
  assert.throws(() => normalizeGroupName("off"), /reserved/);
  assert.throws(() => normalizeGroupName("status"), /reserved/);
  assert.throws(() => normalizeGroupName("one/two"), /path separators/);
  assert.throws(() => normalizeGroupName(".."), /cannot be/);
  assert.throws(() => normalizeGroupName("one\u0085two"), /single printable line/);
  assert.throws(() => normalizeGroupName("one\u2028two"), /single printable line/);
  assert.throws(() => normalizeGroupName("one\u202etwo"), /single printable line/);
  assert.throws(() => normalizeGroupName("one\u200btwo"), /single printable line/);
  assert.throws(() => normalizeGroupName(GROUP_ID), /cannot be UUIDs/);
  assert.throws(() => normalizeGroupName(GROUP_ID.toUpperCase()), /cannot be UUIDs/);
});

test("creates the approved Markdown context template", () => {
  assert.equal(
    createGroupContextTemplate("partitioning"),
    [
      "# partitioning",
      "",
      "## Objective",
      "",
      "## Background",
      "",
      "## Current state",
      "",
      "## Decisions",
      "",
      "## Constraints",
      "",
      "## Important references",
      "",
      "## Next steps",
      "",
      "## Notes",
      "",
    ].join("\n"),
  );
  assert.equal(SESSION_GROUP_CONTEXT_MAX_BYTES, 65_536);
});

test("parses strict state and metadata contracts", () => {
  const timestamp = "2026-08-13T20:47:59.123Z";
  const hash = "a".repeat(64);

  assert.deepEqual(
    parseSessionGroupsState({
      version: SESSION_GROUPS_VERSION,
      revision: 3,
      activeGroupId: GROUP_ID,
      updatedAt: timestamp,
    }),
    {
      version: SESSION_GROUPS_VERSION,
      revision: 3,
      activeGroupId: GROUP_ID,
      updatedAt: timestamp,
    },
  );
  assert.deepEqual(
    parseSessionGroupMetadata({
      version: SESSION_GROUPS_VERSION,
      id: GROUP_ID,
      name: "partitioning",
      createdAt: timestamp,
      updatedAt: timestamp,
      contextRevision: 4,
      contextSha256: hash,
    }),
    {
      version: SESSION_GROUPS_VERSION,
      id: GROUP_ID,
      name: "partitioning",
      createdAt: timestamp,
      updatedAt: timestamp,
      contextRevision: 4,
      contextSha256: hash,
    },
  );

  assert.throws(
    () =>
      parseSessionGroupsState({
        version: SESSION_GROUPS_VERSION,
        revision: -1,
        activeGroupId: null,
        updatedAt: timestamp,
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseSessionGroupsState({
        version: SESSION_GROUPS_VERSION,
        revision: 0,
        activeGroupId: null,
        updatedAt: timestamp,
        futureField: true,
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseSessionGroupsState({
        version: SESSION_GROUPS_VERSION,
        revision: 0,
        activeGroupId: null,
        updatedAt: "2026-02-30T00:00:00.000Z",
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseSessionGroupMetadata({
        version: SESSION_GROUPS_VERSION,
        id: GROUP_ID.toUpperCase(),
        name: "partitioning",
        createdAt: timestamp,
        updatedAt: timestamp,
        contextRevision: 0,
        contextSha256: hash,
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseSessionGroupMetadata({
        version: SESSION_GROUPS_VERSION,
        id: GROUP_ID,
        name: "partitioning",
        createdAt: timestamp,
        updatedAt: timestamp,
        contextRevision: 0,
        contextSha256: "bad-hash",
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      parseSessionGroupMetadata({
        version: SESSION_GROUPS_VERSION,
        id: GROUP_ID,
        name: " partitioning ",
        createdAt: timestamp,
        updatedAt: timestamp,
        contextRevision: 0,
        contextSha256: hash,
      }),
    /not canonical/,
  );
});

test("accepts only versioned membership and presentation payloads", () => {
  assert.deepEqual(
    parseSessionGroupMembership({ version: SESSION_GROUPS_VERSION, groupId: GROUP_ID }),
    { version: SESSION_GROUPS_VERSION, groupId: GROUP_ID },
  );
  assert.deepEqual(
    parseSessionGroupMembership({ version: SESSION_GROUPS_VERSION, groupId: null }),
    { version: SESSION_GROUPS_VERSION, groupId: null },
  );
  assert.equal(parseSessionGroupMembership({ groupId: GROUP_ID }), undefined);
  assert.deepEqual(
    parseSessionGroupToolState({ version: SESSION_GROUPS_VERSION, active: false }),
    { version: SESSION_GROUPS_VERSION, active: false },
  );
  assert.equal(
    parseSessionGroupToolState({ version: SESSION_GROUPS_VERSION, active: "false" }),
    undefined,
  );

  assert.deepEqual(
    parseSessionGroupPresentation({
      version: SESSION_GROUPS_VERSION,
      sessionId: "session-id",
      group: { id: GROUP_ID, name: " partitioning " },
    }),
    {
      version: SESSION_GROUPS_VERSION,
      sessionId: "session-id",
      group: { id: GROUP_ID, name: "partitioning" },
    },
  );
  assert.equal(
    parseSessionGroupPresentation({
      version: SESSION_GROUPS_VERSION,
      sessionId: "session-id",
      group: { id: "not-a-uuid", name: "partitioning" },
    }),
    undefined,
  );
});

test("publishes validated presentation events and supports unsubscribe", () => {
  const handlers = new Map();
  const emitted = [];
  const pi = {
    events: {
      emit(channel, data) {
        emitted.push({ channel, data });
        handlers.get(channel)?.(data);
      },
      on(channel, handler) {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      },
    },
  };
  const received = [];
  const unsubscribe = subscribeToSessionGroupPresentation(pi, (presentation) => {
    received.push(presentation);
  });

  publishSessionGroupPresentation(pi, "session-id", {
    id: GROUP_ID,
    name: " partitioning ",
  });
  assert.equal(emitted.length, 1);
  assert.deepEqual(received, [emitted[0].data]);
  assert.equal(received[0].group.name, "partitioning");
  assert.throws(
    () => publishSessionGroupPresentation(pi, "session-id", { id: "bad", name: "bad" }),
    /Invalid session-group presentation/,
  );

  pi.events.emit("ventris:session-groups:presentation", {
    version: SESSION_GROUPS_VERSION,
    sessionId: "session-id",
    group: { id: "bad", name: "ignored" },
  });
  assert.equal(received.length, 1);

  unsubscribe();
  publishSessionGroupPresentation(pi, "session-id", null);
  assert.equal(received.length, 1);
});
