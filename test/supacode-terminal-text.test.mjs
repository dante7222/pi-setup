import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkerResults } from "../extensions/supacode-subagents/result-context.ts";
import { escapeTerminalText } from "../extensions/supacode-subagents/terminal-text.ts";

test("terminal text escaping preserves newlines and exposes control and bidi sequences", () => {
  const escaped = escapeTerminalText("safe\n\u001b[2Jspoof\u061c\u200e\u200f\u202eabc\r\t");
  assert.equal(escaped, "safe\n\\u001b[2Jspoof\\u061c\\u200e\\u200f\\u202eabc\\r\\t");
  assert.equal(/[\u001b\u061c\u200e\u200f\u202e\r\t]/.test(escaped), false);
});

test("delegated result formatting cannot emit worker-supplied terminal controls", () => {
  const output = formatWorkerResults([{
    id: "job",
    title: "review\u001b[2J",
    mode: "research",
    state: "completed",
    output: "result\u001b]8;;https://example.test\u0007click\u001b]8;;\u0007",
  }], 50_000, 2_000);
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /\\u001b/);
});
