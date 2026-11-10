import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = fileURLToPath(new URL("./live/run-tasks.mjs", import.meta.url));

test("standalone runner imports and exits offline for an empty task list", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "subagents-runner-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", runner], {
    cwd: root,
    input: "[]\n",
    encoding: "utf8",
    // Contain the runner's scratch directory; no pi executable is available if it tries to start a worker.
    env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir, PATH: dir },
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const entries = await readdir(dir, { withFileTypes: true });
  assert.equal(entries.length, 1);
  assert.ok(entries[0].isDirectory());
  assert.match(entries[0].name, /^subagents-run-/);
});
