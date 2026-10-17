import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_STATUS_TTL_MS = 1_000;
// Failed/timed-out reads back off exponentially so a huge or broken repository
// is not re-scanned every second. Explicit invalidations bypass the backoff.
const GIT_STATUS_BACKOFF_BASE_MS = 2_000;
const GIT_STATUS_BACKOFF_MAX_MS = 60_000;

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
  /** Consecutive failed reads; drives the retry backoff. */
  failures: number;
  /** Earliest time a non-forced refresh may run again after a failure. */
  retryAt: number;
  /** A branch change arrived during a read: its follow-up skips the backoff. */
  bypassPending: boolean;
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
    failures: 0,
    retryAt: 0,
    bypassPending: false,
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

/**
 * Mark the snapshot outdated. Routine invalidations (tool results, turns, user
 * shell commands) keep a failure backoff so slow repositories are not
 * re-scanned on every event; pass bypassBackoff for branch changes.
 */
export function invalidateGitStatus(tracker: GitStatusTracker, bypassBackoff = false): void {
  if (tracker.disposed) return;
  tracker.generation++;
  tracker.fetchedAt = 0;
  if (bypassBackoff) {
    tracker.retryAt = 0;
    tracker.failures = 0;
    tracker.bypassPending = true;
  }
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
  maxAgeMs = GIT_STATUS_TTL_MS,
): void {
  const now = Date.now();
  if (tracker.disposed || tracker.pending || now < tracker.retryAt ||
      (tracker.fetchedAt > 0 && now - tracker.fetchedAt < maxAgeMs)) return;

  // Keep one worker alive through overlapping invalidations. Every burst during
  // a read requests one follow-up read, never another concurrent Git process.
  tracker.pending = Promise.resolve().then(async () => {
    if (tracker.disposed) return;
    let generation: number;
    while (true) {
      generation = tracker.generation;
      tracker.bypassPending = false;
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
        tracker.failures = 0;
        tracker.retryAt = 0;
        tracker.counts = counts;
        tracker.status = generation === tracker.generation ? "fresh" : "stale";
      } else {
        if (tracker.status !== "unknown") tracker.status = "stale";
        tracker.failures++;
        tracker.retryAt = Date.now() + Math.min(
          GIT_STATUS_BACKOFF_MAX_MS,
          GIT_STATUS_BACKOFF_BASE_MS * 2 ** (tracker.failures - 1),
        );
      }
      tracker.fetchedAt = Date.now();
      onUpdate();
      if (tracker.disposed || generation === tracker.generation) break;
      // An invalidation arrived during this read. After a failure, honor the
      // backoff unless a branch change requested a bypass; leave the snapshot
      // expired so the first refresh after retryAt runs immediately.
      if (Date.now() < tracker.retryAt && !tracker.bypassPending) {
        tracker.fetchedAt = 0;
        break;
      }
    }
  }).finally(() => {
    tracker.pending = undefined;
  });
}
