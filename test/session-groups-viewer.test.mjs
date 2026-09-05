import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createSessionGroupMarkdownViewer } from "../extensions/session-groups/viewer.ts";

initTheme("dark", false);
const theme = { fg: (_color, value) => value, bold: (value) => value };

test("viewer bounds height/width, pages through all content, resizes and closes", () => {
  let renders = 0;
  let closed = false;
  const tui = { terminal: { rows: 24 }, requestRender: () => renders++ };
  const kb = new KeybindingsManager(TUI_KEYBINDINGS);
  const content = Array.from({ length: 200 }, (_, index) => `row-${index} 界 **text**`).join("\n\n");
  const viewer = createSessionGroupMarkdownViewer(tui, theme, kb, () => { closed = true; }, "Group context", content);
  let page = viewer.render(50);
  assert.ok(page.length <= 22);
  assert.ok(page.every((line) => visibleWidth(line) <= 50));
  assert.match(page.join("\n"), /row-0 /);
  viewer.handleInput("\x1b[6~");
  assert.ok(renders > 0);
  page = viewer.render(50);
  assert.doesNotMatch(page.join("\n"), /row-0 /);
  viewer.handleInput("\x1b[5~");
  assert.match(viewer.render(50).join("\n"), /row-0 /);
  for (let index = 0; index < 100; index++) { viewer.handleInput("\x1b[6~"); viewer.render(50); }
  assert.match(viewer.render(50).join("\n"), /row-199 /);
  for (const rows of [2, 5, 8, 12, 24]) {
    tui.terminal.rows = rows;
    for (const width of [1, 2, 10, 40]) {
      page = viewer.render(width);
      assert.ok(page.length <= rows);
      assert.ok(page.every((line) => visibleWidth(line) <= width));
    }
  }
  viewer.invalidate();
  assert.doesNotThrow(() => viewer.render(80));
  viewer.handleInput("\x1b");
  assert.equal(closed, true);
});

test("viewer does not interpret file text as terminal controls", () => {
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const kb = new KeybindingsManager(TUI_KEYBINDINGS);
  const viewer = createSessionGroupMarkdownViewer(tui, theme, kb, () => {}, "Test", "Text \x1b]52;c;UE9JU09O\x07\n");
  const rendered = viewer.render(80).join("\n");
  assert.doesNotMatch(rendered, /\x1b\]52|\x07/u);
  assert.match(rendered, /u001b/);
});

test("viewer respects configured keys rather than hardcoded page shortcuts", () => {
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.pageDown": "ctrl+n", "tui.select.pageUp": "ctrl+p" });
  const tui = { terminal: { rows: 12 }, requestRender: () => {} };
  const viewer = createSessionGroupMarkdownViewer(tui, theme, kb, () => {}, "Test", "first\n\n" + "other\n\n".repeat(100));
  const before = viewer.render(80);
  viewer.handleInput("\x1b[6~");
  assert.deepEqual(viewer.render(80), before);
  viewer.handleInput("\x0e");
  assert.notDeepEqual(viewer.render(80), before);
  assert.match(viewer.render(80).join("\n"), /ctrl\+p\/ctrl\+n/);
  viewer.handleInput("\x10");
  assert.deepEqual(viewer.render(80), before);
});
