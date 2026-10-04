import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, trackProgress } from "../extensions/herdr-subagents/progress.ts";

test("usage counts finalized assistant, tool and compaction usage once, never previews", () => {
  const progress = { phase: "starting", updatedAt: 0, turns: 0, usage: emptyUsage() };
  const usage = { ...emptyUsage(), input: 10, output: 5, totalTokens: 15, cost: { ...emptyUsage().cost, total: 0.01 } };
  assert.equal(trackProgress(progress, { type: "message_update", usage }), false);
  assert.equal(trackProgress(progress, { type: "tool_execution_end", result: { usage } }), false);
  trackProgress(progress, { type: "message_end", message: { role: "assistant", provider: "test", model: "model", usage } });
  trackProgress(progress, { type: "message_end", message: { role: "toolResult", usage } });
  trackProgress(progress, { type: "compaction_end", result: { usage } });
  assert.equal(progress.turns, 1);
  assert.equal(progress.model, "test/model");
  assert.equal(progress.usage.totalTokens, 45);
  assert.equal(progress.usage.cost.total, 0.03);
  trackProgress(progress, { type: "tool_execution_start", toolName: "bash", parentToolCallId: "codemode" });
  assert.equal(progress.tool, "bash");
  trackProgress(progress, { type: "agent_settled" });
  assert.equal(progress.phase, "settled");
  assert.equal(progress.tool, undefined);
});

test("invalid provider counters cannot poison displayed totals", () => {
  const progress = { phase: "starting", updatedAt: 0, turns: 0, usage: emptyUsage() };
  trackProgress(progress, { type: "message_end", message: { role: "assistant", usage: { input: NaN, output: -1, totalTokens: Infinity, cost: { total: "free" } } } });
  assert.deepEqual(progress.usage, emptyUsage());
});
