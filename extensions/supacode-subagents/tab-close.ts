export type TabCloseDecision = "wait" | "settled" | "closed";

export interface TabCloseWorkerStatus {
  state: "running" | "completed" | "failed";
  pid?: number;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function decideTabClose(
  statuses: Array<TabCloseWorkerStatus | undefined>,
  processRunning: (pid: number) => boolean = isProcessRunning,
): TabCloseDecision {
  if (statuses.length === 0) return "wait";

  let hasUnsettledWorker = false;
  for (const status of statuses) {
    if (status?.state === "completed" || status?.state === "failed") continue;
    hasUnsettledWorker = true;
    if (!status?.pid || processRunning(status.pid)) return "wait";
  }

  return hasUnsettledWorker ? "closed" : "settled";
}
