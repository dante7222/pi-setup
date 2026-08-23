import {
  type ContextEvent,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

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
  // Match Pi's conservative fallback estimator.
  return Math.ceil(text.length / 4);
}

export function usageTokenTotal(usage: Usage): number {
  return (
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

function hasUsableUsage(message: ContextMessage): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason !== "aborted" &&
    message.stopReason !== "error" &&
    usageTokenTotal(message.usage) > 0
  );
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
    if (hasUsableUsage(message)) {
      usageIndex = index;
      break;
    }
  }

  const usageMessage = usageIndex === -1 ? undefined : messages[usageIndex]!;
  if (
    usageMessage?.role === "assistant" &&
    assistantMatchesModel(usageMessage, model)
  ) {
    let trailingTokens = 0;
    for (let index = usageIndex + 1; index < messages.length; index++) {
      trailingTokens += estimateTokens(messages[index]!);
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
      estimated:
        trailingTokens > 0 ||
        loadedDelta !== 0 ||
        authoritativeLoadedContextTokens === undefined,
    };
  }

  let messageTokens = 0;
  for (const message of messages) messageTokens += estimateTokens(message);
  return {
    tokens: loadedContextTokens + messageTokens,
    estimated: true,
  };
}

export function estimateContextWithMessage(
  context: ContextTokenEstimate,
  message: ContextMessage,
): ContextTokenEstimate {
  return {
    tokens: context.tokens + estimateTokens(message),
    estimated: true,
  };
}

export function estimateStreamingContextTokens(
  requestContext: ContextTokenEstimate,
  streamedContentChars: number,
): ContextTokenEstimate {
  return {
    tokens: requestContext.tokens + Math.ceil(streamedContentChars / 4),
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
      serializedTools = JSON.stringify(activeTools);
    } catch {
      serializedTools = "[unserializable]";
    }
  }

  return estimateTextTokens(systemPrompt) + estimateTextTokens(serializedTools);
}
