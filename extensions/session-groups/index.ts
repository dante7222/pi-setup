import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
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
  estimateSessionGroupContextTokens,
} from "./context.ts";
import { publishSessionGroupPresentation } from "./events.ts";
import {
  appendSessionGroupChangelogToolState,
  appendSessionGroupMembership,
  appendSessionGroupToolState,
  consumeSessionGroupTransition,
  readSessionGroupMembership,
  readSessionGroupMembershipFromFile,
  readSessionGroupChangelogToolState,
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
  GROUP_CHANGELOG_TOOL_NAME,
  registerSessionGroupChangelogTool,
  registerSessionGroupTool,
  type SessionGroupUserAuthorization,
} from "./tool.ts";

interface PendingSessionGroupInput {
  authorization: SessionGroupUserAuthorization;
  streaming: boolean;
  imageHash: string;
}

function fingerprintImages(images: InputEvent["images"]): string {
  return createHash("sha256").update(JSON.stringify(images ?? [])).digest("hex");
}

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
  let restoredChangelogToolActive: boolean | undefined;
  let currentContextSnapshot: SessionGroupContextSnapshot | undefined;
  let unavailableContextSnapshot: UnavailableContextSnapshot | undefined;
  let currentUserAuthorization: SessionGroupUserAuthorization | undefined;
  let pendingInputs: PendingSessionGroupInput[] = [];
  let pendingDelivery: PendingSessionGroupInput | undefined;
  let inputOverflow = false;
  const warnedContextKeys = new Set<string>();

  const warnContextOverhead = (snapshot: SessionGroupContextSnapshot, ctx: ExtensionContext): void => {
    const model = ctx.model;
    if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return;
    const tokens = estimateSessionGroupContextTokens(snapshot);
    if (tokens <= model.contextWindow * 0.1) return;
    const hash = createHash("sha256").update(appendSessionGroupContext("", snapshot)).digest("hex");
    const key = JSON.stringify([model.provider, model.id, model.contextWindow, hash]);
    if (warnedContextKeys.has(key)) return;
    warnedContextKeys.add(key);
    notify(
      ctx,
      `Shared session-group context uses approximately ${tokens} tokens (${Math.round(tokens / model.contextWindow * 100)}% of ${model.provider}/${model.id}'s ${model.contextWindow}-token window). Consider shortening it with /group edit; it has not been truncated or summarized.`,
      "warning",
    );
  };

  const sessionGroupToolNames = [
    EDIT_GROUP_CONTEXT_TOOL_NAME,
    GROUP_CHANGELOG_TOOL_NAME,
  ] as const;
  const setSessionGroupTools = (enabledNames: readonly string[]): void => {
    const activeTools = pi.getActiveTools();
    const enabled = new Set(enabledNames);
    const nextTools = [
      ...activeTools.filter(
        (name) => !sessionGroupToolNames.includes(name as typeof sessionGroupToolNames[number]),
      ),
      ...sessionGroupToolNames.filter((name) => enabled.has(name)),
    ];
    if (
      nextTools.length === activeTools.length &&
      nextTools.every((name, index) => name === activeTools[index])
    ) {
      return;
    }
    pi.setActiveTools(nextTools);
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
      if (nextGroupId === null) {
        setSessionGroupTools([]);
      } else {
        const enabled = pi.getActiveTools().filter(
          (name) =>
            sessionGroupToolNames.includes(name as typeof sessionGroupToolNames[number]) &&
            !(name === EDIT_GROUP_CONTEXT_TOOL_NAME && restoredContextEditToolActive === false) &&
            !(name === GROUP_CHANGELOG_TOOL_NAME && restoredChangelogToolActive === false),
        );
        setSessionGroupTools(enabled);
      }
      toolMembershipInitialized = true;
    } else if (currentGroupId !== nextGroupId) {
      setSessionGroupTools(nextGroupId === null ? [] : sessionGroupToolNames);
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
      const enabled = pi.getActiveTools().filter(
        (name) =>
          sessionGroupToolNames.includes(name as typeof sessionGroupToolNames[number]) &&
          !(name === EDIT_GROUP_CONTEXT_TOOL_NAME && restoredContextEditToolActive === false) &&
          !(name === GROUP_CHANGELOG_TOOL_NAME && restoredChangelogToolActive === false),
      );
      setSessionGroupTools(enabled);
      toolMembershipInitialized = true;
    } else if (currentGroupId !== groupId) {
      setSessionGroupTools(sessionGroupToolNames);
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
  const toolController = {
    getCurrentGroupId: () => currentGroupId,
    getCurrentContextSnapshot: () => currentContextSnapshot,
    getCurrentUserAuthorization: () => currentUserAuthorization,
  };
  registerSessionGroupTool(pi, store, toolController);
  registerSessionGroupChangelogTool(pi, store, toolController);

  pi.on("input", (event) => {
    // ExtensionRunner awaits *every* preceding handler, even synchronous ones.
    // ALS.enterWith here cannot authorize the caller's later continuation.
    // Correlate observed input -> final prompt -> delivered user message instead.
    // Pi 0.85.0 exposes neither an input ID nor original text/transform history:
    // earlier transforms are indistinguishable from direct input. Execution-time
    // confirmation remains mandatory; later transforms/expansion fail matching.
    if (pendingInputs.length >= 100) {
      inputOverflow = true;
      pendingInputs = [];
      pendingDelivery = undefined;
      currentUserAuthorization = undefined;
    }
    if (!inputOverflow) {
      pendingInputs.push({
        authorization: { text: event.text, source: event.source },
        streaming: event.streamingBehavior !== undefined,
        imageHash: fingerprintImages(event.images),
      });
    }
    return { action: "continue" };
  });

  pi.on("session_start", async (event, ctx) => {
    currentGroupId = null;
    toolMembershipInitialized = false;
    restoredContextEditToolActive = undefined;
    restoredChangelogToolActive = undefined;
    currentContextSnapshot = undefined;
    unavailableContextSnapshot = undefined;
    currentUserAuthorization = undefined;
    pendingInputs = [];
    pendingDelivery = undefined;
    inputOverflow = false;
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
        `Could not restore the context-edit tool selection: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    try {
      restoredChangelogToolActive =
        readSessionGroupChangelogToolState(entries)?.active;
    } catch (error) {
      notify(
        ctx,
        `Could not restore the changelog tool selection: ${error instanceof Error ? error.message : String(error)}`,
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
      ctx.sessionManager,
    );
    if (
      sourceMembership === undefined &&
      !(event.reason === "startup" && effectiveDestinationMembership !== undefined) &&
      (event.reason === "new" ||
        event.reason === "fork" ||
        (event.reason === "startup" && ctx.sessionManager.getHeader()?.parentSession))
    ) {
      const path = sourceSessionFile(event, ctx);
      if (path) {
        try {
          sourceMembership = await readSessionGroupMembershipFromFile(path);
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
    currentUserAuthorization = undefined;
    pendingDelivery = undefined;
    const idleInputs = pendingInputs.filter(({ streaming }) => !streaming);
    // More than one outstanding input is ambiguous even with different text:
    // a later transform could reproduce an earlier handled request verbatim.
    if (
      !inputOverflow && idleInputs.length === 1 &&
      idleInputs[0]!.authorization.text === event.prompt &&
      idleInputs[0]!.imageHash === fingerprintImages(event.images)
    ) pendingDelivery = idleInputs[0];
    // Keep streaming observations until actual delivery; idle observations are
    // consumed together so handled/stale inputs cannot authorize a later run.
    pendingInputs = pendingInputs.filter(({ streaming }) => streaming);
    if (currentGroupId === null) {
      // Other extensions and /tools can change the active set after startup.
      // Enforce zero Session Groups schema overhead at the provider boundary.
      setSessionGroupTools([]);
      return;
    }
    if (currentContextSnapshot?.id === currentGroupId) {
      warnContextOverhead(currentContextSnapshot, ctx);
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
      warnContextOverhead(snapshot, ctx);
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
    if (event.message.role !== "user") return;
    currentUserAuthorization = undefined;
    const messageText =
      typeof event.message.content === "string"
        ? event.message.content
        : event.message.content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    const candidates = [
      ...(pendingDelivery ? [pendingDelivery] : []),
      ...pendingInputs.filter(({ streaming }) => streaming),
    ];
    const images = typeof event.message.content === "string"
      ? undefined
      : event.message.content.filter((block) => block.type === "image");
    if (
      !inputOverflow && candidates.length === 1 &&
      candidates[0]!.authorization.text === messageText &&
      candidates[0]!.authorization.source !== "extension" &&
      candidates[0]!.imageHash === fingerprintImages(images)
    ) {
      currentUserAuthorization = candidates[0]!.authorization;
    }
    pendingDelivery = undefined;
    // Without delivery IDs, multiple queued/handled/transformed observations
    // cannot be safely disambiguated; consume them together and require fresh input.
    pendingInputs = [];
  });

  pi.on("model_select", (_event, ctx) => {
    if (currentContextSnapshot) warnContextOverhead(currentContextSnapshot, ctx);
  });

  pi.on("agent_settled", () => {
    currentContextSnapshot = undefined;
    unavailableContextSnapshot = undefined;
    currentUserAuthorization = undefined;
    pendingInputs = [];
    pendingDelivery = undefined;
    inputOverflow = false;
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (currentGroupId !== null) {
      const activeTools = pi.getActiveTools();
      appendSessionGroupToolState(
        pi,
        activeTools.includes(EDIT_GROUP_CONTEXT_TOOL_NAME),
      );
      appendSessionGroupChangelogToolState(
        pi,
        activeTools.includes(GROUP_CHANGELOG_TOOL_NAME),
      );
    }
    currentContextSnapshot = undefined;
    unavailableContextSnapshot = undefined;
    currentUserAuthorization = undefined;
    pendingInputs = [];
    pendingDelivery = undefined;
    inputOverflow = false;
    if (event.reason === "new" && !event.targetSessionFile && currentGroupId !== null) {
      notify(ctx, "Pi cannot safely correlate group inheritance across in-memory /new. Use /group join in the new session if no global active group is selected.", "warning");
    }
    recordSessionGroupTransition(
      event,
      ctx.sessionManager.getSessionFile(),
      currentGroupId,
      ctx.sessionManager,
    );
  });
}
