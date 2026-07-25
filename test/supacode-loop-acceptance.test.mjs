import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureReviewerProcessEvidence,
  captureValidationProcessEvidence,
  loopCheckFingerprint,
  publishLoopAcceptance,
  readVerifiedLoopAcceptance,
  writeLoopPolicy,
} from "../extensions/supacode-subagents/loop-acceptance.ts";
import {
  claimWorkerTerminal,
  writeRunnerExit,
  writeRunnerProcess,
} from "../extensions/supacode-subagents/lifecycle.ts";

const JOB_ID = "11111111-2222-4333-8444-555555555555";
const TREE = "1".repeat(40);
const COMMIT = "2".repeat(40);
const HEAD = "3".repeat(40);

async function evidenceFixture() {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-loop-evidence-"));
  const iterationDir = join(jobDir, "iterations", "001");
  await mkdir(iterationDir, { recursive: true });
  const patchPath = join(iterationDir, "candidate.patch");
  const patch = Buffer.from("diff --git a/file b/file\n");
  await writeFile(patchPath, patch);
  const candidate = {
    attempt: 1,
    tree: TREE,
    commit: COMMIT,
    ref: `refs/pi-agent-candidates/${JOB_ID}/001`,
    head: HEAD,
    branch: "pi-agent/batch/job",
    patchPath,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    patchBytes: patch.length,
    patchPreview: patch.toString("utf8"),
    patchPreviewTruncated: false,
    changedPaths: ["file"],
    gitlinkPaths: [],
  };
  const attestation = {
    candidateTree: TREE,
    candidateCommit: COMMIT,
    checkoutPath: join(iterationDir, "checkout"),
    head: COMMIT,
    tree: TREE,
    unchanged: true,
    statusPaths: [],
    gitlinkPaths: [],
    observedAt: new Date().toISOString(),
  };
  const writeProcessEvidence = async (processDir, processJobId, launchNonce) => {
    const wrapper = {
      pid: 999_991,
      startSignature: "fixture process",
      processGroup: 999_991,
      command: "fixture",
      launchNonce,
    };
    await writeRunnerProcess(processDir, {
      schemaVersion: 2,
      jobId: processJobId,
      launchNonce,
      wrapper,
      startedAt: new Date().toISOString(),
    });
    await writeRunnerExit(processDir, {
      schemaVersion: 2,
      jobId: processJobId,
      launchNonce,
      wrapperPid: wrapper.pid,
      exitCode: 0,
      exitedAt: new Date().toISOString(),
    });
  };
  const checkDir = join(iterationDir, "checks", "01");
  const checkJobId = `${JOB_ID}-check-1-1`;
  const checkNonce = "check-launch-nonce";
  await writeProcessEvidence(checkDir, checkJobId, checkNonce);
  const checkInput = {
    command: "npm test",
    candidateTree: TREE,
    candidateCommit: COMMIT,
    before: attestation,
    after: attestation,
    passed: true,
    exitCode: 0,
    killed: false,
    timedOut: false,
    terminationVerified: true,
    process: await captureValidationProcessEvidence(checkDir, checkJobId, checkNonce, 0),
  };
  const checks = [{ ...checkInput, fingerprint: loopCheckFingerprint(checkInput) }];
  const reviewDir = join(jobDir, "reviewer");
  const reviewJobId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const reviewNonce = "review-launch-nonce";
  await writeProcessEvidence(reviewDir, reviewJobId, reviewNonce);
  await claimWorkerTerminal(
    reviewDir,
    reviewJobId,
    "worker",
    { state: "completed" },
    "VERDICT: PASS",
  );
  const reviews = [{
    profileId: "correctness",
    verdict: "pass",
    state: "completed",
    before: attestation,
    after: attestation,
    process: await captureReviewerProcessEvidence(reviewDir, reviewJobId, reviewNonce),
  }];
  await writeFile(join(iterationDir, "checks.json"), `${JSON.stringify(checks, null, 2)}\n`);
  await writeFile(join(iterationDir, "reviews.json"), `${JSON.stringify(reviews, null, 2)}\n`);
  await writeFile(join(iterationDir, "iteration.json"), `${JSON.stringify({
    attempt: 1,
    checks,
    reviews,
    evidence: candidate,
    candidateFingerprint: candidate.tree,
    transition: { state: "awaiting_apply", reason: "passed" },
  }, null, 2)}\n`);
  const policy = await writeLoopPolicy(jobDir, JOB_ID, {
    objective: "test objective",
    checks: [{ command: "npm test", timeoutSeconds: 60 }],
    reviewers: [{ id: "correctness" }],
    maxAttempts: 3,
    delegation: {
      baseSha: HEAD,
      destinationRoot: jobDir,
      branch: candidate.branch,
    },
  });
  return { jobDir, iterationDir, candidate, checks, reviews, policy };
}

test("loop acceptance binds policy, checks, reviews, iteration, patch, and candidate", async () => {
  const fixture = await evidenceFixture();
  try {
    const intent = await publishLoopAcceptance(
      fixture.jobDir,
      JOB_ID,
      fixture.policy,
      fixture.candidate,
      fixture.checks,
      fixture.reviews,
    );
    const verified = await readVerifiedLoopAcceptance(fixture.jobDir, JOB_ID);
    assert.equal(verified.candidate.tree, TREE);
    assert.equal(verified.gateManifest.sha256, intent.gateManifest.sha256);
    assert.equal((await readFile(intent.gateManifest.path, "utf8")).includes("fingerprints"), true);
  } finally {
    await rm(fixture.jobDir, { recursive: true, force: true });
  }
});

test("accepted loop recovery rejects post-acceptance gate tampering", async () => {
  const fixture = await evidenceFixture();
  try {
    await publishLoopAcceptance(
      fixture.jobDir,
      JOB_ID,
      fixture.policy,
      fixture.candidate,
      fixture.checks,
      fixture.reviews,
    );
    await writeFile(join(fixture.iterationDir, "checks.json"), "[]\n");
    await assert.rejects(
      readVerifiedLoopAcceptance(fixture.jobDir, JOB_ID),
      /gate evidence changed/,
    );
  } finally {
    await rm(fixture.jobDir, { recursive: true, force: true });
  }
});

test("accepted loop recovery reauthenticates bound gate processes", async () => {
  const fixture = await evidenceFixture();
  try {
    await publishLoopAcceptance(
      fixture.jobDir,
      JOB_ID,
      fixture.policy,
      fixture.candidate,
      fixture.checks,
      fixture.reviews,
    );
    await writeFile(fixture.checks[0].process.runnerExit.path, "{}\n");
    await assert.rejects(
      readVerifiedLoopAcceptance(fixture.jobDir, JOB_ID),
      /process evidence changed/,
    );
  } finally {
    await rm(fixture.jobDir, { recursive: true, force: true });
  }
});

test("acceptance publication rejects a candidate already present in hashed attempt history", async () => {
  const fixture = await evidenceFixture();
  try {
    await writeFile(join(fixture.iterationDir, "iteration.json"), `${JSON.stringify({
      attempt: 1,
      checks: fixture.checks,
      reviews: fixture.reviews,
      evidence: fixture.candidate,
      candidateFingerprint: fixture.candidate.tree,
      transition: { state: "repairing", reason: "repair" },
    }, null, 2)}\n`);
    const secondDir = join(fixture.jobDir, "iterations", "002");
    await mkdir(secondDir, { recursive: true });
    const secondPatchPath = join(secondDir, "candidate.patch");
    const patch = await readFile(fixture.candidate.patchPath);
    await writeFile(secondPatchPath, patch);
    const secondCandidate = {
      ...fixture.candidate,
      attempt: 2,
      ref: `refs/pi-agent-candidates/${JOB_ID}/002`,
      patchPath: secondPatchPath,
    };
    await writeFile(join(secondDir, "checks.json"), `${JSON.stringify(fixture.checks, null, 2)}\n`);
    await writeFile(join(secondDir, "reviews.json"), `${JSON.stringify(fixture.reviews, null, 2)}\n`);
    await writeFile(join(secondDir, "iteration.json"), `${JSON.stringify({
      attempt: 2,
      checks: fixture.checks,
      reviews: fixture.reviews,
      evidence: secondCandidate,
      candidateFingerprint: secondCandidate.tree,
      transition: { state: "awaiting_apply", reason: "passed" },
    }, null, 2)}\n`);
    await assert.rejects(
      publishLoopAcceptance(
        fixture.jobDir,
        JOB_ID,
        fixture.policy,
        secondCandidate,
        fixture.checks,
        fixture.reviews,
      ),
      /Repeated candidate state/,
    );
  } finally {
    await rm(fixture.jobDir, { recursive: true, force: true });
  }
});
