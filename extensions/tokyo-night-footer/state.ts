import type { ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { ContextTokenEstimate } from "./context-usage.ts";
import type { GitStatusTracker } from "./git-status.ts";

/** Footer state shared by the status line, editor and context tracker. */
export interface StatusLineState {
  latestTps: number | undefined;
  latestTtftMs: number | undefined;
  contextEstimate: ContextTokenEstimate | undefined;
  // contextWindow is undefined when the routed model is not in the registry.
  responseModel: { provider: string; id: string; name: string; contextWindow?: number; thinkingLevel?: string } | undefined;
  requestContextEstimate: ContextTokenEstimate | undefined;
  loadedContextTokens: number | undefined;
  authoritativeLoadedContextTokens: number | undefined;
  streamingContextChars: number;
  streamingContentChars: Map<number, number>;
  contextUsageInvalidated: boolean;
  contextUsageSnapshot: number | null | undefined;
  /** Tokens at which Pi auto-compacts (window - reserveTokens); undefined if disabled/unknown. */
  compactionReserveTokens: number | undefined;
  footerData: ReadonlyFooterDataProvider | undefined;
  gitStatus: GitStatusTracker;
  runtimeContext: ExtensionContext | undefined;
  primeAgentContext: ExtensionContext | undefined;
  primeAgentWidgetText: string | undefined;
  runtimeActive: boolean;
  runtimeGeneration: number;
  titleGenerationAbortController: AbortController;
  titleGenerationInFlight: boolean;
  titleGenerationAttempts: number;
}
