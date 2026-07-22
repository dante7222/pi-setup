export type WorkerPlacementMode = "research" | "coding";

export function workerTabWorktreeId(
  mode: WorkerPlacementMode,
  parentWorktreeId: string,
  codeWorktreeId?: string,
): string {
  if (mode === "research") return parentWorktreeId;
  if (!codeWorktreeId) throw new Error("Coding worker has no isolated Supacode worktree ID.");
  return codeWorktreeId;
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
