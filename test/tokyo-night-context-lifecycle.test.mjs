import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import tokyoNightFooter from "../extensions/tokyo-night-footer/index.ts";
import { estimateLoadedContextTokens } from "../extensions/tokyo-night-footer/context-usage.ts";
import { SESSION_GROUP_PRESENTATION_EVENT } from "../extensions/session-groups/contracts.ts";

function formatExpectedTokens(count) {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${Math.round(count / 1_000)}k`;
}

test("calculates context after session-group tool gating and prompt injection", async () => {
  const previousNerdFonts = process.env.POWERLINE_NERD_FONTS;
  process.env.POWERLINE_NERD_FONTS = "0";

  const handlers = new Map();
  const eventHandlers = new Map();
  const widgets = [];
  const tools = [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "edit_group_context",
      description: "Large shared-context editing tool schema",
      parameters: { type: "object", properties: { edits: { type: "array" } } },
    },
    {
      name: "group_changelog",
      description: "Large group changelog tool schema",
      parameters: { type: "object", properties: { action: { type: "string" } } },
    },
  ];
  let activeToolNames = tools.map(({ name }) => name);
  let effectiveSystemPrompt = "base system prompt";

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    events: {
      on(channel, handler) {
        eventHandlers.set(channel, handler);
        return () => eventHandlers.delete(channel);
      },
      emit(channel, value) {
        eventHandlers.get(channel)?.(value);
      },
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
    getContextUsage: () => ({ tokens: 0, contextWindow: 230_000, percent: 0 }),
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
    pi.events.emit(SESSION_GROUP_PRESENTATION_EVENT, {
      version: 1,
      sessionId: "session-1",
      group: null,
    });
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
    effectiveSystemPrompt = "base system prompt\n\n<session_group_context>shared plan</session_group_context>";
    await handlers.get("agent_start")({ type: "agent_start" }, ctx);
    const requestEstimate = estimateLoadedContextTokens(
      effectiveSystemPrompt,
      tools,
      activeToolNames,
    );
    assert.match(widgets.at(-1), new RegExp(`~${formatExpectedTokens(requestEstimate)}/230k`));
    assert.notEqual(requestEstimate, startupEstimate);
  } finally {
    if (previousNerdFonts === undefined) {
      delete process.env.POWERLINE_NERD_FONTS;
    } else {
      process.env.POWERLINE_NERD_FONTS = previousNerdFonts;
    }
  }
});
