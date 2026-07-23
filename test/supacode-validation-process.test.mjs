import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runValidationProcess,
  ValidationProcessFailure,
} from "../extensions/supacode-subagents/validation-process.ts";

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

test("validation log-open failures reject without an unhandled stream error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-validation-"));
  try {
    await assert.rejects(
      runValidationProcess({
        command: "true",
        cwd: directory,
        logPath: directory,
        timeoutMs: 5000,
        maxLogBytes: 1024,
        tailBytes: 256,
      }),
      /EISDIR|illegal operation on a directory/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validation records authenticated process and exit metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-validation-"));
  try {
    const result = await runValidationProcess({
      command: "sleep 0.2",
      cwd: directory,
      logPath: join(directory, "check.log"),
      timeoutMs: 5000,
      maxLogBytes: 1024,
      tailBytes: 256,
      processLifecycle: {
        jobDir: directory,
        jobId: "validation-job",
        launchNonce: "validation-launch-nonce",
      },
    });
    const processRecord = JSON.parse(await readFile(join(directory, "runner-process.json"), "utf8"));
    const exitRecord = JSON.parse(await readFile(join(directory, "runner-exit.json"), "utf8"));

    assert.equal(result.exitCode, 0);
    assert.equal(result.terminationVerified, true);
    assert.equal(processRecord.jobId, "validation-job");
    assert.equal(processRecord.launchNonce, "validation-launch-nonce");
    assert.equal(processRecord.wrapper.launchNonce, "validation-launch-nonce");
    assert.equal(exitRecord.wrapperPid, processRecord.wrapper.pid);
    assert.equal(exitRecord.exitCode, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validation abort terminates the command process group before rejecting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-validation-"));
  try {
    const pidPath = join(directory, "abort-child.pid");
    const command = `node -e ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`,
    )} & wait`;
    const controller = new AbortController();
    const running = runValidationProcess({
      command,
      cwd: directory,
      logPath: join(directory, "abort.log"),
      timeoutMs: 5000,
      signal: controller.signal,
      maxLogBytes: 1024,
      tailBytes: 256,
    });
    let pid;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        pid = Number(await readFile(pidPath, "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.equal(Number.isSafeInteger(pid), true);
    controller.abort();
    await assert.rejects(running, (error) => {
      assert.equal(error instanceof ValidationProcessFailure, true);
      assert.equal(error.terminationVerified, true);
      return true;
    });
    assert.equal(await waitForProcessExit(pid), true);
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
