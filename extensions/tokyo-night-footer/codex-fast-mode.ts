import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_FILE = join(homedir(), ".pi", "agent", "state", "codex-fast-mode.json");
const SUPPORTED_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

export function isCodexFastModeEffective(
  provider: string | undefined,
  modelId: string | undefined,
  stateFile = STATE_FILE,
): boolean {
  if (provider !== "openai-codex" || modelId === undefined || !SUPPORTED_MODEL_IDS.has(modelId)) {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { enabled?: unknown }).enabled === true
    );
  } catch {
    return false;
  }
}
