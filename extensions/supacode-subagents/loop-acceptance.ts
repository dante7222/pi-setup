import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { durableAtomicWrite, readJsonStrict } from "./durable-state.ts";
import {
  authenticateRunnerExit,
  readRunnerExit,
  readRunnerProcess,
  readWorkerTerminal,
} from "./lifecycle.ts";
import type { CandidateAttestation, LoopCandidate } from "./candidate-tree.ts";

const OBJECT_ID_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export interface HashedEvidenceFile {
  path: string;
  sha256: string;
}

export interface BoundProcessEvidence {
  jobDir: string;
  jobId: string;
  launchNonce: string;
  runnerProcess: HashedEvidenceFile;
  runnerExit: HashedEvidenceFile;
}

export interface BoundReviewerProcessEvidence extends BoundProcessEvidence {
  terminal: HashedEvidenceFile;
}

export interface AcceptanceCheckEvidence {
  command: string;
  candidateTree: string;
  candidateCommit: string;
  before: CandidateAttestation;
  after: CandidateAttestation;
  passed: boolean;
  exitCode: number;
  killed: boolean;
  timedOut: boolean;
  terminationVerified: boolean;
  process?: BoundProcessEvidence;
  fingerprint: string;
}

export interface AcceptanceReviewEvidence {
  profileId: string;
  verdict?: string;
  state: string;
  before: CandidateAttestation;
  after: CandidateAttestation;
  process?: BoundReviewerProcessEvidence;
}

export interface LoopDelegationBinding {
  baseSha: string;
  destinationRoot: string;
  branch: string;
}

interface HistoryEvidenceFile extends HashedEvidenceFile {
  attempt: number;
  candidateFingerprint: string;
}

export interface LoopGateManifest {
  schemaVersion: 2;
  evidenceVersion: 2;
  jobId: string;
  attempt: number;
  policy: HashedEvidenceFile;
  delegation: LoopDelegationBinding;
  candidate: {
    tree: string;
    commit: string;
    ref: string;
    patchSha256: string;
  };
  checks: HashedEvidenceFile & {
    count: number;
    fingerprints: string[];
  };
  reviews: HashedEvidenceFile & {
    count: number;
    profileIds: string[];
  };
  history: HistoryEvidenceFile[];
  iteration: HashedEvidenceFile;
  createdAt: string;
}

export interface LoopAcceptanceIntent {
  schemaVersion: 2;
  evidenceVersion: 2;
  jobId: string;
  delegation: LoopDelegationBinding;
  candidate: LoopCandidate;
  policy: HashedEvidenceFile;
  gateManifest: HashedEvidenceFile;
  createdAt: string;
}

interface LoopPolicyRecord {
  schemaVersion: 2;
  evidenceVersion: 2;
  jobId: string;
  policy: unknown;
  createdAt: string;
}

interface ParsedLoopPolicy {
  checks: Array<{ command: string; timeoutSeconds: number }>;
  reviewerIds: string[];
  maxAttempts: number;
  delegation: LoopDelegationBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(await fs.promises.readFile(filePath));
}

function iterationDirectory(jobDir: string, attempt: number): string {
  return path.join(jobDir, "iterations", String(attempt).padStart(3, "0"));
}

function assertExactEvidenceFile(
  value: unknown,
  expectedPath: string,
  label: string,
): asserts value is HashedEvidenceFile {
  if (!isRecord(value) || value.path !== expectedPath ||
      typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`${label} identity is invalid.`);
  }
}

function assertCandidate(candidate: unknown, jobDir: string, jobId: string): asserts candidate is LoopCandidate {
  if (!isRecord(candidate)) throw new Error("Accepted candidate is missing.");
  const attempt = candidate.attempt;
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) {
    throw new Error("Accepted candidate attempt is invalid.");
  }
  const expectedIterationDir = iterationDirectory(jobDir, attempt as number);
  const expectedPatchPath = path.join(expectedIterationDir, "candidate.patch");
  if (
    typeof candidate.tree !== "string" || !OBJECT_ID_PATTERN.test(candidate.tree) ||
    typeof candidate.commit !== "string" || !OBJECT_ID_PATTERN.test(candidate.commit) ||
    typeof candidate.head !== "string" || !OBJECT_ID_PATTERN.test(candidate.head) ||
    typeof candidate.branch !== "string" || candidate.branch.length === 0 ||
    candidate.ref !== `refs/pi-agent-candidates/${jobId}/${String(attempt).padStart(3, "0")}` ||
    candidate.patchPath !== expectedPatchPath ||
    typeof candidate.patchSha256 !== "string" || !SHA256_PATTERN.test(candidate.patchSha256) ||
    !Number.isSafeInteger(candidate.patchBytes) || (candidate.patchBytes as number) < 0 ||
    typeof candidate.patchPreview !== "string" || typeof candidate.patchPreviewTruncated !== "boolean" ||
    !Array.isArray(candidate.changedPaths) || !candidate.changedPaths.every((entry) => typeof entry === "string") ||
    !Array.isArray(candidate.gitlinkPaths) || !candidate.gitlinkPaths.every((entry) => typeof entry === "string")
  ) throw new Error("Accepted candidate identity is invalid.");
}

function attestationMatches(
  value: unknown,
  candidate: Pick<LoopCandidate, "tree" | "commit">,
): value is CandidateAttestation {
  if (!isRecord(value)) return false;
  return value.candidateTree === candidate.tree && value.candidateCommit === candidate.commit &&
    value.head === candidate.commit && value.tree === candidate.tree && value.unchanged === true &&
    typeof value.checkoutPath === "string" && path.isAbsolute(value.checkoutPath) &&
    typeof value.observedAt === "string" &&
    Array.isArray(value.statusPaths) && value.statusPaths.length === 0 &&
    (value.statusPathCount === undefined || value.statusPathCount === 0) &&
    Array.isArray(value.gitlinkPaths) && value.gitlinkPaths.length === 0 &&
    (value.gitlinkPathCount === undefined || value.gitlinkPathCount === 0);
}

function parseLoopPolicyRecord(
  value: unknown,
  expectedJobId: string,
): ParsedLoopPolicy {
  if (!isRecord(value) || value.schemaVersion !== 2 || value.evidenceVersion !== 2 ||
      value.jobId !== expectedJobId || typeof value.createdAt !== "string" || !isRecord(value.policy)) {
    throw new Error("Delegate-loop policy record is invalid.");
  }
  const policy = value.policy;
  if (typeof policy.objective !== "string" || !policy.objective.trim() ||
      !Array.isArray(policy.checks) || policy.checks.length === 0 ||
      !Array.isArray(policy.reviewers) || policy.reviewers.length === 0 ||
      !Number.isSafeInteger(policy.maxAttempts) || (policy.maxAttempts as number) < 1 ||
      !isRecord(policy.delegation)) {
    throw new Error("Delegate-loop policy semantics are incomplete.");
  }
  const checks = policy.checks.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.command !== "string" || !entry.command.trim() ||
        !Number.isSafeInteger(entry.timeoutSeconds) || (entry.timeoutSeconds as number) < 1) {
      throw new Error(`Delegate-loop policy check ${index + 1} is invalid.`);
    }
    return { command: entry.command, timeoutSeconds: entry.timeoutSeconds as number };
  });
  const reviewerIds = policy.reviewers.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      throw new Error(`Delegate-loop policy reviewer ${index + 1} is invalid.`);
    }
    return entry.id;
  });
  if (new Set(reviewerIds).size !== reviewerIds.length) {
    throw new Error("Delegate-loop policy contains duplicate reviewer profiles.");
  }
  const delegation = policy.delegation;
  if (
    typeof delegation.baseSha !== "string" || !OBJECT_ID_PATTERN.test(delegation.baseSha) ||
    typeof delegation.destinationRoot !== "string" || !path.isAbsolute(delegation.destinationRoot) ||
    path.normalize(delegation.destinationRoot) !== delegation.destinationRoot ||
    typeof delegation.branch !== "string" || !delegation.branch
  ) throw new Error("Delegate-loop delegation identity is invalid.");
  return {
    checks,
    reviewerIds,
    maxAttempts: policy.maxAttempts as number,
    delegation: {
      baseSha: delegation.baseSha,
      destinationRoot: delegation.destinationRoot,
      branch: delegation.branch,
    },
  };
}

function assertBoundProcessShape(
  value: unknown,
  terminalRequired: boolean,
): asserts value is BoundProcessEvidence | BoundReviewerProcessEvidence {
  if (!isRecord(value) || typeof value.jobDir !== "string" || !path.isAbsolute(value.jobDir) ||
      typeof value.jobId !== "string" || !value.jobId ||
      typeof value.launchNonce !== "string" || !value.launchNonce) {
    throw new Error("Gate process evidence identity is invalid.");
  }
  assertExactEvidenceFile(value.runnerProcess, path.join(value.jobDir, "runner-process.json"), "Gate runner process");
  assertExactEvidenceFile(value.runnerExit, path.join(value.jobDir, "runner-exit.json"), "Gate runner exit");
  if (terminalRequired) {
    assertExactEvidenceFile(value.terminal, path.join(value.jobDir, "terminal.json"), "Reviewer terminal");
  }
}

async function verifyBoundProcessEvidence(
  evidence: BoundProcessEvidence | BoundReviewerProcessEvidence,
  expectedExitCode: number,
  terminalRequired: boolean,
): Promise<void> {
  assertBoundProcessShape(evidence, terminalRequired);
  const files = [evidence.runnerProcess, evidence.runnerExit];
  if (terminalRequired) files.push((evidence as BoundReviewerProcessEvidence).terminal);
  const hashes = await Promise.all(files.map((entry) => hashFile(entry.path)));
  if (files.some((entry, index) => entry.sha256 !== hashes[index])) {
    throw new Error("Gate process evidence changed after capture.");
  }
  const [runner, exit] = await Promise.all([
    readRunnerProcess(evidence.jobDir),
    readRunnerExit(evidence.jobDir),
  ]);
  const authenticatedExit = authenticateRunnerExit(
    evidence.jobId,
    evidence.launchNonce,
    runner,
    exit,
  );
  if (!authenticatedExit || authenticatedExit.exitCode !== expectedExitCode) {
    throw new Error("Gate runner exit is missing, unauthenticated, or has the wrong status.");
  }
  if (terminalRequired) {
    const terminal = await readWorkerTerminal<Record<string, unknown>>(evidence.jobDir);
    if (!terminal || terminal.jobId !== evidence.jobId || terminal.owner !== "worker" ||
        !isRecord(terminal.status) || terminal.status.state !== "completed") {
      throw new Error("Reviewer terminal evidence is not an authenticated successful worker result.");
    }
  }
}

async function captureProcessEvidence(
  jobDir: string,
  jobId: string,
  launchNonce: string,
): Promise<BoundProcessEvidence> {
  const runnerProcessPath = path.join(jobDir, "runner-process.json");
  const runnerExitPath = path.join(jobDir, "runner-exit.json");
  const evidence = {
    jobDir,
    jobId,
    launchNonce,
    runnerProcess: { path: runnerProcessPath, sha256: await hashFile(runnerProcessPath) },
    runnerExit: { path: runnerExitPath, sha256: await hashFile(runnerExitPath) },
  } satisfies BoundProcessEvidence;
  assertBoundProcessShape(evidence, false);
  return evidence;
}

export async function captureValidationProcessEvidence(
  jobDir: string,
  jobId: string,
  launchNonce: string,
  expectedExitCode: number,
): Promise<BoundProcessEvidence> {
  const evidence = await captureProcessEvidence(jobDir, jobId, launchNonce);
  await verifyBoundProcessEvidence(evidence, expectedExitCode, false);
  return evidence;
}

export async function captureReviewerProcessEvidence(
  jobDir: string,
  jobId: string,
  launchNonce: string,
): Promise<BoundReviewerProcessEvidence> {
  const processEvidence = await captureProcessEvidence(jobDir, jobId, launchNonce);
  const terminalPath = path.join(jobDir, "terminal.json");
  const evidence = {
    ...processEvidence,
    terminal: { path: terminalPath, sha256: await hashFile(terminalPath) },
  } satisfies BoundReviewerProcessEvidence;
  await verifyBoundProcessEvidence(evidence, 0, true);
  return evidence;
}

export function loopCheckFingerprint(
  check: Omit<AcceptanceCheckEvidence, "fingerprint">,
): string {
  return sha256(JSON.stringify({
    command: check.command,
    candidateTree: check.candidateTree,
    candidateCommit: check.candidateCommit,
    before: check.before,
    after: check.after,
    passed: check.passed,
    exitCode: check.exitCode,
    killed: check.killed,
    timedOut: check.timedOut,
    terminationVerified: check.terminationVerified,
    process: check.process,
  }));
}

async function validateChecks(
  checks: unknown,
  policy: ParsedLoopPolicy,
  candidate: LoopCandidate,
  fingerprints: string[],
): Promise<AcceptanceCheckEvidence[]> {
  if (!Array.isArray(checks) || checks.length !== policy.checks.length || checks.length !== fingerprints.length) {
    throw new Error("Accepted check evidence count does not match its policy and manifest.");
  }
  const validated: AcceptanceCheckEvidence[] = [];
  for (let index = 0; index < checks.length; index++) {
    const check = checks[index];
    if (
      !isRecord(check) || check.command !== policy.checks[index].command || check.passed !== true ||
      check.exitCode !== 0 || check.killed !== false || check.timedOut !== false ||
      check.terminationVerified !== true ||
      check.candidateTree !== candidate.tree || check.candidateCommit !== candidate.commit ||
      typeof check.fingerprint !== "string" || check.fingerprint !== fingerprints[index] ||
      !attestationMatches(check.before, candidate) || !attestationMatches(check.after, candidate)
    ) throw new Error(`Accepted check ${index + 1} is not passing immutable policy evidence.`);
    assertBoundProcessShape(check.process, false);
    const typed = check as unknown as AcceptanceCheckEvidence;
    const { fingerprint: _fingerprint, ...fingerprintInput } = typed;
    if (loopCheckFingerprint(fingerprintInput) !== check.fingerprint) {
      throw new Error(`Accepted check ${index + 1} fingerprint is invalid.`);
    }
    await verifyBoundProcessEvidence(typed.process as BoundProcessEvidence, 0, false);
    validated.push(typed);
  }
  return validated;
}

async function validateReviews(
  reviews: unknown,
  policy: ParsedLoopPolicy,
  candidate: LoopCandidate,
  profileIds: string[],
): Promise<AcceptanceReviewEvidence[]> {
  if (!Array.isArray(reviews) || reviews.length !== policy.reviewerIds.length ||
      reviews.length !== profileIds.length) {
    throw new Error("Accepted review evidence count does not match its policy and manifest.");
  }
  const validated: AcceptanceReviewEvidence[] = [];
  for (let index = 0; index < reviews.length; index++) {
    const review = reviews[index];
    if (
      !isRecord(review) || review.profileId !== policy.reviewerIds[index] ||
      review.profileId !== profileIds[index] || review.state !== "completed" || review.verdict !== "pass" ||
      !attestationMatches(review.before, candidate) || !attestationMatches(review.after, candidate)
    ) throw new Error(`Accepted review ${index + 1} is not passing immutable policy evidence.`);
    assertBoundProcessShape(review.process, true);
    const typed = review as unknown as AcceptanceReviewEvidence;
    await verifyBoundProcessEvidence(typed.process as BoundReviewerProcessEvidence, 0, true);
    validated.push(typed);
  }
  return validated;
}

function validateIteration(
  iteration: unknown,
  candidate: LoopCandidate,
  checks: AcceptanceCheckEvidence[],
  reviews: AcceptanceReviewEvidence[],
): void {
  if (!isRecord(iteration) || iteration.attempt !== candidate.attempt ||
      iteration.candidateFingerprint !== candidate.tree ||
      !isRecord(iteration.evidence) || iteration.evidence.tree !== candidate.tree ||
      iteration.evidence.commit !== candidate.commit || !isRecord(iteration.transition) ||
      iteration.transition.state !== "awaiting_apply" ||
      JSON.stringify(iteration.checks) !== JSON.stringify(checks) ||
      JSON.stringify(iteration.reviews) !== JSON.stringify(reviews)) {
    throw new Error("Accepted iteration did not reach awaiting_apply with the bound gate evidence.");
  }
}

async function collectHistory(
  jobDir: string,
  candidate: LoopCandidate,
): Promise<HistoryEvidenceFile[]> {
  const history: HistoryEvidenceFile[] = [];
  const fingerprints = new Set<string>();
  for (let attempt = 1; attempt < candidate.attempt; attempt++) {
    const filePath = path.join(iterationDirectory(jobDir, attempt), "iteration.json");
    const buffer = await fs.promises.readFile(filePath);
    const iteration = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!isRecord(iteration) || iteration.attempt !== attempt ||
        typeof iteration.candidateFingerprint !== "string" ||
        !isRecord(iteration.evidence) || iteration.evidence.tree !== iteration.candidateFingerprint ||
        !isRecord(iteration.transition) || iteration.transition.state !== "repairing") {
      throw new Error(`Prior delegate-loop iteration ${attempt} is not valid repair history.`);
    }
    const fingerprint = iteration.candidateFingerprint;
    if (fingerprint === candidate.tree || fingerprints.has(fingerprint)) {
      throw new Error("Repeated candidate state cannot be accepted after an earlier gate evaluation.");
    }
    fingerprints.add(fingerprint);
    history.push({
      path: filePath,
      sha256: sha256(buffer),
      attempt,
      candidateFingerprint: fingerprint,
    });
  }
  return history;
}

async function verifyHistory(
  jobDir: string,
  candidate: LoopCandidate,
  history: unknown,
): Promise<void> {
  if (!Array.isArray(history) || history.length !== candidate.attempt - 1) {
    throw new Error("Accepted candidate history is incomplete.");
  }
  const fingerprints = new Set<string>();
  for (let index = 0; index < history.length; index++) {
    const entry = history[index];
    const attempt = index + 1;
    const expectedPath = path.join(iterationDirectory(jobDir, attempt), "iteration.json");
    assertExactEvidenceFile(entry, expectedPath, `Candidate history ${attempt}`);
    if (!isRecord(entry) || entry.attempt !== attempt ||
        typeof entry.candidateFingerprint !== "string") {
      throw new Error(`Candidate history ${attempt} identity is invalid.`);
    }
    const buffer = await fs.promises.readFile(expectedPath);
    if (sha256(buffer) !== entry.sha256) throw new Error(`Candidate history ${attempt} changed after acceptance.`);
    const iteration = JSON.parse(buffer.toString("utf8")) as unknown;
    if (!isRecord(iteration) || iteration.attempt !== attempt ||
        iteration.candidateFingerprint !== entry.candidateFingerprint ||
        !isRecord(iteration.evidence) || iteration.evidence.tree !== entry.candidateFingerprint ||
        !isRecord(iteration.transition) || iteration.transition.state !== "repairing" ||
        entry.candidateFingerprint === candidate.tree || fingerprints.has(entry.candidateFingerprint)) {
      throw new Error(`Candidate history ${attempt} violates the no-repeat acceptance policy.`);
    }
    fingerprints.add(entry.candidateFingerprint);
  }
}

export async function writeLoopPolicy(
  jobDir: string,
  jobId: string,
  policy: unknown,
): Promise<HashedEvidenceFile> {
  const filePath = path.join(jobDir, "loop-policy.json");
  const record = {
    schemaVersion: 2,
    evidenceVersion: 2,
    jobId,
    policy,
    createdAt: new Date().toISOString(),
  } satisfies LoopPolicyRecord;
  parseLoopPolicyRecord(record, jobId);
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await durableAtomicWrite(filePath, content, 0o400);
  return { path: filePath, sha256: sha256(content) };
}

export async function publishLoopAcceptance(
  jobDir: string,
  jobId: string,
  policyEvidence: HashedEvidenceFile,
  candidate: LoopCandidate,
  checks: AcceptanceCheckEvidence[],
  reviews: AcceptanceReviewEvidence[],
): Promise<LoopAcceptanceIntent> {
  assertCandidate(candidate, jobDir, jobId);
  const policyPath = path.join(jobDir, "loop-policy.json");
  assertExactEvidenceFile(policyEvidence, policyPath, "Loop policy");
  const policyBuffer = await fs.promises.readFile(policyPath);
  if (sha256(policyBuffer) !== policyEvidence.sha256) {
    throw new Error("Delegate-loop policy changed before acceptance.");
  }
  const policy = parseLoopPolicyRecord(JSON.parse(policyBuffer.toString("utf8")), jobId);
  if (candidate.attempt > policy.maxAttempts || candidate.branch !== policy.delegation.branch) {
    throw new Error("Accepted candidate does not match its delegation policy.");
  }
  const iterationDir = iterationDirectory(jobDir, candidate.attempt);
  const checksPath = path.join(iterationDir, "checks.json");
  const reviewsPath = path.join(iterationDir, "reviews.json");
  const iterationPath = path.join(iterationDir, "iteration.json");
  const manifestPath = path.join(iterationDir, "gate-manifest.json");
  const [checksBuffer, reviewsBuffer, iterationBuffer] = await Promise.all([
    fs.promises.readFile(checksPath),
    fs.promises.readFile(reviewsPath),
    fs.promises.readFile(iterationPath),
  ]);
  const persistedChecks = JSON.parse(checksBuffer.toString("utf8")) as unknown;
  const persistedReviews = JSON.parse(reviewsBuffer.toString("utf8")) as unknown;
  if (JSON.stringify(persistedChecks) !== JSON.stringify(checks) ||
      JSON.stringify(persistedReviews) !== JSON.stringify(reviews)) {
    throw new Error("Persisted gate evidence changed before acceptance publication.");
  }
  const fingerprints = checks.map((check) => check.fingerprint);
  const profileIds = reviews.map((review) => review.profileId);
  const validatedChecks = await validateChecks(persistedChecks, policy, candidate, fingerprints);
  const validatedReviews = await validateReviews(persistedReviews, policy, candidate, profileIds);
  validateIteration(
    JSON.parse(iterationBuffer.toString("utf8")) as unknown,
    candidate,
    validatedChecks,
    validatedReviews,
  );
  const history = await collectHistory(jobDir, candidate);
  const manifest = {
    schemaVersion: 2,
    evidenceVersion: 2,
    jobId,
    attempt: candidate.attempt,
    policy: policyEvidence,
    delegation: policy.delegation,
    candidate: {
      tree: candidate.tree,
      commit: candidate.commit,
      ref: candidate.ref,
      patchSha256: candidate.patchSha256,
    },
    checks: {
      path: checksPath,
      sha256: sha256(checksBuffer),
      count: checks.length,
      fingerprints,
    },
    reviews: {
      path: reviewsPath,
      sha256: sha256(reviewsBuffer),
      count: reviews.length,
      profileIds,
    },
    history,
    iteration: {
      path: iterationPath,
      sha256: sha256(iterationBuffer),
    },
    createdAt: new Date().toISOString(),
  } satisfies LoopGateManifest;
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  await durableAtomicWrite(manifestPath, manifestContent, 0o400);
  const intent = {
    schemaVersion: 2,
    evidenceVersion: 2,
    jobId,
    delegation: policy.delegation,
    candidate,
    policy: policyEvidence,
    gateManifest: { path: manifestPath, sha256: sha256(manifestContent) },
    createdAt: new Date().toISOString(),
  } satisfies LoopAcceptanceIntent;
  await durableAtomicWrite(
    path.join(jobDir, "acceptance.json"),
    `${JSON.stringify(intent, null, 2)}\n`,
    0o400,
  );
  return intent;
}

export async function readVerifiedLoopAcceptance(
  jobDirValue: string,
  expectedJobId: string,
): Promise<LoopAcceptanceIntent | undefined> {
  const jobDir = path.resolve(jobDirValue);
  await fs.promises.realpath(jobDir);
  const acceptancePath = path.join(jobDir, "acceptance.json");
  const intent = await readJsonStrict<LoopAcceptanceIntent>(acceptancePath);
  if (!intent) return undefined;
  if (
    intent.schemaVersion !== 2 || intent.evidenceVersion !== 2 ||
    intent.jobId !== expectedJobId || typeof intent.createdAt !== "string"
  ) throw new Error(`Unsupported delegate-loop acceptance intent at ${acceptancePath}.`);
  assertCandidate(intent.candidate, jobDir, expectedJobId);
  const iterationDir = iterationDirectory(jobDir, intent.candidate.attempt);
  const policyPath = path.join(jobDir, "loop-policy.json");
  const manifestPath = path.join(iterationDir, "gate-manifest.json");
  assertExactEvidenceFile(intent.policy, policyPath, "Accepted loop policy");
  assertExactEvidenceFile(intent.gateManifest, manifestPath, "Accepted gate manifest");
  const [policyBuffer, manifestBuffer, patchBuffer] = await Promise.all([
    fs.promises.readFile(policyPath),
    fs.promises.readFile(manifestPath),
    fs.promises.readFile(intent.candidate.patchPath),
  ]);
  if (sha256(policyBuffer) !== intent.policy.sha256) throw new Error("Accepted loop policy hash does not match.");
  if (sha256(manifestBuffer) !== intent.gateManifest.sha256) {
    throw new Error("Accepted gate manifest hash does not match.");
  }
  if (
    patchBuffer.length !== intent.candidate.patchBytes ||
    sha256(patchBuffer) !== intent.candidate.patchSha256
  ) throw new Error("Accepted candidate patch hash does not match.");
  const policy = parseLoopPolicyRecord(JSON.parse(policyBuffer.toString("utf8")), expectedJobId);
  if (JSON.stringify(intent.delegation) !== JSON.stringify(policy.delegation) ||
      intent.candidate.branch !== policy.delegation.branch ||
      intent.candidate.attempt > policy.maxAttempts) {
    throw new Error("Accepted delegation identity does not match its policy.");
  }

  const manifest = JSON.parse(manifestBuffer.toString("utf8")) as LoopGateManifest;
  if (
    manifest.schemaVersion !== 2 || manifest.evidenceVersion !== 2 ||
    manifest.jobId !== expectedJobId || manifest.attempt !== intent.candidate.attempt ||
    typeof manifest.createdAt !== "string" || !isRecord(manifest.candidate) ||
    manifest.candidate.tree !== intent.candidate.tree ||
    manifest.candidate.commit !== intent.candidate.commit ||
    manifest.candidate.ref !== intent.candidate.ref ||
    manifest.candidate.patchSha256 !== intent.candidate.patchSha256 ||
    JSON.stringify(manifest.delegation) !== JSON.stringify(intent.delegation)
  ) throw new Error("Accepted gate manifest does not match its candidate and delegation.");
  assertExactEvidenceFile(manifest.policy, policyPath, "Gate policy");
  if (manifest.policy.sha256 !== intent.policy.sha256) {
    throw new Error("Gate manifest policy binding does not match acceptance.");
  }

  const checksPath = path.join(iterationDir, "checks.json");
  const reviewsPath = path.join(iterationDir, "reviews.json");
  const iterationPath = path.join(iterationDir, "iteration.json");
  assertExactEvidenceFile(manifest.checks, checksPath, "Gate checks");
  assertExactEvidenceFile(manifest.reviews, reviewsPath, "Gate reviews");
  assertExactEvidenceFile(manifest.iteration, iterationPath, "Gate iteration");
  if (
    !Number.isSafeInteger(manifest.checks.count) || manifest.checks.count < 1 ||
    !Array.isArray(manifest.checks.fingerprints) ||
    !Number.isSafeInteger(manifest.reviews.count) || manifest.reviews.count < 1 ||
    !Array.isArray(manifest.reviews.profileIds)
  ) throw new Error("Gate manifest evidence counts are invalid.");

  const [checksBuffer, reviewsBuffer, iterationBuffer] = await Promise.all([
    fs.promises.readFile(checksPath),
    fs.promises.readFile(reviewsPath),
    fs.promises.readFile(iterationPath),
  ]);
  if (
    sha256(checksBuffer) !== manifest.checks.sha256 ||
    sha256(reviewsBuffer) !== manifest.reviews.sha256 ||
    sha256(iterationBuffer) !== manifest.iteration.sha256
  ) throw new Error("Delegate-loop gate evidence changed after acceptance.");

  const checks = await validateChecks(
    JSON.parse(checksBuffer.toString("utf8")) as unknown,
    policy,
    intent.candidate,
    manifest.checks.fingerprints,
  );
  const reviews = await validateReviews(
    JSON.parse(reviewsBuffer.toString("utf8")) as unknown,
    policy,
    intent.candidate,
    manifest.reviews.profileIds,
  );
  validateIteration(
    JSON.parse(iterationBuffer.toString("utf8")) as unknown,
    intent.candidate,
    checks,
    reviews,
  );
  await verifyHistory(jobDir, intent.candidate, manifest.history);
  return intent;
}
