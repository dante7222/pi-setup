import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  readSessionGroupMembership,
  readSessionGroupMembershipFromFile,
} from "../session-groups/membership.ts";

/**
 * Resolve only membership metadata, never the global active group or transcript
 * text. Pass the parent's entries in chronological order. Session Groups stores
 * session-wide membership: callers should pass getEntries() when available,
 * rather than a compacted context or a branch omitting the latest membership.
 * Invalid membership throws rather than reviving an older group.
 */
export function parentGroupFromBranch(entries: readonly SessionEntry[]): string {
  return readSessionGroupMembership(entries)?.groupId ?? "none";
}

/**
 * CLI counterpart: read-only, non-symlink, bounded-memory JSONL inspection.
 * No path/no membership means "none". Source I/O, oversized-line and invalid
 * membership errors propagate, so dispatch cannot silently inherit another
 * group. Like Pi, the reader skips malformed JSONL (including unfinished tails).
 * Only a group ID leaves this helper; parent messages are never copied to tasks.
 * Group existence is validated by the worker's session-start controller.
 */
export async function parentGroupFromFile(path: string | undefined): Promise<string> {
  if (path === undefined) return "none";
  return (await readSessionGroupMembershipFromFile(path))?.groupId ?? "none";
}
