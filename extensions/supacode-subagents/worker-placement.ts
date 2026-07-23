export type WorkerPlacementMode = "research" | "coding";

export function workerTabWorktreeId(
  mode: WorkerPlacementMode,
  parentWorktreeId: string,
  codeWorktreeId?: string,
): string {
  if (mode === "research") return parentWorktreeId;
  if (!codeWorktreeId) throw new Error("Coding worker has no separate Supacode worktree ID.");
  return codeWorktreeId;
}

export function researchWorkerSplitPlacement(
  launched: ReadonlyArray<{ surfaceId: string }>,
): { target: string; direction: "h" | "v" } {
  const workerIndex = launched.length;
  if (workerIndex === 0) throw new Error("A research split requires an existing worker surface.");
  if (workerIndex === 1) return { target: launched[0].surfaceId, direction: "h" };

  // Split breadth-first across both columns so 2–8 panes grow as
  // 1/1, 2/1, 2/2, 3/2, 3/3, 4/3, 4/4 instead of nesting in one column.
  const levelStart = 2 ** Math.floor(Math.log2(workerIndex));
  return {
    target: launched[workerIndex - levelStart].surfaceId,
    direction: "v",
  };
}

export function groupWorkersByPlacement<T extends { mode: WorkerPlacementMode }>(
  workers: T[],
): T[][] {
  const groups: T[][] = [];
  let researchGroup: T[] | undefined;

  for (const worker of workers) {
    if (worker.mode === "coding") {
      groups.push([worker]);
      continue;
    }
    if (!researchGroup) {
      researchGroup = [];
      groups.push(researchGroup);
    }
    researchGroup.push(worker);
  }

  return groups;
}
