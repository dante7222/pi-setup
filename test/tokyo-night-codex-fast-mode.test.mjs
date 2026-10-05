import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isCodexFastModeRequested } from "../extensions/tokyo-night-footer/codex-fast-mode.ts";

const supportedModelIds = [
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
];

test("supported IDs match the installed integration without evaluating its provider/config code", (t) => {
  const path = join(homedir(), ".pi/agent/npm/node_modules/@ryan_nookpi/pi-extension-codex-fast-mode/index.ts");
  if (!existsSync(path)) return t.skip("optional Fast Mode integration is not installed");
  const source = readFileSync(path, "utf8");
  const declaration = /export const SUPPORTED_MODEL_IDS = \[([\s\S]*?)\] as const/.exec(source);
  assert.ok(declaration);
  assert.deepEqual([...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]), supportedModelIds);
});

test("shows Codex Fast Mode as requested, only for supported active models", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-fast-mode-"));
  const stateFile = join(directory, "state.json");

  try {
    writeFileSync(stateFile, '{"enabled":true}\n');

    for (const modelId of supportedModelIds) {
      assert.equal(isCodexFastModeRequested("openai-codex", modelId, stateFile), true);
    }
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-5.4", stateFile), false);
    assert.equal(isCodexFastModeRequested("openai", "gpt-5.6-sol", stateFile), false);
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-5.3-codex", stateFile), false);

    writeFileSync(stateFile, '{"enabled":false}\n');
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-5.6-sol", stateFile), false);

    writeFileSync(stateFile, "not json\n");
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-5.6-sol", stateFile), false);

    rmSync(stateFile);
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-5.6-sol", stateFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
