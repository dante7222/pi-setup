import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage, isUsage } from "../extensions/supacode-subagents/usage.ts";

function usage(multiplier, optional = {}) {
  return {
    input: 10 * multiplier,
    output: 5 * multiplier,
    cacheRead: 3 * multiplier,
    cacheWrite: 2 * multiplier,
    totalTokens: 20 * multiplier,
    cost: {
      input: 0.1 * multiplier,
      output: 0.2 * multiplier,
      cacheRead: 0.03 * multiplier,
      cacheWrite: 0.02 * multiplier,
      total: 0.35 * multiplier,
    },
    ...optional,
  };
}

test("usage aggregation sums every worker turn and preserves optional counters", () => {
  const aggregated = aggregateUsage([
    usage(1, { reasoning: 2 }),
    usage(2, { cacheWrite1h: 4 }),
  ]);

  assert.deepEqual(aggregated, {
    input: 30,
    output: 15,
    cacheRead: 9,
    cacheWrite: 6,
    cacheWrite1h: 4,
    reasoning: 2,
    totalTokens: 60,
    cost: {
      input: 0.30000000000000004,
      output: 0.6000000000000001,
      cacheRead: 0.09,
      cacheWrite: 0.06,
      total: 1.0499999999999998,
    },
  });
});

test("usage aggregation ignores malformed data", () => {
  assert.equal(isUsage(usage(1)), true);
  assert.equal(isUsage({ ...usage(1), input: Number.NaN }), false);
  assert.equal(aggregateUsage([undefined, { input: 1 }]), undefined);
});
