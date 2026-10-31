import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import tokyoNightFooter from "../extensions/tokyo-night-footer/index.ts";

function harness(mode) {
  const handlers = new Map();
  let editor, footer, widget, renders = 0;
  const theme = { name: "test", fg: (_color, text) => text, bold: (text) => text,
    getColorMode: () => "none", getFgAnsi: () => "" };
  const tui = { terminal: { rows: 40, columns: 220 }, requestRender() { renders++; } };
  const ctx = {
    mode, hasUI: true, cwd: "/work",
    model: { provider: "test", id: "test", name: "Test model", contextWindow: 100_000 },
    getContextUsage: () => ({ tokens: 0 }), getSystemPrompt: () => "system",
    sessionManager: { getSessionId: () => "star", getBranch: () => [], getLeafId: () => null },
    ui: { theme, setStatus() {},
      setWidget(_key, lines) { widget = lines?.[0]; },
      setFooter(create) {
        footer = create(tui, theme, { getGitBranch: () => "", getExtensionStatuses: () => new Map(),
          onBranchChange: () => () => {} });
      },
      setEditorComponent(create) {
        editor = create(tui, { borderColor: (text) => text, selectList: {} }, { matches: () => false });
      },
    },
  };
  const pi = {
    on: (name, handler) => handlers.set(name, handler), events: { on: () => () => {} },
    getSessionName: () => undefined, getThinkingLevel: () => "off", getActiveTools: () => [], getAllTools: () => [],
    exec: () => new Promise(() => {}),
  };
  tokyoNightFooter(pi);
  const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  return {
    emit,
    star: () => stripVTControlCharacters(editor.render(120)[0]).match(/^╭── (\S) /)?.[1],
    get widget() { return stripVTControlCharacters(widget ?? ""); },
    get footer() { return footer; },
    get renders() { return renders; },
  };
}

test("the footer leads with Claude Code's spinner star, one frame per 120 ms, out and back", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness("tui");
  h.emit("session_start");

  const seen = [h.star()];
  for (let tick = 0; tick < 12; tick++) {
    t.mock.timers.tick(120);
    seen.push(h.star());
  }
  assert.deepEqual(seen, ["·", "✢", "✳", "✶", "✻", "✽", "✽", "✻", "✶", "✳", "✢", "·", "·"]);
  assert.equal(h.renders, 12);

  h.emit("session_shutdown");
  t.mock.timers.tick(1_200);
  assert.equal(h.renders, 12, "no redraws after shutdown");
  assert.equal(h.star(), "✻");
});

test("disposing the footer stops the star", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness("tui");
  h.emit("session_start");
  t.mock.timers.tick(240);
  h.footer.dispose();
  t.mock.timers.tick(1_200);
  assert.equal(h.renders, 2);
  h.emit("session_shutdown");
});

test("Prime Agent's widget shows a still star", () => {
  const h = harness(undefined);
  h.emit("session_start");
  assert.match(h.widget, /^ ✻ /);
  h.emit("session_shutdown");
});
