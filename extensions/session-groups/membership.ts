import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  isSessionGroupId,
  parseSessionGroupMembership,
  parseSessionGroupToolState,
  SESSION_GROUP_CHANGELOG_TOOL_STATE_ENTRY,
  SESSION_GROUP_MEMBERSHIP_ENTRY,
  SESSION_GROUP_TOOL_STATE_ENTRY,
  SESSION_GROUPS_VERSION,
  type SessionGroupMembership,
  type SessionGroupToolState,
} from "./contracts.ts";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

const HANDOFF_MAX_AGE_MS = 60_000;

interface SessionGroupTransitionHandoff {
  version: 1;
  reason: "new" | "fork";
  sourceSessionFile: string | undefined;
  targetSessionFile: string | undefined;
  sourceGroupId: string | null;
  createdAt: number;
  ambiguous?: boolean;
}

interface SessionGroupHandoffs {
  files: Map<string, SessionGroupTransitionHandoff>;
  managers: WeakMap<ReadonlySessionManager, SessionGroupTransitionHandoff>;
}

interface SessionGroupGlobalState {
  __ventrisSessionGroupHandoffsV2?: SessionGroupHandoffs;
}

function transitionStorage(): SessionGroupHandoffs {
  // Survives extension module reload, but never uses an ambient "last handoff".
  const globalState = globalThis as typeof globalThis & SessionGroupGlobalState;
  return (globalState.__ventrisSessionGroupHandoffsV2 ??= {
    files: new Map(),
    managers: new WeakMap(),
  });
}

export interface SessionStartMembershipInput {
  reason: SessionStartEvent["reason"];
  destinationMembership: SessionGroupMembership | undefined;
  destinationIsExistingSession: boolean;
  destinationHasParent: boolean;
  sourceGroupId: string | null;
  activeGroupId: string | null;
}

export interface SessionStartMembershipResolution {
  groupId: string | null;
  shouldAppend: boolean;
  origin: "stored" | "active" | "inherited" | "ungrouped" | "worker";
}

export class SessionGroupMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGroupMembershipError";
  }
}

export function readSessionGroupMembership(
  entries: readonly SessionEntry[],
): SessionGroupMembership | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.customType !== SESSION_GROUP_MEMBERSHIP_ENTRY) {
      continue;
    }
    const membership = parseSessionGroupMembership(entry.data);
    if (!membership) {
      throw new SessionGroupMembershipError(
        `Invalid ${SESSION_GROUP_MEMBERSHIP_ENTRY} entry at ${entry.id}.`,
      );
    }
    return membership;
  }
  return undefined;
}

export async function readSessionGroupMembershipFromFile(
  sessionFile: string,
): Promise<SessionGroupMembership | undefined> {
  // SessionManager.open migrates legacy files and rewrites empty files. This
  // inspection must never mutate a source session, including its header.
  const before = await lstat(sessionFile);
  if (!before.isFile()) {
    throw new SessionGroupMembershipError("Source session must be a regular, non-symlink file.");
  }
  const file = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new SessionGroupMembershipError("Source session changed while opening it.");
    }
    // Scan backwards: the latest custom entry is session-wide, not branch-local.
    // Fixed chunks and a bounded line avoid loading an entire parent transcript.
    // An uninspectable line fails closed instead of silently restoring stale state.
    const maxLineBytes = 8 * 1024 * 1024;
    const buffer = Buffer.alloc(64 * 1024);
    let position = stat.size;
    let fragments: Buffer[] = [];
    let lineBytes = 0;
    const finishLine = (): SessionGroupMembership | undefined => {
      const line = Buffer.concat(fragments.reverse(), lineBytes).toString("utf8");
      fragments = [];
      lineBytes = 0;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // Pi also skips blank/malformed JSONL lines (including an unfinished tail).
        return undefined;
      }
      if (
        !entry || typeof entry !== "object" ||
        !("type" in entry) || entry.type !== "custom" ||
        !("customType" in entry) || entry.customType !== SESSION_GROUP_MEMBERSHIP_ENTRY
      ) return undefined;
      const membership = parseSessionGroupMembership("data" in entry ? entry.data : undefined);
      if (!membership) {
        throw new SessionGroupMembershipError(`Invalid ${SESSION_GROUP_MEMBERSHIP_ENTRY} entry in source session.`);
      }
      return membership;
    };
    while (position > 0) {
      const length = Math.min(position, buffer.length);
      position -= length;
      const { bytesRead } = await file.read(buffer, 0, length, position);
      if (bytesRead !== length) {
        throw new SessionGroupMembershipError("Source session changed while reading it.");
      }
      let end = length;
      for (let index = length - 1; index >= -1; index--) {
        if (index !== -1 && buffer[index] !== 0x0a) continue;
        const fragment = buffer.subarray(index + 1, end);
        lineBytes += fragment.length;
        if (lineBytes > maxLineBytes) {
          throw new SessionGroupMembershipError("Source session line exceeds the 8 MiB inspection limit.");
        }
        if (fragment.length) fragments.push(Buffer.from(fragment));
        if (index !== -1) {
          const membership = finishLine();
          if (membership !== undefined) return membership;
        }
        end = index;
      }
    }
    return finishLine();
  } finally {
    await file.close();
  }
}

function readToolState(
  entries: readonly SessionEntry[],
  customType: string,
): SessionGroupToolState | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.customType !== customType) continue;
    const state = parseSessionGroupToolState(entry.data);
    if (!state) {
      throw new SessionGroupMembershipError(
        `Invalid ${customType} entry at ${entry.id}.`,
      );
    }
    return state;
  }
  return undefined;
}

export function readSessionGroupToolState(
  entries: readonly SessionEntry[],
): SessionGroupToolState | undefined {
  return readToolState(entries, SESSION_GROUP_TOOL_STATE_ENTRY);
}

export function readSessionGroupChangelogToolState(
  entries: readonly SessionEntry[],
): SessionGroupToolState | undefined {
  return readToolState(entries, SESSION_GROUP_CHANGELOG_TOOL_STATE_ENTRY);
}

export function recordSessionGroupTransition(
  event: SessionShutdownEvent,
  sourceSessionFile: string | undefined,
  sourceGroupId: string | null,
  sourceManager: ReadonlySessionManager,
): void {
  if (event.reason !== "new" && event.reason !== "fork") return;
  const storage = transitionStorage();
  const handoff: SessionGroupTransitionHandoff = {
    version: 1,
    reason: event.reason,
    sourceSessionFile,
    targetSessionFile: event.targetSessionFile,
    sourceGroupId,
    createdAt: Date.now(),
  };
  if (event.targetSessionFile) {
    for (const [path, pending] of storage.files) {
      if (Date.now() - pending.createdAt > HANDOFF_MAX_AGE_MS) storage.files.delete(path);
    }
    // Target filenames contain newly generated session UUIDs. A collision is
    // ambiguous; never choose whichever source happened to shut down last.
    if (storage.files.size >= 1000) return;
    handoff.ambiguous = storage.files.has(event.targetSessionFile);
    storage.files.set(event.targetSessionFile, handoff);
  } else if (event.reason === "fork") {
    // Pi 0.85.0 reuses this exact manager for ephemeral fork/clone. Ephemeral
    // /new creates a different manager and exposes no safe shared runtime ID.
    const previous = storage.managers.get(sourceManager);
    handoff.ambiguous = previous !== undefined && Date.now() - previous.createdAt <= HANDOFF_MAX_AGE_MS;
    storage.managers.set(sourceManager, handoff);
  }
}

export function consumeSessionGroupTransition(
  event: SessionStartEvent,
  destinationSessionFile: string | undefined,
  destinationManager: ReadonlySessionManager,
): SessionGroupMembership | undefined {
  if (event.reason !== "new" && event.reason !== "fork") return undefined;
  const storage = transitionStorage();
  const handoff = destinationSessionFile
    ? storage.files.get(destinationSessionFile)
    : storage.managers.get(destinationManager);
  if (
    !handoff ||
    handoff.ambiguous ||
    handoff.version !== 1 ||
    handoff.reason !== event.reason ||
    Date.now() - handoff.createdAt > HANDOFF_MAX_AGE_MS ||
    handoff.sourceSessionFile !== event.previousSessionFile ||
    handoff.targetSessionFile !== destinationSessionFile
  ) {
    return undefined;
  }

  if (destinationSessionFile) storage.files.delete(destinationSessionFile);
  else storage.managers.delete(destinationManager);
  return { version: SESSION_GROUPS_VERSION, groupId: handoff.sourceGroupId };
}

/**
 * Herdr's PI_HERDR_GROUP is a resolved launch policy ("none" or a group UUID),
 * never "inherit": the dispatcher resolves inheritance from parent metadata.
 * With PI_HERDR_WORKER=1, missing/invalid policy fails closed to ungrouped, and
 * neither the global active group nor source-session fallback can override it.
 * The session-start controller validates the selected group's existence before
 * presentation/context injection; deleted groups become ungrouped, not active.
 *
 * Launch policy initializes membership only. Startup with stored membership and
 * resume/reload preserve it (including an explicit null), even if launch policy
 * changes. Existing legacy sessions without membership remain ungrouped. Use
 * /group join or /group leave to change a persistent worker's stored membership.
 * New/fork lifecycle destinations use the worker launch policy again.
 */
export function resolveSessionStartMembership(
  input: SessionStartMembershipInput,
  environment: Partial<Pick<NodeJS.ProcessEnv, "PI_HERDR_WORKER" | "PI_HERDR_GROUP">> = process.env,
): SessionStartMembershipResolution {
  const stored = input.destinationMembership;
  if (
    input.reason === "resume" || input.reason === "reload" ||
    (input.reason === "startup" && stored !== undefined)
  ) {
    return {
      groupId: stored?.groupId ?? null,
      shouldAppend: stored === undefined,
      origin: stored?.groupId ? "stored" : "ungrouped",
    };
  }

  if (environment.PI_HERDR_WORKER === "1") {
    const existingUngrouped = input.reason === "startup" && input.destinationIsExistingSession;
    const groupId = !existingUngrouped && isSessionGroupId(environment.PI_HERDR_GROUP)
      ? environment.PI_HERDR_GROUP
      : null;
    return { groupId, shouldAppend: true, origin: groupId === null ? "ungrouped" : "worker" };
  }

  if (input.reason === "startup") {
    if (input.destinationHasParent) {
      return {
        groupId: input.sourceGroupId ?? input.activeGroupId,
        shouldAppend: true,
        origin:
          input.sourceGroupId !== null
            ? "inherited"
            : input.activeGroupId !== null
              ? "active"
              : "ungrouped",
      };
    }
    if (input.destinationIsExistingSession) {
      return { groupId: null, shouldAppend: true, origin: "ungrouped" };
    }
    return {
      groupId: input.activeGroupId,
      shouldAppend: true,
      origin: input.activeGroupId === null ? "ungrouped" : "active",
    };
  }

  if (input.reason === "new") {
    const groupId = input.activeGroupId ?? input.sourceGroupId;
    return {
      groupId,
      shouldAppend: true,
      origin:
        input.activeGroupId !== null
          ? "active"
          : input.sourceGroupId !== null
            ? "inherited"
            : "ungrouped",
    };
  }

  const groupId = input.sourceGroupId ?? input.activeGroupId;
  return {
    groupId,
    shouldAppend: true,
    origin:
      input.sourceGroupId !== null
        ? "inherited"
        : input.activeGroupId !== null
          ? "active"
          : "ungrouped",
  };
}

function appendToolState(
  pi: ExtensionAPI,
  customType: string,
  active: boolean,
): SessionGroupToolState {
  const state = parseSessionGroupToolState({
    version: SESSION_GROUPS_VERSION,
    active,
  });
  if (!state) throw new SessionGroupMembershipError("Invalid session-group tool state.");
  pi.appendEntry<SessionGroupToolState>(customType, state);
  return state;
}

export function appendSessionGroupToolState(
  pi: ExtensionAPI,
  active: boolean,
): SessionGroupToolState {
  return appendToolState(pi, SESSION_GROUP_TOOL_STATE_ENTRY, active);
}

export function appendSessionGroupChangelogToolState(
  pi: ExtensionAPI,
  active: boolean,
): SessionGroupToolState {
  return appendToolState(pi, SESSION_GROUP_CHANGELOG_TOOL_STATE_ENTRY, active);
}

export function appendSessionGroupMembership(
  pi: ExtensionAPI,
  groupId: string | null,
): SessionGroupMembership {
  const membership = parseSessionGroupMembership({
    version: SESSION_GROUPS_VERSION,
    groupId,
  });
  if (!membership) throw new SessionGroupMembershipError("Invalid session-group membership.");
  pi.appendEntry<SessionGroupMembership>(SESSION_GROUP_MEMBERSHIP_ENTRY, membership);
  return membership;
}
