import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parentGroupFromBranch, parentGroupFromFile } from "../extensions/herdr-subagents/groups.ts";
import sessionGroups from "../extensions/session-groups/index.ts";
import { SESSION_GROUP_MEMBERSHIP_ENTRY } from "../extensions/session-groups/contracts.ts";
import { readSessionGroupMembership, resolveSessionStartMembership } from "../extensions/session-groups/membership.ts";
import { SessionGroupStore } from "../extensions/session-groups/store.ts";

const A = "019cda47-9baf-7000-8000-000000000001";
const B = "019cda47-9baf-7000-8000-000000000002";
const membership = (groupId) => ({ version: 1, groupId });
const setMembership = (manager, groupId) => manager.appendCustomEntry(SESSION_GROUP_MEMBERSHIP_ENTRY, membership(groupId));
const current = (manager) => readSessionGroupMembership(manager.getEntries())?.groupId;

function resolve(overrides, environment) {
  return resolveSessionStartMembership({
    reason: "startup",
    destinationMembership: undefined,
    destinationIsExistingSession: false,
    destinationHasParent: false,
    sourceGroupId: A,
    activeGroupId: B,
    ...overrides,
  }, environment);
}

async function withFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-groups-"));
  const keys = ["PI_CODING_AGENT_DIR", "PI_HERDR_WORKER", "PI_HERDR_GROUP"];
  const previous = keys.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  delete process.env.PI_HERDR_WORKER;
  delete process.env.PI_HERDR_GROUP;
  const store = new SessionGroupStore();
  // Exercise the actual extension startup/context handlers and actual session
  // files, without constructing an agent or making any provider/model request.
  const boot = async (manager = SessionManager.create(directory, join(directory, "sessions")), reason = "startup") => {
    const handlers = new Map();
    const notifications = [];
    let activeTools = ["read", "bash"];
    const pi = {
      on: (name, handler) => handlers.set(name, handler),
      registerCommand() {},
      registerTool: (tool) => activeTools.push(tool.name),
      getActiveTools: () => [...activeTools],
      setActiveTools: (names) => { activeTools = [...names]; },
      appendEntry: (type, data) => manager.appendCustomEntry(type, data),
      events: { emit() {} },
    };
    const ctx = {
      sessionManager: manager,
      hasUI: true,
      ui: { notify: (message) => notifications.push(message) },
    };
    sessionGroups(pi);
    await handlers.get("session_start")({ type: "session_start", reason }, ctx);
    return {
      manager,
      notifications,
      activeTools: () => activeTools,
      prompt: () => handlers.get("before_agent_start")({ prompt: "Continue", systemPrompt: "base" }, ctx),
    };
  };
  try {
    await run({ directory, store, boot });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
}

test("worker inherits parent A, never unrelated globally active B", async () => {
  await withFixture(async ({ directory, store, boot }) => {
    const a = await store.createGroup("parent-A");
    const b = await store.createGroup("global-B");
    await store.setActiveGroup(b.id);
    const parent = SessionManager.inMemory(directory);
    setMembership(parent, a.id);
    process.env.PI_HERDR_WORKER = "1";
    process.env.PI_HERDR_GROUP = parentGroupFromBranch(parent.getEntries());
    const child = await boot();
    assert.equal(current(child.manager), a.id);
    const prompt = await child.prompt();
    assert.match(prompt.systemPrompt, /# parent-A/);
    assert.doesNotMatch(prompt.systemPrompt, /# global-B/);
    assert.equal((await store.getActiveGroup()).id, b.id);
  });
});

test("ungrouped parents and explicit none never join the active group", async () => {
  await withFixture(async ({ directory, store, boot }) => {
    const b = await store.createGroup("global-B");
    await store.setActiveGroup(b.id);
    const parent = SessionManager.inMemory(directory);
    assert.equal(parentGroupFromBranch(parent.getEntries()), "none");
    setMembership(parent, null);
    process.env.PI_HERDR_WORKER = "1";
    process.env.PI_HERDR_GROUP = parentGroupFromBranch(parent.getEntries());
    const child = await boot();
    assert.equal(current(child.manager), null);
    assert.equal(await child.prompt(), undefined);
    assert.deepEqual(child.activeTools(), ["read", "bash"]);
  });
});

test("explicit group initializes a worker independently of parent and active group", async () => {
  await withFixture(async ({ store, boot }) => {
    const explicit = await store.createGroup("explicit-C");
    const active = await store.createGroup("global-B");
    await store.setActiveGroup(active.id);
    process.env.PI_HERDR_WORKER = "1";
    process.env.PI_HERDR_GROUP = explicit.id;
    const child = await boot();
    assert.equal(current(child.manager), explicit.id);
    assert.match((await child.prompt()).systemPrompt, /# explicit-C/);
  });
});

test("worker launch policy fails closed for missing, invalid and unresolved values", () => {
  for (const policy of [undefined, "", "none", "inherit", "../../group", "not-a-uuid"]) {
    for (const reason of ["startup", "new", "fork"]) {
      assert.equal(resolve({ reason, destinationHasParent: true }, {
        PI_HERDR_WORKER: "1", PI_HERDR_GROUP: policy,
      }).groupId, null);
    }
  }
  for (const reason of ["startup", "new", "fork"]) {
    assert.equal(resolve({ reason }, { PI_HERDR_WORKER: "1", PI_HERDR_GROUP: A }).groupId, A);
  }
});

test("nonworker resolution is unchanged even with a stray group environment value", async () => {
  for (const marker of [undefined, "0"]) {
    const environment = { PI_HERDR_WORKER: marker, PI_HERDR_GROUP: "none" };
    assert.equal(resolve({}, environment).groupId, B);
    assert.equal(resolve({ reason: "new" }, environment).groupId, B);
    assert.equal(resolve({ reason: "fork" }, environment).groupId, A);
    assert.equal(resolve({ destinationIsExistingSession: true }, environment).groupId, null);
  }
  await withFixture(async ({ store, boot }) => {
    const active = await store.createGroup("normal-active");
    await store.setActiveGroup(active.id);
    process.env.PI_HERDR_GROUP = "none";
    const normal = await boot();
    assert.equal(current(normal.manager), active.id);
    assert.match((await normal.prompt()).systemPrompt, /# normal-active/);
  });
});

test("persistent continuation preserves stored group or explicit null despite a changed launch policy", async () => {
  await withFixture(async ({ directory, store, boot }) => {
    const a = await store.createGroup("stored-A");
    const b = await store.createGroup("global-B");
    await store.setActiveGroup(b.id);
    process.env.PI_HERDR_WORKER = "1";
    for (const initialGroup of [a.id, null]) {
      process.env.PI_HERDR_GROUP = initialGroup ?? "none";
      const first = await boot();
      assert.equal(current(first.manager), initialGroup);
      first.manager.appendMessage({ role: "user", content: "Persist this worker", timestamp: Date.now() });
      const path = first.manager.getSessionFile();
      const bytes = await readFile(path, "utf8");
      for (const reason of ["startup", "resume", "reload"]) {
        process.env.PI_HERDR_GROUP = initialGroup === null ? b.id : "none";
        const reopened = SessionManager.open(path, join(directory, "sessions"));
        const count = reopened.getEntries().length;
        const continued = await boot(reopened, reason);
        assert.equal(current(continued.manager), initialGroup);
        assert.equal(continued.manager.getEntries().length, count);
        assert.equal(await readFile(path, "utf8"), bytes);
      }
    }
    for (const reason of ["startup", "resume", "reload"]) {
      assert.equal(resolve({ reason, destinationIsExistingSession: true }, {
        PI_HERDR_WORKER: "1", PI_HERDR_GROUP: a.id,
      }).groupId, null, "legacy continuation without membership stays ungrouped");
    }
  });
});

test("nonexistent and deleted explicit groups detach without falling back to global B", async () => {
  await withFixture(async ({ store, boot }) => {
    const active = await store.createGroup("global-B");
    const deleted = await store.createGroup("deleted-C");
    await store.setActiveGroup(active.id);
    await store.deleteGroup(deleted.id);
    process.env.PI_HERDR_WORKER = "1";
    for (const id of [A, deleted.id]) {
      process.env.PI_HERDR_GROUP = id;
      const child = await boot();
      assert.equal(current(child.manager), null);
      assert.equal(await child.prompt(), undefined);
      assert.deepEqual(child.activeTools(), ["read", "bash"]);
      assert.ok(child.notifications.some((message) => message.includes("deleted")));
    }
    assert.equal((await store.getActiveGroup()).id, active.id);
  });
});

test("persisted deleted membership never joins an unrelated active group on continuation", async () => {
  await withFixture(async ({ directory, store, boot }) => {
    const a = await store.createGroup("stored-A");
    const b = await store.createGroup("global-B");
    await store.setActiveGroup(b.id);
    process.env.PI_HERDR_WORKER = "1";
    process.env.PI_HERDR_GROUP = a.id;
    const first = await boot();
    first.manager.appendMessage({ role: "user", content: "Persist", timestamp: Date.now() });
    const child = await boot(SessionManager.create(directory, join(directory, "sessions"), {
      parentSession: first.manager.getSessionFile(),
    }));
    child.manager.appendMessage({ role: "user", content: "Persist child", timestamp: Date.now() });
    await store.deleteGroup(a.id);
    process.env.PI_HERDR_GROUP = b.id;
    for (const previous of [first, child]) {
      const continued = await boot(SessionManager.open(previous.manager.getSessionFile()));
      assert.equal(current(continued.manager), null);
      assert.equal(await continued.prompt(), undefined);
    }
  });
});

test("parent helpers use real latest membership metadata, not transcript text", async () => {
  await withFixture(async ({ directory }) => {
    const parent = SessionManager.create(directory, join(directory, "sessions"));
    setMembership(parent, A);
    const old = parent.appendMessage({ role: "user", content: `groupId=${B}`, timestamp: Date.now() });
    setMembership(parent, B);
    parent.branch(old);
    parent.appendMessage({ role: "user", content: "Another branch", timestamp: Date.now() });
    // Membership is session-wide; the native caller must not substitute the
    // compacted context or a branch that omits the latest membership entry.
    assert.equal(parentGroupFromBranch(parent.getEntries()), B);
    assert.equal(await parentGroupFromFile(parent.getSessionFile()), B);
    setMembership(parent, null);
    assert.equal(parentGroupFromBranch(parent.getEntries()), "none");
    assert.equal(await parentGroupFromFile(parent.getSessionFile()), "none");
    assert.equal(await parentGroupFromFile(undefined), "none");
    parent.appendCustomEntry(SESSION_GROUP_MEMBERSHIP_ENTRY, { version: 1, groupId: "invalid" });
    assert.throws(() => parentGroupFromBranch(parent.getEntries()), /Invalid.*membership/);
    await assert.rejects(parentGroupFromFile(parent.getSessionFile()), /Invalid.*membership/);
  });
});

test("source inspection is bounded and read-only; malformed metadata and unsafe files fail closed", async () => {
  await withFixture(async ({ directory }) => {
    const path = join(directory, "source.jsonl");
    const line = JSON.stringify({ type: "custom", customType: SESSION_GROUP_MEMBERSHIP_ENTRY, data: membership(A) });
    for (const [contents, expected] of [
      ["", "none"],
      ["malformed source\n{unfinished", "none"],
      [line + "\n{unfinished", A],
      [JSON.stringify({ type: "message", message: { content: line } }), "none"],
      [line + "\n" + JSON.stringify({ type: "message", text: "文".repeat(30_000) }), A],
    ]) {
      await writeFile(path, contents);
      const before = await lstat(path);
      assert.equal(await parentGroupFromFile(path), expected);
      assert.equal(await readFile(path, "utf8"), contents);
      const after = await lstat(path);
      assert.equal(after.ino, before.ino);
      assert.equal(after.mtimeMs, before.mtimeMs);
    }
    await writeFile(path, line + "\n" + JSON.stringify({ type: "custom", customType: SESSION_GROUP_MEMBERSHIP_ENTRY, data: {} }));
    await assert.rejects(parentGroupFromFile(path), /Invalid.*membership/);
    await writeFile(path, line + "\n" + "x".repeat(8 * 1024 * 1024 + 1));
    await assert.rejects(parentGroupFromFile(path), /8 MiB inspection limit/);
    const link = join(directory, "link.jsonl");
    await symlink(path, link);
    await assert.rejects(parentGroupFromFile(link), /regular, non-symlink/);
    await assert.rejects(parentGroupFromFile(directory), /regular, non-symlink/);
    const missing = join(directory, "missing.jsonl");
    await assert.rejects(parentGroupFromFile(missing), { code: "ENOENT" });
    await assert.rejects(lstat(missing), { code: "ENOENT" });
  });
});
