import {
  type ContextEvent,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { StopReason, Usage } from "@earendil-works/pi-ai";

interface ContextTool {
  name: string;
  description: string;
  parameters: unknown;
}

type ContextMessage = ContextEvent["messages"][number];

interface ContextModelIdentity {
  provider: string | undefined;
  id: string | undefined;
}

export interface ContextTokenEstimate {
  tokens: number;
  estimated: boolean;
}

function estimateTextTokens(text: string): number {
  // Match Pi's cheap fallback. This is not a tokenizer or an upper bound.
  return Math.ceil(text.length / 4);
}

function tokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function usageTokenTotal(usage: Usage): number {
  // Pi normalizes input/cache buckets to be disjoint. reasoning is a subset of
  // output and cacheWrite1h is a subset of cacheWrite: neither gets added again.
  // Some compatible endpoints leave totalTokens unset or stale during streaming.
  return Math.max(
    tokenCount(usage.totalTokens),
    tokenCount(usage.input) + tokenCount(usage.output) +
      tokenCount(usage.cacheRead) + tokenCount(usage.cacheWrite),
  );
}

export function usageInputTokens(usage: Usage): number {
  return usageTokenTotal(usage) - tokenCount(usage.output);
}

export function isCompletedResponse(stopReason: StopReason): boolean {
  return stopReason === "stop" || stopReason === "length" || stopReason === "toolUse";
}

function hasUsableUsage(message: ContextMessage): boolean {
  return (
    message.role === "assistant" &&
    isCompletedResponse(message.stopReason) &&
    usageInputTokens(message.usage) > 0
  );
}

function estimateMessageTokens(message: ContextMessage): number {
  // !! shell output is persisted but never sent to the model.
  if (message.role === "bashExecution" && message.excludeFromContext) return 0;
  return estimateTokens(message);
}

export function assistantMatchesModel(
  message: ContextMessage,
  model: ContextModelIdentity,
): boolean {
  return (
    message.role === "assistant" &&
    model.provider !== undefined &&
    model.id !== undefined &&
    message.provider === model.provider &&
    message.model === model.id
  );
}

export function estimateRequestContextTokens(
  messages: readonly ContextMessage[],
  loadedContextTokens: number,
  model: ContextModelIdentity,
  authoritativeLoadedContextTokens: number | undefined,
): ContextTokenEstimate {
  let usageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "compactionSummary") {
      // Retained assistant messages still carry PRE-compaction usage. Their
      // position after the summary does not make that usage a new measurement.
      if (usageIndex !== -1 && messages[usageIndex]!.timestamp <= message.timestamp) {
        usageIndex = -1;
      }
      break;
    }
    if (usageIndex === -1 && hasUsableUsage(message)) usageIndex = index;
  }

  const usageMessage = usageIndex === -1 ? undefined : messages[usageIndex]!;
  if (
    usageMessage?.role === "assistant" &&
    assistantMatchesModel(usageMessage, model)
  ) {
    let trailingTokens = 0;
    for (let index = usageIndex + 1; index < messages.length; index++) {
      trailingTokens += estimateMessageTokens(messages[index]!);
    }

    const loadedDelta =
      authoritativeLoadedContextTokens === undefined
        ? 0
        : loadedContextTokens - authoritativeLoadedContextTokens;
    return {
      tokens: Math.max(
        0,
        usageTokenTotal(usageMessage.usage) + trailingTokens + loadedDelta,
      ),
      // Reusing a previous response is a forecast, not a measurement of the
      // next serialized request (reasoning retention and provider wrappers vary).
      estimated: true,
    };
  }

  let messageTokens = 0;
  for (const message of messages) messageTokens += estimateMessageTokens(message);
  return {
    tokens: loadedContextTokens + messageTokens,
    estimated: true,
  };
}

export function estimateContextWithMessage(
  context: ContextTokenEstimate,
  message: ContextMessage,
): ContextTokenEstimate {
  const tokens = estimateMessageTokens(message);
  return tokens === 0 ? context : { tokens: context.tokens + tokens, estimated: true };
}

export function estimateStreamingContextTokens(
  requestContext: ContextTokenEstimate,
  streamedContentChars: number,
  usage?: Usage,
): ContextTokenEstimate {
  const inputTokens = usage ? usageInputTokens(usage) : 0;
  return {
    // Input-only usage (e.g. Anthropic message_start) must not freeze the live
    // counter or erase generated content. Output-only usage must not erase input.
    tokens: (inputTokens > 0 ? inputTokens : requestContext.tokens) + Math.max(
      usage ? tokenCount(usage.output) : 0,
      Math.ceil(streamedContentChars / 4),
    ),
    estimated: true,
  };
}

export function estimateLoadedContextTokens(
  systemPrompt: string,
  tools: readonly ContextTool[],
  activeToolNames: readonly string[],
): number {
  const activeNames = new Set(activeToolNames);
  const activeTools = tools
    .filter((tool) => activeNames.has(tool.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));

  let serializedTools = "";
  if (activeTools.length > 0) {
    try {
      // Pi exposes mutable schema objects. Re-measure at request boundaries,
      // never during streaming/rendering; identity caching misses nested edits.
      serializedTools = JSON.stringify(activeTools);
    } catch {
      serializedTools = "[unserializable]";
    }
  }

  return estimateTextTokens(systemPrompt) + estimateTextTokens(serializedTools);
}
