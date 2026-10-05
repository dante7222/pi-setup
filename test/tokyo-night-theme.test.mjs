import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateThemeJson } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-json.js";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const path = fileURLToPath(new URL("../themes/tokyo-night.json", import.meta.url));
const theme = JSON.parse(readFileSync(path, "utf8"));

function luminance(hex) {
  const values = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

function contrast(first, second) {
  const resolve = (value) => theme.vars[value] ?? value;
  const a = luminance(resolve(first));
  const b = luminance(resolve(second));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("Tokyo Night validates against installed Pi and renders in truecolor and 256-color modes", () => {
  assert.equal(validateThemeJson("tokyo-night", theme).name, "tokyo-night");
  for (const mode of ["truecolor", "256color"]) {
    const loaded = loadThemeFromPath(path, mode);
    assert.equal(loaded.appearance, "dark");
    assert.equal(loaded.getColorMode(), mode);
    for (const token of ["thinkingText", "syntaxComment", "toolDiffContext", "mdLinkUrl", "scrollbarThumb", "scrollbarTrack"]) {
      assert.ok(loaded.fg(token, "Text").includes("Text"));
    }
  }
});

test("reading text has at least 4.5:1 contrast on intended Tokyo Night backgrounds", () => {
  const backgrounds = [theme.vars.bg, theme.colors.userMessageBg, theme.colors.toolPendingBg,
    theme.colors.toolSuccessBg, theme.colors.toolErrorBg];
  for (const token of ["thinkingText", "syntaxComment", "toolDiffContext", "mdLinkUrl"]) {
    for (const background of backgrounds) {
      assert.ok(contrast(theme.colors[token], background) >= 4.5, `${token} on ${background}`);
    }
  }
  assert.equal(theme.colors.borderMuted, "comment", "Decorative borders stay subdued");
  assert.equal(theme.colors.dim, "comment");
});

test("fullscreen scrollbar thumb and track are distinct while search fallbacks stay readable", () => {
  assert.ok(contrast(theme.colors.scrollbarThumb, theme.colors.scrollbarTrack) >= 3);
  assert.ok(contrast(theme.colors.text, theme.colors.selectedBg) >= 4.5);
});
