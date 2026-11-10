import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loaded only into worker processes with `-e`. Unlike --append-system-prompt, a
// prompt section keeps Pi's normal APPEND_SYSTEM.md discovery.
export default function subagentWorkerPrompt(pi: ExtensionAPI): void {
  const prompt = process.env.PI_SUBAGENT_PROMPT;
  if (process.env.PI_SUBAGENT !== "1" || !prompt) return;
  // One reminder per run. Only a prompt fires before_agent_start; the continuation a
  // reminder requests does not, so a model that stays silent cannot loop.
  let reminded = false;
  pi.on("before_agent_start", (event) => {
    reminded = false;
    event.systemPromptOptions.sections.subagent = prompt;
    // A whole-prompt override hides sections from the provider; append there too.
    if (event.systemPromptOptions.forceSystemPrompt !== undefined && !event.systemPromptOptions.forceSystemPrompt.includes(prompt)) {
      event.systemPromptOptions.forceSystemPrompt += `\n\n${prompt}`;
    }
  });
  // Only the final text reaches the parent. A run about to end without one (tool calls
  // only, an answer cut off at the output limit) is asked once more instead of failing.
  // Provider errors and aborts are left alone: asking again would not help.
  pi.on("agent_before_settle", (event) => {
    if (reminded || event.outcome !== "completed") return;
    const last = event.context.contextMessages.findLast((message) => message.role === "assistant");
    if (!last || (last.stopReason === "stop" && last.content.every((part) => part.type !== "toolCall") && last.content.some((part) => part.type === "text" && part.text.trim()))) return;
    reminded = true;
    return {
      entries: [...event.entries, { type: "custom_message", customType: "subagent-report-reminder", content: "Reply now with your final report as text.", display: false }],
      continue: true,
    };
  });
  // Nobody knows whether an idle worker will be continued, and its cache refreshes would be
  // paid for without appearing in any report. During a run Pi's own decision stands.
  pi.on("cache_warming_decision", (_event, ctx) => ctx.isIdle() ? { action: "stop" } : undefined);
}
