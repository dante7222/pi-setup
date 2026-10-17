import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  firstUserPrompt,
  generateAgentTitle,
  normalizeAgentTitle,
} from "./agent-title.ts";
import { createContextTracker, estimateLoadedContext } from "./context-tracker.ts";
import {
  assistantMatchesModel,
  estimateContextWithMessage,
  estimateRequestContextTokens,
  estimateStreamingContextTokens,
  estimateSystemContextTokens,
  isCompletedResponse,
  usageInputTokens,
  usageTokenTotal,
} from "./context-usage.ts";
import { EmptyFooter, TokyoNightStatusEditor } from "./editor.ts";
import {
  createGitStatusTracker,
  disposeGitStatus,
  ensureGitStatus,
  invalidateGitStatus,
} from "./git-status.ts";
import type { StatusLineState } from "./state.ts";
import {
  LEGACY_SESSION_NAME_STATUS_KEY,
  LEGACY_TPS_STATUS_KEY,
  PRIME_AGENT_WIDGET_KEY,
  updatePrimeAgentWidget,
} from "./status-line.ts";
import {
  responseTimeToFirstToken,
  responseTokensPerSecond,
} from "./throughput.ts";

export { findBottomBorderIndex, styleCaret } from "./editor.ts";
export {
  contextLevel,
  formatTokens,
  sanitizeStatusText,
  truncatePath,
  truncateSessionTitle,
} from "./status-line.ts";

const TITLE_GENERATION_TIMEOUT_MS = 20_000;
// Event-driven refreshes (tools, turns, branch changes) invalidate immediately.
// Renders only catch external edits, so they may reuse a much older snapshot.
const RENDER_GIT_STATUS_MAX_AGE_MS = 10_000;
const MAX_TITLE_ATTEMPTS = 3;

export default function (pi: ExtensionAPI): void {
  const state: StatusLineState = {
    latestTps: undefined,
    latestTtftMs: undefined,
    contextEstimate: undefined,
    responseModel: undefined,
    requestContextEstimate: undefined,
    loadedContextTokens: undefined,
    authoritativeLoadedContextTokens: undefined,
    streamingContextChars: 0,
    streamingContentChars: new Map(),
    contextUsageInvalidated: false,
    contextUsageSnapshot: undefined,
    compactionReserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    footerData: undefined,
    gitStatus: createGitStatusTracker(process.cwd()),
    runtimeContext: undefined,
    primeAgentContext: undefined,
    primeAgentWidgetText: undefined,
    runtimeActive: false,
    runtimeGeneration: 0,
    titleGenerationAbortController: new AbortController(),
    titleGenerationInFlight: false,
    titleGenerationAttempts: 0,
  };
  let requestRender: (() => void) | undefined;
  let requestHeadersObserved = false;
  let requestClockLocked = false;
  const bashRefreshTimers = new Set<ReturnType<typeof setTimeout>>();
  const tracker = createContextTracker(pi, state, () => requestRender?.());
  const tracking = tracker.state;
  const {
    recordResponseModel,
    contextModel,
    snapshotContextUsage,
    setContextEstimate,
    resetCompactedContext,
    refreshContextEntries,
    rebuildProjectedContext,
    checkContextEntries,
    updateLoadedContext,
    refreshLoadedContext,
    refreshCompactionThreshold,
  } = tracker;

  const refreshGitStatus = (force = false, bypassBackoff = false) => {
    if (!state.runtimeActive) return;
    // Pi resolves the branch from .git/HEAD without spawning. No branch means
    // no repository: never spawn `git status` there. Prime Agent has no footer
    // data provider, so it keeps probing (with failure backoff).
    if (state.footerData && !state.footerData.getGitBranch()) return;
    const gitTracker = state.gitStatus;
    if (force) invalidateGitStatus(gitTracker, bypassBackoff);
    ensureGitStatus(pi, gitTracker, () => {
      if (state.gitStatus === gitTracker) requestRender?.();
    }, force ? undefined : RENDER_GIT_STATUS_MAX_AGE_MS);
  };

  const maybeGenerateAgentTitle = (
    ctx: ExtensionContext,
    submittedPrompt?: string,
  ): void => {
    if (!state.runtimeActive || state.titleGenerationInFlight || pi.getSessionName()) return;
    // Each attempt is an extra LLM call; a model that keeps returning
    // unusable titles must not cost one per turn for the whole session.
    if (state.titleGenerationAttempts >= MAX_TITLE_ATTEMPTS) return;

    const prompt =
      (submittedPrompt === undefined ? undefined : normalizeAgentTitle(submittedPrompt)) ??
      firstUserPrompt(ctx.sessionManager.getBranch());
    const model = ctx.model;
    if (!prompt || !model) return;

    const runtimeGeneration = state.runtimeGeneration;
    const signal = AbortSignal.any([
      state.titleGenerationAbortController.signal,
      AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS),
    ]);
    state.titleGenerationInFlight = true;
    state.titleGenerationAttempts++;

    void generateAgentTitle(ctx.modelRegistry, model, prompt, signal)
      .then((title) => {
        if (
          !title ||
          signal.aborted ||
          !state.runtimeActive ||
          state.runtimeGeneration !== runtimeGeneration
        ) {
          return;
        }
        if (!pi.getSessionName()) pi.setSessionName(title);
      })
      .catch(() => {
        // Title generation is best-effort; leave the session unnamed so a later
        // submitted prompt can retry.
      })
      .finally(() => {
        if (state.runtimeGeneration === runtimeGeneration) {
          state.titleGenerationInFlight = false;
        }
      });
  };

  pi.on("session_start", (_event, ctx) => {
    // Compat cast: Prime Agent 0.7 predates ctx.mode. Current Pi uses it to distinguish the
    // TUI from other UI-capable transports such as RPC.
    const mode = (ctx as { mode?: string }).mode;
    if (mode === undefined ? !ctx.hasUI : mode !== "tui") return;

    disposeGitStatus(state.gitStatus);
    for (const timer of bashRefreshTimers) clearTimeout(timer);
    bashRefreshTimers.clear();
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
    state.responseModel = undefined;
    state.loadedContextTokens = estimateLoadedContext(pi, ctx);
    tracking.registeredLoadedContextTokens = state.loadedContextTokens;
    tracking.runSystemPromptOptions = undefined;
    tracking.provenUsage = undefined;
    tracking.usageLoadedContextTokens = undefined;
    tracking.requestSystemPromptOverride = undefined;
    snapshotContextUsage(ctx);
    tracking.contextLeafId = ctx.sessionManager.getLeafId?.();
    refreshCompactionThreshold(ctx);
    state.footerData = undefined;
    state.gitStatus = createGitStatusTracker(ctx.cwd);
    state.runtimeContext = ctx;
    state.primeAgentContext = undefined;
    state.primeAgentWidgetText = undefined;
    state.runtimeActive = true;
    state.runtimeGeneration++;
    state.titleGenerationAbortController.abort();
    state.titleGenerationAbortController = new AbortController();
    state.titleGenerationInFlight = false;
    state.titleGenerationAttempts = 0;
    requestRender = undefined;
    tracking.requestStartedAt = undefined;
    ctx.ui.setStatus(LEGACY_SESSION_NAME_STATUS_KEY, undefined);
    ctx.ui.setStatus(LEGACY_TPS_STATUS_KEY, undefined);

    if (mode === undefined) {
      state.primeAgentContext = ctx;
      requestRender = () => {
        checkContextEntries();
        updatePrimeAgentWidget(pi, state);
      };
      requestRender();
      refreshGitStatus(true);
      maybeGenerateAgentTitle(ctx);
      return;
    }

    ctx.ui.setFooter((tui, _theme, footerData) => {
      const render = () => tui.requestRender();
      const branchChanged = () => {
        // A branch switch changes the whole worktree: skip any failure backoff.
        refreshGitStatus(true, true);
        render();
      };
      requestRender = render;
      state.footerData = footerData;
      const unsubscribe = footerData.onBranchChange(branchChanged);

      return new EmptyFooter(() => {
        unsubscribe();
        if (state.footerData === footerData) state.footerData = undefined;
        if (requestRender === render) requestRender = undefined;
      });
    });

    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
      new TokyoNightStatusEditor(
        tui,
        editorTheme,
        keybindings,
        pi,
        ctx,
        state,
        () => {
          refreshGitStatus();
          checkContextEntries();
        },
        (render) => {
          requestRender = render;
        },
      ),
    );
    maybeGenerateAgentTitle(ctx);
  });

  pi.on("resources_discover", (_event, ctx) => {
    if (!state.runtimeActive) return;
    // Resource discovery can change the active tool loadout after startup.
    refreshLoadedContext(ctx);
    requestRender?.();
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Pi shares this options object across all before_agent_start handlers.
    // Retain the reference so later handlers (including returned systemPrompt)
    // can set or clear an explicit override even when its text is unchanged.
    if (state.runtimeActive) tracking.runSystemPromptOptions = event.systemPromptOptions;
    // Since Pi 1.2.0, runs started by sendMessage(triggerTurn) carry a message, not a prompt.
    maybeGenerateAgentTitle(ctx, event.messageType === "user" ? event.prompt : undefined);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!state.runtimeActive) return;
    // This runs after every extension's before_agent_start handler, so both the
    // effective system prompt and active tool schemas match the agent request.
    refreshLoadedContext(ctx);
    refreshCompactionThreshold(ctx);
    requestRender?.();
  });

  pi.on("context", (event, ctx) => {
    if (!state.runtimeActive) return;
    // Request boundaries may walk canonical history; rendering never does.
    refreshContextEntries(ctx);
    if (ctx.sessionManager.getLeafId?.() !== tracking.projectionLeafId) rebuildProjectedContext(ctx);
    tracking.requestContextRevision = tracking.contextRevision;
    // This request already contains every persisted shell result before it.
    tracking.contextLeafId = ctx.sessionManager.getLeafId?.();
    // Old runtimes without request/header hooks retain the context fallback.
    tracking.requestStartedAt = performance.now();
    tracking.requestFirstTokenAt = undefined;
    requestHeadersObserved = false;
    requestClockLocked = false;
    tracking.requestLoadedContextTokens = undefined;
    // Tools can be activated by a tool result between calls in the same run.
    refreshLoadedContext(ctx);
    const loadedContextTokens = state.loadedContextTokens;
    if (loadedContextTokens === undefined) return;
    tracking.requestLoadedContextTokens = loadedContextTokens;
    // All before_agent_start handlers have finished by this request boundary.
    // Pi reapplies an explicit forced prompt after context_with_system, even
    // when that prompt equals the canonical text or is the empty string.
    tracking.requestSystemPromptOverride = tracking.runSystemPromptOptions?.forceSystemPrompt;

    const model = contextModel(ctx);
    const estimate = estimateRequestContextTokens(
      event.messages,
      loadedContextTokens,
      { provider: model?.provider, id: model?.id },
      state.authoritativeLoadedContextTokens ?? tracking.usageLoadedContextTokens,
      !state.contextUsageInvalidated,
      tracking.provenUsage,
    );
    state.requestContextEstimate = estimate;
    setContextEstimate(estimate);
  });

  pi.on("context_with_system", (event, ctx) => {
    if (!state.runtimeActive) return;
    let messages = event.messages;
    if (tracking.requestSystemPromptOverride !== undefined) {
      const system = getCurrentSystemMessage(messages);
      messages = [{ role: "system", content: tracking.requestSystemPromptOverride,
        toolsAdded: system?.toolsAdded, timestamp: system?.timestamp ?? 0 },
      ...messages.filter((message) => message.role !== "system")];
    }
    // This public hook sees prepared declarations and earlier request-local
    // transforms. Pi 1.0.2's hiddenDeclarations projection runs AFTER this hook;
    // its private hidden set and later handlers are not observable here.
    const loaded = estimateSystemContextTokens(messages) ?? 0;
    updateLoadedContext(loaded);
    tracking.requestLoadedContextTokens = loaded;
    const model = contextModel(ctx);
    const estimate = estimateRequestContextTokens(messages, loaded,
      { provider: model?.provider, id: model?.id },
      state.authoritativeLoadedContextTokens ?? tracking.usageLoadedContextTokens,
      !state.contextUsageInvalidated, tracking.provenUsage);
    state.requestContextEstimate = estimate;
    setContextEstimate(estimate);
  });

  pi.on("before_provider_headers", () => {
    // ModelRuntime emits this after resolving auth, even for custom streamSimple
    // providers that omit onPayload. Prefer the later payload hook if available.
    if (state.runtimeActive && tracking.requestStartedAt !== undefined && !requestClockLocked && !requestHeadersObserved) {
      tracking.requestStartedAt = performance.now();
      requestHeadersObserved = true;
    }
  });

  pi.on("before_provider_request", () => {
    // Do not time unrelated calls (e.g. compaction/title generation). A context
    // event opens a main-agent request; message_end closes it.
    if (state.runtimeActive && tracking.requestStartedAt !== undefined && !requestClockLocked) {
      tracking.requestStartedAt = performance.now();
      // Repeated payload hooks (transport fallback/retry) belong to the same
      // logical response. Restarting here would hide latency and inflate TPS.
      requestClockLocked = true;
    }
  });

  pi.on("message_start", (event) => {
    if (!state.runtimeActive || event.message.role !== "assistant") return;
    // A late custom-provider hook must not move the start past response headers.
    requestClockLocked = true;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    if (state.requestContextEstimate) {
      setContextEstimate(estimateStreamingContextTokens(state.requestContextEstimate, 0,
        tracking.requestContextRevision === tracking.contextRevision ? event.message.usage : undefined));
    }
  });

  pi.on("message_update", (event) => {
    if (!state.runtimeActive || event.message.role !== "assistant") return;
    const streamEvent = event.assistantMessageEvent;
    if (
      streamEvent.type === "text_delta" ||
      streamEvent.type === "thinking_delta" ||
      streamEvent.type === "toolcall_delta"
    ) {
      if (tracking.requestFirstTokenAt === undefined && tracking.requestStartedAt !== undefined && streamEvent.delta.length > 0) {
        // Only immutable delta payloads carry event-time output evidence. Pi's
        // partial.content/usage are shared mutable objects: even a start event
        // can already contain future output when a buffered stream is consumed.
        // One clock read per response, never one per token/chunk or render.
        tracking.requestFirstTokenAt = performance.now();
        requestClockLocked = true;
      }
      const previous = state.streamingContentChars.get(streamEvent.contentIndex) ?? 0;
      const current = previous + streamEvent.delta.length;
      state.streamingContentChars.set(streamEvent.contentIndex, current);
      state.streamingContextChars += streamEvent.delta.length;
    } else if (
      streamEvent.type === "text_end" ||
      streamEvent.type === "thinking_end" ||
      streamEvent.type === "toolcall_end"
    ) {
      const previous = state.streamingContentChars.get(streamEvent.contentIndex) ?? 0;
      let current = previous;
      if (streamEvent.type === "text_end" || streamEvent.type === "thinking_end") {
        current = streamEvent.content.length;
      } else {
        try {
          current =
            streamEvent.toolCall.name.length +
            JSON.stringify(streamEvent.toolCall.arguments).length;
        } catch {
          // Keep the streamed character count if unusual tool arguments cannot serialize.
        }
      }
      state.streamingContentChars.set(streamEvent.contentIndex, current);
      state.streamingContextChars = Math.max(
        0,
        state.streamingContextChars + current - previous,
      );
    }

    if (state.requestContextEstimate) {
      setContextEstimate(
        estimateStreamingContextTokens(
          state.requestContextEstimate,
          state.streamingContextChars,
          tracking.requestContextRevision === tracking.contextRevision ? event.message.usage : undefined,
        ),
      );
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (!state.runtimeActive) return;
    if (event.message.role !== "assistant") {
      if (state.contextEstimate) {
        setContextEstimate(estimateContextWithMessage(state.contextEstimate, event.message));
      }
      return;
    }

    const completedAt = performance.now();
    const contextTokens = usageTokenTotal(event.message.usage);
    const completed = isCompletedResponse(event.message.stopReason);
    const matchesModel = ctx.model?.api === "pi-virtual"
      ? event.message.api !== "pi-virtual"
      : assistantMatchesModel(event.message, { provider: ctx.model?.provider, id: ctx.model?.id });
    if (completed && matchesModel) recordResponseModel(ctx, event.message);
    const hasCurrentModelUsage = completed && matchesModel && tracking.requestContextRevision === tracking.contextRevision &&
      usageInputTokens(event.message.usage) > 0;

    const previousTps = state.latestTps;
    const previousTtftMs = state.latestTtftMs;
    if (completed && matchesModel) {
      state.latestTps = responseTokensPerSecond(event.message, tracking.requestStartedAt, completedAt);
      // Publish the pair on completion, retaining the last successful response
      // during streaming/failure. TTFT does not depend on token-usage support.
      state.latestTtftMs = responseTimeToFirstToken(tracking.requestStartedAt, tracking.requestFirstTokenAt, completedAt);
    }
    if (hasCurrentModelUsage) {
      state.contextUsageInvalidated = false;
      // A tool loadout change while streaming applies to the NEXT request, not
      // the one whose usage just arrived.
      state.authoritativeLoadedContextTokens = tracking.requestLoadedContextTokens;
      setContextEstimate({ tokens: contextTokens, estimated: false });
    } else if (state.requestContextEstimate) {
      const fallback = estimateContextWithMessage(state.requestContextEstimate, event.message);
      setContextEstimate(estimateStreamingContextTokens(
        state.requestContextEstimate,
        (fallback.tokens - state.requestContextEstimate.tokens) * 4,
        completed && matchesModel && tracking.requestContextRevision === tracking.contextRevision ? event.message.usage : undefined,
      ));
    }
    state.requestContextEstimate = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    tracking.requestStartedAt = undefined;
    tracking.requestFirstTokenAt = undefined;
    // Context/TPS can round to the same display value even when TTFT changes.
    if (ctx.model?.api === "pi-virtual" || state.latestTps !== previousTps || state.latestTtftMs !== previousTtftMs) requestRender?.();
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
      refreshGitStatus(true);
    }
  });

  pi.on("user_bash", () => {
    if (!state.runtimeActive) return;
    const gitTracker = state.gitStatus;
    for (const delay of [100, 500, 1_500]) {
      const timer = setTimeout(() => {
        bashRefreshTimers.delete(timer);
        if (state.runtimeActive && state.gitStatus === gitTracker) refreshGitStatus(true);
      }, delay);
      bashRefreshTimers.add(timer);
    }
  });

  pi.on("turn_end", () => {
    tracking.requestStartedAt = undefined;
    refreshGitStatus(true);
  });
  pi.on("agent_settled", (_event, ctx) => {
    // Boundary handlers/recovery can append context edits/compactions after the last turn
    // notification, including when there will be no further model request.
    checkContextEntries();
    maybeGenerateAgentTitle(ctx);
    requestRender?.();
  });
  pi.on("session_info_changed", () => requestRender?.());
  pi.on("model_select", (_event, ctx) => {
    if (!state.runtimeActive) return;
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    tracking.requestStartedAt = undefined;
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
    refreshCompactionThreshold(ctx);
    // Rebuild for every model: assistantMatchesModel() already rejects usage
    // from another model, and switching A -> B -> A keeps A's valid usage.
    snapshotContextUsage(ctx);
    requestRender?.();
  });
  pi.on("thinking_level_select", () => requestRender?.());
  pi.on("session_compact", (_event, ctx) => {
    if (!state.runtimeActive) return;
    resetCompactedContext();
    tracking.contextRevision++;
    tracking.contextLeafId = ctx.sessionManager.getLeafId?.();
    snapshotContextUsage(ctx);
    requestRender?.();
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!state.runtimeActive) return;
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    tracking.requestStartedAt = undefined;
    tracking.contextLeafId = ctx.sessionManager.getLeafId?.();
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
    snapshotContextUsage(ctx);
    requestRender?.();
    maybeGenerateAgentTitle(ctx);
  });
  pi.on("session_shutdown", () => {
    state.runtimeActive = false;
    state.runtimeGeneration++;
    state.latestTps = undefined;
    state.latestTtftMs = undefined;
    tracking.requestFirstTokenAt = undefined;
    state.titleGenerationAbortController.abort();
    state.titleGenerationInFlight = false;
    for (const timer of bashRefreshTimers) clearTimeout(timer);
    bashRefreshTimers.clear();
    state.primeAgentContext?.ui.setWidget(PRIME_AGENT_WIDGET_KEY, undefined, {
      placement: "belowEditor",
    });
    // The disposed tracker ignores further refreshes; session_start replaces it.
    disposeGitStatus(state.gitStatus);
    requestRender = undefined;
    state.footerData = undefined;
    state.contextEstimate = undefined;
    state.requestContextEstimate = undefined;
    state.loadedContextTokens = undefined;
    state.authoritativeLoadedContextTokens = undefined;
    state.streamingContextChars = 0;
    state.streamingContentChars.clear();
    state.contextUsageInvalidated = false;
    state.contextUsageSnapshot = undefined;
    state.responseModel = undefined;
    tracking.contextLeafId = undefined;
    tracking.projectionLeafId = undefined;
    tracking.registeredLoadedContextTokens = undefined;
    tracking.runSystemPromptOptions = undefined;
    tracking.provenUsage = undefined;
    tracking.usageLoadedContextTokens = undefined;
    tracking.requestSystemPromptOverride = undefined;
    state.runtimeContext = undefined;
    state.primeAgentContext = undefined;
    state.primeAgentWidgetText = undefined;
    tracking.requestStartedAt = undefined;
  });
}
