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
}

export function createGitStatusTracker(cwd: string): GitStatusTracker {
  return {
    cwd,
    counts: { staged: 0, unstaged: 0, untracked: 0 },
    fetchedAt: 0,
    generation: 0,
    pending: undefined,
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
  tracker.generation++;
  tracker.fetchedAt = 0;
  tracker.pending = undefined;
}

/** Refresh asynchronously while synchronous editor renders keep using the last snapshot. */
export function ensureGitStatus(
  pi: ExtensionAPI,
  tracker: GitStatusTracker,
  onUpdate: () => void,
): void {
  if (tracker.pending || Date.now() - tracker.fetchedAt < GIT_STATUS_TTL_MS) return;

  const generation = tracker.generation;
  const refresh = (async () => {
    let counts: GitStatusCounts = { staged: 0, unstaged: 0, untracked: 0 };
    try {
      const result = await pi.exec("git", ["status", "--porcelain"], {
        cwd: tracker.cwd,
        timeout: 1_000,
      });
      if (result.code === 0) counts = parseGitStatusOutput(result.stdout);
    } catch {
      // A missing Git executable, non-repository cwd, or timeout renders as clean/no status.
    }

    if (generation !== tracker.generation) return;
    tracker.counts = counts;
    tracker.fetchedAt = Date.now();
    tracker.pending = undefined;
    onUpdate();
  })();

  tracker.pending = refresh;
}
