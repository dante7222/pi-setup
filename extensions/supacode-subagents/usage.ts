import type { Usage } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isUsage(value: unknown): value is Usage {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  if (
    !isNonNegativeFiniteNumber(value.input) ||
    !isNonNegativeFiniteNumber(value.output) ||
    !isNonNegativeFiniteNumber(value.cacheRead) ||
    !isNonNegativeFiniteNumber(value.cacheWrite) ||
    !isNonNegativeFiniteNumber(value.totalTokens) ||
    !isNonNegativeFiniteNumber(value.cost.input) ||
    !isNonNegativeFiniteNumber(value.cost.output) ||
    !isNonNegativeFiniteNumber(value.cost.cacheRead) ||
    !isNonNegativeFiniteNumber(value.cost.cacheWrite) ||
    !isNonNegativeFiniteNumber(value.cost.total)
  ) {
    return false;
  }
  return (
    (value.cacheWrite1h === undefined || isNonNegativeFiniteNumber(value.cacheWrite1h)) &&
    (value.reasoning === undefined || isNonNegativeFiniteNumber(value.reasoning))
  );
}

export function aggregateUsage(values: Iterable<unknown>): Usage | undefined {
  let count = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cacheWrite1h = 0;
  let reasoning = 0;
  let totalTokens = 0;
  let hasCacheWrite1h = false;
  let hasReasoning = false;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;

  for (const value of values) {
    if (!isUsage(value)) continue;
    count++;
    input += value.input;
    output += value.output;
    cacheRead += value.cacheRead;
    cacheWrite += value.cacheWrite;
    totalTokens += value.totalTokens;
    costInput += value.cost.input;
    costOutput += value.cost.output;
    costCacheRead += value.cost.cacheRead;
    costCacheWrite += value.cost.cacheWrite;
    costTotal += value.cost.total;
    if (value.cacheWrite1h !== undefined) {
      hasCacheWrite1h = true;
      cacheWrite1h += value.cacheWrite1h;
    }
    if (value.reasoning !== undefined) {
      hasReasoning = true;
      reasoning += value.reasoning;
    }
  }

  if (count === 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(hasCacheWrite1h ? { cacheWrite1h } : {}),
    ...(hasReasoning ? { reasoning } : {}),
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}
