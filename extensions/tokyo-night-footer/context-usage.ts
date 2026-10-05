import {
  type ContextEvent,
  type SessionProjection,
  type SessionEntry,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, type AssistantMessage, type StopReason, type Usage } from "@earendil-works/pi-ai";

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
  allowUsage = true,
  provenUsage?: AssistantMessage,
): ContextTokenEstimate {
  // Replay patches/removals/checkpoints, rather than counting every historical
  // declaration or replacing prepared descriptions with tool registrations.
  loadedContextTokens = estimateSystemContextTokens(messages) ?? loadedContextTokens;
  let usageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "compactionSummary") {
      // Retained assistant messages still carry PRE-compaction usage. Their
      // position after the summary does not make that usage a new measurement.
      const usage = messages[usageIndex];
      if (provenUsage === undefined && usage && usage.timestamp <= message.timestamp) usageIndex = -1;
      break;
    }
    if (usageIndex === -1 && hasUsableUsage(message)) usageIndex = index;
  }

  const usageMessage = usageIndex === -1 ? undefined : messages[usageIndex]!;
  // A request-local transform may remove/replace the canonical anchor. Do not
  // apply that anchor's loaded-system baseline to a different response.
  const matchesProvenUsage = provenUsage === undefined || usageMessage === provenUsage ||
    JSON.stringify(usageMessage) === JSON.stringify(provenUsage);
  if (
    allowUsage && matchesProvenUsage && usageMessage?.role === "assistant" &&
    assistantMatchesModel(usageMessage, model)
  ) {
    let trailingTokens = 0;
    for (let index = usageIndex + 1; index < messages.length; index++) {
      if (messages[index]!.role !== "system") trailingTokens += estimateMessageTokens(messages[index]!);
    }

    const baseline = authoritativeLoadedContextTokens ??
      estimateSystemContextTokens(messages.slice(0, usageIndex + 1));
    const loadedDelta = baseline === undefined ? 0 : loadedContextTokens - baseline;
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
  for (const message of messages) {
    if (message.role !== "system") messageTokens += estimateMessageTokens(message);
  }
  return {
    tokens: loadedContextTokens + messageTokens,
    estimated: true,
  };
}

/** Complete effective system state, including prepared tool declarations. */
export function estimateSystemContextTokens(messages: readonly ContextMessage[]): number | undefined {
  const system = getCurrentSystemMessage(messages);
  return system ? estimateTokens(system) : undefined;
}

/** Source entry order, not timestamps, determines whether an edit invalidates usage. */
export function estimateProjectedContext(
  projection: SessionProjection,
  branch: readonly SessionEntry[],
  loadedContextTokens: number,
  model: ContextModelIdentity,
  authoritativeLoadedContextTokens?: number,
): {
  estimate: ContextTokenEstimate;
  invalidated: boolean;
  loadedContextTokens: number;
  provenUsage: AssistantMessage | undefined;
  usageLoadedContextTokens: number | undefined;
} {
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  let barrier = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]!.type === "context_edit" || branch[index]!.type === "compaction") {
      barrier = index;
      break;
    }
  }
  let usagePosition = -1;
  let usage: AssistantMessage | undefined;
  for (const entry of projection.entries) {
    for (const message of entry.messages) {
      if (message.role === "assistant" && hasUsableUsage(message)) {
        usage = message;
        usagePosition = positions.get(entry.sourceEntry.id) ?? -1;
      }
    }
  }
  const invalidated = barrier >= 0 && usagePosition <= barrier;
  const provenUsage = usagePosition > barrier ? usage : undefined;
  const usageLoadedContextTokens = usage ? estimateSystemContextTokens(
    projection.messages.slice(0, projection.messages.indexOf(usage) + 1),
  ) : undefined;
  loadedContextTokens = estimateSystemContextTokens(projection.messages) ?? loadedContextTokens;
  return {
    estimate: estimateRequestContextTokens(
      projection.messages, loadedContextTokens, model, authoritativeLoadedContextTokens,
      !invalidated, provenUsage,
    ),
    invalidated,
    loadedContextTokens,
    provenUsage,
    usageLoadedContextTokens,
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
