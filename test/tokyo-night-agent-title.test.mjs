import assert from "node:assert/strict";
import test from "node:test";
import {
  firstUserPrompt,
  generateAgentTitle,
  normalizeAgentTitle,
  parseGeneratedAgentTitle,
} from "../extensions/tokyo-night-footer/agent-title.ts";

function messageEntry(id, role, content) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-09T00:00:00.000Z",
    message: { role, content, timestamp: 0 },
  };
}

test("normalizes explicit session names used by named agents and subagents", () => {
  assert.equal(normalizeAgentTitle(" Explore#a1b2c3d4 "), "Explore#a1b2c3d4");
});

test("extracts the submitted prompt without requiring an assistant response", () => {
  const prompt = messageEntry("user", "user", [
    { type: "text", text: "  Generate an AI footer title\n" },
    { type: "image", data: "ignored", mimeType: "image/png" },
  ]);

  assert.equal(firstUserPrompt([prompt]), "Generate an AI footer title");
});

test("parses only concise generated titles instead of displaying the prompt", () => {
  assert.equal(
    parseGeneratedAgentTitle("<title>Generate concise footer titles</title>"),
    "Generate concise footer titles",
  );
  assert.equal(
    parseGeneratedAgentTitle(
      "currently our footer does not show the current agent title and should do so after a response",
    ),
    undefined,
  );
  assert.equal(parseGeneratedAgentTitle("<title/>"), undefined);
});

test("starts title generation immediately with the active model", async () => {
  const calls = [];
  const registry = {
    async complete(model, context, options) {
      calls.push({ model, context, options });
      return {
        role: "assistant",
        content: [{ type: "text", text: "<title>Add AI-generated footer titles</title>" }],
        stopReason: "stop",
      };
    },
  };
  const model = {
    api: "openai-codex-responses",
    provider: "openai-codex",
    id: "gpt-5.6-sol",
  };

  const title = await generateAgentTitle(
    registry,
    model,
    "The footer should immediately generate a concise title from this prompt.",
    new AbortController().signal,
  );

  assert.equal(title, "Add AI-generated footer titles");
  assert.equal(calls.length, 1);
  assert.match(calls[0].context.systemPrompt, /3-7 word title/);
  assert.match(calls[0].context.messages[0].content[0].text, /<user>/);
  assert.doesNotMatch(calls[0].context.messages[0].content[0].text, /assistantResponse/);
  assert.equal(calls[0].options.reasoningEffort, "minimal");
  assert.equal(calls[0].options.textVerbosity, "low");
});
