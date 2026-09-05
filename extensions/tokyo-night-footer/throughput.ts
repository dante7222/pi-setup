import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isCompletedResponse } from "./context-usage.ts";

/**
 * Observed request throughput, not server-side decode speed. The common Pi API
 * exposes no generation clock. Include TTFT/prefill/hidden reasoning so reasoning
 * tokens are never divided by only the visible-text interval. Tool execution,
 * prior turns and work before the request hook are outside this interval.
 * Provider-internal retries/backoff remain inside it; Pi exposes no common
 * per-attempt clock. Subtracting observed TTFT would overstate decode speed
 * when output includes reasoning generated before the first visible delta.
 */
export function responseTokensPerSecond(
  message: AssistantMessage,
  requestStartedAt: number | undefined,
  completedAt: number,
): number | undefined {
  const output = message.usage.output;
  if (
    !isCompletedResponse(message.stopReason) ||
    !Number.isFinite(output) || output <= 0 ||
    requestStartedAt === undefined || !Number.isFinite(requestStartedAt) ||
    !Number.isFinite(completedAt) || completedAt <= requestStartedAt
  ) {
    return undefined;
  }
  // usage.output already includes usage.reasoning. Never estimate TPS from
  // character counts or stream-chunk counts: neither is a token count.
  const rate = output * 1_000 / (completedAt - requestStartedAt);
  return Number.isFinite(rate) ? rate : undefined;
}

/** Client-observed first non-empty output delta, not a server generation clock. */
export function responseTimeToFirstToken(
  requestStartedAt: number | undefined,
  firstTokenAt: number | undefined,
  completedAt: number,
): number | undefined {
  if (
    requestStartedAt === undefined || !Number.isFinite(requestStartedAt) ||
    firstTokenAt === undefined || !Number.isFinite(firstTokenAt) ||
    !Number.isFinite(completedAt) ||
    firstTokenAt < requestStartedAt || firstTokenAt > completedAt
  ) {
    return undefined;
  }
  return firstTokenAt - requestStartedAt;
}

export function formatFirstTokenLatency(milliseconds: number): string {
  if (milliseconds < 1) return `${milliseconds.toFixed(1)}ms`;
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}
