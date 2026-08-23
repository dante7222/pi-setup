import assert from "node:assert/strict";
import test from "node:test";
import {
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
    { tokens: 1_000, estimated: false },
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
