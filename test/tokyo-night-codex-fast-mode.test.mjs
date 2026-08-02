import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isCodexFastModeEffective } from "../extensions/tokyo-night-footer/codex-fast-mode.ts";

const supportedModelIds = [
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
];

test("shows Codex Fast Mode only when it is effective for the active model", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-codex-fast-mode-"));
  const stateFile = join(directory, "state.json");

  try {
    writeFileSync(stateFile, '{"enabled":true}\n');

    for (const modelId of supportedModelIds) {
      assert.equal(isCodexFastModeEffective("openai-codex", modelId, stateFile), true);
    }
    assert.equal(isCodexFastModeEffective("openai", "gpt-5.6-sol", stateFile), false);
    assert.equal(isCodexFastModeEffective("openai-codex", "gpt-5.3-codex", stateFile), false);

    writeFileSync(stateFile, '{"enabled":false}\n');
    assert.equal(isCodexFastModeEffective("openai-codex", "gpt-5.6-sol", stateFile), false);

    writeFileSync(stateFile, "not json\n");
    assert.equal(isCodexFastModeEffective("openai-codex", "gpt-5.6-sol", stateFile), false);

    rmSync(stateFile);
    assert.equal(isCodexFastModeEffective("openai-codex", "gpt-5.6-sol", stateFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
