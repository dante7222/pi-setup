import assert from "node:assert/strict";
import test from "node:test";
import {
  groupWorkersByPlacement,
  workerTabWorktreeId,
} from "../extensions/supacode-subagents/worker-placement.ts";

test("research workers stay in the parent Supacode worktree", () => {
  assert.equal(workerTabWorktreeId("research", "parent", undefined), "parent");
});

test("coding workers place their tab in their isolated Supacode worktree", () => {
  assert.equal(workerTabWorktreeId("coding", "parent", "worker"), "worker");
  assert.throws(
    () => workerTabWorktreeId("coding", "parent", undefined),
    /no isolated Supacode worktree ID/,
  );
});

test("research workers share one group while coding workers remain isolated", () => {
  const researchOne = { id: "research-one", mode: "research" };
  const codingOne = { id: "coding-one", mode: "coding" };
  const researchTwo = { id: "research-two", mode: "research" };
  const codingTwo = { id: "coding-two", mode: "coding" };

  assert.deepEqual(
    groupWorkersByPlacement([researchOne, codingOne, researchTwo, codingTwo]),
    [[researchOne, researchTwo], [codingOne], [codingTwo]],
  );
});
