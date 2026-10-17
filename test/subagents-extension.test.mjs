import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import subagents, { formatReport } from "../extensions/subagents/index.ts";
import { SubagentManager } from "../extensions/subagents/manager.ts";

// Tests may themselves run inside a subagent, which sets this for its own process.
delete process.env.PI_SUBAGENT;

function fakePi() {
  const registered = { tools: [], commands: [], handlers: {}, renderers: [], messages: [] };
  const pi = {
    registerTool(tool) { registered.tools.push(tool); },
    registerCommand(name, command) { registered.commands.push({ name, command }); },
    registerMessageRenderer(type) { registered.renderers.push(type); },
    on(event, handler) { registered.handlers[event] = handler; },
    sendMessage(message, options) { registered.messages.push({ message, options }); },
    getThinkingLevel() { return "high"; },
  };
  return { pi, registered };
}

function fakeCtx({ models = [], sessionId = "test-session", idle = true } = {}) {
  const state = { idle };
  return {
    state,
    cwd: "/tmp", hasUI: false, mode: "print",
    model: { provider: "p", id: "parent" },
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: { getAll: () => models, getAvailable: () => models },
    isIdle: () => state.idle,
    ui: { notify() {}, setWidget() {} },
  };
}

const report = (name, extra = {}) => ({ name, state: "done", text: `${name} ok`, path: `/r/${name}-1.md`, batch: 1, seconds: 1, tokens: 1000, cost: 0, ...extra });
/** Outbox take with the manager's filter semantics. */
const taker = (outbox) => (filter = () => true) => {
  const taken = outbox.filter(filter);
  for (const item of taken) outbox.splice(outbox.indexOf(item), 1);
  return taken;
};

/** Load the extension, start a session, and inject a manager without spawning processes. */
function loaded(options) {
  const { pi, registered } = fakePi();
  subagents(pi);
  const ctx = fakeCtx(options);
  registered.handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  const [tool] = registered.tools;
  return { pi, registered, ctx, tool };
}

async function managerOf(tool, ctx) {
  // `list` lazily creates the session manager; reach it through a report hook.
  await tool.execute("id", { action: "list" }, undefined, undefined, ctx);
}

test("registers one compact tool, a command and a report renderer", () => {
  const { registered } = loaded();
  assert.equal(registered.tools.length, 1);
  const [tool] = registered.tools;
  assert.equal(tool.name, "subagents");
  // Keep the declaration small: the parent pays for it on every request.
  const size = JSON.stringify({ d: tool.description, p: tool.parameters, g: tool.promptGuidelines, s: tool.promptSnippet }).length;
  assert.ok(size < 2700, `tool declaration is ${size} bytes`);
  assert.deepEqual(registered.commands.map((c) => c.name), ["subagents"]);
  assert.deepEqual(registered.renderers, ["subagent-report"]);
  for (const event of ["session_start", "session_shutdown", "before_agent_start", "agent_settled"]) assert.ok(registered.handlers[event], event);
});

test("does nothing inside a worker process", () => {
  const { pi, registered } = fakePi();
  process.env.PI_SUBAGENT = "1";
  try { subagents(pi); } finally { delete process.env.PI_SUBAGENT; }
  assert.equal(registered.tools.length, 0);
});

test("run rejects unknown and ambiguous models before starting anything", async () => {
  const models = [{ provider: "a", id: "gpt-6-astra" }, { provider: "b", id: "gpt-6-astra" }, { provider: "c", id: "solo" }];
  const { tool, ctx, registered } = loaded({ models, sessionId: "models" });
  const run = (model) => tool.execute("id", { action: "run", tasks: [{ name: "x", task: "t", model }] }, undefined, undefined, ctx);
  const unknown = await run("nope");
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown or unauthenticated model "nope"/);
  assert.match((await run("gpt-6-astra")).content[0].text, /ambiguous: a\/gpt-6-astra, b\/gpt-6-astra/);
  assert.equal((await tool.execute("id", { action: "list" }, undefined, undefined, ctx)).content[0].text, "No subagents.");
  assert.match((await tool.execute("id", { action: "send", name: "x", message: "m" }, undefined, undefined, ctx)).content[0].text, /No subagent named "x"/);
  await registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });
});

test("reports are delivered only while the parent is idle, batched, and never during an aborted run", async (t) => {
  // Inject a process-free manager through reload adoption, keyed by session id.
  const outbox = [];
  const fake = { outbox, take: taker(outbox), isReady: () => true, stop: () => [], workers: new Map(), setHooks() {}, dispose: async () => {} };
  globalThis[Symbol.for("ventris.pi-subagents.managers")].set("delivery", { manager: fake, interrupted: false, runOwned: new Set() });
  const { pi, registered } = fakePi();
  subagents(pi);
  const ctx = fakeCtx({ sessionId: "delivery", idle: false });
  registered.handlers.session_start({ type: "session_start", reason: "reload" }, ctx);
  t.after(() => registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }));

  outbox.push(report("a"), report("b"));
  registered.handlers.agent_settled({ type: "agent_settled", aborted: true }, ctx);
  assert.equal(registered.messages.length, 0, "parent still busy: nothing sent");
  ctx.state.idle = true;
  registered.handlers.agent_settled({ type: "agent_settled", aborted: true }, ctx);
  assert.equal(registered.messages.length, 1);
  assert.equal(registered.messages[0].options.triggerTurn, false, "aborted parent is not woken");
  assert.match(registered.messages[0].message.content, /\[subagent a done[\s\S]*\[subagent b done/);

  // A report arriving after Esc (e.g. a late cancellation) still does not wake the parent.
  outbox.push(report("late", { state: "cancelled" }));
  registered.handlers.agent_settled({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(registered.messages.length, 2);
  assert.equal(registered.messages[1].options.triggerTurn, false);

  // The next user prompt re-enables waking.
  registered.handlers.before_agent_start({ type: "before_agent_start", messageType: "user", prompt: "go" }, ctx);
  outbox.push(report("c"));
  registered.handlers.agent_settled({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(registered.messages.length, 3);
  assert.deepEqual(registered.messages[2].options, { triggerTurn: true });
  assert.equal(outbox.length, 0);
});

test("Esc stops only subagents the aborted run started or messaged", async (t) => {
  const stops = [];
  const workers = new Map([["old", {}], ["new", {}]]);
  const fake = { outbox: [], take: () => [], isReady: () => true, stop: (names) => { stops.push(names); return names; }, workers, setHooks() {}, dispose: async () => {}, send: async () => "steered", spawn: () => [] };
  globalThis[Symbol.for("ventris.pi-subagents.managers")].set("scoped", { manager: fake, interrupted: false, runOwned: new Set() });
  const { pi, registered } = fakePi();
  subagents(pi);
  const ctx = fakeCtx({ sessionId: "scoped" });
  registered.handlers.session_start({ type: "session_start", reason: "reload" }, ctx);
  t.after(() => registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }));
  const [tool] = registered.tools;
  await tool.execute("id", { action: "send", name: "new", message: "m" }, undefined, undefined, ctx);
  // A retry inside the same run (another agent_start without settling) keeps ownership.
  registered.handlers.agent_start?.({ type: "agent_start" }, ctx);
  registered.handlers.agent_settled({ type: "agent_settled", aborted: true }, ctx);
  assert.deepEqual(stops, [["new"]]);
  // A later aborted run that touched no subagent stops nothing.
  registered.handlers.agent_settled({ type: "agent_settled", aborted: true }, ctx);
  assert.deepEqual(stops, [["new"]]);
});

test("Esc suppression of auto-wake survives /reload until the next user prompt", async (t) => {
  const outbox = [];
  const fake = { outbox, take: taker(outbox), isReady: () => true, stop: () => [], workers: new Map(), setHooks() {}, dispose: async () => {} };
  const managers = globalThis[Symbol.for("ventris.pi-subagents.managers")];
  managers.set("wakeful", { manager: fake, interrupted: false, runOwned: new Set() });
  const first = fakePi();
  subagents(first.pi);
  const ctx = fakeCtx({ sessionId: "wakeful" });
  first.registered.handlers.session_start({ type: "session_start", reason: "reload" }, ctx);
  first.registered.handlers.agent_settled({ type: "agent_settled", aborted: true }, ctx);
  await first.registered.handlers.session_shutdown({ type: "session_shutdown", reason: "reload" });
  const second = fakePi();
  subagents(second.pi);
  second.registered.handlers.session_start({ type: "session_start", reason: "reload" }, ctx);
  t.after(() => second.registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }));
  outbox.push(report("late"));
  second.registered.handlers.agent_settled({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(second.registered.messages[0].options.triggerTurn, false);
});

test("automatic delivery holds a batch's reports until the whole batch finished", async (t) => {
  const outbox = [];
  const unfinished = new Set([1]);
  const fake = { outbox, take: taker(outbox), isReady: (r) => !unfinished.has(r.batch), stop: () => [], workers: new Map(), setHooks() {}, dispose: async () => {} };
  globalThis[Symbol.for("ventris.pi-subagents.managers")].set("batched", { manager: fake, interrupted: false, runOwned: new Set() });
  const { pi, registered } = fakePi();
  subagents(pi);
  const ctx = fakeCtx({ sessionId: "batched" });
  registered.handlers.session_start({ type: "session_start", reason: "reload" }, ctx);
  t.after(() => registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }));
  // Batch 1 has one report while another of its subagents still runs; batch 2 is complete.
  outbox.push(report("a", { batch: 1 }), report("solo", { batch: 2 }));
  registered.handlers.agent_settled({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(registered.messages.length, 1);
  assert.match(registered.messages[0].message.content, /subagent solo/);
  assert.doesNotMatch(registered.messages[0].message.content, /subagent a /);
  // The rest of batch 1 finishes: both its reports arrive in one wake-up.
  outbox.push(report("b", { batch: 1 }));
  unfinished.delete(1);
  registered.handlers.agent_settled({ type: "agent_settled", aborted: false }, ctx);
  assert.equal(registered.messages.length, 2);
  assert.match(registered.messages[1].message.content, /subagent a [\s\S]*subagent b /);
  assert.deepEqual(registered.messages[1].options, { triggerTurn: true });
});

test("a stale ctx never throws out of worker event hooks, and reload detaches them", async () => {
  const hookSets = [];
  const fake = { outbox: [], take: () => [], isReady: () => true, stop: () => [], workers: new Map(), setHooks(hooks) { hookSets.push(hooks); }, dispose: async () => {} };
  globalThis[Symbol.for("ventris.pi-subagents.managers")].set("stale", { manager: fake, interrupted: false, runOwned: new Set() });
  const { pi, registered } = fakePi();
  subagents(pi);
  let stale = false;
  const ctx = fakeCtx({ sessionId: "stale" });
  const guarded = new Proxy(ctx, { get(target, key) { if (stale) throw new Error("This extension ctx is stale"); return target[key]; } });
  registered.handlers.session_start({ type: "session_start", reason: "reload" }, guarded);
  const live = hookSets.at(-1);
  stale = true;
  // Worker events reach these hooks from stdout handlers; they must not throw.
  assert.doesNotThrow(() => live.changed());
  assert.doesNotThrow(() => live.report());
  await registered.handlers.session_shutdown({ type: "session_shutdown", reason: "reload" });
  const detachedHooks = hookSets.at(-1);
  assert.notEqual(detachedHooks, live, "reload replaces the hooks before adoption");
  assert.doesNotThrow(() => detachedHooks.changed());
  globalThis[Symbol.for("ventris.pi-subagents.managers")].delete("stale");
});

test("reload keeps the session's manager; other session changes dispose it", async () => {
  const { tool, ctx, registered } = loaded({ sessionId: "reload" });
  await managerOf(tool, ctx);
  const detachedKey = Symbol.for("ventris.pi-subagents.managers");
  await registered.handlers.session_shutdown({ type: "session_shutdown", reason: "reload" });
  const kept = globalThis[detachedKey].get("reload").manager;
  assert.ok(kept instanceof SubagentManager);
  // The reloaded extension instance adopts it.
  const next = loaded({ sessionId: "reload" });
  assert.equal(globalThis[detachedKey].has("reload"), false);
  await next.registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });
  assert.equal(globalThis[detachedKey].has("reload"), false);
  assert.throws(() => kept.spawn([]), /shut down/);
});

test("formatReport is compact and truncates long reports with a path", () => {
  assert.equal(formatReport(report("r", { seconds: 12, tokens: 15400, cost: 0.123, text: "all good" })), "[subagent r done 12s 15k tok]\nall good");
  const long = formatReport(report("r", { text: "x".repeat(5000) }));
  assert.ok(long.length < 3200);
  assert.match(long, /\[truncated; full report: \/r\/r-1\.md\]$/);
  assert.match(formatReport(report("r", { state: "failed", text: "", error: "boom" })), /failed.*\nerror: boom$/);
  assert.ok(formatReport(report("r", { state: "failed", text: "", error: "e".repeat(100_000) })).length < 600);
});

test("is included in the package manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/subagents/index.ts"));
});
