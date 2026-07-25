import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  acquireOrchestratorLease,
  acquireOrchestratorRecoveryLease,
  authorizeOrchestratorRecovery,
} from "../extensions/supacode-subagents/orchestrator-lease.ts";

const JOB_ID = "11111111-2222-4333-8444-555555555555";

function childLease(jobDir) {
  const moduleUrl = pathToFileURL(join(process.cwd(), "extensions/supacode-subagents/orchestrator-lease.ts")).href;
  const source = `
    import { acquireOrchestratorLease } from ${JSON.stringify(moduleUrl)};
    await acquireOrchestratorLease(${JSON.stringify(jobDir)}, ${JSON.stringify(JOB_ID)});
  `;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--input-type=module", "-e", source],
      { encoding: "utf8" },
      (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolve(),
    );
  });
}

test("an active authenticated orchestrator blocks recovery until release", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-live-"));
  try {
    const lease = await acquireOrchestratorLease(jobDir, JOB_ID);
    const active = await authorizeOrchestratorRecovery(jobDir, JOB_ID, 1);
    assert.equal(active.allowed, false);
    assert.equal(active.ownerState, "alive");
    await lease.release();
    const released = await authorizeOrchestratorRecovery(jobDir, JOB_ID, 1);
    assert.equal(released.allowed, true);
    assert.match(released.reason, /released/);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("lease artifacts cannot be bypassed by missing or unsupported metadata versions", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-version-"));
  try {
    const lease = await acquireOrchestratorLease(jobDir, JOB_ID);
    const missingVersion = await authorizeOrchestratorRecovery(jobDir, JOB_ID, undefined);
    assert.equal(missingVersion.allowed, false);
    assert.equal(missingVersion.ownerState, "alive");
    const unsupported = await authorizeOrchestratorRecovery(jobDir, JOB_ID, 2);
    assert.equal(unsupported.allowed, false);
    assert.match(unsupported.reason, /Unsupported/);
    await lease.release();
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("cancellation generation closes a live-orchestrator release race", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-live-cancel-"));
  try {
    const orchestrator = await acquireOrchestratorLease(jobDir, JOB_ID);
    const cancellation = await acquireOrchestratorRecoveryLease(
      jobDir,
      JOB_ID,
      1,
      { allowLiveOrchestrator: true },
    );
    assert.equal(cancellation.acquired, true);
    await orchestrator.release();
    const racingRecovery = await acquireOrchestratorRecoveryLease(jobDir, JOB_ID, 1);
    assert.equal(racingRecovery.acquired, false);
    assert.equal(racingRecovery.ownerState, "alive");
    await cancellation.lease.release();
    const laterRecovery = await acquireOrchestratorRecoveryLease(jobDir, JOB_ID, 1);
    assert.equal(laterRecovery.acquired, true);
    await laterRecovery.lease.release();
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("concurrent recovery attempts are serialized by immutable generations", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-recovery-claim-"));
  try {
    const lease = await acquireOrchestratorLease(jobDir, JOB_ID);
    await lease.release();
    const attempts = await Promise.all([
      acquireOrchestratorRecoveryLease(jobDir, JOB_ID, 1),
      acquireOrchestratorRecoveryLease(jobDir, JOB_ID, 1),
    ]);
    const acquired = attempts.filter((attempt) => attempt.acquired);
    assert.equal(acquired.length, 1);
    await acquired[0].lease.release();
    const next = await acquireOrchestratorRecoveryLease(jobDir, JOB_ID, 1);
    assert.equal(next.acquired, true);
    assert.equal(next.lease.generation, 2);
    await next.lease.release();
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("recovery can take ownership only after an unreleased owner process is gone", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-orchestrator-crash-"));
  try {
    await childLease(jobDir);
    const authorization = await authorizeOrchestratorRecovery(jobDir, JOB_ID, 1);
    assert.equal(authorization.allowed, true);
    assert.equal(authorization.ownerState, "missing");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
