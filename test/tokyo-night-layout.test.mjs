import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import tokyoNightFooter from "../extensions/tokyo-night-footer/index.ts";

// Exported only so an isolated differential check can compare an earlier
// implementation across every width without adding snapshots to production.
export function footerLayout(factory, title = "Metrics test") {
  const handlers = new Map();
  let editor;
  const color = (text) => `\x1b[36m${text}\x1b[39m`;
  const theme = { name: "test", fg: (_color, text) => color(text), bold: (text) => text,
    getColorMode: () => "none", getFgAnsi: () => "\x1b[36m" };
  const tui = { terminal: { rows: 40, columns: 220 }, requestRender() {} };
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/work",
    model: { provider: "test", id: "test", name: "Test model", contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 0 }), getSystemPrompt: () => "system",
    sessionManager: { getSessionId: () => "layout", getBranch: () => [], getLeafId: () => null },
    ui: { theme, setStatus() {},
      setFooter(create) {
        create(tui, theme, {
          getGitBranch: () => "main",
          getExtensionStatuses: () => new Map([
            ["pi-permission-system", "read-only"],
            ["unicode", "\x1b[33m日本語 e\u0301\x1b[39m"],
          ]),
          onBranchChange: () => () => {},
        });
      },
      setEditorComponent(create) {
        editor = create(tui, { borderColor: color, selectList: {} }, { matches: () => false });
      },
    },
  };
  const pi = {
    on: (name, handler) => handlers.set(name, handler), events: { on: () => () => {} },
    getSessionName: () => title, getThinkingLevel: () => "off", getActiveTools: () => [], getAllTools: () => [],
    // Keep Git pending without starting processes or timers.
    exec: () => new Promise(() => {}),
  };
  factory(pi);
  const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  emit("session_start");
  emit("resources_discover");
  return { emit, render: (width) => editor.render(width) };
}

export function finishLayoutResponse(h) {
  const message = { role: "assistant", provider: "test", model: "test", api: "test", content: [], timestamp: 1,
    stopReason: "stop", usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1_100 } };
  h.emit("message_start", { message });
  h.emit("message_update", { message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first" } });
  return () => h.emit("message_end", { message });
}

test("clock follows tps; responsive border preserves width, title and critical status", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const previousIcons = process.env.POWERLINE_NERD_FONTS;
  t.after(() => {
    if (previousIcons === undefined) delete process.env.POWERLINE_NERD_FONTS;
    else process.env.POWERLINE_NERD_FONTS = previousIcons;
  });
  for (const icons of ["0", "1"]) {
    process.env.POWERLINE_NERD_FONTS = icons;
    for (const title of ["Metrics test", "A long 日本語 title with combining e\u0301 characters".repeat(3)]) {
      const h = footerLayout(tokyoNightFooter, title);
      h.emit("context", { messages: [] });
      h.emit("before_provider_request");
      now += 250;
      const finish = finishLayoutResponse(h);
      now += 750;
      finish();
      const wide = stripVTControlCharacters(h.render(220)[0]);
      assert.match(wide, /100\.0 tps.*[◷] 250ms/);
      for (let width = 10; width <= 240; width++) {
        const lines = h.render(width);
        assert.equal(visibleWidth(lines[0]), width, `top border at ${width} cols, icons=${icons}`);
        for (const line of lines) assert.ok(visibleWidth(line) <= width);
      }
      if (title === "Metrics test") {
        const narrow = stripVTControlCharacters(h.render(44)[0]);
        assert.match(narrow, /read-only.*Metrics test/);
        assert.doesNotMatch(narrow, / tps|[◷]/);
      }
      h.emit("session_shutdown");
    }
  }
});
