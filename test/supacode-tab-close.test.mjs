import assert from "node:assert/strict";
import test from "node:test";
import { decideTabClose } from "../extensions/supacode-subagents/tab-close.ts";

const alivePids = new Set([101, 202]);
const processRunning = (pid) => alivePids.has(pid);

test("settled worker results take precedence over a missing tab snapshot", () => {
  assert.equal(
    decideTabClose(
      [
        { state: "completed", pid: 101 },
        { state: "failed", pid: 202 },
      ],
      processRunning,
    ),
    "settled",
  );
});

test("a live worker prevents a missing tab snapshot from aborting the parent", () => {
  assert.equal(decideTabClose([{ state: "running", pid: 101 }], processRunning), "wait");
});

test("an unreported worker prevents a missing tab snapshot from aborting the parent", () => {
  assert.equal(decideTabClose([undefined], processRunning), "wait");
  assert.equal(decideTabClose([{ state: "running" }], processRunning), "wait");
});

test("a missing tab is confirmed when an unsettled worker process is gone", () => {
  assert.equal(decideTabClose([{ state: "running", pid: 303 }], processRunning), "closed");
  assert.equal(
    decideTabClose(
      [
        { state: "completed", pid: 101 },
        { state: "running", pid: 303 },
      ],
      processRunning,
    ),
    "closed",
  );
});

test("unknown worker state keeps tab monitoring fail-safe", () => {
  assert.equal(
    decideTabClose(
      [
        { state: "running", pid: 303 },
        undefined,
      ],
      processRunning,
    ),
    "wait",
  );
  assert.equal(decideTabClose([], processRunning), "wait");
});
