import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_FILE = join(homedir(), ".pi", "agent", "state", "codex-fast-mode.json");
const SUPPORTED_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
]);

// Render paths call this on every paint. Re-stat at most once per interval and
// re-read only when the file's mtime/size changed.
const RECHECK_INTERVAL_MS = 1_000;

interface CachedState {
  stateFile: string;
  checkedAt: number;
  mtimeMs: number | undefined;
  size: number | undefined;
  enabled: boolean;
}

let cache: CachedState | undefined;

/** Drop the cached state-file read (tests and explicit refreshes). */
export function resetCodexFastModeCache(): void {
  cache = undefined;
}

function readEnabled(stateFile: string): boolean {
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

// Mirrors the installed codex-fast-mode integration. This is a request for
// priority service, not evidence that the provider scheduled it at that tier.
export function isCodexFastModeRequested(
  provider: string | undefined,
  modelId: string | undefined,
  stateFile = STATE_FILE,
  now = Date.now(),
): boolean {
  if (provider !== "openai-codex" || modelId === undefined || !SUPPORTED_MODEL_IDS.has(modelId)) {
    return false;
  }

  if (cache?.stateFile === stateFile && now >= cache.checkedAt && now - cache.checkedAt < RECHECK_INTERVAL_MS) {
    return cache.enabled;
  }
  let mtimeMs: number | undefined;
  let size: number | undefined;
  try {
    const stats = statSync(stateFile);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    // Missing file: fall through to readEnabled(), which reports false.
  }
  const unchanged = cache?.stateFile === stateFile && mtimeMs !== undefined &&
    cache.mtimeMs === mtimeMs && cache.size === size;
  const enabled = unchanged ? cache!.enabled : mtimeMs === undefined ? false : readEnabled(stateFile);
  cache = { stateFile, checkedAt: now, mtimeMs, size, enabled };
  return enabled;
}
