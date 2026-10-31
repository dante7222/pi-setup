import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { updatePrimeAgentWidget } from "../extensions/tokyo-night-footer/status-line.ts";

test("Prime Agent widget excludes session names at wide and narrow terminal widths", (t) => {
  const descriptors = ["isTTY", "columns"].map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]);
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else delete process.stdout[key];
    }
  });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  const widgets = [];
  const theme = { name: "test", fg: (_color, text) => text, getColorMode: () => "none" };
  const state = {
    primeAgentContext: { cwd: "/work", model: { name: "Test model", contextWindow: 100_000 },
      ui: { theme, setWidget: (_key, lines) => widgets.push(lines.join("\n")) } },
  };
  const pi = { getSessionName: () => "HIDDEN_SESSION_NAME" };
  for (const columns of [220, 44]) {
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    updatePrimeAgentWidget(pi, state);
    assert.ok(widgets.length > 0);
    const text = stripVTControlCharacters(widgets.at(-1));
    assert.match(text, /Test model/);
    assert.doesNotMatch(text, /HIDDEN/);
    assert.ok(visibleWidth(widgets.at(-1)) <= columns - 2);
  }
});
