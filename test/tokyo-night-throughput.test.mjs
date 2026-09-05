import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFirstTokenLatency,
  responseTimeToFirstToken,
  responseTokensPerSecond,
} from "../extensions/tokyo-night-footer/throughput.ts";

test("TTFT uses the first observed delta, including sub-millisecond and zero-latency samples", () => {
  assert.equal(responseTimeToFirstToken(1_000, 1_250, 9_000), 250);
  assert.equal(responseTimeToFirstToken(100, 100.25, 101), 0.25);
  assert.equal(responseTimeToFirstToken(0, 0, 1), 0);
});

test("TTFT rejects missing, non-finite and out-of-order observations", () => {
  for (const missing of [undefined, NaN, Infinity, -Infinity]) {
    assert.equal(responseTimeToFirstToken(missing, 100, 1_000), undefined);
    assert.equal(responseTimeToFirstToken(0, missing, 1_000), undefined);
  }
  assert.equal(responseTimeToFirstToken(200, 100, 1_000), undefined);
  assert.equal(responseTimeToFirstToken(0, 1_001, 1_000), undefined);
  assert.equal(responseTimeToFirstToken(0, 100, NaN), undefined);
});

test("TTFT formatting uses milliseconds for fast responses and seconds for longer waits", () => {
  for (const [milliseconds, expected] of [
    [0, "0.0ms"], [0.25, "0.3ms"], [1, "1ms"], [250.4, "250ms"],
    [999, "999ms"], [1_000, "1.00s"], [1_234, "1.23s"], [12_345, "12.35s"],
  ]) {
    assert.equal(formatFirstTokenLatency(milliseconds), expected);
  }
});

function response(output, stopReason = "stop") {
  return { stopReason, usage: { output, reasoning: output / 2 } };
}

test("TPS uses reported output inclusive of reasoning and the whole request interval", () => {
  // 9 seconds of hidden thinking/TTFT and 1 second of visible text: not 1000 TPS.
  assert.equal(responseTokensPerSecond(response(1_000), 500, 10_500), 100);
});

test("fast responses below 100ms are measured rather than leaving a stale value", () => {
  assert.equal(responseTokensPerSecond(response(5), 100, 150), 100);
  assert.equal(responseTokensPerSecond(response(3), 100, 107.5), 400);
});

test("TPS accepts normal, length-limited and tool-call responses", () => {
  for (const reason of ["stop", "length", "toolUse"]) {
    assert.equal(responseTokensPerSecond(response(100, reason), 0, 1_000), 100);
  }
});

test("TPS is unavailable for incomplete/failed responses, missing counts or invalid clocks", () => {
  for (const reason of ["pending", "deferred", "aborted", "error"]) {
    assert.equal(responseTokensPerSecond(response(100, reason), 0, 1_000), undefined);
  }
  for (const output of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(responseTokensPerSecond(response(output), 0, 1_000), undefined);
  }
  for (const start of [undefined, NaN, Infinity, 1_000, 2_000]) {
    assert.equal(responseTokensPerSecond(response(100), start, 1_000), undefined);
  }
  assert.equal(responseTokensPerSecond(response(100), 0, Infinity), undefined);
});
