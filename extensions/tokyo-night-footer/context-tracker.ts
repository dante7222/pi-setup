import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type BeforeAgentStartEvent,
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  assistantMatchesModel,
  type ContextTokenEstimate,
  estimateContextWithMessage,
  estimateLoadedContextTokens,
  estimateProjectedContext,
  isCompletedResponse,
  usageInputTokens,
} from "./context-usage.ts";
import type { StatusLineState } from "./state.ts";
import { contextLevel, contextWindow, formatTokens } from "./status-line.ts";

export function estimateLoadedContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  systemPromptOverride?: string,
): number | undefined {
  // Compat casts: Pi 1.3.0 types these as required, but Prime Agent's older
  // extension transport omits them. Keep the optional access for that target.
  const compatContext = ctx as { getSystemPrompt?: () => string };
  const systemPrompt = systemPromptOverride ?? compatContext.getSystemPrompt?.();
  if (systemPrompt === undefined) return undefined;

  const compatPi = pi as {
    getActiveTools?: ExtensionAPI["getActiveTools"];
    getAllTools?: ExtensionAPI["getAllTools"];
  };
  return estimateLoadedContextTokens(
    systemPrompt,
    compatPi.getAllTools?.() ?? [],
    compatPi.getActiveTools?.() ?? [],
  );
}

function compactionReserveTokens(
  pi: ExtensionAPI,
  model: { provider: string; id: string } | undefined,
): number | undefined {
  // Compat cast: Prime Agent's transport predates getSettings().
  const settings = (pi as { getSettings?: ExtensionAPI["getSettings"] }).getSettings?.();
  if (!settings) return DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const compaction = settings.compaction;
  if (compaction?.enabled === false) return undefined;
  // Same resolution order as SettingsManager.getCompactionReserveTokens(),
  // which rejects anything but a non-negative safe integer. Settings are
  // user-edited JSON; fall back to the default instead of throwing in render.
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const entry: unknown = model ? compaction?.modelOverrides?.[`${model.provider}/${model.id}`] : undefined;
  if (entry !== undefined && (typeof entry !== "object" || entry === null)) {
    return DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  }
  const override = (entry as { reserveTokens?: unknown } | undefined)?.reserveTokens;
  if (valid(override)) return override;
  if (override === undefined && valid(compaction?.reserveTokens)) return compaction.reserveTokens;
  return DEFAULT_COMPACTION_SETTINGS.reserveTokens;
}

/**
 * Per-request and per-branch bookkeeping that lives beside StatusLineState.
 * Event handlers in index.ts read and write these fields directly.
 */
export interface ContextTrackerState {
  requestStartedAt: number | undefined;
  requestFirstTokenAt: number | undefined;
  requestLoadedContextTokens: number | undefined;
  registeredLoadedContextTokens: number | undefined;
  runSystemPromptOptions: BeforeAgentStartEvent["systemPromptOptions"] | undefined;
  provenUsage: AssistantMessage | undefined;
  usageLoadedContextTokens: number | undefined;
  requestSystemPromptOverride: string | undefined;
  contextLeafId: string | null | undefined;
  projectionLeafId: string | null | undefined;
  contextRefreshQueued: boolean;
  contextRevision: number;
  requestContextRevision: number;
}

export interface ContextTracker {
  state: ContextTrackerState;
  recordResponseModel(ctx: ExtensionContext, message: AssistantMessage): void;
  contextModel(ctx: ExtensionContext): { provider: string; id: string } | undefined;
  rebuildProjectedContext(ctx: ExtensionContext): boolean;
  snapshotContextUsage(ctx: ExtensionContext): void;
  setContextEstimate(estimate: ContextTokenEstimate | undefined): void;
  resetCompactedContext(): void;
  refreshContextEntries(ctx: ExtensionContext): void;
  checkContextEntries(): void;
  updateLoadedContext(loadedContextTokens: number | undefined): void;
  refreshLoadedContext(ctx: ExtensionContext): void;
  refreshCompactionThreshold(ctx: ExtensionContext): void;
}

/** `requestRender` must call the footer's current render callback, if any. */
export function createContextTracker(
  pi: ExtensionAPI,
  state: StatusLineState,
  requestRender: () => void,
): ContextTracker {
  const tracking: ContextTrackerState = {
    requestStartedAt: undefined,
    requestFirstTokenAt: undefined,
    requestLoadedContextTokens: undefined,
    registeredLoadedContextTokens: undefined,
    runSystemPromptOptions: undefined,
    provenUsage: undefined,
    usageLoadedContextTokens: undefined,
    requestSystemPromptOverride: undefined,
    contextLeafId: undefined,
    projectionLeafId: undefined,
    contextRefreshQueued: false,
    contextRevision: 0,
    requestContextRevision: 0,
  };

  const recordResponseModel = (ctx: ExtensionContext, message: AssistantMessage): void => {
    if (!isCompletedResponse(message.stopReason) || message.api === "pi-virtual") return;
    const model = ctx.modelRegistry?.find(message.provider, message.model);
    state.responseModel = {
      provider: message.provider, id: message.model, name: model?.name ?? message.model,
      contextWindow: model?.contextWindow, thinkingLevel: message.thinkingLevel,
    };
  };

  const contextModel = (ctx: ExtensionContext) =>
    ctx.model?.api === "pi-virtual" ? state.responseModel : ctx.model;

  const rebuildProjectedContext = (ctx: ExtensionContext): boolean => {
    // Compat check: typed as required in 1.3.0, but Prime Agent's older
    // transport lacks projection; keep its existing fallback.
    if (!ctx.sessionManager.buildSessionProjection) return false;
    const projection = ctx.sessionManager.buildSessionProjection();
    tracking.projectionLeafId = ctx.sessionManager.getLeafId();
    const branch = ctx.sessionManager.getBranch();
    state.responseModel = undefined;
    for (let index = projection.messages.length - 1; index >= 0; index--) {
      const message = projection.messages[index]!;
      if (message.role === "assistant" && isCompletedResponse(message.stopReason) && message.api !== "pi-virtual") {
        recordResponseModel(ctx, message);
        break;
      }
    }
    const model = contextModel(ctx);
    const result = estimateProjectedContext(projection, branch, state.loadedContextTokens ?? 0, {
      provider: model?.provider, id: model?.id,
    }, state.authoritativeLoadedContextTokens);
    state.loadedContextTokens = result.loadedContextTokens;
    tracking.provenUsage = result.provenUsage;
    tracking.usageLoadedContextTokens = result.usageLoadedContextTokens;
    state.contextUsageInvalidated = result.invalidated;
    state.contextUsageSnapshot = undefined;
    if (result.invalidated) state.authoritativeLoadedContextTokens = undefined;
    state.contextEstimate = result.estimate;
    return true;
  };

  const snapshotContextUsage = (ctx: ExtensionContext): void => {
    if (rebuildProjectedContext(ctx)) return;
    const tokens = ctx.getContextUsage()?.tokens;
    state.contextUsageSnapshot = tokens;
    if (tokens === null || tokens === undefined || tokens === 0) return;
    // Pi's own usage fallback does not validate the active model identity.
    const manager = ctx.sessionManager;
    // Current Pi can walk just the trailing entries through O(1) lookups. Avoid
    // a second full getBranch() allocation; retain the older runtime fallback.
    // Compat cast: required in 1.3.0, absent on Prime Agent's transport.
    const getLeafEntry = (manager as {
      getLeafEntry?: ExtensionContext["sessionManager"]["getLeafEntry"];
    }).getLeafEntry;
    const branch = getLeafEntry ? undefined : manager.getBranch();
    let index = (branch?.length ?? 0) - 1;
    let entry = branch ? branch[index] : getLeafEntry?.call(manager);
    let excludedTokens = 0;
    while (entry) {
      // Pi's fallback estimator includes trailing persisted !! results even
      // though convertToLlm excludes them. Correct that on resume/tree/reload.
      if (entry.type === "message" && entry.message.role === "bashExecution" && entry.message.excludeFromContext) {
        excludedTokens += Math.ceil((entry.message.command.length + entry.message.output.length) / 4);
      }
      if (entry.type === "message" && entry.message.role === "assistant" &&
          isCompletedResponse(entry.message.stopReason) && usageInputTokens(entry.message.usage) > 0) {
        recordResponseModel(ctx, entry.message);
        const model = contextModel(ctx);
        if (!assistantMatchesModel(entry.message, { provider: model?.provider, id: model?.id })) {
          state.contextUsageSnapshot = undefined;
        }
        break;
      }
      entry = branch ? branch[--index] : entry.parentId === null ? undefined : manager.getEntry(entry.parentId);
    }
    if (state.contextUsageSnapshot !== undefined) {
      state.contextUsageSnapshot = Math.max(0, tokens - excludedTokens);
    }
  };

  const contextRenderKey = (estimate: ContextTokenEstimate | undefined): string => {
    if (!estimate) return "unknown";
    const window = state.runtimeContext ? contextWindow(state.runtimeContext, state) : 0;
    const level = contextLevel(estimate.tokens, window, state.compactionReserveTokens);
    return `${estimate.estimated ? "estimated" : "reported"}:${formatTokens(estimate.tokens)}:${level}`;
  };

  const setContextEstimate = (estimate: ContextTokenEstimate | undefined): void => {
    const previousKey = contextRenderKey(state.contextEstimate);
    state.contextEstimate = estimate;
    if (contextRenderKey(estimate) !== previousKey) requestRender();
  };

  const resetCompactedContext = (): void => {
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    tracking.requestStartedAt = undefined;
    tracking.requestFirstTokenAt = undefined;
    tracking.requestLoadedContextTokens = undefined;
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
  };

  const refreshContextEntries = (ctx: ExtensionContext): void => {
    const leafId = ctx.sessionManager.getLeafId?.();
    if (leafId === undefined || leafId === tracking.contextLeafId) return;
    let entry = leafId === null ? undefined : ctx.sessionManager.getEntry(leafId);
    let estimate = state.contextEstimate;
    if (!estimate && !state.contextUsageInvalidated && state.contextUsageSnapshot !== null) {
      const tokens = state.contextUsageSnapshot === 0
        ? state.loadedContextTokens
        : state.contextUsageSnapshot;
      if (tokens !== undefined) estimate = { tokens, estimated: true };
    }
    let changed = false;
    let contextEdited = false;
    let compacted = false;
    let systemChanged = false;
    // Inspect only newly appended entries, outside render/streaming. Boundary
    // compactions emit entry_appended, not the extension's session_compact event.
    while (entry && entry.id !== tracking.contextLeafId) {
      if (entry.type === "context_edit") contextEdited = true;
      if (entry.type === "compaction") compacted = true;
      if (entry.type === "message" && entry.message.role === "system") systemChanged = true;
      if (estimate && entry.type === "message" && entry.message.role === "bashExecution") {
        const next = estimateContextWithMessage(estimate, entry.message);
        changed ||= next !== estimate;
        estimate = next;
      }
      entry = entry.parentId === null ? undefined : ctx.sessionManager.getEntry(entry.parentId);
    }
    tracking.contextLeafId = leafId;
    if (contextEdited || compacted) tracking.contextRevision++;
    if (compacted) resetCompactedContext();
    if (contextEdited || compacted || systemChanged) {
      if (compacted) snapshotContextUsage(ctx);
      else rebuildProjectedContext(ctx);
      if (state.requestContextEstimate) state.requestContextEstimate = state.contextEstimate;
      requestRender();
    } else if (changed) setContextEstimate(estimate);
  };

  const checkContextEntries = (): void => {
    const ctx = state.runtimeContext;
    // Prime Agent may not expose leaf lookup. In Pi these are O(1) map accesses.
    if (!ctx?.sessionManager.getLeafId || tracking.contextRefreshQueued || !state.runtimeActive) return;
    if (ctx.sessionManager.getLeafId() === tracking.contextLeafId) return;
    tracking.contextRefreshQueued = true;
    const generation = state.runtimeGeneration;
    queueMicrotask(() => {
      tracking.contextRefreshQueued = false;
      if (!state.runtimeActive || generation !== state.runtimeGeneration) return;
      refreshContextEntries(ctx);
    });
  };

  const updateLoadedContext = (loadedContextTokens: number | undefined): void => {
    const previous = state.loadedContextTokens;
    state.loadedContextTokens = loadedContextTokens;
    if (
      previous === undefined ||
      loadedContextTokens === undefined ||
      previous === loadedContextTokens
    ) {
      return;
    }

    const delta = loadedContextTokens - previous;
    if (state.requestContextEstimate) {
      state.requestContextEstimate = {
        tokens: Math.max(0, state.requestContextEstimate.tokens + delta),
        estimated: true,
      };
    }
    if (state.contextEstimate) {
      setContextEstimate({
        tokens: Math.max(0, state.contextEstimate.tokens + delta),
        estimated: true,
      });
    }
  };

  const refreshLoadedContext = (ctx: ExtensionContext): void => {
    const registered = estimateLoadedContext(pi, ctx);
    // Registration metadata is a forecast for unsent changes, not a replacement
    // for canonical prepareLoadout descriptions or a request-local system state.
    if (registered !== undefined && tracking.registeredLoadedContextTokens !== undefined) {
      updateLoadedContext(Math.max(0, (state.loadedContextTokens ?? tracking.registeredLoadedContextTokens) +
        registered - tracking.registeredLoadedContextTokens));
    } else if (state.loadedContextTokens === undefined) updateLoadedContext(registered);
    tracking.registeredLoadedContextTokens = registered;
  };

  const refreshCompactionThreshold = (ctx: ExtensionContext): void => {
    state.compactionReserveTokens = compactionReserveTokens(pi, ctx.model);
  };

  return {
    state: tracking,
    recordResponseModel,
    contextModel,
    rebuildProjectedContext,
    snapshotContextUsage,
    setContextEstimate,
    resetCompactedContext,
    refreshContextEntries,
    checkContextEntries,
    updateLoadedContext,
    refreshLoadedContext,
    refreshCompactionThreshold,
  };
}
