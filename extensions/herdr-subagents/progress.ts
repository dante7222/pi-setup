import type { Usage } from "@earendil-works/pi-ai";

export interface WorkerProgress {
  phase: "starting" | "working" | "tool" | "retry" | "compacting" | "settled";
  updatedAt: number;
  turns: number;
  tool?: string;
  model?: string;
  usage: Usage;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Only authoritative completed messages/compactions count; streamed and nested previews do not. */
export function trackProgress(progress: WorkerProgress, event: Record<string, unknown>): boolean {
  let usage: unknown;
  if (event.type === "message_end" && event.message && typeof event.message === "object") {
    const message = event.message as Record<string, unknown>;
    if (message.role === "assistant") {
      progress.turns++;
      if (typeof message.provider === "string" && typeof message.model === "string") progress.model = `${message.provider}/${message.model}`.slice(0, 200);
      usage = message.usage;
    } else if (message.role === "toolResult") usage = message.usage;
    else return false;
  } else if (event.type === "agent_start" || event.type === "turn_start") { progress.phase = "working"; delete progress.tool; }
  else if (event.type === "agent_settled") { progress.phase = "settled"; delete progress.tool; }
  else if (event.type === "tool_execution_start") {
    progress.phase = "tool";
    progress.tool = typeof event.toolName === "string" ? event.toolName.slice(0, 100) : "tool";
  } else if (event.type === "auto_retry_start") progress.phase = "retry";
  else if (event.type === "compaction_start") progress.phase = "compacting";
  else if (event.type === "compaction_end") {
    progress.phase = "working";
    if (event.result && typeof event.result === "object") usage = (event.result as Record<string, unknown>).usage;
  } else return false;
  if (usage && typeof usage === "object") {
    const value = usage as Record<string, unknown>;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      const amount = value[key];
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) progress.usage[key] += amount;
    }
    if (value.cost && typeof value.cost === "object") {
      const cost = value.cost as Record<string, unknown>;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
        const amount = cost[key];
        if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) progress.usage.cost[key] += amount;
      }
    }
  }
  progress.updatedAt = Date.now();
  return true;
}
