import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import extension from "../extensions/herdr-subagents/index.ts";
import { atomic, collect, jobs, locked, save, scopeFor, validateTasks } from "../extensions/herdr-subagents/core.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-abort-"));
  const old = { ...process.env };
  const oldKeys = getKeybindings();
  setKeybindings(new KeybindingsManager({ "app.interrupt": { defaultKeys: "escape" } }, { "app.interrupt": "ctrl+y" }));
  t.after(async () => {
    setKeybindings(oldKeys);
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
    await rm(directory, { recursive: true, force: true });
  });
  const backend = join(directory, "herdr.mjs");
  const statePath = join(directory, "panes.json");
  await writeFile(statePath, JSON.stringify([{ pane_id: "main", terminal_id: "parent" }]));
  await writeFile(backend, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.FAKE_STATE, args=process.argv.slice(2);
const panes=JSON.parse(readFileSync(file,'utf8'));
if(args[1]==='close') writeFileSync(file,JSON.stringify(panes.filter(p=>p.pane_id!==args[2])));
console.log(JSON.stringify({result:args[1]==='list'?{panes}:{}}));
`);
  await chmod(backend, 0o700);
  Object.assign(process.env, { PI_HERDR_WORKER: "", PI_CODING_AGENT_DIR: directory, HERDR_ENV: "1", HERDR_PANE_ID: "main", HERDR_WORKSPACE_ID: "w", HERDR_SOCKET_PATH: "test.sock", HERDR_BIN_PATH: backend, FAKE_STATE: statePath });
  const scope = scopeFor("parent");
  const handlers = new Map();
  // Deliberately no registerTool/sendMessage/exec: cancellation must remain local.
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} });
  let session = "parent", idle = false;
  const notices = [];
  let input;
  const ctx = { sessionManager: { getSessionId: () => session }, isIdle: () => idle, hasUI: true, mode: "tui", ui: { notify: (...args) => notices.push(args), onTerminalInput: (handler) => { input = handler; return () => { input = undefined; }; } } };
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  const controller = new AbortController();
  ctx.signal = controller.signal;
  await emit("session_start");
  await emit("before_agent_start");
  await emit("agent_start");
  const add = async (id, claimed = false, target = scope) => {
    const job = { id: id.toString(16).padStart(12, "0"), task: validateTasks([{ name: `job-${id}`, prompt: "test" }])[0], pane: `pane-${id}`, terminal: `terminal-${id}`, launched: true, cursor: 0, created: id };
    await mkdir(join(target.root, job.id), { recursive: true });
    await save(target, job);
    const panes = JSON.parse(await readFile(statePath, "utf8"));
    panes.push({ pane_id: job.pane, terminal_id: job.terminal });
    await writeFile(statePath, JSON.stringify(panes));
    if (claimed) await atomic(join(target.root, job.id, "worker.json"), { pid: process.pid }, true);
    return job;
  };
  return { scope, ctx, controller, emit, add, notices, statePath, input: (data) => input?.(data), setIdle: (value) => { idle = value; }, setSession: (value) => { session = value; }, settle: async () => { idle = true; await emit("agent_settled"); } };
}

async function waitFor(path) {
  for (let i = 0; i < 500; i++) {
    if (await stat(path).catch(() => undefined)) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${path}`);
}

test("Stop broadcasts all 16 cancellations before acknowledgements, closes only owned panes, preserves reports", async (t) => {
  const f = await fixture(t);
  const launched = [];
  for (let i = 1; i <= 16; i++) launched.push(await f.add(i, true));
  const other = scopeFor("other");
  await f.add(17, false, other);
  f.controller.abort();
  for (const job of launched) await waitFor(join(f.scope.root, job.id, "cancel.json"));
  assert.ok((await jobs(f.scope)).every((job) => !job.closed));
  for (const job of launched) await atomic(join(f.scope.root, job.id, "done.json"), { state: "cancelled", report: `partial ${job.id}` }, true);
  await f.settle();
  assert.ok((await jobs(f.scope)).every((job) => job.closed && !job.collected));
  assert.equal((await jobs(other))[0].closed, undefined);
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).length, 2);
  await collect(f.scope, 0, async (output) => {
    assert.equal(output.reports.length, 16);
    assert.ok(output.reports.every((report) => report.state === "cancelled" && report.text.startsWith("partial")));
  });
});

test("Stop cleanup survives blocked state lock and next prompt waits without cancelling its new jobs", async (t) => {
  const f = await fixture(t);
  await f.add(1);
  let next, started = false;
  await locked(f.scope, async () => {
    f.controller.abort();
    next = f.emit("before_agent_start").then(() => { started = true; });
    await delay(100);
    assert.equal(started, false);
    // Simulates a spawn still publishing its final job while holding the lock.
    await f.add(2);
  });
  await next;
  assert.ok((await jobs(f.scope)).every((job) => job.closed));
  const nextController = new AbortController();
  f.ctx.signal = nextController.signal;
  await f.emit("agent_start");
  const fresh = await f.add(3);
  await f.settle();
  assert.equal((await jobs(f.scope)).find((job) => job.id === fresh.id).closed, undefined);
});

test("normal completion, successful retry and ordinary terminal error preserve unread workers", async (t) => {
  const f = await fixture(t);
  await f.add(1);
  await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
  assert.equal((await jobs(f.scope))[0].closed, undefined);
  f.ctx.signal = new AbortController().signal;
  await f.emit("agent_start");
  await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await f.settle();
  assert.equal((await jobs(f.scope))[0].closed, undefined);
  await f.emit("before_agent_start");
  await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
  await f.settle();
  assert.equal((await jobs(f.scope))[0].closed, undefined);
});

test("automatic compaction cancellation stops workers; manual compaction cancellation does not", async (t) => {
  const f = await fixture(t);
  await f.add(1);
  const manual = new AbortController();
  await f.emit("session_before_compact", { reason: "manual", signal: manual.signal });
  manual.abort();
  await f.settle();
  assert.equal((await jobs(f.scope))[0].closed, undefined);
  await f.emit("before_agent_start");
  const automatic = new AbortController();
  await f.emit("session_before_compact", { reason: "threshold", signal: automatic.signal });
  automatic.abort();
  await f.settle();
  assert.equal((await jobs(f.scope))[0].closed, true);
});

test("reload detaches abort listeners; already-requested Stop still completes before shutdown", async (t) => {
  const f = await fixture(t);
  await f.add(1);
  await f.emit("session_shutdown", { reason: "reload" });
  f.controller.abort();
  await delay(50);
  assert.equal((await jobs(f.scope))[0].closed, undefined);
  const controller = new AbortController();
  f.ctx.signal = controller.signal;
  await f.emit("session_start");
  controller.abort();
  await f.emit("session_shutdown", { reason: "reload" });
  assert.equal((await jobs(f.scope))[0].closed, true);
});

test("abort snapshots original session and handles already-aborted signals without duplicate cleanup", async (t) => {
  const f = await fixture(t);
  await f.add(1);
  const other = scopeFor("other");
  await f.add(2, false, other);
  f.controller.abort();
  f.setSession("other");
  await f.settle();
  assert.equal((await jobs(f.scope))[0].closed, true);
  assert.equal((await jobs(other))[0].closed, undefined);
  assert.equal(f.notices.length, 1);
  await f.emit("before_agent_start");
  await f.emit("agent_start"); // attaching after abort must not miss cancellation
  await f.settle();
  assert.equal((await jobs(other))[0].closed, true);
});

test("unsafe process cleanup remains visible and does not prevent other panes closing", async (t) => {
  const f = await fixture(t);
  const unsafe = await f.add(1);
  await f.add(2);
  await atomic(join(f.scope.root, unsafe.id, "done.json"), { state: "failed", report: "", cleanupError: "cannot reap" }, true);
  f.controller.abort();
  await f.settle();
  const all = await jobs(f.scope);
  assert.equal(all[0].closed, undefined);
  assert.equal(all[1].closed, true);
  assert.match(f.notices[0][0], /cannot reap.*pane retained/);
  assert.equal(f.notices[0][1], "warning");
});

test("busy old settlement cannot detach a new run; extension-triggered runs reset cancellation", async (t) => {
  const f = await fixture(t);
  await f.add(1);
  f.controller.abort();
  await f.settle();
  f.setIdle(false);
  f.ctx.signal = new AbortController().signal;
  const next = new AbortController();
  f.ctx.signal = next.signal;
  await f.emit("agent_start"); // sendMessage(triggerTurn) skips before_agent_start
  await f.add(2);
  await f.emit("agent_settled"); // stale settlement delivered while the next run is busy
  next.abort();
  await f.settle();
  assert.ok((await jobs(f.scope)).every((job) => job.closed));
});

test("retry Stop observes configured keys only; resumed retries clear unconsumed Stop intent", async (t) => {
  const f = await fixture(t);
  await f.add(1);
  await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
  f.ctx.signal = undefined;
  f.input("\u001b"); // Escape is NOT the configured interrupt in this fixture.
  await f.settle();
  assert.equal((await jobs(f.scope))[0].closed, undefined);
  f.setIdle(false);
  assert.equal(f.input("\u0019"), undefined);
  // If another UI consumes the key and retry proceeds, do not cancel the retry.
  f.ctx.signal = new AbortController().signal;
  await f.emit("agent_start");
  await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
  await f.settle();
  assert.equal((await jobs(f.scope))[0].closed, undefined);
  f.setIdle(false);
  f.ctx.signal = undefined;
  f.input("\u0019");
  await f.settle();
  assert.equal((await jobs(f.scope))[0].closed, true);
});

for (const phase of ["generation", "tool", "retry-delay", "retry-reload"]) test(`real Pi runtime Stop during ${phase} cancels workers without context injection`, { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const directory = process.env.PI_CODING_AGENT_DIR;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: phase.startsWith("retry"), baseDelayMs: 30000, maxRetries: 2 } });
  const entered = Promise.withResolvers();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only-not-a-real-key");
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Test system prompt",
    extensionFactories: [extension, (pi) => {
      pi.registerTool({ name: "wait_for_stop", description: "Test tool", parameters: Type.Object({}),
        async execute(_id, _params, signal) {
          entered.resolve();
          if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return { content: [{ type: "text", text: "Stopped" }] };
        },
      });
    }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader, settingsManager, modelRuntime, model, sessionManager: SessionManager.inMemory(directory) });
  const errors = [];
  let terminalInput;
  await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, onTerminalInput: (handler) => { terminalInput = handler; return () => { terminalInput = undefined; }; } }, onError: (error) => errors.push(error) });
  t.after(() => session.dispose());
  const scope = scopeFor(session.sessionManager.getSessionId());
  const job = await f.add(1, false, scope);
  const reply = (stopReason) => ({
    role: "assistant", content: stopReason === "toolUse" ? [{ type: "toolCall", id: "wait", name: "wait_for_stop", arguments: {} }] : [],
    api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(), ...(stopReason === "error" ? { errorMessage: "429 rate limit" } : {}),
  });
  let requests = 0;
  session.agent.streamFunction = (_model, context, options) => {
    if (++requests > 2) throw new Error(`Unexpected repeat request: ${JSON.stringify(session.messages)}`);
    assert.equal(context.systemPrompt, `Test system prompt\nCurrent working directory: ${directory}\n`);
    const stream = createAssistantMessageEventStream();
    const end = (reason) => {
      const message = reply(reason);
      stream.push(reason === "error" || reason === "aborted" ? { type: "error", reason, error: message } : { type: "done", reason, message });
      stream.end(message);
    };
    if (phase === "generation") {
      entered.resolve();
      options.signal.addEventListener("abort", () => end("aborted"), { once: true });
    } else queueMicrotask(() => end(phase === "tool" ? "toolUse" : "error"));
    return stream;
  };
  session.subscribe((event) => { if (event.type === "auto_retry_start") entered.resolve(); });
  const running = session.prompt("Run test");
  await Promise.race([entered.promise, running.then(() => { throw new Error(`Run ended before entering ${phase}: ${JSON.stringify(session.messages)}; ${JSON.stringify(errors)}`); })]);
  if (phase.startsWith("retry")) {
    for (let i = 0; i < 100 && !session.isRetrying; i++) await delay(10);
    assert.equal(session.isRetrying, true);
    assert.equal(session.agent.signal, undefined, "Retry-delay coverage must not rely on a live agent signal");
    if (phase === "retry-reload") {
      await session.reload();
      assert.equal(session.isRetrying, true);
      assert.equal((await jobs(scope))[0].closed, undefined, "Reload itself must preserve the worker");
    }
    assert.equal(terminalInput("\u0019"), undefined, "Observe configured Stop without consuming it");
  }
  await session.abort();
  await running;
  assert.equal((await jobs(scope)).find((entry) => entry.id === job.id).closed, true);
  assert.deepEqual(errors, []);
  assert.ok(session.messages.every((message) => message.role !== "custom"));
});
