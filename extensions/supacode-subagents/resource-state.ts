import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execRejectKilled } from "./exec-result.ts";
import {
  decodeSupacodeResourceId,
  findSupacodePathId,
  sameSupacodeUuid,
} from "./resource-id.ts";

export type SupacodeResourcePresence = "present" | "absent" | "unknown";

export interface SupacodeResourceObservationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function observeSupacodeWorktree(
  pi: ExtensionAPI,
  worktreeId: string,
  options: SupacodeResourceObservationOptions = {},
): Promise<SupacodeResourcePresence> {
  const listed = await execRejectKilled(
    pi,
    "supacode",
    ["worktree", "list"],
    { signal: options.signal, timeout: options.timeoutMs ?? 5000 },
  );
  if (listed.code !== 0) return "unknown";
  return findSupacodePathId(listed.stdout, decodeSupacodeResourceId(worktreeId))
    ? "present"
    : "absent";
}

export async function observeSupacodeTab(
  pi: ExtensionAPI,
  worktreeId: string,
  tabId: string,
  options: SupacodeResourceObservationOptions = {},
): Promise<SupacodeResourcePresence> {
  const listed = await execRejectKilled(
    pi,
    "supacode",
    ["tab", "list", "-w", worktreeId],
    { signal: options.signal, timeout: options.timeoutMs ?? 5000 },
  );
  if (listed.code === 0) {
    return listed.stdout
      .split(/\r?\n/)
      .some((listedId) => sameSupacodeUuid(listedId, tabId))
      ? "present"
      : "absent";
  }
  return await observeSupacodeWorktree(pi, worktreeId, options) === "absent"
    ? "absent"
    : "unknown";
}

export async function observeSupacodeSurface(
  pi: ExtensionAPI,
  worktreeId: string,
  tabId: string,
  surfaceId: string,
  options: SupacodeResourceObservationOptions = {},
): Promise<SupacodeResourcePresence> {
  const listed = await execRejectKilled(
    pi,
    "supacode",
    ["surface", "list", "-w", worktreeId, "-t", tabId],
    { signal: options.signal, timeout: options.timeoutMs ?? 5000 },
  );
  if (listed.code === 0) {
    return listed.stdout
      .split(/\r?\n/)
      .some((listedId) => sameSupacodeUuid(listedId, surfaceId))
      ? "present"
      : "absent";
  }
  return await observeSupacodeTab(pi, worktreeId, tabId, options) === "absent"
    ? "absent"
    : "unknown";
}
