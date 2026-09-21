import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { atomic } from "./core.ts";
import { snapshotProcesses } from "./process-tree.ts";

// Explicitly loaded only in workers. Unlike --append-system-prompt, this preserves
// Pi's ordinary global/project APPEND_SYSTEM.md discovery and trust semantics.
export default function workerPrompt(pi: ExtensionAPI): void {
  const directory = process.env.PI_HERDR_JOB_DIR;
  if (process.env.PI_HERDR_WORKER !== "1" || !directory) return;
  pi.on("before_agent_start", async (event) => {
    const rolePrompt = await readFile(join(directory, "system.md"), "utf8");
    event.systemPromptOptions.sections.herdr_subagent = rolePrompt;
    // A prior whole-prompt override (e.g. session-groups) hides section edits
    // from the provider. Preserve it and append the role there as well.
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
      event.systemPromptOptions.forceSystemPrompt += `\n\n${rolePrompt}`;
    }
  });
  // Preserve descendant ancestry before Pi exits/reparents detached tool children.
  // The supervisor revalidates these identities against live ps before signaling.
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") await atomic(join(directory, "processes.json"), await snapshotProcesses());
  });
}
