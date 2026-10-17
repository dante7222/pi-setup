import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loaded only into worker processes with `-e`. Unlike --append-system-prompt, a
// prompt section keeps Pi's normal APPEND_SYSTEM.md discovery.
export default function subagentWorkerPrompt(pi: ExtensionAPI): void {
  const prompt = process.env.PI_SUBAGENT_PROMPT;
  if (process.env.PI_SUBAGENT !== "1" || !prompt) return;
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.subagent = prompt;
    // A whole-prompt override hides sections from the provider; append there too.
    if (event.systemPromptOptions.forceSystemPrompt !== undefined && !event.systemPromptOptions.forceSystemPrompt.includes(prompt)) {
      event.systemPromptOptions.forceSystemPrompt += `\n\n${prompt}`;
    }
  });
}
