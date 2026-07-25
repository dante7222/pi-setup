import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authenticateRunnerExit,
  claimJobDecision,
  claimWorkerTerminal,
  initializeJobLifecycle,
  listLifecycleJobs,
  publishWorkerReport,
  readJobDecision,
  readJobLifecycle,
  readTerminalOutput,
  readWorkerReport,
  reconcileJobLifecycle,
  restoreWorkerTerminalProjection,
  resolveLifecycleJob,
  readWorkerTerminal,
  updateJobLifecycle,
  writeJobControl,
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
    await writeFile(join(jobDir, "status.json"), `${JSON.stringify({ state: "losing-projection" })}\n`);
    await writeFile(join(jobDir, "result.md"), "losing projection\n");
    const late = await claimWorkerTerminal(
      jobDir,
      JOB_ID,
      "cancel",
      { state: "failed", stopReason: "cancelled" },
      "late cancellation",
    );
    assert.equal(late.won, false);
    const canonicalStatus = JSON.parse(await readFile(join(jobDir, "status.json"), "utf8"));
    const canonicalResult = await readFile(join(jobDir, "result.md"), "utf8");
    assert.deepEqual(canonicalStatus, terminal.status);
    assert.equal(canonicalResult, await readTerminalOutput(terminal));
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("an authoritative terminal repairs stale status and result projections", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-terminal-projection-"));
  try {
    const status = { state: "completed", stopReason: "stop" };
    const terminal = (await claimWorkerTerminal(jobDir, JOB_ID, "worker", status, "final output")).record;
    await writeFile(join(jobDir, "status.json"), `${JSON.stringify({ state: "running" })}\n`);
    await writeFile(join(jobDir, "result.md"), "stale output\n");

    await restoreWorkerTerminalProjection(jobDir, terminal);

    assert.deepEqual(JSON.parse(await readFile(join(jobDir, "status.json"), "utf8")), status);
    assert.equal(await readFile(join(jobDir, "result.md"), "utf8"), "final output\n");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("terminal and report outputs are bound to their token-derived paths", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-result-token-binding-"));
  try {
    const status = { state: "completed", stopReason: "stop" };
    const terminal = (await claimWorkerTerminal(jobDir, JOB_ID, "worker", status, "same output")).record;
    const alternateTerminal = join(jobDir, "terminal-results", "alternate.md");
    await writeFile(alternateTerminal, "same output\n");
    await writeFile(join(jobDir, "terminal.json"), `${JSON.stringify({
      ...terminal,
      resultFile: alternateTerminal,
    }, null, 2)}\n`);
    await assert.rejects(readWorkerTerminal(jobDir), /Unsupported terminal metadata/);

    const report = await publishWorkerReport(jobDir, JOB_ID, "nonce", status, "same report");
    const alternateReport = join(jobDir, "worker-reports", "alternate.md");
    await writeFile(alternateReport, "same report\n");
    await writeFile(join(jobDir, "worker-report.json"), `${JSON.stringify({
      ...report,
      resultFile: alternateReport,
    }, null, 2)}\n`);
    await assert.rejects(
      readWorkerReport(jobDir, JOB_ID, "nonce"),
      /Unsupported worker report metadata/,
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("one corrupt job does not hide or block unrelated lifecycle jobs", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-lifecycle-list-isolation-"));
  const validDir = join(agentDir, "subagents", BATCH_ID, JOB_ID);
  const corruptId = "22222222-3333-4444-8555-666666666666";
  const corruptDir = join(agentDir, "subagents", BATCH_ID, corruptId);
  try {
    await mkdir(validDir, { recursive: true });
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(validDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: JOB_ID,
      batchId: BATCH_ID,
      title: "valid job",
      mode: "research",
      createdAt: new Date().toISOString(),
    })}\n`);
    await initializeJobLifecycle(validDir, JOB_ID, BATCH_ID, "planned");
    await writeFile(join(corruptDir, "job.json"), "{not-json\n");

    const jobs = await listLifecycleJobs(agentDir);
    assert.equal(jobs.some((job) => job.id === JOB_ID && job.title === "valid job"), true);
    assert.equal(jobs.some((job) => job.id === corruptId && typeof job.metadata.corruptMetadataError === "string"), true);
    assert.equal((await resolveLifecycleJob(agentDir, JOB_ID.slice(0, 8))).id, JOB_ID);
    await assert.rejects(
      resolveLifecycleJob(agentDir, corruptId.slice(0, 8)),
      /metadata is corrupt/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("lifecycle discovery binds storage, lifecycle, terminal, decision, and control identities", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-lifecycle-identity-"));
  const ids = {
    path: "21111111-2222-4333-8444-555555555555",
    lifecycle: "31111111-2222-4333-8444-555555555555",
    terminal: "41111111-2222-4333-8444-555555555555",
    decision: "51111111-2222-4333-8444-555555555555",
    control: "61111111-2222-4333-8444-555555555555",
    runtime: "71111111-2222-4333-8444-555555555555",
  };
  const wrongId = "99999999-8888-4777-8666-555555555555";
  try {
    const writeJob = async (directoryId, declaredId = directoryId) => {
      const jobDir = join(agentDir, "subagents", BATCH_ID, directoryId);
      await mkdir(jobDir, { recursive: true });
      await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
        schemaVersion: 2,
        id: declaredId,
        batchId: BATCH_ID,
        title: `identity ${directoryId}`,
        mode: "research",
        createdAt: new Date().toISOString(),
      })}\n`);
      return jobDir;
    };

    await writeJob(ids.path, wrongId);
    await initializeJobLifecycle(await writeJob(ids.lifecycle), ids.lifecycle, wrongId, "planned");
    await claimWorkerTerminal(
      await writeJob(ids.terminal),
      wrongId,
      "recovery",
      { state: "failed", stopReason: "error" },
      "wrong terminal",
    );
    await claimJobDecision(await writeJob(ids.decision), wrongId, "cancel");
    await writeJobControl(await writeJob(ids.control), wrongId, "wrong control");
    const runtimeJobDir = await writeJob(ids.runtime);
    const outsideRuntime = join(agentDir, "outside-runtime");
    const linkedRuntime = join(runtimeJobDir, "active-runtime");
    await mkdir(outsideRuntime);
    await symlink(outsideRuntime, linkedRuntime);
    const runtimeJob = JSON.parse(await readFile(join(runtimeJobDir, "job.json"), "utf8"));
    runtimeJob.activeWorkerJobDir = linkedRuntime;
    await writeFile(join(runtimeJobDir, "job.json"), `${JSON.stringify(runtimeJob)}\n`);

    const jobs = await listLifecycleJobs(agentDir);
    for (const id of Object.values(ids)) {
      const job = jobs.find((candidate) => candidate.id === id);
      assert.ok(job, id);
      assert.equal(typeof job.metadata.corruptMetadataError, "string", id);
    }
  } finally {
    await rm(agentDir, { recursive: true, force: true });
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
