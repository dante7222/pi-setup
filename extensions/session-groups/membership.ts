import { AsyncLocalStorage } from "node:async_hooks";
import {
  SessionManager,
  type ExtensionAPI,
  type SessionEntry,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  parseSessionGroupMembership,
  parseSessionGroupToolState,
  SESSION_GROUP_CHANGELOG_TOOL_STATE_ENTRY,
  SESSION_GROUP_MEMBERSHIP_ENTRY,
  SESSION_GROUP_TOOL_STATE_ENTRY,
  SESSION_GROUPS_VERSION,
  type SessionGroupMembership,
  type SessionGroupToolState,
} from "./contracts.ts";

const HANDOFF_MAX_AGE_MS = 60_000;

interface SessionGroupTransitionHandoff {
  version: 1;
  reason: "new" | "fork";
  sourceSessionFile: string | undefined;
  targetSessionFile: string | undefined;
  sourceGroupId: string | null;
  createdAt: number;
  consumed: boolean;
}

interface SessionGroupGlobalState {
  __ventrisSessionGroupTransitionStorage?: AsyncLocalStorage<SessionGroupTransitionHandoff>;
}

function transitionStorage(): AsyncLocalStorage<SessionGroupTransitionHandoff> {
  const globalState = globalThis as typeof globalThis & SessionGroupGlobalState;
  globalState.__ventrisSessionGroupTransitionStorage ??=
    new AsyncLocalStorage<SessionGroupTransitionHandoff>();
  return globalState.__ventrisSessionGroupTransitionStorage;
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
  origin: "stored" | "active" | "inherited" | "ungrouped";
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

export function readSessionGroupMembershipFromFile(
  sessionFile: string,
): SessionGroupMembership | undefined {
  return readSessionGroupMembership(SessionManager.open(sessionFile).getEntries());
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
): void {
  if (event.reason !== "new" && event.reason !== "fork") return;
  transitionStorage().enterWith({
    version: 1,
    reason: event.reason,
    sourceSessionFile,
    targetSessionFile: event.targetSessionFile,
    sourceGroupId,
    createdAt: Date.now(),
    consumed: false,
  });
}

export function consumeSessionGroupTransition(
  event: SessionStartEvent,
  destinationSessionFile: string | undefined,
): SessionGroupMembership | undefined {
  if (event.reason !== "new" && event.reason !== "fork") return undefined;
  const handoff = transitionStorage().getStore();
  if (
    !handoff ||
    handoff.consumed ||
    handoff.version !== 1 ||
    handoff.reason !== event.reason ||
    Date.now() - handoff.createdAt > HANDOFF_MAX_AGE_MS ||
    handoff.sourceSessionFile !== event.previousSessionFile ||
    handoff.targetSessionFile !== destinationSessionFile
  ) {
    return undefined;
  }

  handoff.consumed = true;
  return { version: SESSION_GROUPS_VERSION, groupId: handoff.sourceGroupId };
}

export function resolveSessionStartMembership(
  input: SessionStartMembershipInput,
): SessionStartMembershipResolution {
  const stored = input.destinationMembership;
  if (input.reason === "resume" || input.reason === "reload") {
    return {
      groupId: stored?.groupId ?? null,
      shouldAppend: stored === undefined,
      origin: stored?.groupId ? "stored" : "ungrouped",
    };
  }

  if (input.reason === "startup") {
    if (stored !== undefined) {
      return {
        groupId: stored.groupId,
        shouldAppend: false,
        origin: stored.groupId ? "stored" : "ungrouped",
      };
    }
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
