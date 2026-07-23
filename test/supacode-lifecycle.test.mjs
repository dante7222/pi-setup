import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authenticateRunnerExit,
  claimJobDecision,
  claimWorkerTerminal,
  initializeJobLifecycle,
  readJobDecision,
  readJobLifecycle,
  readTerminalOutput,
  reconcileJobLifecycle,
  readWorkerTerminal,
  updateJobLifecycle,
} from "../extensions/supacode-subagents/lifecycle.ts";

const JOB_ID = "11111111-2222-4333-8444-555555555555";
const BATCH_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function runNode(source) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "--input-type=module", "-e", source],
      { encoding: "utf8" },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout),
    );
  });
}

test("durable lifecycle metadata exists before transitions and records every revision", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-lifecycle-"));
  try {
    const initial = await initializeJobLifecycle(jobDir, JOB_ID, BATCH_ID, "planned", {
      branch: "pi-agent/aaaaaa/111111",
    });
    assert.equal(initial.revision, 1);
    const provisioning = await updateJobLifecycle(jobDir, "provisioning_worktree");
    const ready = await updateJobLifecycle(jobDir, "workspace_ready", undefined, {
      worktreePath: "/tmp/worktree",
    });
    assert.equal(provisioning.revision, 2);
    assert.equal(ready.revision, 3);
    assert.equal((await readJobLifecycle(jobDir)).details.branch, "pi-agent/aaaaaa/111111");
    const events = (await readFile(join(jobDir, "lifecycle-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.phase), [
      "planned",
      "provisioning_worktree",
      "workspace_ready",
    ]);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("concurrent lifecycle updates are serialized without lost revisions", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-lifecycle-concurrent-"));
  try {
    await initializeJobLifecycle(jobDir, JOB_ID, BATCH_ID, "planned");
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      updateJobLifecycle(jobDir, "running", undefined, { [`update${index}`]: true })));

    const lifecycle = await readJobLifecycle(jobDir);
    assert.equal(lifecycle.revision, 21);
    for (let index = 0; index < 20; index++) assert.equal(lifecycle.details[`update${index}`], true);
    const events = (await readFile(join(jobDir, "lifecycle-events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.revision), Array.from({ length: 21 }, (_, index) => index + 1));
    await updateJobLifecycle(jobDir, "cancelled", "cancelled");
    await updateJobLifecycle(jobDir, "running");
    assert.equal((await readJobLifecycle(jobDir)).phase, "cancelled");
    await updateJobLifecycle(jobDir, "recovery_required", "termination indeterminate");
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");
    await updateJobLifecycle(jobDir, "failed", "late finalizer");
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");
    await reconcileJobLifecycle(jobDir, "failed", "verified recovery");
    assert.equal((await readJobLifecycle(jobDir)).phase, "failed");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("acceptance and cancellation have one exclusive terminal decision", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-decision-"));
  try {
    const [accept, cancel] = await Promise.all([
      claimJobDecision(jobDir, JOB_ID, "accept"),
      claimJobDecision(jobDir, JOB_ID, "cancel"),
    ]);
    assert.equal(Number(accept.won) + Number(cancel.won), 1);
    const decision = await readJobDecision(jobDir);
    assert.ok(decision);
    assert.equal(accept.record.owner, decision.owner);
    assert.equal(cancel.record.owner, decision.owner);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a cancellation decision is authoritative over stale lifecycle revisions", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-decision-lifecycle-"));
  try {
    await initializeJobLifecycle(jobDir, JOB_ID, BATCH_ID, "running");
    await claimJobDecision(jobDir, JOB_ID, "cancel");
    assert.equal((await readJobLifecycle(jobDir)).phase, "cancelled");
    await updateJobLifecycle(jobDir, "recovery_required", "termination indeterminate");
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");
    await updateJobLifecycle(jobDir, "failed", "late finalizer");
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("lifecycle revision claims serialize updates across processes", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-lifecycle-processes-"));
  try {
    await initializeJobLifecycle(jobDir, JOB_ID, BATCH_ID, "planned");
    const moduleUrl = new URL("../extensions/supacode-subagents/lifecycle.ts", import.meta.url).href;
    await Promise.all(["left", "right"].map((key) => runNode(`
      import { updateJobLifecycle } from ${JSON.stringify(moduleUrl)};
      await updateJobLifecycle(${JSON.stringify(jobDir)}, "running", undefined, { ${key}: true });
    `)));
    const lifecycle = await readJobLifecycle(jobDir);
    assert.equal(lifecycle.revision, 3);
    assert.equal(lifecycle.details.left, true);
    assert.equal(lifecycle.details.right, true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("runner exits require matching job, nonce, and wrapper PID", () => {
  const runner = {
    schemaVersion: 2,
    jobId: JOB_ID,
    launchNonce: "nonce",
    wrapper: {
      pid: 1234,
      startSignature: "start",
      processGroup: 1234,
      command: "worker",
      launchNonce: "nonce",
    },
    startedAt: new Date().toISOString(),
  };
  const exit = {
    schemaVersion: 2,
    jobId: JOB_ID,
    launchNonce: "nonce",
    wrapperPid: 1234,
    exitCode: 0,
    exitedAt: new Date().toISOString(),
  };
  assert.equal(authenticateRunnerExit(JOB_ID, "nonce", runner, exit), exit);
  assert.equal(authenticateRunnerExit("different-job", "nonce", runner, exit), undefined);
  assert.equal(authenticateRunnerExit(JOB_ID, "different-nonce", runner, exit), undefined);
  assert.equal(authenticateRunnerExit(JOB_ID, "nonce", runner, { ...exit, wrapperPid: 5678 }), undefined);
});

test("one terminal claimant wins and late completion cannot overwrite it", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-terminal-"));
  try {
    const timeoutStatus = { state: "failed", stopReason: "timeout" };
    const workerStatus = { state: "completed", stopReason: "stop" };
    const [timeout, worker] = await Promise.all([
      claimWorkerTerminal(jobDir, JOB_ID, "timeout", timeoutStatus, "timed out"),
      claimWorkerTerminal(jobDir, JOB_ID, "worker", workerStatus, "completed"),
    ]);
    assert.equal(Number(timeout.won) + Number(worker.won), 1);
    const terminal = await readWorkerTerminal(jobDir);
    assert.ok(terminal);
    const canonicalStatus = JSON.parse(await readFile(join(jobDir, "status.json"), "utf8"));
    const canonicalResult = await readFile(join(jobDir, "result.md"), "utf8");
    assert.deepEqual(canonicalStatus, terminal.status);
    assert.equal(canonicalResult, await readTerminalOutput(terminal));
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("corrupt lifecycle JSON is reported rather than treated as missing", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-lifecycle-corrupt-"));
  try {
    await writeFile(join(jobDir, "lifecycle.json"), "{not-json\n");
    await assert.rejects(readJobLifecycle(jobDir), /Corrupt JSON metadata/);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
