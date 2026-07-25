import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { boundedArtifactText } from "./artifact-limits.ts";
import {
  createExclusiveJson,
  durableAppendJsonLine,
  durableAtomicWrite,
  readJsonStrict,
} from "./durable-state.ts";
import type { ProcessIdentity } from "./process-identity.ts";

export const SUBAGENT_SCHEMA_VERSION = 2;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type JobLifecyclePhase =
  | "planned"
  | "provisioning_worktree"
  | "workspace_ready"
  | "launching"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "recovery_required";

const lifecycleUpdateQueues = new Map<string, Promise<void>>();

async function withLifecycleUpdateLock<T>(
  jobDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(jobDir);
  const predecessor = lifecycleUpdateQueues.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => gate);
  lifecycleUpdateQueues.set(key, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleUpdateQueues.get(key) === tail) lifecycleUpdateQueues.delete(key);
  }
}

const JOB_LIFECYCLE_PHASES: readonly JobLifecyclePhase[] = [
  "planned",
  "provisioning_worktree",
  "workspace_ready",
  "launching",
  "running",
  "stopping",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "recovery_required",
];

export interface JobLifecycleSnapshot {
  schemaVersion: 2;
  jobId: string;
  batchId: string;
  revision: number;
  phase: JobLifecyclePhase;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  details: Record<string, unknown>;
}

export interface WorkerTerminalRecord<TStatus = unknown> {
  schemaVersion: 2;
  jobId: string;
  owner: "worker" | "timeout" | "abort" | "cancel" | "runner" | "recovery";
  ownerToken: string;
  claimedAt: string;
  status: TStatus;
  resultFile: string;
  resultSha256: string;
}

export interface WorkerReportRecord<TStatus = unknown> {
  schemaVersion: 2;
  jobId: string;
  launchNonce: string;
  reportToken: string;
  reportedAt: string;
  status: TStatus;
  resultFile: string;
  resultSha256: string;
}

export interface RunnerProcessRecord {
  schemaVersion: 2;
  jobId: string;
  launchNonce: string;
  wrapper: ProcessIdentity;
  startedAt: string;
}

export interface RunnerExitRecord {
  schemaVersion: 2;
  jobId: string;
  launchNonce: string;
  wrapperPid: number;
  exitCode: number;
  exitedAt: string;
}

export function authenticateRunnerExit(
  jobId: string,
  launchNonce: string,
  runner: RunnerProcessRecord | undefined,
  exit: RunnerExitRecord | undefined,
): RunnerExitRecord | undefined {
  return runner && exit &&
      runner.jobId === jobId && exit.jobId === jobId &&
      runner.launchNonce === launchNonce && exit.launchNonce === launchNonce &&
      runner.wrapper.launchNonce === launchNonce &&
      exit.wrapperPid === runner.wrapper.pid
    ? exit
    : undefined;
}

export interface LifecycleJobRecord {
  id: string;
  batchId: string;
  title: string;
  mode: "research" | "coding";
  jobDir: string;
  createdAt?: string;
  metadata: Record<string, unknown>;
  lifecycle?: JobLifecycleSnapshot;
  terminal?: WorkerTerminalRecord;
  decision?: JobDecisionRecord;
  control?: JobControlRecord;
}

export interface JobDecisionRecord {
  schemaVersion: 2;
  jobId: string;
  owner: "accept" | "cancel";
  ownerToken: string;
  claimedAt: string;
}

export interface JobControlRecord {
  schemaVersion: 2;
  jobId: string;
  action: "cancel";
  requestedAt: string;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!isRecord(value)) return false;
  return typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 1 &&
    typeof value.startSignature === "string" && value.startSignature.length > 0 &&
    typeof value.processGroup === "number" && Number.isSafeInteger(value.processGroup) && value.processGroup > 1 &&
    typeof value.command === "string" && typeof value.launchNonce === "string" &&
    value.launchNonce.length > 0;
}

function lifecyclePath(jobDir: string): string {
  return path.join(jobDir, "lifecycle.json");
}

function lifecycleRevisionPath(jobDir: string, revision: number): string {
  return path.join(jobDir, "lifecycle-revisions", `${String(revision).padStart(12, "0")}.json`);
}

function validateLifecycleSnapshot(
  snapshot: JobLifecycleSnapshot,
  filePath: string,
): JobLifecycleSnapshot {
  if (
    snapshot.schemaVersion !== SUBAGENT_SCHEMA_VERSION ||
    typeof snapshot.jobId !== "string" ||
    typeof snapshot.batchId !== "string" ||
    !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
    !JOB_LIFECYCLE_PHASES.includes(snapshot.phase) ||
    typeof snapshot.details !== "object" || snapshot.details === null || Array.isArray(snapshot.details)
  ) {
    throw new Error(`Unsupported lifecycle metadata at ${filePath}.`);
  }
  return snapshot;
}

async function readLatestLifecycleRevision(jobDir: string): Promise<JobLifecycleSnapshot | undefined> {
  const directory = path.join(jobDir, "lifecycle-revisions");
  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const latest = entries
    .filter((entry) => /^\d{12}\.json$/.test(entry))
    .sort()
    .at(-1);
  if (!latest) return undefined;
  const filePath = path.join(directory, latest);
  const snapshot = await readJsonStrict<JobLifecycleSnapshot>(filePath);
  if (!snapshot) throw new Error(`Lifecycle revision disappeared: ${filePath}`);
  return validateLifecycleSnapshot(snapshot, filePath);
}

export async function initializeJobLifecycle(
  jobDir: string,
  jobId: string,
  batchId: string,
  phase: JobLifecyclePhase,
  details: Record<string, unknown> = {},
): Promise<JobLifecycleSnapshot> {
  const now = new Date().toISOString();
  const snapshot = {
    schemaVersion: SUBAGENT_SCHEMA_VERSION,
    jobId,
    batchId,
    revision: 1,
    phase,
    createdAt: now,
    updatedAt: now,
    details,
  } satisfies JobLifecycleSnapshot;
  const revisionCreated = await createExclusiveJson(lifecycleRevisionPath(jobDir, 1), snapshot);
  if (!revisionCreated) throw new Error(`Lifecycle metadata already exists for ${jobId}.`);
  await durableAtomicWrite(lifecyclePath(jobDir), `${JSON.stringify(snapshot, null, 2)}\n`);
  await durableAppendJsonLine(path.join(jobDir, "lifecycle-events.jsonl"), snapshot);
  return snapshot;
}

export async function readJobLifecycle(jobDir: string): Promise<JobLifecycleSnapshot | undefined> {
  const revision = await readLatestLifecycleRevision(jobDir);
  const filePath = lifecyclePath(jobDir);
  const stored = revision ?? await readJsonStrict<JobLifecycleSnapshot>(filePath);
  if (!stored) return undefined;
  const snapshot = validateLifecycleSnapshot(stored, revision ? lifecycleRevisionPath(jobDir, revision.revision) : filePath);
  const decision = await readJobDecision(jobDir);
  return decision?.owner === "cancel" && snapshot.phase !== "recovery_required"
    ? { ...snapshot, phase: "cancelled" }
    : snapshot;
}

export async function updateJobLifecycle(
  jobDir: string,
  phase: JobLifecyclePhase,
  reason?: string,
  details: Record<string, unknown> = {},
  allowRecoveryTransition = false,
): Promise<JobLifecycleSnapshot> {
  return withLifecycleUpdateLock(jobDir, async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const previous = await readJobLifecycle(jobDir);
      if (!previous) throw new Error(`Lifecycle metadata is missing from ${jobDir}.`);
      const decision = await readJobDecision(jobDir);
      const cancelled = previous.phase === "cancelled" || decision?.owner === "cancel";
      const recoveryPinned = previous.phase === "recovery_required" && !allowRecoveryTransition;
      const snapshot = {
        ...previous,
        revision: previous.revision + 1,
        phase: recoveryPinned
          ? "recovery_required"
          : cancelled && phase !== "recovery_required"
            ? "cancelled"
            : phase,
        updatedAt: new Date().toISOString(),
        reason: recoveryPinned
          ? previous.reason
          : cancelled && phase !== "recovery_required" && reason === undefined
            ? previous.reason
            : reason,
        details: { ...previous.details, ...details },
      } satisfies JobLifecycleSnapshot;
      const claimed = await createExclusiveJson(
        lifecycleRevisionPath(jobDir, snapshot.revision),
        snapshot,
      );
      if (!claimed) continue;
      await durableAtomicWrite(lifecyclePath(jobDir), `${JSON.stringify(snapshot, null, 2)}\n`);
      await durableAppendJsonLine(path.join(jobDir, "lifecycle-events.jsonl"), snapshot);
      return snapshot;
    }
    throw new Error(`Lifecycle update contention did not settle for ${jobDir}.`);
  });
}

export async function reconcileJobLifecycle(
  jobDir: string,
  phase: Exclude<JobLifecyclePhase, "running" | "launching" | "stopping">,
  reason?: string,
  details: Record<string, unknown> = {},
): Promise<JobLifecycleSnapshot> {
  return updateJobLifecycle(jobDir, phase, reason, details, true);
}

export async function claimJobDecision(
  jobDir: string,
  jobId: string,
  owner: JobDecisionRecord["owner"],
): Promise<{ won: boolean; record: JobDecisionRecord }> {
  const record = {
    schemaVersion: SUBAGENT_SCHEMA_VERSION,
    jobId,
    owner,
    ownerToken: randomUUID(),
    claimedAt: new Date().toISOString(),
  } satisfies JobDecisionRecord;
  const decisionPath = path.join(jobDir, "decision.json");
  const won = await createExclusiveJson(decisionPath, record);
  if (won) return { won: true, record };
  const existing = await readJobDecision(jobDir);
  if (!existing) throw new Error(`Job decision disappeared for ${jobId}.`);
  return { won: false, record: existing };
}

export async function readJobDecision(jobDir: string): Promise<JobDecisionRecord | undefined> {
  const filePath = path.join(jobDir, "decision.json");
  const record = await readJsonStrict<JobDecisionRecord>(filePath);
  if (!record) return undefined;
  if (
    record.schemaVersion !== SUBAGENT_SCHEMA_VERSION ||
    typeof record.jobId !== "string" || record.jobId === "" ||
    (record.owner !== "accept" && record.owner !== "cancel") ||
    typeof record.ownerToken !== "string" || typeof record.claimedAt !== "string"
  ) throw new Error(`Unsupported decision metadata at ${filePath}.`);
  return record;
}

export async function writeJobControl(
  jobDir: string,
  jobId: string,
  reason: string,
): Promise<JobControlRecord> {
  const record = {
    schemaVersion: SUBAGENT_SCHEMA_VERSION,
    jobId,
    action: "cancel",
    requestedAt: new Date().toISOString(),
    reason,
  } satisfies JobControlRecord;
  await durableAtomicWrite(path.join(jobDir, "control.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function readJobControl(jobDir: string): Promise<JobControlRecord | undefined> {
  const filePath = path.join(jobDir, "control.json");
  const record = await readJsonStrict<JobControlRecord>(filePath);
  if (!record) return undefined;
  if (
    record.schemaVersion !== SUBAGENT_SCHEMA_VERSION ||
    typeof record.jobId !== "string" || record.action !== "cancel" ||
    typeof record.requestedAt !== "string" || typeof record.reason !== "string"
  ) throw new Error(`Unsupported control metadata at ${filePath}.`);
  return record;
}

export async function writeRunnerProcess(
  jobDir: string,
  record: RunnerProcessRecord,
): Promise<void> {
  await durableAtomicWrite(path.join(jobDir, "runner-process.json"), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readRunnerProcess(jobDir: string): Promise<RunnerProcessRecord | undefined> {
  const filePath = path.join(jobDir, "runner-process.json");
  const record = await readJsonStrict<RunnerProcessRecord>(filePath);
  if (!record) return undefined;
  if (
    record.schemaVersion !== SUBAGENT_SCHEMA_VERSION ||
    typeof record.jobId !== "string" || typeof record.launchNonce !== "string" ||
    !isProcessIdentity(record.wrapper) || record.wrapper.launchNonce !== record.launchNonce ||
    typeof record.startedAt !== "string"
  ) throw new Error(`Unsupported runner process metadata at ${filePath}.`);
  return record;
}

export async function writeRunnerExit(
  jobDir: string,
  record: RunnerExitRecord,
): Promise<void> {
  await durableAtomicWrite(path.join(jobDir, "runner-exit.json"), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readRunnerExit(jobDir: string): Promise<RunnerExitRecord | undefined> {
  const filePath = path.join(jobDir, "runner-exit.json");
  const record = await readJsonStrict<RunnerExitRecord>(filePath);
  if (!record) return undefined;
  if (
    record.schemaVersion !== SUBAGENT_SCHEMA_VERSION ||
    typeof record.jobId !== "string" || typeof record.launchNonce !== "string" ||
    !Number.isSafeInteger(record.wrapperPid) || !Number.isSafeInteger(record.exitCode) ||
    typeof record.exitedAt !== "string"
  ) throw new Error(`Unsupported runner exit metadata at ${filePath}.`);
  return record;
}

export async function publishWorkerReport<TStatus>(
  jobDir: string,
  jobId: string,
  launchNonce: string,
  status: TStatus,
  output: string,
): Promise<WorkerReportRecord<TStatus>> {
  if (!isRecord(status)) throw new Error(`Worker report status for ${jobId} must be an object.`);
  const reportToken = randomUUID();
  const resultsDir = path.join(jobDir, "worker-reports");
  const resultFile = path.join(resultsDir, `${reportToken}.md`);
  const normalizedOutput = boundedArtifactText(output);
  await durableAtomicWrite(resultFile, normalizedOutput);
  const record = {
    schemaVersion: SUBAGENT_SCHEMA_VERSION,
    jobId,
    launchNonce,
    reportToken,
    reportedAt: new Date().toISOString(),
    status,
    resultFile,
    resultSha256: createHash("sha256").update(normalizedOutput).digest("hex"),
  } satisfies WorkerReportRecord<TStatus>;
  const won = await createExclusiveJson(path.join(jobDir, "worker-report.json"), record);
  if (!won) {
    await fs.promises.rm(resultFile, { force: true });
    const existing = await readWorkerReport<TStatus>(jobDir, jobId, launchNonce);
    if (!existing) throw new Error(`Worker report disappeared for ${jobId}.`);
    return existing;
  }
  return record;
}

export async function readWorkerReport<TStatus>(
  jobDir: string,
  expectedJobId?: string,
  expectedLaunchNonce?: string,
): Promise<WorkerReportRecord<TStatus> | undefined> {
  const filePath = path.join(jobDir, "worker-report.json");
  const record = await readJsonStrict<WorkerReportRecord<TStatus>>(filePath);
  if (!record) return undefined;
  const resolvedJobDir = await fs.promises.realpath(jobDir);
  const lexicalResultFile = typeof record.resultFile === "string"
    ? path.resolve(record.resultFile)
    : "";
  const resolvedResultFile = lexicalResultFile
    ? await fs.promises.realpath(lexicalResultFile)
    : "";
  const expectedResultFile = typeof record.reportToken === "string"
    ? path.join(resolvedJobDir, "worker-reports", `${record.reportToken}.md`)
    : "";
  if (
    record.schemaVersion !== SUBAGENT_SCHEMA_VERSION ||
    typeof record.jobId !== "string" ||
    typeof record.launchNonce !== "string" || record.launchNonce.length === 0 ||
    typeof record.reportToken !== "string" || !UUID_PATTERN.test(record.reportToken) ||
    typeof record.reportedAt !== "string" ||
    !isRecord(record.status) || typeof record.resultFile !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.resultSha256) ||
    resolvedResultFile !== expectedResultFile ||
    (expectedJobId !== undefined && record.jobId !== expectedJobId) ||
    (expectedLaunchNonce !== undefined && record.launchNonce !== expectedLaunchNonce)
  ) throw new Error(`Unsupported worker report metadata at ${filePath}.`);
  return { ...record, resultFile: resolvedResultFile };
}

export async function readWorkerReportOutput(record: WorkerReportRecord): Promise<string> {
  const output = await fs.promises.readFile(record.resultFile, "utf8");
  const hash = createHash("sha256").update(output).digest("hex");
  if (hash !== record.resultSha256) {
    throw new Error(`Worker report changed after publication: ${record.resultFile}`);
  }
  return output;
}

export async function claimWorkerTerminal<TStatus>(
  jobDir: string,
  jobId: string,
  owner: WorkerTerminalRecord["owner"],
  status: TStatus,
  output: string,
): Promise<{ won: boolean; record: WorkerTerminalRecord<TStatus> }> {
  if (!isRecord(status)) throw new Error(`Terminal status for ${jobId} must be an object.`);
  const ownerToken = randomUUID();
  const resultsDir = path.join(jobDir, "terminal-results");
  const resultFile = path.join(resultsDir, `${owner}-${ownerToken}.md`);
  const normalizedOutput = boundedArtifactText(output);
  await durableAtomicWrite(resultFile, normalizedOutput);
  const record = {
    schemaVersion: SUBAGENT_SCHEMA_VERSION,
    jobId,
    owner,
    ownerToken,
    claimedAt: new Date().toISOString(),
    status,
    resultFile,
    resultSha256: createHash("sha256").update(normalizedOutput).digest("hex"),
  } satisfies WorkerTerminalRecord<TStatus>;
  const terminalPath = path.join(jobDir, "terminal.json");
  const won = await createExclusiveJson(terminalPath, record);
  if (!won) {
    await fs.promises.rm(resultFile, { force: true });
    const existing = await readWorkerTerminal<TStatus>(jobDir);
    if (!existing) throw new Error(`Terminal claim disappeared for ${jobId}.`);
    await restoreWorkerTerminalProjection(jobDir, existing);
    return { won: false, record: existing };
  }
  await restoreWorkerTerminalProjection(jobDir, record);
  return { won: true, record };
}

export async function readWorkerTerminal<TStatus>(
  jobDir: string,
): Promise<WorkerTerminalRecord<TStatus> | undefined> {
  const record = await readJsonStrict<WorkerTerminalRecord<TStatus>>(path.join(jobDir, "terminal.json"));
  if (!record) return undefined;
  const resolvedJobDir = await fs.promises.realpath(jobDir);
  const lexicalResultFile = typeof record.resultFile === "string"
    ? path.resolve(record.resultFile)
    : "";
  const resolvedResultFile = lexicalResultFile
    ? await fs.promises.realpath(lexicalResultFile)
    : "";
  const expectedResultFile = typeof record.ownerToken === "string" && typeof record.owner === "string"
    ? path.join(resolvedJobDir, "terminal-results", `${record.owner}-${record.ownerToken}.md`)
    : "";
  if (
    record.schemaVersion !== SUBAGENT_SCHEMA_VERSION ||
    typeof record.jobId !== "string" ||
    !["worker", "timeout", "abort", "cancel", "runner", "recovery"].includes(record.owner) ||
    typeof record.ownerToken !== "string" || !UUID_PATTERN.test(record.ownerToken) ||
    typeof record.claimedAt !== "string" ||
    !isRecord(record.status) ||
    typeof record.resultFile !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.resultSha256) ||
    resolvedResultFile !== expectedResultFile
  ) {
    throw new Error(`Unsupported terminal metadata in ${jobDir}.`);
  }
  return { ...record, resultFile: resolvedResultFile };
}

export async function readTerminalOutput(record: WorkerTerminalRecord): Promise<string> {
  const output = await fs.promises.readFile(record.resultFile, "utf8");
  const hash = createHash("sha256").update(output).digest("hex");
  if (hash !== record.resultSha256) {
    throw new Error(`Terminal result changed after claim: ${record.resultFile}`);
  }
  return output;
}

export async function restoreWorkerTerminalProjection(
  jobDir: string,
  record: WorkerTerminalRecord,
): Promise<void> {
  const output = await readTerminalOutput(record);
  await durableAtomicWrite(path.join(jobDir, "result.md"), output);
  await durableAtomicWrite(path.join(jobDir, "status.json"), `${JSON.stringify(record.status)}\n`);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function listLifecycleJobs(agentDir: string): Promise<LifecycleJobRecord[]> {
  const root = path.join(agentDir, "subagents");
  let batches: fs.Dirent[];
  try {
    batches = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: LifecycleJobRecord[] = [];
  for (const batch of batches) {
    if (!batch.isDirectory()) continue;
    const batchDir = path.join(root, batch.name);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(batchDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobDir = path.join(batchDir, entry.name);
      try {
      const metadata = await readJsonStrict<Record<string, unknown>>(path.join(jobDir, "job.json"));
      if (!metadata || metadata.schemaVersion !== SUBAGENT_SCHEMA_VERSION) continue;
      const id = nonEmptyString(metadata.id);
      const batchId = nonEmptyString(metadata.batchId);
      const title = nonEmptyString(metadata.title);
      const mode = metadata.mode;
      if (!id || !batchId || !title || (mode !== "research" && mode !== "coding")) continue;
      if (
        entry.name.toLowerCase() !== id.toLowerCase() ||
        batch.name.toLowerCase() !== batchId.toLowerCase()
      ) throw new Error("Job metadata does not match its job and batch directories.");
      const configuredRuntimeDir = nonEmptyString(metadata.activeWorkerJobDir);
      const resolvedJobDir = await fs.promises.realpath(jobDir);
      const resolvedRuntimeDir = configuredRuntimeDir
        ? await fs.promises.realpath(configuredRuntimeDir)
        : resolvedJobDir;
      if (
        resolvedRuntimeDir !== resolvedJobDir &&
        !resolvedRuntimeDir.startsWith(`${resolvedJobDir}${path.sep}`)
      ) throw new Error("Active worker runtime directory escapes its job directory.");
      const [lifecycle, terminal, decision, runtimeControl, rootControl] = await Promise.all([
        readJobLifecycle(jobDir),
        readWorkerTerminal(resolvedRuntimeDir),
        readJobDecision(jobDir),
        readJobControl(resolvedRuntimeDir),
        resolvedRuntimeDir === resolvedJobDir ? Promise.resolve(undefined) : readJobControl(jobDir),
      ]);
      if (lifecycle && (lifecycle.jobId !== id || lifecycle.batchId !== batchId)) {
        throw new Error("Lifecycle identity does not match job metadata.");
      }
      if (terminal && terminal.jobId !== id) {
        throw new Error("Terminal identity does not match job metadata.");
      }
      if (decision && decision.jobId !== id) {
        throw new Error("Decision identity does not match job metadata.");
      }
      if (runtimeControl && runtimeControl.jobId !== id) {
        throw new Error("Runtime control identity does not match job metadata.");
      }
      if (rootControl && rootControl.jobId !== id) {
        throw new Error("Root control identity does not match job metadata.");
      }
      jobs.push({
        id,
        batchId,
        title,
        mode,
        jobDir,
        createdAt: nonEmptyString(metadata.createdAt),
        metadata,
        lifecycle,
        terminal,
        decision,
        control: runtimeControl ?? rootControl,
      });
      } catch (error) {
        if (/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(entry.name)) {
          jobs.push({
            id: entry.name,
            batchId: batch.name,
            title: "corrupt delegation metadata",
            mode: "research",
            jobDir,
            metadata: {
              schemaVersion: SUBAGENT_SCHEMA_VERSION,
              corruptMetadataError: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }
  }
  return jobs.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
}

export async function resolveLifecycleJob(
  agentDir: string,
  requestedId: string,
): Promise<LifecycleJobRecord> {
  const requested = requestedId.trim().toLowerCase();
  if (requested.length < 4 || !/^[a-f0-9-]+$/.test(requested)) {
    throw new Error("Worker ID must contain at least four hexadecimal or hyphen characters.");
  }
  const matches = (await listLifecycleJobs(agentDir)).filter((job) =>
    job.id.toLowerCase() === requested || job.id.toLowerCase().startsWith(requested));
  if (matches.length === 0) throw new Error(`No lifecycle job matches ${requestedId}.`);
  if (matches.length > 1) throw new Error(`Worker ID prefix ${requestedId} is ambiguous.`);
  const match = matches[0];
  const metadataError = nonEmptyString(match.metadata.corruptMetadataError);
  if (metadataError) throw new Error(`Lifecycle job ${match.id} metadata is corrupt: ${metadataError}`);
  return match;
}
