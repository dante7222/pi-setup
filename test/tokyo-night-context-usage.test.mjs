import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateContextWithMessage,
  estimateLoadedContextTokens,
  estimateRequestContextTokens,
  estimateStreamingContextTokens,
  usageTokenTotal,
} from "../extensions/tokyo-night-footer/context-usage.ts";

const zeroCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};

function assistantMessage(model, totalTokens, text = "12345678") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model,
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: zeroCost,
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

test("estimates the loaded system prompt and active tool schemas before the first message", () => {
  const systemPrompt = "system prompt with AGENTS.md and local agent instructions";
  const tools = [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "write",
      description: "Write a file",
      parameters: { type: "object", properties: { content: { type: "string" } } },
    },
  ];
  const serializedReadTool = JSON.stringify([tools[0]]);

  assert.equal(
    estimateLoadedContextTokens(systemPrompt, tools, ["read"]),
    Math.ceil(systemPrompt.length / 4) + Math.ceil(serializedReadTool.length / 4),
  );
});

test("does not count inactive tools", () => {
  assert.equal(
    estimateLoadedContextTokens("1234", [
      { name: "agent", description: "Large local agent definition", parameters: {} },
    ], []),
    1,
  );
});

test("counts cache buckets once when native totals are unavailable", () => {
  assert.equal(
    usageTokenTotal({
      input: 100,
      output: 20,
      cacheRead: 300,
      cacheWrite: 40,
      totalTokens: 0,
      cost: zeroCost,
    }),
    460,
  );
});

test("includes loaded context when no authoritative provider usage exists", () => {
  assert.deepEqual(
    estimateRequestContextTokens(
      [{ role: "user", content: "12345678", timestamp: 1 }],
      10,
      { provider: "test", id: "current" },
      undefined,
    ),
    { tokens: 12, estimated: true },
  );
});

test("combines current-model usage with trailing messages and loaded-context changes", () => {
  const assistant = assistantMessage("current", 1_000);

  assert.deepEqual(
    estimateRequestContextTokens(
      [assistant],
      100,
      { provider: "test", id: "current" },
      100,
    ),
    { tokens: 1_000, estimated: true },
  );
  assert.deepEqual(
    estimateRequestContextTokens(
      [assistant, { role: "user", content: "12345678", timestamp: 2 }],
      110,
      { provider: "test", id: "current" },
      100,
    ),
    { tokens: 1_012, estimated: true },
  );
});

test("does not reuse an old model's tokenization against a new context window", () => {
  assert.deepEqual(
    estimateRequestContextTokens(
      [assistantMessage("old", 50_000)],
      10,
      { provider: "test", id: "new" },
      undefined,
    ),
    { tokens: 12, estimated: true },
  );
});

test("progresses locally while streaming usage is unavailable", () => {
  assert.deepEqual(
    estimateStreamingContextTokens(
      { tokens: 1_000, estimated: true },
      4_000,
    ),
    { tokens: 2_000, estimated: true },
  );
});

test("partial input usage never freezes streaming growth or claims final precision", () => {
  const usage = { ...assistantMessage("current", 1_000).usage, output: 1 };
  const request = { tokens: 900, estimated: true };
  assert.deepEqual(estimateStreamingContextTokens(request, 4_000, usage), {
    tokens: 2_000, estimated: true,
  });
  assert.deepEqual(estimateStreamingContextTokens(request, 8_000, usage), {
    tokens: 3_000, estimated: true,
  });
});

test("output-only usage keeps estimated request input and includes hidden reasoning", () => {
  const usage = { ...assistantMessage("current", 0).usage, output: 8_000, reasoning: 7_900, totalTokens: 8_000 };
  assert.deepEqual(estimateStreamingContextTokens({ tokens: 500, estimated: true }, 400, usage), {
    tokens: 8_500, estimated: true,
  });
  assert.deepEqual(estimateRequestContextTokens(
    [{ ...assistantMessage("current", 0), usage }], 10,
    { provider: "test", id: "current" }, 10,
  ), { tokens: 12, estimated: true });
});

test("native totals and normalized buckets count reasoning and caches only once", () => {
  const usage = {
    input: 100, output: 200, reasoning: 150, cacheRead: 300,
    cacheWrite: 400, cacheWrite1h: 350, totalTokens: 1_000, cost: zeroCost,
  };
  assert.equal(usageTokenTotal(usage), 1_000);
  assert.equal(usageTokenTotal({ ...usage, totalTokens: 0 }), 1_000);
  assert.equal(usageTokenTotal({ ...usage, totalTokens: 1_200 }), 1_200);
  assert.equal(usageTokenTotal({ ...usage, totalTokens: 100 }), 1_000);
  assert.equal(usageTokenTotal({ ...usage, input: NaN, cacheRead: -1, cacheWrite: Infinity, totalTokens: NaN }), 200);
});

test("retained pre-compaction assistant usage is never an anchor", () => {
  const summary = { role: "compactionSummary", summary: "12345678", timestamp: 100, tokensBefore: 50_000 };
  const retained = assistantMessage("current", 50_000);
  assert.deepEqual(estimateRequestContextTokens(
    [summary, retained], 10, { provider: "test", id: "current" }, undefined,
  ), { tokens: 14, estimated: true });
  const fresh = { ...assistantMessage("current", 200), timestamp: 101 };
  assert.deepEqual(estimateRequestContextTokens(
    [summary, retained, fresh], 10, { provider: "test", id: "current" }, 10,
  ), { tokens: 200, estimated: true });
});

test("failed, pending and deferred messages are not authoritative anchors", () => {
  for (const stopReason of ["error", "aborted", "pending", "deferred"]) {
    const message = { ...assistantMessage("current", 50_000), stopReason };
    assert.deepEqual(estimateRequestContextTokens(
      [message], 10, { provider: "test", id: "current" }, 10,
    ), { tokens: 12, estimated: true });
  }
});

test("excluded shell output and nested tool usage do not inflate main context", () => {
  const context = { tokens: 100, estimated: false };
  const shell = { role: "bashExecution", command: "echo hi", output: "x".repeat(40_000), excludeFromContext: true, timestamp: 1 };
  assert.equal(estimateContextWithMessage(context, shell), context);
  const result = { role: "toolResult", content: [{ type: "text", text: "12345678" }], usage: assistantMessage("current", 80_000).usage };
  assert.deepEqual(estimateContextWithMessage(context, result), { tokens: 102, estimated: true });
});

test("loaded context detects active-tool changes and in-place schema mutations", () => {
  const parameters = { type: "object", properties: { path: { type: "string" } } };
  const tool = { name: "read", description: "Read", parameters };
  const initial = estimateLoadedContextTokens("system", [tool], ["read"]);
  assert.equal(estimateLoadedContextTokens("system", [tool], []), 2);
  parameters.properties.path.description = "x".repeat(40_000);
  assert.equal(estimateLoadedContextTokens("system", [tool], ["read"]),
    2 + Math.ceil(JSON.stringify([tool]).length / 4));
  assert.ok(estimateLoadedContextTokens("system", [tool], ["read"]) > initial + 10_000);
});
