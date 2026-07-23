import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runValidationProcess } from "../extensions/supacode-subagents/validation-process.ts";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

test("validation output is drained but its persisted log is capped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-validation-"));
  try {
    const logPath = join(directory, "check.log");
    const result = await runValidationProcess({
      command: `node -e "process.stdout.write('x'.repeat(100000))"`,
      cwd: directory,
      logPath,
      timeoutMs: 5000,
      maxLogBytes: 1024,
      tailBytes: 256,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.outputBytes, 100000);
    assert.equal(result.logBytes, 1024);
    assert.equal(result.logTruncated, true);
    assert.equal(Buffer.byteLength(result.outputTail), 256);
    assert.equal((await stat(logPath)).size, 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validation timeout terminates the command process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-validation-"));
  try {
    const pidPath = join(directory, "child.pid");
    const command = `node -e ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`,
    )} & wait`;
    const result = await runValidationProcess({
      command,
      cwd: directory,
      logPath: join(directory, "check.log"),
      timeoutMs: 500,
      maxLogBytes: 1024,
      tailBytes: 256,
    });
    const pid = Number(await readFile(pidPath, "utf8"));

    assert.equal(result.exitCode, 124);
    assert.equal(result.killed, true);
    assert.equal(result.timedOut, true);
    assert.equal(await waitForProcessExit(pid), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
