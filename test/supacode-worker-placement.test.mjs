import assert from "node:assert/strict";
import test from "node:test";
import {
  groupWorkersByPlacement,
  researchWorkerSplitPlacement,
  workerTabWorktreeId,
} from "../extensions/supacode-subagents/worker-placement.ts";

test("research workers stay in the parent Supacode worktree", () => {
  assert.equal(workerTabWorktreeId("research", "parent", undefined), "parent");
});

test("coding workers place their tab in their separate Supacode worktree", () => {
  assert.equal(workerTabWorktreeId("coding", "parent", "worker"), "worker");
  assert.throws(
    () => workerTabWorktreeId("coding", "parent", undefined),
    /no separate Supacode worktree ID/,
  );
});

test("research worker panes grow into balanced columns", () => {
  const panes = Array.from({ length: 8 }, (_, index) => ({ surfaceId: `pane-${index + 1}` }));
  const launched = [panes[0]];
  const columns = new Map([[panes[0].surfaceId, 0]]);
  const placements = [];
  const layouts = [];

  for (const pane of panes.slice(1)) {
    const placement = researchWorkerSplitPlacement(launched);
    const targetColumn = columns.get(placement.target);
    assert.notEqual(targetColumn, undefined);
    columns.set(pane.surfaceId, placement.direction === "h" ? 1 : targetColumn);
    launched.push(pane);
    placements.push([placement.target, placement.direction]);
    layouts.push(
      `${[...columns.values()].filter((column) => column === 0).length}/${
        [...columns.values()].filter((column) => column === 1).length
      }`,
    );
  }

  assert.deepEqual(placements, [
    ["pane-1", "h"],
    ["pane-1", "v"],
    ["pane-2", "v"],
    ["pane-1", "v"],
    ["pane-2", "v"],
    ["pane-3", "v"],
    ["pane-4", "v"],
  ]);
  assert.deepEqual(layouts, ["1/1", "2/1", "2/2", "3/2", "3/3", "4/3", "4/4"]);
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
