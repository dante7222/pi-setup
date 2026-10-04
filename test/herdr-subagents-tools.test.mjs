import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { Type } from "typebox";
import { Check } from "typebox/value";
import * as core from "../extensions/herdr-subagents/core.ts";
import * as reports from "../extensions/herdr-subagents/reports.ts";
import * as conversations from "../extensions/herdr-subagents/conversations.ts";
import * as groups from "../extensions/herdr-subagents/groups.ts";
import * as presentation from "../extensions/herdr-subagents/presentation.ts";
import * as scheduler from "../extensions/herdr-subagents/scheduler.ts";
import * as recovery from "../extensions/herdr-subagents/recovery.ts";
import * as policy from "../extensions/herdr-subagents/policy.ts";
import * as workflow from "../extensions/herdr-subagents/workflow.ts";
import * as outputSchema from "../extensions/herdr-subagents/output-schema.ts";
import * as inputSchema from "../extensions/herdr-subagents/input-schema.ts";
import * as discovery from "../extensions/herdr-subagents/discovery.ts";
import { setTimeout as delay } from "node:timers/promises";

// Load the actual facade with narrowly replaceable module dependencies. This
// avoids Herdr/process launches without adding test injection to production APIs.
const source = await readFile(new URL("../extensions/herdr-subagents/tools.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function tool(coreOverrides = {}, reportOverrides = {}, workflowOverrides = {}) {
  const modules = {
    typebox: { Type },
    "typebox/value": { Check },
    "./core.ts": { ...core, ...coreOverrides },
    "./reports.ts": { ...reports, ...reportOverrides },
    "./ownership.ts": { claimScope: async () => {} },
    "./conversations.ts": conversations,
    "./groups.ts": groups,
    "./presentation.ts": presentation,
    "./scheduler.ts": scheduler,
    "./recovery.ts": recovery,
    "./policy.ts": policy,
    "./workflow.ts": { ...workflow, ...workflowOverrides },
    "./output-schema.ts": outputSchema,
    "./input-schema.ts": inputSchema,
    "./discovery.ts": discovery,
  };
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected runtime import: ${name}`);
    return modules[name];
  }, exports);
  const registered = [];
  exports.registerSubagentTools({ registerTool: (definition) => registered.push(definition) });
  assert.equal(registered.length, 1);
  return registered[0];
}
const ctx = {
  sessionManager: { getSessionId: () => "current-session", getEntries: () => [] },
  model: { provider: "current-provider", id: "current-model" },
  thinkingLevel: "high",
  cwd: process.cwd(),
};
function execute(definition, params, context = ctx, signal) {
  return definition.execute("tool-call", params, signal, undefined, context);
}
function envelope(definition, output, action, ok = true) {
  assert.equal(output.structuredContent.ok, ok);
  assert.equal(output.structuredContent.action, action);
  assert.equal(Check(definition.outputSchema, output.structuredContent), true);
  assert.deepEqual(JSON.parse(output.content[0].text), output.structuredContent);
  assert.equal(Object.hasOwn(output, "usage"), false, "Worker usage must not charge parent totals again");
  if (!ok) assert.equal(output.isError, true);
  return output.structuredContent;
}
async function fixture(t, text = "Final report") {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scope = core.scopeFor("current-session", {
    PI_CODING_AGENT_DIR: directory, HERDR_ENV: "1", HERDR_SOCKET_PATH: "test.sock",
    HERDR_PANE_ID: "main", HERDR_WORKSPACE_ID: "test", HERDR_BIN_PATH: "/nonexistent-herdr",
  });
  const job = {
    id: "abcdef123456", task: core.validateTasks([{ name: "report", prompt: "test" }], {}, directory)[0],
    cursor: 0, created: 1,
  };
  await mkdir(join(scope.root, job.id), { recursive: true });
  await core.save(scope, job);
  await core.atomic(join(scope.root, job.id, "done.json"), {
    state: "done", report: text,
    usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } },
  });
  return { scope, job };
}

test("registers one deferred namespaced tool with provider-compatible object-root parameters", () => {
  const definition = tool();
  assert.equal(definition.name, "subagents");
  assert.equal(definition.exposure, "deferred");
  assert.equal(definition.namespace.name, "subagents");
  assert.match(definition.namespace.instructions, /Check result\.ok/);
  assert.ok(definition.description.length < 200);
  assert.ok(!definition.promptSnippet && !definition.promptGuidelines);
  assert.equal(definition.parameters.type, "object");
  assert.deepEqual(definition.parameters.required, ["action"]);
  assert.deepEqual(definition.parameters.properties.action.anyOf.map((branch) => branch.const), [
    "prepare", "spawn", "request_status", "status", "wait", "next", "read", "read_many", "ack", "cancel", "close", "continue", "send", "stop", "recover", "reattach", "configure", "help",
  ]);
  const valid = [
    { action: "prepare", tasks: [{ name: "one", prompt: "Review" }] },
    { action: "spawn", requestId: "prepared-id" },
    { action: "spawn", tasks: [{ name: "one", prompt: "Review" }], requestId: "stable-id" },
    { action: "status" }, { action: "status", offset: 16 }, { action: "wait" },
    { action: "wait", seconds: 0 }, { action: "wait", seconds: 60, details: true },
    { action: "next" }, { action: "next", acknowledge: [], seconds: 0, details: true },
    { action: "next", acknowledge: [`abcdef123456.${"0".repeat(64)}`] },
    { action: "read_many", ids: ["abcdef123456"] },
    { action: "read", id: "abcdef123456", offset: 0 },
    { action: "ack", receipt: "opaque" }, { action: "cancel", ids: "all" },
    { action: "cancel", ids: ["abcdef123456"] }, { action: "close" },
  ];
  for (const value of valid) assert.equal(Check(definition.parameters, value), true, JSON.stringify(value));
  const invalid = [
    { action: "spawn", tasks: [{ name: "one", prompt: "Review" }], requestId: " " },
    { action: "spawn", tasks: [], requestId: "id" }, { action: "wait", seconds: 61 },
    { action: "wait", seconds: -1 }, { action: "read", id: "../escape" },
    { action: "status", offset: 0.5 }, { action: "status", offset: -1 },
    { action: "cancel", ids: [] }, { action: "collect" },
    { action: "wait", details: "true" }, { action: "read_many", ids: [] },
    { action: "read_many", ids: ["abcdef123456", "abcdef123456"] },
    { action: "next", acknowledge: ["forged"] }, { action: "next", acknowledge: "all" },
    { action: "next", acknowledge: Array(17).fill(`abcdef123456.${"0".repeat(64)}`) },
  ];
  for (const value of invalid) assert.equal(Check(definition.parameters, value), false, JSON.stringify(value));
});

test("narrow help needs no session or Herdr authority and validates selection before effects", async () => {
  const definition = tool({ scopeFor() { assert.fail("Help must not create/claim a scope"); } });
  const context = { sessionManager: { getSessionId() { assert.fail("Help must not read session state"); } } };
  const value = envelope(definition, await execute(definition, { action: "help", actions: ["spawn", "next"] }, context), "help");
  assert.deepEqual(value.data, discovery.actionHelp(["spawn", "next"]));
  for (const actions of [[], ["unknown"], ["spawn", "spawn"], ["spawn", "next", "status", "wait"], "spawn"]) {
    envelope(definition, await execute(definition, { action: "help", actions }, context), "help", false);
  }
  envelope(definition, await execute(definition, { action: "help", actions: ["spawn"] }, context, AbortSignal.abort()), "help", false);
});

test("spawn derives session/model/thinking/cwd from each live context, preserving explicit overrides", async (t) => {
  const previous = { PI_PROVIDER: process.env.PI_PROVIDER, PI_MODEL: process.env.PI_MODEL, PI_REASONING_LEVEL: process.env.PI_REASONING_LEVEL };
  Object.assign(process.env, { PI_PROVIDER: "stale", PI_MODEL: "stale-model", PI_REASONING_LEVEL: "low" });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const captured = [];
  const scope = { root: "test-scope" };
  const definition = tool({
    scopeFor(session) { assert.equal(session, "current-session"); return scope; },
    async spawnTasks(actualScope, plan, requestId) {
      assert.equal(actualScope, scope);
      const tasks = await plan.resolve(plan.intent);
      captured.push({ tasks, requestId });
      return tasks.map((task, i) => ({ id: String(i).padStart(12, "0"), task }));
    },
  });
  const current = { ...ctx, cwd: tmpdir() };
  const output = await execute(definition, {
    action: "spawn", requestId: "stable-retry", tasks: [
      { name: "inherit", prompt: "Review", cwd: "relative", extensions: ["extra.ts"] },
      { name: "override", prompt: "Explore", model: "other/model", thinking: "off" },
      { name: "model-only", prompt: "Explore", model: "other/model:low" },
    ],
  }, current);
  const data = envelope(definition, output, "spawn").data;
  assert.equal(data.jobs.length, 3);
  assert.equal(captured[0].requestId, "stable-retry");
  assert.equal(captured[0].tasks[0].model, "current-provider/current-model");
  assert.equal(captured[0].tasks[0].thinking, "high");
  assert.equal(captured[0].tasks[0].cwd, join(tmpdir(), "relative"));
  assert.deepEqual(captured[0].tasks[0].extensions, [join(tmpdir(), "extra.ts")]);
  assert.equal(captured[0].tasks[1].model, "other/model");
  assert.equal(captured[0].tasks[1].thinking, "off");
  assert.equal(captured[0].tasks[2].thinking, undefined);
  await execute(definition, { action: "spawn", requestId: "new-id", tasks: [{ name: "unset", prompt: "test" }] }, {
    ...current, model: undefined, thinkingLevel: undefined,
  });
  assert.equal(captured[1].tasks[0].model, undefined);
  assert.equal(captured[1].tasks[0].thinking, undefined);
});

for (const prepared of [false, true]) test(`${prepared ? "prepared" : "explicit"} spawn retries preserve first-admission context and presets`, async (t) => {
  const { scope } = await fixture(t);
  const backend = join(scope.root, "fake-herdr.mjs");
  await writeFile(backend, `#!${process.execPath}
const action=process.argv[3];
const pane={pane_id:'worker',terminal_id:'terminal'};
const result=action==='list'?{panes:[]} : action==='layout'?{layout:{panes:[{pane_id:'main',rect:{width:100,height:40}}]}} : {pane:action==='current'?{pane_id:'main'}:pane};
if(action!=='run')console.log(JSON.stringify({result}));
`);
  await chmod(backend, 0o700);
  Object.assign(scope.env, { HERDR_BIN_PATH: backend, PI_HERDR_PI_BIN: process.execPath });
  const definition = tool({ scopeFor: () => scope });
  const context = { ...ctx, cwd: scope.root };
  const intent = [
    { name: "inherit", prompt: "inspect", cwd: "." },
    { name: "preset", prompt: "inspect", preset: "review" },
  ];
  const preparationContext = {
    sessionManager: { getSessionId: () => "current-session", getEntries() { assert.fail("Preparation must not resolve group"); } },
    get model() { assert.fail("Preparation must not resolve model"); },
    get thinkingLevel() { assert.fail("Preparation must not resolve thinking"); },
    get cwd() { assert.fail("Preparation must not resolve cwd"); },
  };
  const operation = prepared ? envelope(definition, await execute(definition, { action: "prepare", tasks: intent }, preparationContext), "prepare").data : undefined;
  if (prepared) assert.equal(envelope(definition, await execute(definition, { action: "request_status", requestId: operation.requestId }), "request_status").data.admissionState, "prepared");
  await policy.configurePresets(scope, { review: { model: "preset/first", thinking: "low", maxTokens: 1000 } });
  const request = prepared ? { action: "spawn", requestId: operation.requestId } : { action: "spawn", requestId: "intent", tasks: intent };
  const first = envelope(definition, await execute(definition, request, context), "spawn").data;
  const snapshot = await core.jobs(scope);
  assert.equal(snapshot.find((job) => job.task.name === "inherit").task.model, "current-provider/current-model");
  assert.equal(snapshot.find((job) => job.task.name === "preset").task.model, "preset/first");
  for (const presets of [{ review: { model: "preset/changed", thinking: "max" } }, {}]) {
    await policy.configurePresets(scope, presets);
    const changed = { ...context, model: { provider: "changed", id: "changed" }, thinkingLevel: "off", cwd: "/missing/retry-cwd",
      sessionManager: { ...ctx.sessionManager, getEntries() { throw new Error("Retry must not resolve group"); } } };
    assert.deepEqual(envelope(definition, await execute(definition, request, changed), "spawn").data, first);
    assert.deepEqual(envelope(definition, await execute(definition, request, { ...changed, model: undefined }), "spawn").data, first);
  }
  const record = JSON.parse(await readFile(join(scope.root, "requests", (await readdir(join(scope.root, "requests")))[0]), "utf8"));
  assert.deepEqual(record.intent, intent);
  assert.deepEqual(record.tasks, first.jobs.map(({ id }) => snapshot.find((job) => job.id === id).task));
  for (const change of [{ model: "explicit/model" }, { thinking: "high" }, { cwd: scope.root }, { group: "none" }, { prompt: "changed" }, { preset: "deleted" }]) {
    const changed = { ...request, tasks: [{ ...intent[0], ...change }, intent[1]] };
    const failure = envelope(definition, await execute(definition, changed, context), "spawn", false);
    assert.match(failure.error, /different tasks/);
    assert.equal(failure.code, "REQUEST_ID_CONFLICT");
    assert.deepEqual(failure.inspection, { action: "request_status", requestId: request.requestId });
    const inspected = envelope(definition, await execute(definition, failure.inspection, context), "request_status").data;
    assert.deepEqual(failure.diagnostic, inspected);
    assert.equal(inspected.admissionState, "done");
    assert.deepEqual(inspected.jobs.map(({ id }) => id), first.jobs.map(({ id }) => id));
    assert.ok(!JSON.stringify(failure).includes("preset/first"));
  }
  assert.deepEqual(await core.jobs(scope), snapshot);
});

test("execution failures are structured errors; missing context never falls back to process session", async () => {
  const definition = tool({
    scopeFor: () => ({}),
    status: async () => { throw new Error("offline"); },
  });
  const failed = envelope(definition, await execute(definition, { action: "status" }), "status", false);
  assert.equal(failed.error, "offline");
  const invalid = envelope(definition, await execute(definition, { action: "wait", seconds: 61 }), "wait", false);
  assert.match(invalid.error, /Invalid/);
  for (const params of [{ action: "spawn", tasks: [{ name: "one", prompt: "test" }] }, { action: "cancel" }, { action: "close", receipt: "extra" }, { action: "read_many", ids: "all" }, { action: "read_many" }, { action: "read", id: "abcdef123456", details: true }]) {
    envelope(definition, await execute(definition, params), params.action, false);
  }
  const missing = envelope(definition, await execute(definition, { action: "status" }, {
    ...ctx, sessionManager: { getSessionId: () => undefined },
  }), "status", false);
  assert.match(missing.error, /session ID/);
});

test("aborting wait passes its signal through and never cancels workers", async () => {
  const controller = new AbortController();
  let called = 0;
  const definition = tool({
    scopeFor: () => ({}),
    cleanup: () => assert.fail("Abort must not clean up workers"),
    closeJobs: () => assert.fail("Abort must not cancel workers"),
  }, {
    waitForReports: (_scope, seconds, signal) => {
      called++;
      assert.equal(seconds, 30);
      assert.equal(signal, controller.signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Wait aborted")), { once: true });
      });
    },
  });
  const pending = execute(definition, { action: "wait" }, ctx, controller.signal);
  await delay(0);
  controller.abort();
  const failed = envelope(definition, await pending, "wait", false);
  assert.match(failed.error, /aborted/);
  assert.equal(called, 1);
});

test("read/ack use temporary durable reports: reads replay, acknowledgements retry, usage stays metadata", async (t) => {
  const { scope, job } = await fixture(t);
  const definition = tool({ scopeFor: () => scope });
  const first = envelope(definition, await execute(definition, { action: "read", id: job.id }), "read").data;
  assert.equal(typeof first.receipt, "string");
  assert.equal(first.text, "Final report");
  assert.equal((await core.jobs(scope))[0].cursor, 0);
  assert.ok(!(await core.jobs(scope))[0].collected);
  const replay = envelope(definition, await execute(definition, { action: "read", id: job.id, offset: 0 }), "read").data;
  assert.deepEqual(replay, first);
  envelope(definition, await execute(definition, { action: "ack", receipt: first.receipt }), "ack");
  assert.equal((await core.jobs(scope))[0].collected, true);
  envelope(definition, await execute(definition, { action: "ack", receipt: first.receipt }), "ack");
  const afterAck = envelope(definition, await execute(definition, { action: "read", id: job.id, offset: 0 }), "read").data;
  assert.deepEqual(afterAck, first);
  envelope(definition, await execute(definition, { action: "ack", receipt: "forged" }), "ack", false);
});

test("batch reads keep per-job errors and receipts separate; wait details and cancellation reach report operations", async (t) => {
  const { scope, job } = await fixture(t);
  const definition = tool({ scopeFor: () => scope });
  const output = envelope(definition, await execute(definition, { action: "read_many", ids: [job.id, "000000000000"] }), "read_many").data;
  assert.equal(output.reports[0].text, "Final report");
  assert.match(output.errors[0].error, /Unknown/);
  assert.equal((await core.jobs(scope))[0].cursor, 0);
  envelope(definition, await execute(definition, { action: "ack", receipt: output.reports[0].receipt }), "ack");
  const wait = envelope(definition, await execute(definition, { action: "wait", seconds: 0, details: true }), "wait").data;
  assert.deepEqual(wait, { ready: [], pending: 0, pendingWorkers: [] });
  const controller = new AbortController();
  let calls = 0;
  const forward = tool({ scopeFor: () => scope }, {
    waitForReports: async (value, seconds, signal, details) => {
      assert.equal(value, scope); assert.equal(seconds, 1);
      assert.equal(signal, controller.signal); assert.equal(details, true); calls++; return { ready: [], pending: 0 };
    },
    readManyReports: async (value, ids, signal) => {
      assert.equal(value, scope); assert.deepEqual(ids, [job.id]); assert.equal(signal, controller.signal); calls++; return { reports: [], errors: [] };
    },
  });
  envelope(forward, await execute(forward, { action: "wait", seconds: 1, details: true }, ctx, controller.signal), "wait");
  envelope(forward, await execute(forward, { action: "read_many", ids: [job.id] }, ctx, controller.signal), "read_many");
  controller.abort();
  envelope(forward, await execute(forward, { action: "read_many", ids: [job.id] }, ctx, controller.signal), "read_many", false);
  assert.equal(calls, 2);
});

test("status/cancel/close dispatch scoped operations and validate cancellation IDs before mutation", async () => {
  const job = { id: "abcdef123456", task: { name: "one" } };
  const scope = { root: "fixture" };
  const calls = [];
  const definition = tool({
    scopeFor: () => scope,
    status: async (value, offset) => { assert.equal(value, scope); return { jobs: [], next: offset + 16 }; },
    locked: async (value, run) => { assert.equal(value, scope); return run(); },
    jobs: async () => [job],
    closeJobs: async (value, selected, cancel) => {
      assert.equal(value, scope); assert.deepEqual(selected, [job]); assert.equal(cancel, true);
      calls.push("selected"); return ["one"];
    },
    cleanup: async (value, cancel) => { assert.equal(value, scope); calls.push(cancel ? "all" : "collected"); return []; },
  });
  assert.equal(envelope(definition, await execute(definition, { action: "status", offset: 16 }), "status").data.next, 32);
  envelope(definition, await execute(definition, { action: "cancel", ids: ["000000000000", job.id] }), "cancel", false);
  assert.deepEqual(calls, []);
  envelope(definition, await execute(definition, { action: "cancel", ids: [job.id] }), "cancel");
  envelope(definition, await execute(definition, { action: "cancel", ids: "all" }), "cancel");
  envelope(definition, await execute(definition, { action: "close" }), "close");
  assert.deepEqual(calls, ["selected", "all", "collected"]);
});

test("next dispatches one real cycle without acknowledging its newly returned pages", async (t) => {
  const { scope, job } = await fixture(t);
  const definition = tool({ scopeFor: () => scope });
  const first = envelope(definition, await execute(definition, { action: "next", seconds: 0 }), "next").data;
  assert.equal(first.reports[0].text, "Final report");
  assert.deepEqual(first.errors, []);
  assert.equal(first.pending, 0);
  assert.equal((await core.jobs(scope))[0].cursor, 0);
  assert.notEqual((await core.jobs(scope))[0].closed, true);
  const last = envelope(definition, await execute(definition, {
    action: "next", acknowledge: [first.reports[0].receipt], seconds: 0,
  }), "next").data;
  assert.deepEqual(last, { reports: [], errors: [], pending: 0, acknowledgementRequired: false, finished: true, closed: [job.task.name] });
  assert.equal((await core.jobs(scope))[0].collected, true);
  assert.equal((await core.jobs(scope))[0].closed, true);
});

test("next validates action-specific inputs, forwards defaults/signals, and bounds fatal errors", async () => {
  const scope = {};
  const controller = new AbortController();
  let calls = 0;
  const definition = tool({ scopeFor: () => scope }, {}, {
    nextReports: async (value, receipts, seconds, signal, details) => {
      assert.equal(value, scope); assert.deepEqual(receipts, []); assert.equal(seconds, 30);
      assert.equal(signal, controller.signal); assert.equal(details, true); calls++;
      throw Error("\\u0000😀".repeat(10000));
    },
  });
  const failed = envelope(definition, await execute(definition, { action: "next", details: true }, ctx, controller.signal), "next", false);
  assert.ok(Buffer.byteLength(JSON.stringify(failed)) < core.PAGE_BYTES);
  assert.ok(failed.error.endsWith("..."));
  for (const input of [
    { action: "next", ids: ["abcdef123456"] }, { action: "next", receipt: "opaque" },
    { action: "wait", acknowledge: [] }, { action: "next", seconds: 61 },
  ]) envelope(definition, await execute(definition, input), input.action, false);
  controller.abort();
  envelope(definition, await execute(definition, { action: "next" }, ctx, controller.signal), "next", false);
  assert.equal(calls, 1);
});

for (const action of ["close", "cancel-all", "cancel-selected"]) test(`queued native ${action} honors cancellation before admission`, async (t) => {
  const { scope, job } = await fixture(t);
  job.collected = true;
  job.cursor = "Final report".length;
  job.launched = true;
  await core.save(scope, job);
  const before = await core.jobs(scope);
  const definition = tool({ scopeFor: () => scope });
  const controller = new AbortController();
  const input = action === "close" ? { action } : { action: "cancel", ids: action === "cancel-all" ? "all" : [job.id] };
  let pending;
  await core.locked(scope, async () => {
    pending = execute(definition, input, ctx, controller.signal);
    const deadline = Date.now() + 3000;
    while ((await readdir(join(scope.root, "locks"))).length < 2) {
      assert.ok(Date.now() < deadline, "native action never queued");
      await delay(10);
    }
    controller.abort(new Error("queued native abort"));
    const failed = await Promise.race([
      pending,
      delay(3000).then(() => { throw Error("queued native action ignored abort"); }),
    ]);
    assert.match(envelope(definition, failed, input.action, false).error, /abort/i);
    assert.deepEqual(await core.jobs(scope), before);
  });
  await pending;
  await core.locked(scope, async () => {}, AbortSignal.timeout(3000));
  assert.deepEqual(await core.jobs(scope), before, "cancelled contender must not mutate after the lock is released");
  assert.equal(await core.json(join(scope.root, job.id, "cancel.json")), undefined);
});

test("request inspection forwards cancellation and diagnostic failures preserve bounded metadata", async () => {
  const scope = { root: "fixture" };
  const controller = new AbortController();
  const diagnostic = { requestId: "historical", scope: "abc", found: true, admissionState: "done",
    jobs: Array.from({ length: 16 }, (_, i) => ({ id: i.toString(16).padStart(12, "0"), name: "review", closed: true, collected: true, artifactMissing: false })) };
  const definition = tool({
    scopeFor: () => scope,
    requestStatus: async (value, requestId, signal) => {
      assert.equal(value, scope); assert.equal(requestId, "historical"); assert.equal(signal, controller.signal);
      return diagnostic;
    },
    spawnTasks: async () => { throw new core.RequestDiagnosticError("REQUEST_ID_CONFLICT", "\\u0000😀".repeat(12000), diagnostic); },
  });
  assert.deepEqual(envelope(definition, await execute(definition, { action: "request_status", requestId: "historical" }, ctx, controller.signal), "request_status").data, diagnostic);
  const failure = envelope(definition, await execute(definition, { action: "spawn", requestId: "historical", tasks: [{ name: "new", prompt: "different" }] }), "spawn", false);
  assert.deepEqual(failure.diagnostic, diagnostic);
  assert.equal(failure.code, "REQUEST_ID_CONFLICT");
  assert.ok(Buffer.byteLength(JSON.stringify(failure)) <= core.PAGE_BYTES);
  assert.ok(failure.error.endsWith("..."));
  controller.abort();
  envelope(definition, await execute(definition, { action: "request_status", requestId: "historical" }, ctx, controller.signal), "request_status", false);
});

test("native prepare validates arguments and forwards scope, payload and cancellation without spawning", async () => {
  const scope = {};
  const controller = new AbortController();
  const tasks = [{ name: "one", prompt: "test", preset: "not-yet-configured" }];
  let calls = 0;
  const definition = tool({
    scopeFor: () => scope,
    prepareTasks: async (value, input, signal) => {
      assert.equal(value, scope); assert.deepEqual(input, tasks); assert.equal(signal, controller.signal);
      calls++; return { requestId: "generated" };
    },
    spawnTasks() { assert.fail("Preparation cannot spawn"); },
  });
  assert.deepEqual(envelope(definition, await execute(definition, { action: "prepare", tasks }, ctx, controller.signal), "prepare").data, { requestId: "generated" });
  for (const input of [{ action: "prepare" }, { action: "prepare", tasks, requestId: "forged" }, { action: "prepare", tasks: [] }]) envelope(definition, await execute(definition, input), "prepare", false);
  controller.abort();
  envelope(definition, await execute(definition, { action: "prepare", tasks }, ctx, controller.signal), "prepare", false);
  assert.equal(calls, 1);
});

test("native spawn forwards cancellation into lock admission and the launch batch", async () => {
  const controller = new AbortController();
  let called = 0;
  const definition = tool({
    scopeFor: () => ({}),
    spawnTasks: async (_scope, _tasks, _request, signal) => {
      assert.equal(signal, controller.signal); called++; return [];
    },
  });
  const params = { action: "spawn", requestId: "cancel-test", tasks: [{ name: "one", prompt: "test" }] };
  envelope(definition, await execute(definition, params, ctx, controller.signal), "spawn");
  controller.abort();
  envelope(definition, await execute(definition, params, ctx, controller.signal), "spawn", false);
  assert.equal(called, 1);
});
