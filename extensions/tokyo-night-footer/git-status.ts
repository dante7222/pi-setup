import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_STATUS_TTL_MS = 1_000;

export interface GitStatusCounts {
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface GitStatusTracker {
  cwd: string;
  counts: GitStatusCounts;
  fetchedAt: number;
  generation: number;
  pending: Promise<void> | undefined;
  status: "unknown" | "fresh" | "stale";
  disposed: boolean;
  controller: AbortController;
}

export function createGitStatusTracker(cwd: string): GitStatusTracker {
  return {
    cwd,
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    fetchedAt: 0,
    generation: 0,
    pending: undefined,
    status: "unknown",
    disposed: false,
    controller: new AbortController(),
  };
}

/** Parse the XY columns emitted by `git status --porcelain`. */
export function parseGitStatusOutput(output: string): GitStatusCounts {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];

    if (indexStatus === "?" && worktreeStatus === "?") {
      untracked++;
      continue;
    }
    if (indexStatus && indexStatus !== " " && indexStatus !== "?") staged++;
    if (worktreeStatus && worktreeStatus !== " ") unstaged++;
  }

  return { staged, unstaged, untracked };
}

export function invalidateGitStatus(tracker: GitStatusTracker): void {
  if (tracker.disposed) return;
  tracker.generation++;
  tracker.fetchedAt = 0;
  if (tracker.status === "fresh") tracker.status = "stale";
}

export function disposeGitStatus(tracker: GitStatusTracker): void {
  tracker.disposed = true;
  tracker.controller.abort();
}

/** Refresh asynchronously while synchronous editor renders keep using the last snapshot. */
export function ensureGitStatus(
  pi: ExtensionAPI,
  tracker: GitStatusTracker,
  onUpdate: () => void,
): void {
  if (tracker.disposed || tracker.pending ||
      (tracker.fetchedAt > 0 && Date.now() - tracker.fetchedAt < GIT_STATUS_TTL_MS)) return;

  // Keep one worker alive through overlapping invalidations. Every burst during
  // a read requests one follow-up read, never another concurrent Git process.
  tracker.pending = Promise.resolve().then(async () => {
    if (tracker.disposed) return;
    let generation: number;
    do {
      generation = tracker.generation;
      let counts: GitStatusCounts | undefined;
      try {
        const result = await pi.exec("git", ["--no-optional-locks", "status", "--porcelain"], {
          cwd: tracker.cwd,
          timeout: 1_000,
          signal: tracker.controller.signal,
        });
        if (result.code === 0 && !result.killed) counts = parseGitStatusOutput(result.stdout);
      } catch {
        // Keep the last known counts on errors, including spawn failures/timeouts.
      }
      if (tracker.disposed) return;
      if (counts) {
        tracker.counts = counts;
        tracker.status = generation === tracker.generation ? "fresh" : "stale";
      } else if (tracker.status !== "unknown") {
        tracker.status = "stale";
      }
      tracker.fetchedAt = Date.now();
      onUpdate();
    } while (!tracker.disposed && generation !== tracker.generation);
  }).finally(() => {
    tracker.pending = undefined;
  });
}
