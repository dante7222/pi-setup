import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import subagents, { formatStarted } from "../extensions/subagents/index.ts";
import { formatReport, formatReports, reportLimits } from "../extensions/subagents/report.ts";
import { SubagentManager } from "../extensions/subagents/manager.ts";
import workerPrompt from "../extensions/subagents/worker-prompt.ts";

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

function fakeCtx({ models = [], sessionId = "test-session", idle = true, mode = "rpc" } = {}) {
  const state = { idle };
  return {
    state,
    cwd: "/tmp", hasUI: false, mode,
    isProjectTrusted: () => true,
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
  // An orchestrating tool: codemode scripts must not drive it (or hold a worker in wait).
  assert.equal(tool.exposure, "model-only");
  // Keep the declaration small: the parent pays for it on every request.
  const size = JSON.stringify({ d: tool.description, p: tool.parameters, g: tool.promptGuidelines, s: tool.promptSnippet }).length;
  assert.ok(size < 1900, `tool declaration is ${size} bytes`);
  assert.deepEqual(registered.commands.map((c) => c.name), ["subagents"]);
  assert.deepEqual(registered.renderers, ["subagent-report"]);
  for (const event of ["session_start", "session_shutdown", "before_agent_start", "agent_settled"]) assert.ok(registered.handlers[event], event);
});

test("keeps provider-friendly enum schemas and optional task fields", () => {
  const { tool } = loaded();
  // Inspect exactly what is serialized for providers, not TypeBox's hidden metadata.
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  assert.deepEqual(schema.required, ["action"]);
  assert.deepEqual(schema.properties.action, { type: "string", enum: ["run", "send", "wait", "stop", "list"] });
  const task = schema.properties.tasks.items;
  assert.deepEqual(task.required, ["name", "task"]);
  assert.deepEqual(task.properties.role, {
    type: "string", enum: ["worker", "reviewer", "explorer", "tester"], description: "reviewer/explorer: read-only",
  });
  assert.deepEqual(task.properties.thinking, { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] });
  assert.equal(schema.properties.context.type, "string");
});

/** A session whose manager is a process-free fake, injected through reload adoption. */
function withFakeManager(t, sessionId, manager, options) {
  globalThis[Symbol.for("ventris.pi-subagents.managers")].set(sessionId, { manager: { outbox: [], take: () => [], isReady: () => true, stop: () => [], workers: new Map(), setHooks() {}, dispose: async () => {}, busyNames: () => new Set(), ...manager }, interrupted: false, runOwned: new Set() });
  const { pi, registered } = fakePi();
  subagents(pi);
  const ctx = fakeCtx({ sessionId, ...options });
  registered.handlers.session_start({ type: "session_start", reason: "reload" }, ctx);
  t.after(() => registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }));
  return { ctx, registered, tool: registered.tools[0] };
}

test("run puts the shared context ahead of every task and passes the parent's trust on", async (t) => {
  let spawned;
  const { tool, ctx } = withFakeManager(t, "context", { spawn: (tasks) => { spawned = tasks; return tasks.map((task) => ({ task, state: "running" })); } });
  const result = await tool.execute("id", { action: "run", context: " Repo uses pnpm. ", tasks: [{ name: "a", task: "Fix A" }, { name: "b", task: "Fix B", cwd: "/" }] }, undefined, undefined, ctx);
  assert.equal(result.content[0].text, "started: a (p/parent:high), b (p/parent:high)");
  assert.deepEqual(spawned.map((task) => task.task), ["Repo uses pnpm.\n\nFix A", "Repo uses pnpm.\n\nFix B"]);
  assert.deepEqual(spawned.map((task) => task.trusted), [true, undefined]);
  const empty = await tool.execute("id", { action: "run", context: "Shared", tasks: [{ name: "c", task: "  " }] }, undefined, undefined, ctx);
  assert.match(empty.content[0].text, /Task for "c" is empty/, "context does not stand in for a task");
});

test("print and JSON modes return the reports from run and send, since nothing can arrive later", async (t) => {
  for (const mode of ["print", "json"]) {
    const waits = [];
    const { tool, ctx } = withFakeManager(t, `one-shot-${mode}`, {
      spawn: (tasks) => tasks.map((task) => ({ task, state: "running" })),
      get: () => ({}),
      send: async () => "started",
      wait: async (names, seconds, _signal, all) => { waits.push({ names, seconds, all }); return { reports: names.map((name) => report(name)), pending: [] }; },
    }, { mode });
    const ran = await tool.execute("id", { action: "run", tasks: [{ name: "a", task: "x" }, { name: "b", task: "y" }] }, undefined, undefined, ctx);
    assert.match(ran.content[0].text, /^\[subagent a done[\s\S]*\[subagent b done/);
    assert.equal(ran.details.reports.length, 2);
    const sent = await tool.execute("id", { action: "send", name: "a", message: "more" }, undefined, undefined, ctx);
    assert.match(sent.content[0].text, /^\[subagent a done/);
    assert.deepEqual(waits.map((wait) => [wait.names, wait.all]), [[["a", "b"], true], [["a"], true]]);
    assert.ok(waits.every((wait) => wait.seconds * 1000 < 2 ** 31), "the wait timer must not overflow");
  }
});

test("/subagents shows cost to the user; the model-facing list does not", async (t) => {
  const worker = { task: { name: "a", role: "worker" }, state: "idle", total: { tokens: 12_000, cost: 0.456 } };
  const { tool, ctx, registered } = withFakeManager(t, "cost", { workers: new Map([["a", worker]]) });
  assert.equal((await tool.execute("id", { action: "list" }, undefined, undefined, ctx)).content[0].text, "a worker idle 12k");
  const notices = [];
  await registered.commands[0].command.handler("", { ...ctx, ui: { notify: (message) => notices.push(message) } });
  assert.equal(notices[0], "a worker idle 12k $0.46\nauto-wake: on");
});

test("the worker extension asks once for a missing final report and stops idle cache warming", () => {
  const { pi, registered } = fakePi();
  process.env.PI_SUBAGENT = "1";
  process.env.PI_SUBAGENT_PROMPT = "You are a worker subagent.";
  try { workerPrompt(pi); } finally { delete process.env.PI_SUBAGENT; delete process.env.PI_SUBAGENT_PROMPT; }
  const { before_agent_start: start, agent_before_settle: settle, cache_warming_decision: warming } = registered.handlers;
  const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason });
  const boundary = (last, outcome = "completed") => ({ type: "agent_before_settle", entries: [{ type: "custom", customType: "other" }], continue: false, outcome, context: { contextMessages: [{ role: "user", content: "task" }, last, { role: "toolResult" }] } });
  const begin = () => { const event = { systemPromptOptions: { sections: {} } }; start(event); return event; };
  assert.equal(begin().systemPromptOptions.sections.subagent, "You are a worker subagent.");
  assert.equal(settle(boundary(assistant([{ type: "text", text: "Done: all good." }]))), undefined, "a final text needs no reminder");
  assert.equal(settle(boundary(assistant([], "error"), "error")), undefined, "a provider error is not retried here");
  assert.equal(settle(boundary(assistant([], "aborted"), "aborted")), undefined);
  const asked = settle(boundary(assistant([{ type: "toolCall", id: "t" }], "toolUse")));
  assert.equal(asked.continue, true);
  assert.deepEqual(asked.entries.map((entry) => entry.customType), ["other", "subagent-report-reminder"]);
  assert.equal(asked.entries[1].display, false);
  assert.equal(settle(boundary(assistant([{ type: "text", text: " " }]))), undefined, "only once per run");
  begin();
  assert.equal(settle(boundary(assistant([{ type: "text", text: "cut off" }], "length"))).continue, true, "a new run may be reminded again");
  assert.deepEqual(warming({}, { isIdle: () => true }), { action: "stop" });
  assert.equal(warming({}, { isIdle: () => false }), undefined, "during a run Pi decides");
});

test("Pi validates action, role and thinking enums without requiring optional fields", () => {
  const { tool } = loaded();
  const validate = (args) => validateToolArguments(tool, { type: "toolCall", id: "schema", name: tool.name, arguments: args });
  for (const action of ["run", "send", "wait", "stop", "list"]) assert.deepEqual(validate({ action }), { action });
  const task = { name: "schema", task: "Check schema" };
  assert.deepEqual(validate({ action: "run", tasks: [task] }), { action: "run", tasks: [task] });
  for (const role of ["worker", "reviewer", "explorer", "tester"]) {
    assert.equal(validate({ action: "run", tasks: [{ ...task, role }] }).tasks[0].role, role);
  }
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(validate({ action: "run", tasks: [{ ...task, thinking }] }).tasks[0].thinking, thinking);
  }
  assert.deepEqual(validate({ action: "run", tasks: [{ ...task, role: null, thinking: null }] }), { action: "run", tasks: [task] });
  assert.throws(() => validate({}), /action:/);
  assert.throws(() => validate({ action: "launch" }), /action:/);
  assert.throws(() => validate({ action: "run", tasks: [{ ...task, role: "admin" }] }), /tasks\.0\.role:/);
  assert.throws(() => validate({ action: "run", tasks: [{ ...task, thinking: "extreme" }] }), /tasks\.0\.thinking:/);
});

test("Pi coerces arguments without mutating the call and enforces task/wait limits", () => {
  const { tool } = loaded();
  const validate = (args) => validateToolArguments(tool, { type: "toolCall", id: "schema", name: tool.name, arguments: args });
  const input = { action: "wait", seconds: "12", all: "true", names: "schema" };
  assert.deepEqual(validate(input), { action: "wait", seconds: 12, all: true, names: ["schema"] });
  assert.deepEqual(input, { action: "wait", seconds: "12", all: "true", names: "schema" });
  assert.deepEqual(validate({ action: "wait", seconds: null }), { action: "wait" });
  for (const seconds of [0, 1800]) assert.equal(validate({ action: "wait", seconds }).seconds, seconds);
  for (const seconds of [-1, 1801, "not-a-number"]) assert.throws(() => validate({ action: "wait", seconds }), /seconds:/);
  const task = { name: "schema", task: "Check schema" };
  assert.deepEqual(validate({ action: "run", tasks: task }).tasks, [task]);
  assert.equal(validate({ action: "run", tasks: Array(16).fill(task) }).tasks.length, 16);
  for (const tasks of [[], Array(17).fill(task)]) assert.throws(() => validate({ action: "run", tasks }), /tasks:/);
  assert.throws(() => validate({ action: "run", tasks: [{ task: "Check schema" }] }), /tasks\.0\.name:/);
  assert.throws(() => validate({ action: "run", tasks: [{ name: "schema" }] }), /tasks\.0\.task:/);
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
  const fake = { outbox: [], take: () => [], isReady: () => true, stop: (names) => { stops.push(names); return names; }, workers, setHooks() {}, dispose: async () => {}, send: async () => "steered", spawn: () => [], get: (name) => workers.get(name) };
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

test("a manager stashed for /reload that nobody adopts is disposed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { tool, ctx, registered } = loaded({ sessionId: "orphaned" });
  await managerOf(tool, ctx);
  const key = Symbol.for("ventris.pi-subagents.managers");
  await registered.handlers.session_shutdown({ type: "session_shutdown", reason: "reload" });
  const kept = globalThis[key].get("orphaned").manager;
  t.mock.timers.tick(59_000);
  assert.ok(globalThis[key].has("orphaned"));
  t.mock.timers.tick(1_000);
  assert.equal(globalThis[key].has("orphaned"), false);
  assert.throws(() => kept.spawn([]), /shut down/);
});

test("formatReport is compact and cuts a long single-line report with a path", () => {
  assert.equal(formatReport(report("r", { seconds: 12, tokens: 15400, cost: 0.123, text: "all good" })), "[subagent r done 12s 15k tok]\nall good");
  const long = formatReport(report("r", { text: "x".repeat(5000) }));
  assert.ok(long.length < 3200);
  assert.match(long, /x…\n\[truncated line 1 of 1; full report: \/r\/r-1\.md \(read offset=1 limit=1\)\]$/);
  assert.match(formatReport(report("r", { state: "failed", text: "", error: "boom" })), /failed.*\nerror: boom$/);
  assert.ok(formatReport(report("r", { state: "failed", text: "", error: "e".repeat(100_000) })).length < 600);
  // A long error keeps its start and its end: a stderr tail names the cause last.
  assert.match(formatReport(report("r", { state: "failed", text: "", error: `Worker exited (1): ${"noise ".repeat(200)}Error: ENOSPC` })), /\nerror: Worker exited \(1\): noise .* \.\.\. .*noise Error: ENOSPC$/);
});

test("truncation keeps whole lines from the start and the end and names the omitted range", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i + 1).padStart(3, "0")} ${"x".repeat(41)}`);
  const [header, ...body] = formatReport(report("r", { text: lines.join("\n") })).split("\n");
  assert.match(header, /^\[subagent r done/);
  const markerAt = body.findIndex((line) => line.startsWith("[truncated"));
  const [, from, to, offset, limit] = /^\[truncated lines (\d+)-(\d+) of 100; full report: \/r\/r-1\.md \(read offset=(\d+) limit=(\d+)\)\]$/.exec(body[markerAt]).map(Number);
  assert.deepEqual(body.slice(0, markerAt), lines.slice(0, from - 1), "head is the first lines");
  assert.deepEqual(body.slice(markerAt + 1), lines.slice(to), "tail is the last lines, ending with the verdict");
  assert.equal(offset, from);
  assert.equal(limit, to - from + 1);
  assert.ok(body.join("\n").length - body[markerAt].length <= 3000);
});

test("a first line longer than the head budget is cut, not dropped", () => {
  const text = `${"S".repeat(2500)}\nmiddle\n${"m".repeat(2000)}\nVERDICT: ok`;
  const body = formatReport(report("r", { text })).split("\n").slice(1);
  assert.match(body[0], /^S+…$/);
  assert.match(body[1], /^\[truncated lines 1-3 of 4; .*read offset=1 limit=3\)\]$/);
  assert.equal(body.at(-1), "VERDICT: ok");
});

test("reports delivered together share one body budget", () => {
  assert.deepEqual(reportLimits([5000, 5000, 5000, 5000]), [3000, 3000, 3000, 3000]);
  assert.deepEqual(reportLimits(Array(8).fill(9000)), Array(8).fill(1500));
  assert.deepEqual(reportLimits(Array(16).fill(9000)), Array(16).fill(800), "every report keeps a minimum");
  // Short reports keep their text and leave their share to a long one.
  assert.equal(reportLimits([...Array(7).fill(500), 9000])[7], 3000);
  const wide = formatReports(Array.from({ length: 16 }, (_, i) => report(`r${i}`, { text: "y\n".repeat(4000) })));
  assert.equal(wide.views.length, 16);
  assert.ok(wide.text.length < 16 * 1000, `batch text is ${wide.text.length} chars`);
});

test("reports show edited files relative to the parent cwd, overlaps, and partial runs", () => {
  const text = formatReport(report("r", { partial: true, files: ["/tmp/src/a.ts", "/elsewhere/b.ts"], overlaps: { "/tmp/src/a.ts": ["x", "y"] } }), 3000, "/tmp");
  assert.equal(text, "[subagent r done partial 1s 1k tok]\nedited: src/a.ts, /elsewhere/b.ts\noverlap: src/a.ts (x, y)\nr ok");
  const many = formatReport(report("r", { files: Array.from({ length: 15 }, (_, i) => `/tmp/f${i}.ts`) }), 3000, "/tmp");
  assert.match(many, /^edited: f0\.ts, .*f11\.ts, \+3 more$/m);
  // Reports from a manager adopted across /reload may lack the new fields.
  assert.equal(formatReport(report("r")), "[subagent r done 1s 1k tok]\nr ok");
});

test("formatStarted groups names by state and shows resolved models compactly", () => {
  const worker = (name, state, model, thinking) => ({ state, task: { name, model, thinking } });
  assert.equal(
    formatStarted([worker("a", "running", "openai-codex/gpt-6-astra", "xhigh"), worker("b", "running"), worker("c", "queued", "p/m"), worker("d", "failed")]),
    "started: a (openai-codex/gpt-6-astra:xhigh), b; queued: c (p/m); failed: d",
  );
});

test("is included in the package manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/subagents/index.ts"));
});
