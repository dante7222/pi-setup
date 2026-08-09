interface ContextTool {
  name: string;
  description: string;
  parameters: unknown;
}

function estimateTextTokens(text: string): number {
  // Match Pi's conservative fallback estimator.
  return Math.ceil(text.length / 4);
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
