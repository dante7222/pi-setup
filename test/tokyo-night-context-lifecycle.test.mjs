import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import tokyoNightFooter from "../extensions/tokyo-night-footer/index.ts";
import { estimateLoadedContextTokens } from "../extensions/tokyo-night-footer/context-usage.ts";

function formatExpectedTokens(count) {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${Math.round(count / 1_000)}k`;
}

test("calculates context after dynamic tool loadout and prompt changes", async () => {
  const previousNerdFonts = process.env.POWERLINE_NERD_FONTS;
  process.env.POWERLINE_NERD_FONTS = "0";

  const handlers = new Map();
  const widgets = [];
  const tools = [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "edit_document",
      description: "Large document editing tool schema",
      parameters: { type: "object", properties: { edits: { type: "array" } } },
    },
    {
      name: "query_history",
      description: "Large history query tool schema",
      parameters: { type: "object", properties: { action: { type: "string" } } },
    },
  ];
  let activeToolNames = tools.map(({ name }) => name);
  let effectiveSystemPrompt = "base system prompt";
  let reportedContextTokens = 0;

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    getActiveTools: () => [...activeToolNames],
    getAllTools: () => tools,
    getSessionName: () => "Context calculator test",
    getThinkingLevel: () => "off",
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
  };
  const theme = {
    name: "test",
    fg: (_color, text) => text,
    bold: (text) => text,
    getColorMode: () => "none",
  };
  tokyoNightFooter(pi);

  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    model: {
      id: "test-model",
      name: "Test Model",
      provider: "test",
      contextWindow: 230_000,
      reasoning: false,
    },
    getContextUsage: () => ({
      tokens: reportedContextTokens,
      contextWindow: ctx.model.contextWindow,
      percent: (reportedContextTokens / ctx.model.contextWindow) * 100,
    }),
    getSystemPrompt: () => effectiveSystemPrompt,
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => [],
    },
    ui: {
      theme,
      setStatus: () => undefined,
      setWidget(_key, lines) {
        if (lines) widgets.push(stripVTControlCharacters(lines.join("\n")));
      },
    },
  };

  try {
    await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

    activeToolNames = ["read"];
    await handlers.get("resources_discover")({ type: "resources_discover" }, ctx);
    const startupEstimate = estimateLoadedContextTokens(
      effectiveSystemPrompt,
      tools,
      activeToolNames,
    );
    assert.match(widgets.at(-1), new RegExp(`~${formatExpectedTokens(startupEstimate)}/230k`));

    activeToolNames = tools.map(({ name }) => name);
    await handlers.get("before_agent_start")(
      {
        type: "before_agent_start",
        prompt: "continue",
        systemPrompt: "base system prompt",
        systemPromptOptions: {},
      },
      ctx,
    );
    assert.match(widgets.at(-1), new RegExp(`~${formatExpectedTokens(startupEstimate)}/230k`));

    activeToolNames = ["read"];
    effectiveSystemPrompt = "base system prompt\n\nUse the current document plan.";
    await handlers.get("agent_start")({ type: "agent_start" }, ctx);
    const requestEstimate = estimateLoadedContextTokens(
      effectiveSystemPrompt,
      tools,
      activeToolNames,
    );
    assert.match(widgets.at(-1), new RegExp(`~${formatExpectedTokens(requestEstimate)}/230k`));
    assert.notEqual(requestEstimate, startupEstimate);

    reportedContextTokens = 5;
    const userMessage = { role: "user", content: "12345678", timestamp: 1 };
    await handlers.get("context")({ type: "context", messages: [userMessage] }, ctx);
    const requestWithUserEstimate = requestEstimate + 2;
    assert.match(
      widgets.at(-1),
      new RegExp(`~${formatExpectedTokens(requestWithUserEstimate)}/230k`),
    );

    const zeroUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const streamingAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(4_000) }],
      api: "test",
      provider: "test",
      model: "test-model",
      usage: zeroUsage,
      stopReason: "pending",
      timestamp: 2,
    };
    await handlers.get("message_start")(
      { type: "message_start", message: streamingAssistant },
      ctx,
    );
    await handlers.get("message_update")(
      {
        type: "message_update",
        message: streamingAssistant,
        assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4_000) },
      },
      ctx,
    );
    assert.match(
      widgets.at(-1),
      new RegExp(`~${formatExpectedTokens(requestWithUserEstimate + 1_000)}/230k`),
    );

    const completedAssistant = {
      ...streamingAssistant,
      usage: { ...zeroUsage, input: 11_000, output: 1_000, totalTokens: 12_000 },
      stopReason: "stop",
    };
    reportedContextTokens = 12_000;
    await handlers.get("message_end")(
      { type: "message_end", message: completedAssistant },
      ctx,
    );
    assert.match(widgets.at(-1), /◫ 12k\/230k/);
    assert.doesNotMatch(widgets.at(-1), /~12k\/230k/);

    ctx.model = {
      ...ctx.model,
      id: "new-model",
      name: "New Model",
      contextWindow: 100_000,
    };
    await handlers.get("model_select")(
      { type: "model_select", model: ctx.model, source: "select" },
      ctx,
    );
    assert.match(widgets.at(-1), /◫ \?\/100k/);

    await handlers.get("context")(
      { type: "context", messages: [completedAssistant] },
      ctx,
    );
    assert.match(
      widgets.at(-1),
      new RegExp(`~${formatExpectedTokens(requestEstimate + 1_000)}/100k`),
    );
    assert.doesNotMatch(widgets.at(-1), /12k\/100k/);
  } finally {
    if (previousNerdFonts === undefined) {
      delete process.env.POWERLINE_NERD_FONTS;
    } else {
      process.env.POWERLINE_NERD_FONTS = previousNerdFonts;
    }
  }
});
