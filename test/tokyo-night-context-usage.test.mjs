import assert from "node:assert/strict";
import test from "node:test";
import { estimateLoadedContextTokens } from "../extensions/tokyo-night-footer/context-usage.ts";

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
