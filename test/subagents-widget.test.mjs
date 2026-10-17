import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { formatTokens, renderWidget, shortModelName } from "../extensions/subagents/widget.ts";

const theme = loadThemeFromPath(new URL("../themes/tokyo-night.json", import.meta.url).pathname, "truecolor");
const rows = [
  { name: "review-auth", model: "GPT-6 Astra", thinking: "xhigh", state: "running", contextTokens: 92_000, contextWindow: 272_000 },
  { name: "fixer", model: "Opus 5.5", thinking: "high", state: "stopping", contextTokens: 250_000, contextWindow: 272_000 },
  { name: "tester", model: "Sonnet 5.5", state: "queued" },
  { name: "scout", model: "GPT-6 Astra", thinking: "low", state: "running" },
];

test("one header and one line per subagent with short model, effort and context, no cost", () => {
  const lines = renderWidget(rows, theme, 160).map(stripVTControlCharacters);
  assert.deepEqual(lines, [
    "Subagents  3 running · 1 queued",
    " ● review-auth  GPT-6 Astra xhigh  ━━━━━━━━━━  34%",
    " ● fixer        Opus 5.5 high      ━━━━━━━━━━  92%",
    " ○ tester       Sonnet 5.5                  queued",
    " ● scout        GPT-6 Astra low           starting",
  ]);
  // Compact columns: wide panes do not stretch rows to the right edge.
  assert.ok(lines.every((line) => line.length < 60));
  // Effort keeps its thinking-level colour.
  assert.ok(renderWidget(rows, theme, 160)[1].includes(theme.getFgAnsi("thinkingXhigh")));
});

test("model names drop vendor prefixes and region suffixes", () => {
  assert.equal(shortModelName("Claude Opus 5.5"), "Opus 5.5");
  assert.equal(shortModelName("Claude Sonnet 5.5 (Global)"), "Sonnet 5.5");
  assert.equal(shortModelName("GPT-6 Astra"), "GPT-6 Astra");
});

test("context uses the footer's thresholds and colours", () => {
  const [, ok, high] = renderWidget(rows, theme, 100);
  assert.ok(ok.includes(theme.getFgAnsi("success")));
  assert.ok(high.includes(theme.getFgAnsi("error")));
  const [, warn] = renderWidget([{ ...rows[0], contextTokens: 210_000 }], theme, 100);
  assert.ok(warn.includes(theme.getFgAnsi("warning")));
});

test("every line fits the width and clipping never inserts a colour reset", () => {
  for (const width of [24, 36, 49, 50, 60, 100, 200]) {
    for (const line of renderWidget(rows, theme, width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`);
    }
  }
  const long = [{ ...rows[0], model: "A Very Long Experimental Model Name", thinking: "xhigh" }];
  for (const line of renderWidget(long, theme, 52).slice(1)) assert.ok(!line.includes("\x1b[0m"), JSON.stringify(line));
  // The model is clipped before the effort, which stays visible.
  assert.match(stripVTControlCharacters(renderWidget(long, theme, 52)[1]), /…\s?xhigh\s+━/);
  // Narrow panes drop the model column but keep name and context.
  assert.match(stripVTControlCharacters(renderWidget(rows, theme, 36)[1]), /^ ● review-auth\s+━+\s+34%$/);
});

test("nothing to show renders nothing", () => {
  assert.deepEqual(renderWidget([], theme, 100), []);
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(92_400), "92k");
  assert.equal(formatTokens(1_250_000), "1.3M");
});
