import { AsyncLocalStorage } from "node:async_hooks";
import { lstat } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  registerSessionGroupCommands,
  type SessionGroupCommandController,
} from "./commands.ts";
import {
  SESSION_GROUPS_VERSION,
  type SessionGroupContextSnapshot,
  type SessionGroupMembership,
  type SessionGroupMetadata,
} from "./contracts.ts";
import {
  appendSessionGroupContext,
  appendUnavailableSessionGroupContext,
} from "./context.ts";
import { publishSessionGroupPresentation } from "./events.ts";
import {
  appendSessionGroupMembership,
  appendSessionGroupToolState,
  consumeSessionGroupTransition,
  readSessionGroupMembership,
  readSessionGroupMembershipFromFile,
  readSessionGroupToolState,
  recordSessionGroupTransition,
  resolveSessionStartMembership,
  type SessionStartMembershipResolution,
} from "./membership.ts";
import {
  SessionGroupContextEncodingError,
  SessionGroupContextMissingError,
  SessionGroupContextTooLargeError,
  SessionGroupNotFoundError,
  SessionGroupStore,
} from "./store.ts";
import {
  EDIT_GROUP_CONTEXT_TOOL_NAME,
  registerSessionGroupTool,
  type SessionGroupUserAuthorization,
} from "./tool.ts";

interface UnavailableContextSnapshot {
  groupId: string;
  groupName: string;
  reason: string;
  repairWithGroupEdit: boolean;
}

interface GroupInspection {
  groupId: string | null;
  metadata: SessionGroupMetadata | null;
  missing: boolean;
  error: Error | undefined;
}

function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  process.stderr.write(`${message}\n`);
}

async function inspectGroup(
  store: SessionGroupStore,
  groupId: string | null,
): Promise<GroupInspection> {
  if (groupId === null) {
    return { groupId: null, metadata: null, missing: false, error: undefined };
  }
  try {
    return {
      groupId,
      metadata: await store.readMembershipMetadata(groupId),
      missing: false,
      error: undefined,
    };
  } catch (error) {
    if (error instanceof SessionGroupNotFoundError) {
      return { groupId: null, metadata: null, missing: true, error: undefined };
    }
    return {
      groupId,
      metadata: null,
      missing: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function destinationSessionAlreadyExists(ctx: ExtensionContext): Promise<boolean> {
  const path = ctx.sessionManager.getSessionFile();
  if (!path) return false;
  try {
    const entry = await lstat(path);
    return entry.isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function sourceSessionFile(event: SessionStartEvent, ctx: ExtensionContext): string | undefined {
  if (event.previousSessionFile) return event.previousSessionFile;
  if (event.reason === "startup") return ctx.sessionManager.getHeader()?.parentSession;
  return undefined;
}

export default function sessionGroups(pi: ExtensionAPI): void {
  const store = new SessionGroupStore();
  let currentGroupId: string | null = null;
  let toolMembershipInitialized = false;
  let restoredContextEditToolActive: boolean | undefined;
  let currentContextSnapshot: SessionGroupContextSnapshot | undefined;
  let unavailableContextSnapshot: UnavailableContextSnapshot | undefined;
  let currentUserAuthorization: SessionGroupUserAuthorization | undefined;
  let pendingStreamingAuthorizations: SessionGroupUserAuthorization[] = [];
  const authorizationStorage = new AsyncLocalStorage<SessionGroupUserAuthorization>();

  const synchronizeContextEditTool = (groupId: string | null): void => {
    const activeTools = pi.getActiveTools();
    const isActive = activeTools.includes(EDIT_GROUP_CONTEXT_TOOL_NAME);
    const shouldBeActive = groupId !== null;
    if (isActive === shouldBeActive) return;
    pi.setActiveTools(
      shouldBeActive
        ? [...activeTools, EDIT_GROUP_CONTEXT_TOOL_NAME]
        : activeTools.filter((name) => name !== EDIT_GROUP_CONTEXT_TOOL_NAME),
    );
  };

  const present = (
    ctx: ExtensionContext,
    group: SessionGroupMetadata | null,
  ): void => {
    const nextGroupId = group?.id ?? null;
    if (!toolMembershipInitialized) {
      // Registration makes custom tools active by default. On grouped startup,
      // preserve Pi's current selection so /tools and CLI allowlists remain
      // authoritative across reload. Ungrouped startup must remove our tool.
      if (nextGroupId === null || restoredContextEditToolActive === false) {
        synchronizeContextEditTool(null);
      }
      toolMembershipInitialized = true;
    } else if (currentGroupId !== nextGroupId) {
      synchronizeContextEditTool(nextGroupId);
    }
    if (currentGroupId !== nextGroupId) {
      currentContextSnapshot = undefined;
      unavailableContextSnapshot = undefined;
    }
    currentGroupId = nextGroupId;
    publishSessionGroupPresentation(
      pi,
      ctx.sessionManager.getSessionId(),
      group === null ? null : { id: group.id, name: group.name },
    );
  };

  const presentUnavailable = (
    ctx: ExtensionContext,
    groupId: string,
    error: Error,
  ): void => {
    if (!toolMembershipInitialized) {
      // Keep an explicit inactive-tool selection when a grouped session reloads.
      if (restoredContextEditToolActive === false) synchronizeContextEditTool(null);
      toolMembershipInitialized = true;
    } else if (currentGroupId !== groupId) {
      synchronizeContextEditTool(groupId);
    }
    currentGroupId = groupId;
    publishSessionGroupPresentation(pi, ctx.sessionManager.getSessionId(), {
      id: groupId,
      name: "unavailable",
    });
    notify(
      ctx,
      `Could not load session group; membership is preserved but unavailable: ${error.message}`,
      "error",
    );
  };

  const controller: SessionGroupCommandController = {
    getCurrentGroupId: () => currentGroupId,
    setCurrentGroup: (ctx, group) => {
      appendSessionGroupMembership(pi, group?.id ?? null);
      present(ctx, group);
    },
    presentCurrentGroup: (ctx, group) => present(ctx, group),
  };

  registerSessionGroupCommands(pi, store, controller);
  registerSessionGroupTool(pi, store, {
    getCurrentGroupId: () => currentGroupId,
    getCurrentContextSnapshot: () => currentContextSnapshot,
    getCurrentUserAuthorization: () => currentUserAuthorization,
  });

  pi.on("input", (event) => {
    const authorization = { text: event.text, source: event.source };
    if (event.streamingBehavior) {
      pendingStreamingAuthorizations.push(authorization);
      if (pendingStreamingAuthorizations.length > 100) {
        pendingStreamingAuthorizations = pendingStreamingAuthorizations.slice(-100);
      }
    } else {
      authorizationStorage.enterWith(authorization);
    }
    return { action: "continue" };
  });

  pi.on("session_start", async (event, ctx) => {
    currentGroupId = null;
    toolMembershipInitialized = false;
    restoredContextEditToolActive = undefined;
    currentContextSnapshot = undefined;
    unavailableContextSnapshot = undefined;
    currentUserAuthorization = undefined;
    pendingStreamingAuthorizations = [];
    const entries = ctx.sessionManager.getEntries();
    let destinationMembership: SessionGroupMembership | undefined;
    try {
      destinationMembership = readSessionGroupMembership(entries);
    } catch (error) {
      present(ctx, null);
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
      return;
    }
    try {
      restoredContextEditToolActive = readSessionGroupToolState(entries)?.active;
    } catch (error) {
      notify(
        ctx,
        `Could not restore the session-group tool selection: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }

    const destinationInspection = await inspectGroup(
      store,
      destinationMembership?.groupId ?? null,
    );
    let effectiveDestinationMembership = destinationMembership;
    let staleDestination = false;
    if (destinationMembership?.groupId && destinationInspection.missing) {
      effectiveDestinationMembership =
        event.reason === "startup" &&
        ctx.sessionManager.getHeader()?.parentSession !== undefined
          ? undefined
          : { version: SESSION_GROUPS_VERSION, groupId: null };
      staleDestination = true;
    }

    let sourceMembership = consumeSessionGroupTransition(
      event,
      ctx.sessionManager.getSessionFile(),
    );
    if (
      sourceMembership === undefined &&
      (event.reason === "new" ||
        event.reason === "fork" ||
        (event.reason === "startup" && ctx.sessionManager.getHeader()?.parentSession))
    ) {
      const path = sourceSessionFile(event, ctx);
      if (path) {
        try {
          sourceMembership = readSessionGroupMembershipFromFile(path);
        } catch (error) {
          notify(
            ctx,
            `Could not inspect source-session group membership: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        }
      }
    }
    const sourceInspection = await inspectGroup(store, sourceMembership?.groupId ?? null);
    if (sourceInspection.missing) {
      notify(ctx, "The source session referenced a deleted group.", "warning");
    }

    let activeMetadata: SessionGroupMetadata | null = null;
    try {
      activeMetadata = await store.getActiveGroup();
    } catch (error) {
      notify(
        ctx,
        `Could not load the global active group: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }

    const resolution: SessionStartMembershipResolution = resolveSessionStartMembership({
      reason: event.reason,
      destinationMembership: effectiveDestinationMembership,
      destinationIsExistingSession: await destinationSessionAlreadyExists(ctx),
      destinationHasParent: ctx.sessionManager.getHeader()?.parentSession !== undefined,
      sourceGroupId: sourceInspection.groupId,
      activeGroupId: activeMetadata?.id ?? null,
    });
    if (resolution.shouldAppend || staleDestination) {
      appendSessionGroupMembership(pi, resolution.groupId);
    }

    if (staleDestination) {
      notify(
        ctx,
        resolution.groupId === null
          ? "This session referenced a deleted group and is now ungrouped."
          : "Ignored a deleted destination-group reference and applied the lifecycle fallback.",
        "warning",
      );
    }
    if (resolution.groupId === null) {
      present(ctx, null);
      return;
    }

    const matchingInspection = [
      destinationInspection,
      sourceInspection,
      activeMetadata
        ? {
            groupId: activeMetadata.id,
            metadata: activeMetadata,
            missing: false,
            error: undefined,
          }
        : undefined,
    ].find((inspection) => inspection?.groupId === resolution.groupId);
    const finalInspection =
      matchingInspection ?? (await inspectGroup(store, resolution.groupId));
    if (finalInspection.missing) {
      appendSessionGroupMembership(pi, null);
      present(ctx, null);
      notify(
        ctx,
        "The selected session group was deleted before it could be attached.",
        "warning",
      );
      return;
    }
    if (finalInspection.error) {
      presentUnavailable(ctx, resolution.groupId, finalInspection.error);
      return;
    }
    if (!finalInspection.metadata) {
      present(ctx, null);
      return;
    }

    present(ctx, finalInspection.metadata);
    if (resolution.origin === "active") {
      notify(
        ctx,
        `Joined global active session group '${finalInspection.metadata.name}'.`,
        "info",
      );
    } else if (resolution.origin === "inherited") {
      notify(ctx, `Inherited session group '${finalInspection.metadata.name}'.`, "info");
    } else if (
      resolution.origin === "stored" &&
      (event.reason === "resume" || event.reason === "startup")
    ) {
      notify(ctx, `Restored session group '${finalInspection.metadata.name}'.`, "info");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentUserAuthorization = authorizationStorage.getStore();
    if (currentGroupId === null) {
      // Other extensions and /tools can change the active set after startup.
      // Enforce zero Session Groups schema overhead at the provider boundary.
      synchronizeContextEditTool(null);
      return;
    }
    if (currentContextSnapshot?.id === currentGroupId) {
      return {
        systemPrompt: appendSessionGroupContext(
          event.systemPrompt,
          currentContextSnapshot,
        ),
      };
    }
    if (unavailableContextSnapshot?.groupId === currentGroupId) {
      return {
        systemPrompt: appendUnavailableSessionGroupContext(
          event.systemPrompt,
          unavailableContextSnapshot.groupName,
          unavailableContextSnapshot.reason,
          unavailableContextSnapshot.repairWithGroupEdit,
        ),
      };
    }

    let metadata: SessionGroupMetadata;
    try {
      metadata = await store.readMetadata(currentGroupId);
    } catch (error) {
      if (error instanceof SessionGroupNotFoundError) {
        appendSessionGroupMembership(pi, null);
        present(ctx, null);
        notify(
          ctx,
          "This session's group was deleted and the session is now ungrouped.",
          "warning",
        );
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      unavailableContextSnapshot = {
        groupId: currentGroupId,
        groupName: "unavailable group",
        reason,
        repairWithGroupEdit: false,
      };
      presentUnavailable(ctx, currentGroupId, error instanceof Error ? error : new Error(reason));
      return {
        systemPrompt: appendUnavailableSessionGroupContext(
          event.systemPrompt,
          unavailableContextSnapshot.groupName,
          reason,
          false,
        ),
      };
    }

    try {
      const snapshot = await store.reconcileContext(metadata.id);
      currentContextSnapshot = snapshot;
      present(ctx, metadata);
      return {
        systemPrompt: appendSessionGroupContext(event.systemPrompt, snapshot),
      };
    } catch (error) {
      if (error instanceof SessionGroupNotFoundError) {
        appendSessionGroupMembership(pi, null);
        present(ctx, null);
        notify(
          ctx,
          "This session's group was deleted and the session is now ungrouped.",
          "warning",
        );
        return;
      }

      const reason = error instanceof Error ? error.message : String(error);
      const repairable =
        error instanceof SessionGroupContextTooLargeError ||
        error instanceof SessionGroupContextEncodingError ||
        error instanceof SessionGroupContextMissingError;
      unavailableContextSnapshot = {
        groupId: metadata.id,
        groupName: metadata.name,
        reason,
        repairWithGroupEdit: repairable,
      };
      notify(
        ctx,
        `${reason}${repairable ? " Run /group edit to repair the shared context." : ""}`,
        "error",
      );
      return {
        systemPrompt: appendUnavailableSessionGroupContext(
          event.systemPrompt,
          metadata.name,
          reason,
          repairable,
        ),
      };
    }
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "user" || pendingStreamingAuthorizations.length === 0) {
      return;
    }
    const messageText =
      typeof event.message.content === "string"
        ? event.message.content
        : event.message.content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    const matchingIndexes = pendingStreamingAuthorizations.flatMap(
      (authorization, index) => (authorization.text === messageText ? [index] : []),
    );
    if (matchingIndexes.length !== 1) {
      currentUserAuthorization = undefined;
      if (matchingIndexes.length === 0) {
        pendingStreamingAuthorizations = [];
      } else {
        pendingStreamingAuthorizations = pendingStreamingAuthorizations.slice(
          matchingIndexes[matchingIndexes.length - 1]! + 1,
        );
      }
      return;
    }
    const matchIndex = matchingIndexes[0]!;
    currentUserAuthorization = pendingStreamingAuthorizations[matchIndex];
    pendingStreamingAuthorizations = pendingStreamingAuthorizations.slice(matchIndex + 1);
  });

  pi.on("agent_settled", () => {
    currentContextSnapshot = undefined;
    unavailableContextSnapshot = undefined;
    currentUserAuthorization = undefined;
    pendingStreamingAuthorizations = [];
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (currentGroupId !== null) {
      appendSessionGroupToolState(
        pi,
        pi.getActiveTools().includes(EDIT_GROUP_CONTEXT_TOOL_NAME),
      );
    }
    currentContextSnapshot = undefined;
    unavailableContextSnapshot = undefined;
    currentUserAuthorization = undefined;
    pendingStreamingAuthorizations = [];
    recordSessionGroupTransition(
      event,
      ctx.sessionManager.getSessionFile(),
      currentGroupId,
    );
  });
}
