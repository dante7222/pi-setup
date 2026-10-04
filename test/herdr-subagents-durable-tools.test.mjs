import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { Type } from "typebox";
import { Check } from "typebox/value";

const source = await readFile(new URL("../extensions/herdr-subagents/durable-tools.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(overrides = {}, claim = async () => {}) {
  const requests = [];
  const scope = { root: "/private/scope" };
  const modules = {
    typebox: { Type }, "typebox/value": { Check },
    "./core.ts": { scopeFor: () => scope },
    "./ownership.ts": { claimScope: claim },
    "./durable/transport.ts": {
      startDurable: async (actual, experimental) => { assert.equal(actual, scope); requests.push({ action: "start", experimental }); return { started: true }; },
      shutdownDurable: async () => { requests.push({ action: "shutdown" }); },
      durableRequest: async (actual, request) => { assert.equal(actual, scope); requests.push(request); return { id: "attempt" }; }, ...overrides,
    },
  };
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    assert.ok(Object.hasOwn(modules, name), name); return modules[name];
  }, exports);
  let tool;
  exports.registerDurableTools({ registerTool: (value) => { tool = value; } });
  const ctx = { sessionManager: { getSessionId: () => "parent" }, model: { provider: "current", id: "model" }, thinkingLevel: "high", cwd: "/work" };
  const run = async (params, signal, context = ctx) => {
    const result = await tool.execute("id", params, signal, undefined, context);
    assert.equal(Check(tool.outputSchema, result.structuredContent), true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.ok(!("usage" in result));
    return result.structuredContent;
  };
  return { requests, tool, run, ctx };
}

test("durable tool is separately deferred with object-root schema and explicit opt-in", async () => {
  const { tool, run, requests } = fixture();
  assert.equal(tool.name, "durable_subagents"); assert.equal(tool.exposure, "deferred");
  assert.equal(tool.namespace.name, "durable_subagents");
  assert.equal(tool.parameters.type, "object");
  assert.equal((await run({ action: "start" })).ok, false);
  assert.equal((await run({ action: "start", experimental: false })).ok, false);
  assert.deepEqual(requests, []);
  assert.equal((await run({ action: "start", experimental: true })).ok, true);
  assert.deepEqual(requests, [{ action: "start", experimental: true }]);
});

test("durable model and cwd defaults come from live context without leaking thinking overrides", async () => {
  const { run, requests } = fixture();
  await run({ action: "spawn", requestId: "first", name: "review", prompt: "Review" });
  assert.deepEqual(requests[0], { action: "spawn", requestId: "first", name: "review", prompt: "Review", defaults: { model: { provider: "current", modelId: "model" }, cwd: "/work", thinking: "high" } });
  await run({ action: "spawn", requestId: "other", name: "other", prompt: "Inspect", model: { provider: "other", modelId: "model" }, tools: "coding" });
  assert.equal(requests[1].thinking, undefined);
  assert.equal(requests[1].tools, "coding");
  assert.ok(!requests.some((request) => request.action === "start"), "Spawn must never implicitly opt in/start storage");
});

test("durable facade keeps explicit retry intent apart from changed or missing context", async () => {
  const { run, requests, ctx } = fixture();
  const request = { action: "spawn", requestId: "retry", name: "review", prompt: "Review", cwd: "relative" };
  for (const context of [ctx, { ...ctx, model: { provider: "other", id: "changed" }, thinkingLevel: "off", cwd: "/changed" }, { ...ctx, model: undefined, thinkingLevel: undefined }]) {
    assert.equal((await run(request, undefined, context)).ok, true);
    const { defaults, ...intent } = requests.at(-1);
    assert.deepEqual(intent, request);
    assert.equal(defaults.cwd, context.cwd);
    assert.equal(defaults.model?.modelId, context.model?.id);
  }
  assert.equal((await run({ ...request, defaults: { model: { provider: "forged", modelId: "forged" } } })).ok, false);
  assert.equal(requests.length, 3, "Private defaults are not public tool arguments");
});

test("durable controls preserve stable request IDs and validate action-specific fields", async () => {
  const { run, requests } = fixture();
  for (const action of [
    { action: "send", id: "child", requestId: "message-1", message: "literal", kind: "steer" },
    { action: "cancel", id: "all", requestId: "stop-1" },
    { action: "read", id: "attempt", offset: 0 }, { action: "ack", receipt: "receipt" },
    { action: "resume" }, { action: "wait", seconds: 0 }, { action: "shutdown" },
  ]) assert.equal((await run(action)).ok, true);
  assert.equal(requests.length, 7);
  for (const action of [
    { action: "cancel", id: "all" }, { action: "resume", id: "child" },
    { action: "wait", seconds: 61 }, { action: "read", id: "attempt", offset: -1 },
    { action: "spawn", requestId: "r", name: "BAD", prompt: "task" },
  ]) assert.equal((await run(action)).ok, false);
  assert.equal(requests.length, 7);
});

test("start and shutdown stop if cancellation arrives while ownership is being claimed", async () => {
  for (const action of [{ action: "start", experimental: true }, { action: "shutdown" }]) {
    const controller = new AbortController();
    const { run, requests } = fixture({}, async () => { controller.abort(); });
    assert.equal((await run(action, controller.signal)).ok, false);
    assert.deepEqual(requests, []);
  }
});

test("durable transport errors remain structured data and abort never sends work", async () => {
  const { run, requests } = fixture({ durableRequest: async () => { throw new Error("coordinator offline"); } });
  assert.deepEqual(await run({ action: "status" }), { ok: false, action: "status", error: "coordinator offline" });
  const abort = new AbortController(); abort.abort();
  assert.equal((await run({ action: "start", experimental: true }, abort.signal)).ok, false);
  assert.equal(requests.length, 0);
});
