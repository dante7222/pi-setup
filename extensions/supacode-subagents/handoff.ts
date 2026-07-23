import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  acquireDestinationApplyLock,
  destinationApplyStateDir,
  recoverStaleDestinationApplyLock,
  releaseDestinationApplyLock,
} from "./apply-lock.ts";
import {
  durableAtomicWrite,
  ensureDirectoryDurable,
  syncDirectory,
} from "./durable-state.ts";
import {
  authenticateRunnerExit,
  readJobDecision,
  readJobLifecycle,
  readRunnerExit,
  readRunnerProcess,
  readWorkerTerminal,
} from "./lifecycle.ts";
import type { ProcessIdentity } from "./process-identity.ts";
import {
  decodeSupacodeResourceId,
  sameSupacodeUuid,
} from "./resource-id.ts";
import { verifyWorkerProcessesAbsent } from "./worker-supervisor.ts";

const HANDOFF_VERSION = 1;
const GIT_TIMEOUT_MS = 60_000;
const SUPACODE_DELETE_TIMEOUT_MS = 190_000;
const MAX_DIAGNOSTIC_LENGTH = 16_000;
const MIN_JOB_ID_PREFIX_LENGTH = 4;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OBJECT_ID_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

type WorkerCompletionState = "running" | "completed" | "failed" | "unknown";
type HandoffState = "prepared" | "applying" | "applied" | "blocked" | "conflicted" | "failed" | "indeterminate";

interface StoredCodingJob {
  id: string;
  batchId: string;
  batchTitle: string;
  title: string;
  originalCwd: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  tabWorktreeId: string;
  codeWorktreeId: string;
  tabId: string;
  surfaceId: string;
  launchNonce: string;
  createdAt?: string;
  delegateLoop: boolean;
  loopState?: string;
  acceptedTree?: string;
  acceptedCommit?: string;
  acceptedRef?: string;
  activeWorkerJobDir: string;
  lifecyclePhase: string;
  jobDir: string;
  workerState: WorkerCompletionState;
}

export interface DelegateCodingJobSummary {
  id: string;
  batchId: string;
  title: string;
  branch: string;
  worktreePath: string;
  workerState: WorkerCompletionState;
  createdAt?: string;
}

export interface PreparedDelegateHandoff {
  id: string;
  job: StoredCodingJob;
  draftDir: string;
  draftPatchPath: string;
  sourceRoot: string;
  sourceHead: string;
  sourceTree: string;
  sourceStatus: string;
  baseSha: string;
  baseIsAncestor: boolean;
  commitCount?: number;
  targetRoot: string;
  targetGitDir: string;
  targetCommonGitDir: string;
  targetHead: string;
  targetBranch?: string;
  targetStatus: string;
  patchSha256: string;
  patchBytes: number;
  touchedPaths: string[];
  blockers: string[];
  warnings: string[];
  createdAt: string;
}

interface HandoffCleanupResult {
  paneClosed: boolean;
  worktreeRemoved: boolean;
  branchPreserved: boolean;
  recoveryRef?: string;
  preservedHead?: string;
  errors: string[];
}

export interface DelegateHandoffResult {
  id: string;
  state: HandoffState;
  appliedPaths: string[];
  conflictedPaths: string[];
  blockedPaths: string[];
  diagnostic?: string;
  manifestPath: string;
  patchPath: string;
  cleanup: HandoffCleanupResult;
}

interface HandoffManifest {
  version: number;
  id: string;
  jobId: string;
  batchId: string;
  title: string;
  state: HandoffState;
  createdAt: string;
  updatedAt: string;
  source: {
    root: string;
    branch: string;
    baseSha: string;
    head: string;
    tree: string;
    status: string;
    workerState: WorkerCompletionState;
  };
  destination: {
    root: string;
    gitDir: string;
    commonGitDir: string;
    branch?: string;
    head: string;
  };
  patch: {
    sha256: string;
    bytes: number;
    touchedPaths: string[];
  };
  apply?: {
    appliedPaths: string[];
    conflictedPaths: string[];
    blockedPaths: string[];
    diagnostic?: string;
  };
  cleanup?: HandoffCleanupResult;
}

interface DestinationBaseline {
  indexPath: string;
  indexBackupPath: string;
  indexSha256: string;
  tree: string;
  expectedTree?: string;
}

interface DestinationTransaction {
  version: 1;
  id: string;
  jobId: string;
  state: HandoffState | "rolled_back" | "resolved";
  createdAt: string;
  updatedAt: string;
  destination: {
    root: string;
    gitDir: string;
    commonGitDir: string;
    head: string;
    branch?: string;
  };
  patch: {
    sha256: string;
    bytes: number;
    touchedPaths: string[];
  };
  baseline?: DestinationBaseline;
  diagnostic?: string;
  jobManifestPath: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function diagnosticText(result: CommandResult): string {
  const text = (result.stderr || result.stdout || `exit ${result.code}`).trim();
  return text.length > MAX_DIAGNOSTIC_LENGTH
    ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}\n[diagnostic truncated]`
    : text;
}

async function atomicWrite(filePath: string, content: string | Buffer): Promise<void> {
  await durableAtomicWrite(filePath, content);
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function commandWithInput(
  command: string,
  args: string[],
  input: Buffer,
  options: { signal?: AbortSignal; timeout: number },
): Promise<CommandResult> {
  if (options.signal?.aborted) throw new Error(`${command} aborted before launch.`);
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let inputError: Error | undefined;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeout);
    const abort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      if (aborted) {
        reject(new Error(`${command} aborted after process exit.`));
        return;
      }
      if (inputError) {
        reject(inputError);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: timedOut ? 124 : code ?? 1,
        timedOut,
      });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && !settled) {
        inputError = error;
        terminate();
      }
    });
    child.stdin.end(input);
  });
}

async function gitResult(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  indexPath?: string,
): Promise<CommandResult> {
  const command = indexPath ? "env" : "git";
  const commandArgs = indexPath
    ? [`GIT_INDEX_FILE=${indexPath}`, "git", "-C", cwd, ...args]
    : ["-C", cwd, ...args];
  return pi.exec(command, commandArgs, { signal, timeout: GIT_TIMEOUT_MS });
}

async function gitStdout(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  indexPath?: string,
): Promise<string> {
  const result = await gitResult(pi, cwd, args, signal, indexPath);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${diagnosticText(result)}`);
  }
  return result.stdout;
}

async function gitOutput(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  indexPath?: string,
): Promise<string> {
  return (await gitStdout(pi, cwd, args, signal, indexPath)).trim();
}

function parseNulPaths(output: string): string[] {
  const paths = output.split("\0").filter(Boolean);
  if (paths.some((filePath) => filePath.includes("\uFFFD"))) {
    throw new Error("Git returned a path that is not valid UTF-8; handoff stopped to avoid a lossy path operation.");
  }
  return paths;
}

function displayPath(filePath: string): string {
  return /[\u0000-\u001f\u007f]/.test(filePath) ? JSON.stringify(filePath) : filePath;
}

function uniqueSortedPaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export function delegatePathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function overlappingDirtyPaths(touchedPaths: string[], dirtyPaths: string[]): string[] {
  return uniqueSortedPaths(
    dirtyPaths.filter((dirtyPath) =>
      touchedPaths.some((touchedPath) => delegatePathsOverlap(touchedPath, dirtyPath))),
  );
}

async function readWorkerState(jobDir: string): Promise<WorkerCompletionState> {
  const status = await readJsonRecord(path.join(jobDir, "status.json"));
  const state = status && stringValue(status, "state");
  return state === "running" || state === "completed" || state === "failed" ? state : "unknown";
}

async function parseStoredJob(jobDir: string): Promise<StoredCodingJob | undefined> {
  const record = await readJsonRecord(path.join(jobDir, "job.json"));
  if (
    !record || record.schemaVersion !== 2 ||
    stringValue(record, "mode") !== "coding"
  ) return undefined;

  const id = stringValue(record, "id");
  const batchId = stringValue(record, "batchId");
  const batchTitle = stringValue(record, "batchTitle");
  const title = stringValue(record, "title");
  const originalCwd = stringValue(record, "originalCwd");
  const worktreePath = stringValue(record, "worktreePath");
  const branch = stringValue(record, "branch");
  const baseSha = stringValue(record, "baseSha");
  const tabWorktreeId = stringValue(record, "tabWorktreeId");
  const codeWorktreeId = stringValue(record, "codeWorktreeId");
  const tabId = stringValue(record, "tabId");
  const surfaceId = stringValue(record, "surfaceId");
  const launchNonce = stringValue(record, "launchNonce");
  if (
    !id || !batchId || !batchTitle || !title || !originalCwd || !worktreePath ||
    !branch || !baseSha || !tabWorktreeId || !codeWorktreeId || !tabId || !surfaceId || !launchNonce ||
    !UUID_PATTERN.test(id) || !UUID_PATTERN.test(batchId) || !UUID_PATTERN.test(tabId) ||
    !UUID_PATTERN.test(surfaceId) || !OBJECT_ID_PATTERN.test(baseSha) ||
    !path.isAbsolute(originalCwd) || !path.isAbsolute(worktreePath)
  ) {
    return undefined;
  }
  const expectedBranch = `pi-agent/${batchId.slice(0, 6).toLowerCase()}/${id.slice(0, 6).toLowerCase()}`;
  if (branch !== expectedBranch) return undefined;
  const lifecycle = await readJobLifecycle(jobDir);
  if (!lifecycle || lifecycle.jobId !== id) return undefined;
  const control = await readJsonRecord(path.join(jobDir, "control.json"));
  if (control && stringValue(control, "action") === "cancel") return undefined;
  if (booleanValue(record, "delegateLoop")) {
    const decision = await readJobDecision(jobDir);
    if (!decision || decision.jobId !== id || decision.owner !== "accept") return undefined;
  }
  const activeWorkerJobDir = path.resolve(stringValue(record, "activeWorkerJobDir") ?? jobDir);
  const resolvedJobDir = path.resolve(jobDir);
  if (
    activeWorkerJobDir !== resolvedJobDir &&
    !activeWorkerJobDir.startsWith(`${resolvedJobDir}${path.sep}`)
  ) return undefined;

  return {
    id,
    batchId,
    batchTitle,
    title,
    originalCwd,
    worktreePath,
    branch,
    baseSha,
    tabWorktreeId,
    codeWorktreeId,
    tabId,
    surfaceId,
    launchNonce,
    createdAt: stringValue(record, "createdAt"),
    delegateLoop: booleanValue(record, "delegateLoop"),
    loopState: stringValue(record, "loopState"),
    acceptedTree: stringValue(record, "acceptedTree"),
    acceptedCommit: stringValue(record, "acceptedCommit"),
    acceptedRef: stringValue(record, "acceptedRef"),
    activeWorkerJobDir,
    lifecyclePhase: lifecycle.phase,
    jobDir,
    workerState: await readWorkerState(jobDir),
  };
}

async function codingJobs(agentDir: string): Promise<StoredCodingJob[]> {
  const root = path.join(agentDir, "subagents");
  let batches: fs.Dirent[];
  try {
    batches = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const jobs: StoredCodingJob[] = [];
  for (const batch of batches) {
    if (!batch.isDirectory()) continue;
    const batchPath = path.join(root, batch.name);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(batchPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const job = await parseStoredJob(path.join(batchPath, entry.name));
      if (job) jobs.push(job);
    }
  }

  return jobs.sort((left, right) =>
    (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
}

export async function listDelegateCodingJobs(
  agentDir: string,
): Promise<DelegateCodingJobSummary[]> {
  return (await codingJobs(agentDir)).map((job) => ({
    id: job.id,
    batchId: job.batchId,
    title: job.title,
    branch: job.branch,
    worktreePath: job.worktreePath,
    workerState: job.workerState,
    createdAt: job.createdAt,
  }));
}

async function resolveCodingJob(jobId: string, agentDir: string): Promise<StoredCodingJob> {
  const requested = jobId.trim().toLowerCase();
  if (
    requested.length < MIN_JOB_ID_PREFIX_LENGTH ||
    !/^[a-f0-9-]+$/.test(requested)
  ) {
    throw new Error(`Worker ID must be at least ${MIN_JOB_ID_PREFIX_LENGTH} hexadecimal or hyphen characters.`);
  }

  const matches = (await codingJobs(agentDir)).filter((job) =>
    job.id.toLowerCase() === requested || job.id.toLowerCase().startsWith(requested));
  if (matches.length === 0) throw new Error(`No coding worker matches ${jobId}.`);
  if (matches.length > 1) throw new Error(`Worker ID prefix ${jobId} is ambiguous.`);
  return matches[0];
}

async function canonicalGitRoot(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const root = await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"], signal);
  return fs.promises.realpath(root);
}

async function canonicalCommonGitDir(
  pi: ExtensionAPI,
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const commonDir = await gitOutput(pi, root, ["rev-parse", "--git-common-dir"], signal);
  return fs.promises.realpath(path.resolve(root, commonDir));
}

async function canonicalGitDir(
  pi: ExtensionAPI,
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const gitDir = await gitOutput(pi, root, ["rev-parse", "--absolute-git-dir"], signal);
  return fs.promises.realpath(gitDir);
}

async function listedWorktreeIdForRoot(
  listOutput: string,
  root: string,
): Promise<string | undefined> {
  for (const listedId of listOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    try {
      const listedPath = await fs.promises.realpath(path.resolve(decodeSupacodeResourceId(listedId)));
      if (listedPath === root) return listedId;
    } catch {
      // Ignore stale Supacode entries while looking for the exact worktree.
    }
  }
  return undefined;
}

async function currentBranch(
  pi: ExtensionAPI,
  root: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await gitResult(pi, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

export async function gitlinkPathsForTree(
  pi: ExtensionAPI,
  root: string,
  treeish: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const records = parseNulPaths(await gitStdout(
    pi,
    root,
    ["ls-tree", "-r", "--full-tree", "-z", treeish, "--"],
    signal,
  ));
  return records
    .filter((record) => record.startsWith("160000 "))
    .map((record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) throw new Error("Git returned a malformed gitlink entry.");
      return record.slice(separator + 1);
    });
}

export async function snapshotWorktreeTree(
  pi: ExtensionAPI,
  root: string,
  head: string,
  indexPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const lockPath = `${indexPath}.lock`;
  await Promise.all([
    fs.promises.rm(indexPath, { force: true }),
    fs.promises.rm(lockPath, { force: true }),
  ]);
  try {
    await gitOutput(pi, root, ["read-tree", head], signal, indexPath);
    await gitOutput(pi, root, ["add", "-A", "--", "."], signal, indexPath);
    return await gitOutput(pi, root, ["write-tree"], signal, indexPath);
  } finally {
    await Promise.all([
      fs.promises.rm(indexPath, { force: true }),
      fs.promises.rm(lockPath, { force: true }),
    ]);
  }
}

async function statusPaths(
  pi: ExtensionAPI,
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const output = await gitStdout(
    pi,
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    signal,
  );
  return uniqueSortedPaths(
    parseNulPaths(output).map((record) => record.length >= 4 ? record.slice(3) : record),
  );
}

async function ignoredPaths(
  pi: ExtensionAPI,
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return uniqueSortedPaths(parseNulPaths(await gitStdout(
    pi,
    root,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    signal,
  )));
}

export async function repositoryOperationBlockers(
  pi: ExtensionAPI,
  root: string,
  signal?: AbortSignal,
  checkoutLabel = "Destination",
): Promise<string[]> {
  const blockers: string[] = [];
  const unmerged = parseNulPaths(await gitStdout(
    pi,
    root,
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    signal,
  ));
  if (unmerged.length > 0) {
    blockers.push(`${checkoutLabel} has unresolved conflicts: ${unmerged.map(displayPath).join(", ")}`);
  }

  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_START",
  ]) {
    const markerPath = await gitOutput(pi, root, ["rev-parse", "--git-path", marker], signal);
    if (await pathExists(path.resolve(root, markerPath))) {
      blockers.push(`${checkoutLabel} has an active Git operation (${marker}).`);
    }
  }
  return blockers;
}

async function priorSnapshotApplied(
  targetGitDir: string,
  patchSha256: string,
  targetRoot: string,
): Promise<boolean> {
  const handoffsDir = path.join(destinationApplyStateDir(targetGitDir), "transactions");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(handoffsDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transactionPath = path.join(handoffsDir, entry.name, "transaction.json");
    const manifest = await readJsonRecord(transactionPath);
    if (!manifest) throw new Error(`Destination transaction metadata is corrupt: ${transactionPath}`);
    const patchRecord = isRecord(manifest.patch) ? manifest.patch : undefined;
    const destinationRecord = isRecord(manifest.destination) ? manifest.destination : undefined;
    const state = stringValue(manifest, "state");
    const storedPatch = patchRecord && stringValue(patchRecord, "sha256");
    const storedRoot = destinationRecord && stringValue(destinationRecord, "root");
    if (
      !state || !storedPatch || !storedRoot || storedRoot !== targetRoot ||
      !["prepared", "applying", "applied", "blocked", "conflicted", "failed", "indeterminate", "rolled_back", "resolved"].includes(state)
    ) {
      throw new Error(`Destination transaction metadata is invalid: ${transactionPath}`);
    }
    if (state === "applying" || state === "conflicted" || state === "indeterminate") {
      if (storedPatch === patchSha256) return true;
      throw new Error(`Destination has unresolved ${state} transaction ${entry.name}; recover it before another apply.`);
    }
    if ((state === "applied" || state === "resolved") && storedPatch === patchSha256) return true;
  }
  return false;
}

function pathListPreview(paths: string[], limit = 20): string {
  const visible = paths.slice(0, limit).map((filePath) => `- ${displayPath(filePath)}`);
  if (paths.length > limit) visible.push(`- … ${paths.length - limit} more`);
  return visible.join("\n");
}

export function formatDelegateHandoffPreview(prepared: PreparedDelegateHandoff): string {
  const lines = [
    `Worker: ${prepared.job.title} (${prepared.job.id.slice(0, 8)})`,
    `Worker state: ${prepared.job.workerState}`,
    `Source: ${prepared.job.branch} @ ${prepared.sourceHead.slice(0, 12)}`,
    `Source checkout: ${prepared.sourceRoot}`,
    `Destination: ${prepared.targetBranch ?? "detached HEAD"} @ ${prepared.targetHead.slice(0, 12)}`,
    `Destination checkout: ${prepared.targetRoot}`,
    `Changes: ${prepared.touchedPaths.length} path${prepared.touchedPaths.length === 1 ? "" : "s"}, ${prepared.patchBytes} bytes`,
  ];
  if (prepared.commitCount !== undefined) {
    lines.push(`Worker commits since base: ${prepared.commitCount}`);
  }
  if (prepared.sourceStatus) lines.push("Source also has uncommitted changes.");
  if (prepared.warnings.length > 0) {
    lines.push("", "Warnings:", ...prepared.warnings.map((warning) => `- ${warning}`));
  }
  lines.push("", "Paths:", pathListPreview(prepared.touchedPaths));
  return lines.join("\n");
}

export function formatDelegateHandoffResult(result: DelegateHandoffResult): string {
  const lines = [
    `Delegated changes: ${result.state}`,
    `Applied paths: ${result.appliedPaths.length}`,
    `Conflicted paths: ${result.conflictedPaths.length}`,
    `Blocked paths: ${result.blockedPaths.length}`,
  ];
  if (result.state === "applied") {
    lines.push(
      `Pane: ${result.cleanup.paneClosed ? "closed" : "retained"}`,
      `Worktree: ${result.cleanup.worktreeRemoved ? "removed" : "retained"}`,
      `Branch: ${result.cleanup.branchPreserved ? "preserved" : "needs inspection"}`,
    );
  }
  if (result.cleanup.preservedHead) lines.push(`Preserved worker snapshot: ${result.cleanup.preservedHead}`);
  if (result.cleanup.recoveryRef) lines.push(`Recovery ref: ${result.cleanup.recoveryRef}`);
  if (result.cleanup.errors.length > 0) {
    lines.push("Cleanup warnings:", ...result.cleanup.errors.map((error) => `- ${error}`));
  }
  if (result.diagnostic) lines.push(`Git: ${result.diagnostic}`);
  lines.push(`Manifest: ${result.manifestPath}`);
  return lines.join("\n");
}

export async function prepareDelegateHandoff(
  pi: ExtensionAPI,
  jobId: string,
  signal: AbortSignal | undefined,
  agentDir: string,
): Promise<PreparedDelegateHandoff> {
  const job = await resolveCodingJob(jobId, agentDir);
  if (job.workerState === "running") {
    throw new Error(`Worker ${job.id} is still running.`);
  }
  if (!["completed", "failed", "timed_out", "cancelled"].includes(job.lifecyclePhase)) {
    throw new Error(`Worker ${job.id} lifecycle is ${job.lifecyclePhase}; reconcile it before applying.`);
  }
  const terminal = await readWorkerTerminal<{ processIdentity?: ProcessIdentity }>(job.activeWorkerJobDir);
  if (!terminal) throw new Error(`Worker ${job.id} has no authoritative terminal claim.`);
  if (terminal.owner === "worker") {
    const [runner, exit] = await Promise.all([
      readRunnerProcess(job.activeWorkerJobDir),
      readRunnerExit(job.activeWorkerJobDir),
    ]);
    if (!authenticateRunnerExit(job.id, job.launchNonce, runner, exit)) {
      throw new Error(`Worker ${job.id} has no authenticated normal runner exit.`);
    }
  }
  const processes = await verifyWorkerProcessesAbsent(
    {
      id: job.id,
      jobDir: job.activeWorkerJobDir,
      tabWorktreeId: job.tabWorktreeId,
      tabId: job.tabId,
      surfaceId: job.surfaceId,
      launchNonce: job.launchNonce,
    },
    terminal.status.processIdentity,
  );
  if (!processes.absent) {
    throw new Error(`Worker ${job.id} termination is not verified (${processes.states.join(", ")}).`);
  }
  if (!await pathExists(job.worktreePath)) {
    throw new Error(`Worker worktree no longer exists: ${job.worktreePath}`);
  }

  const sourceRoot = await canonicalGitRoot(pi, job.worktreePath, signal);
  const targetRoot = await canonicalGitRoot(pi, job.originalCwd, signal);
  if (sourceRoot === targetRoot) {
    throw new Error("Worker source and destination resolve to the same checkout.");
  }
  const [codeWorktreePath, tabWorktreePath] = await Promise.all([
    fs.promises.realpath(path.resolve(decodeSupacodeResourceId(job.codeWorktreeId))),
    fs.promises.realpath(path.resolve(decodeSupacodeResourceId(job.tabWorktreeId))),
  ]);
  if (codeWorktreePath !== sourceRoot) {
    throw new Error("Worker metadata does not map its Supacode worktree ID to the source checkout.");
  }
  if (tabWorktreePath !== sourceRoot) {
    throw new Error("Worker metadata does not map its pane Supacode worktree ID to the source checkout.");
  }

  const [sourceCommonDir, targetCommonDir, targetGitDir, sourceBranch, listedWorktrees] = await Promise.all([
    canonicalCommonGitDir(pi, sourceRoot, signal),
    canonicalCommonGitDir(pi, targetRoot, signal),
    canonicalGitDir(pi, targetRoot, signal),
    currentBranch(pi, sourceRoot, signal),
    pi.exec("supacode", ["worktree", "list"], { signal, timeout: GIT_TIMEOUT_MS }),
  ]);
  if (sourceCommonDir !== targetCommonDir) {
    throw new Error("Worker and destination are not worktrees of the same Git repository.");
  }
  if (sourceBranch !== job.branch) {
    throw new Error(`Worker checkout is on ${sourceBranch ?? "detached HEAD"}, not its recorded branch ${job.branch}.`);
  }
  if (listedWorktrees.code !== 0) {
    throw new Error(`Could not verify Supacode worktree identities: ${diagnosticText(listedWorktrees)}`);
  }
  const [sourceWorktreeId, targetWorktreeId] = await Promise.all([
    listedWorktreeIdForRoot(listedWorktrees.stdout, sourceRoot),
    listedWorktreeIdForRoot(listedWorktrees.stdout, targetRoot),
  ]);
  if (!sourceWorktreeId || !targetWorktreeId) {
    throw new Error("Supacode does not currently list both the worker and destination checkouts.");
  }
  const verifiedJob: StoredCodingJob = {
    ...job,
    codeWorktreeId: sourceWorktreeId,
    tabWorktreeId: sourceWorktreeId,
  };
  const sourceOperationBlockers = await repositoryOperationBlockers(
    pi,
    sourceRoot,
    signal,
    "Source checkout",
  );
  if (sourceOperationBlockers.length > 0) {
    throw new Error(`Cannot hand off a source checkout with an active Git operation:\n${sourceOperationBlockers.join("\n")}`);
  }

  const id = randomUUID();
  const draftDir = await fs.promises.mkdtemp(path.join(job.jobDir, `.handoff-${id}-`));
  const indexPath = path.join(draftDir, "source.index");
  const draftPatchPath = path.join(draftDir, "changes.patch");

  try {
    const sourceHead = await gitOutput(pi, sourceRoot, ["rev-parse", "HEAD"], signal);
    const sourceTree = await snapshotWorktreeTree(pi, sourceRoot, sourceHead, indexPath, signal);
    const gitlinkPaths = await gitlinkPathsForTree(pi, sourceRoot, sourceTree, signal);
    if (gitlinkPaths.length > 0) {
      throw new Error(
        `Submodules and embedded Git repositories are not supported by delegated handoff: ${gitlinkPaths.map(displayPath).join(", ")}`,
      );
    }
    if (job.delegateLoop) {
      if (job.loopState !== "awaiting_apply") {
        throw new Error(`Delegate loop is ${job.loopState ?? "missing its terminal state"}; only accepted loops can be applied.`);
      }
      if (
        !job.acceptedTree || !OBJECT_ID_PATTERN.test(job.acceptedTree) ||
        !job.acceptedCommit || !OBJECT_ID_PATTERN.test(job.acceptedCommit) ||
        !job.acceptedRef || !job.acceptedRef.startsWith("refs/pi-agent-candidates/")
      ) {
        throw new Error("Accepted delegate loop is missing valid reviewed tree, commit, or ref identities.");
      }
      const [acceptedCommit, acceptedTree] = await Promise.all([
        gitOutput(pi, sourceRoot, ["rev-parse", "--verify", job.acceptedRef], signal),
        gitOutput(pi, sourceRoot, ["rev-parse", `${job.acceptedRef}^{tree}`], signal),
      ]);
      if (acceptedCommit !== job.acceptedCommit || acceptedTree !== job.acceptedTree) {
        throw new Error("Accepted delegate-loop ref no longer identifies its reviewed commit and tree.");
      }
      if (sourceTree !== job.acceptedTree) {
        throw new Error("Delegate loop worktree changed after acceptance; rerun checks and review before applying.");
      }
    }

    const patch = await gitResult(
      pi,
      sourceRoot,
      [
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        `--output=${draftPatchPath}`,
        job.baseSha,
        sourceTree,
        "--",
      ],
      signal,
    );
    if (patch.code !== 0) throw new Error(`Could not construct worker patch: ${diagnosticText(patch)}`);
    const patchBuffer = await fs.promises.readFile(draftPatchPath);
    if (patchBuffer.length === 0) throw new Error("Worker has no changes relative to its delegation base.");
    await fs.promises.chmod(draftPatchPath, 0o400);

    const touchedPaths = uniqueSortedPaths(parseNulPaths(await gitStdout(
      pi,
      sourceRoot,
      ["diff", "--name-only", "-z", "--no-renames", job.baseSha, sourceTree, "--"],
      signal,
    )));
    if (touchedPaths.length === 0) throw new Error("Worker patch contains no changed paths.");

    const [sourceStatus, targetHead, targetBranch, targetStatus, targetDirtyPaths, targetIgnoredPaths, operationBlockers] = await Promise.all([
      gitOutput(pi, sourceRoot, ["status", "--short"], signal),
      gitOutput(pi, targetRoot, ["rev-parse", "HEAD"], signal),
      currentBranch(pi, targetRoot, signal),
      gitOutput(pi, targetRoot, ["status", "--short"], signal),
      statusPaths(pi, targetRoot, signal),
      ignoredPaths(pi, targetRoot, signal),
      repositoryOperationBlockers(pi, targetRoot, signal),
    ]);
    const blockedPaths = overlappingDirtyPaths(touchedPaths, targetDirtyPaths);
    const ignoredBlockedPaths = overlappingDirtyPaths(touchedPaths, targetIgnoredPaths);
    const blockers = [...operationBlockers];
    if (blockedPaths.length > 0) {
      blockers.push(`Destination changes overlap the patch: ${blockedPaths.map(displayPath).join(", ")}`);
    }
    if (ignoredBlockedPaths.length > 0) {
      blockers.push(`Ignored destination entries overlap the patch: ${ignoredBlockedPaths.map(displayPath).join(", ")}`);
    }

    const baseAncestorResult = await gitResult(
      pi,
      sourceRoot,
      ["merge-base", "--is-ancestor", job.baseSha, sourceHead],
      signal,
    );
    const baseIsAncestor = baseAncestorResult.code === 0;
    let commitCount: number | undefined;
    if (baseIsAncestor) {
      const count = Number(await gitOutput(
        pi,
        sourceRoot,
        ["rev-list", "--count", `${job.baseSha}..${sourceHead}`],
        signal,
      ));
      if (Number.isInteger(count)) commitCount = count;
    }

    const patchSha256 = createHash("sha256").update(patchBuffer).digest("hex");
    if (await priorSnapshotApplied(targetGitDir, patchSha256, targetRoot)) {
      blockers.push("This exact worker snapshot was already applied to this destination.");
    }

    const warnings: string[] = [];
    if (job.workerState !== "completed") warnings.push(`Worker state is ${job.workerState}; changes may be incomplete.`);
    if (!baseIsAncestor) warnings.push("Delegation base is not an ancestor of the worker HEAD.");
    if (sourceStatus) warnings.push("The patch includes the worker's final uncommitted filesystem state.");
    if (targetHead !== job.baseSha) {
      if (job.delegateLoop) {
        blockers.push("Destination HEAD changed since the loop was reviewed; rerun the loop against the current destination.");
      } else {
        warnings.push("Destination HEAD advanced or changed since delegation; Git will use a three-way apply.");
      }
    }
    if (targetStatus && blockedPaths.length === 0) warnings.push("Unrelated destination working-tree changes will be preserved.");

    return {
      id,
      job: verifiedJob,
      draftDir,
      draftPatchPath,
      sourceRoot,
      sourceHead,
      sourceTree,
      sourceStatus,
      baseSha: job.baseSha,
      baseIsAncestor,
      commitCount,
      targetRoot,
      targetGitDir,
      targetCommonGitDir: targetCommonDir,
      targetHead,
      targetBranch,
      targetStatus,
      patchSha256,
      patchBytes: patchBuffer.length,
      touchedPaths,
      blockers,
      warnings,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    await fs.promises.rm(draftDir, { recursive: true, force: true });
    throw error;
  }
}

export async function discardPreparedDelegateHandoff(
  prepared: PreparedDelegateHandoff,
): Promise<void> {
  await fs.promises.rm(prepared.draftDir, { recursive: true, force: true });
}

function manifestFor(
  prepared: PreparedDelegateHandoff,
  state: HandoffState,
  apply?: HandoffManifest["apply"],
  cleanup?: HandoffCleanupResult,
): HandoffManifest {
  return {
    version: HANDOFF_VERSION,
    id: prepared.id,
    jobId: prepared.job.id,
    batchId: prepared.job.batchId,
    title: prepared.job.title,
    state,
    createdAt: prepared.createdAt,
    updatedAt: new Date().toISOString(),
    source: {
      root: prepared.sourceRoot,
      branch: prepared.job.branch,
      baseSha: prepared.baseSha,
      head: prepared.sourceHead,
      tree: prepared.sourceTree,
      status: prepared.sourceStatus,
      workerState: prepared.job.workerState,
    },
    destination: {
      root: prepared.targetRoot,
      gitDir: prepared.targetGitDir,
      commonGitDir: prepared.targetCommonGitDir,
      branch: prepared.targetBranch,
      head: prepared.targetHead,
    },
    patch: {
      sha256: prepared.patchSha256,
      bytes: prepared.patchBytes,
      touchedPaths: prepared.touchedPaths,
    },
    apply,
    cleanup,
  };
}

async function writeManifest(
  manifestPath: string,
  manifest: HandoffManifest,
): Promise<void> {
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function destinationTransactionPath(prepared: PreparedDelegateHandoff): string {
  return path.join(
    destinationApplyStateDir(prepared.targetGitDir),
    "transactions",
    prepared.id,
    "transaction.json",
  );
}

async function writeDestinationTransaction(
  prepared: PreparedDelegateHandoff,
  manifestPath: string,
  state: DestinationTransaction["state"],
  baseline?: DestinationBaseline,
  diagnostic?: string,
): Promise<void> {
  const transactionPath = destinationTransactionPath(prepared);
  const prior = await readJsonRecord(transactionPath);
  const createdAt = prior && stringValue(prior, "createdAt") || new Date().toISOString();
  const transaction = {
    version: 1,
    id: prepared.id,
    jobId: prepared.job.id,
    state,
    createdAt,
    updatedAt: new Date().toISOString(),
    destination: {
      root: prepared.targetRoot,
      gitDir: prepared.targetGitDir,
      commonGitDir: prepared.targetCommonGitDir,
      head: prepared.targetHead,
      branch: prepared.targetBranch,
    },
    patch: {
      sha256: prepared.patchSha256,
      bytes: prepared.patchBytes,
      touchedPaths: prepared.touchedPaths,
    },
    baseline,
    diagnostic,
    jobManifestPath: manifestPath,
  } satisfies DestinationTransaction;
  await atomicWrite(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
}

async function captureDestinationBaseline(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  handoffDir: string,
  patchBuffer: Buffer,
  signal?: AbortSignal,
): Promise<DestinationBaseline> {
  const indexOutput = await gitOutput(pi, prepared.targetRoot, ["rev-parse", "--git-path", "index"], signal);
  const indexPath = path.resolve(prepared.targetRoot, indexOutput);
  const indexBuffer = await fs.promises.readFile(indexPath);
  const indexBackupPath = path.join(handoffDir, "destination.index");
  await atomicWrite(indexBackupPath, indexBuffer);
  const tree = await snapshotWorktreeTree(
    pi,
    prepared.targetRoot,
    prepared.targetHead,
    path.join(handoffDir, "destination-baseline.index"),
    signal,
  );
  const expectedWorktreeIndexPath = path.join(handoffDir, "destination-expected-worktree.index");
  await fs.promises.rm(expectedWorktreeIndexPath, { force: true });
  await gitOutput(pi, prepared.targetRoot, ["read-tree", tree], signal, expectedWorktreeIndexPath);
  const expectedWorktreeApply = await commandWithInput(
    "env",
    [
      `GIT_INDEX_FILE=${expectedWorktreeIndexPath}`,
      "git",
      "-C",
      prepared.targetRoot,
      "apply",
      "--3way",
      "--cached",
      "--binary",
      "-",
    ],
    patchBuffer,
    { signal, timeout: GIT_TIMEOUT_MS },
  );
  const expectedTree = expectedWorktreeApply.code === 0
    ? await gitOutput(pi, prepared.targetRoot, ["write-tree"], signal, expectedWorktreeIndexPath)
    : undefined;
  await fs.promises.rm(expectedWorktreeIndexPath, { force: true });
  return {
    indexPath,
    indexBackupPath,
    indexSha256: createHash("sha256").update(indexBuffer).digest("hex"),
    tree,
    expectedTree,
  };
}

async function replaceDestinationIndex(
  baseline: DestinationBaseline,
  replacement: Buffer,
): Promise<void> {
  const lockPath = `${baseline.indexPath}.lock`;
  const handle = await fs.promises.open(lockPath, "wx", 0o600);
  try {
    const currentIndexHash = createHash("sha256")
      .update(await fs.promises.readFile(baseline.indexPath))
      .digest("hex");
    if (currentIndexHash !== baseline.indexSha256) {
      throw new Error("Destination index changed before the transaction acquired index.lock.");
    }
    await handle.writeFile(replacement);
    await handle.sync();
    await handle.close();
    await fs.promises.rename(lockPath, baseline.indexPath);
    const directory = await fs.promises.open(path.dirname(baseline.indexPath), fs.constants.O_RDONLY);
    try {
      await directory.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function verifyAppliedPostcondition(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  baseline: DestinationBaseline,
  handoffDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const failures: string[] = [];
  const [root, gitDir, commonGitDir, head, branch, unmerged] = await Promise.all([
    canonicalGitRoot(pi, prepared.targetRoot, signal),
    canonicalGitDir(pi, prepared.targetRoot, signal),
    canonicalCommonGitDir(pi, prepared.targetRoot, signal),
    gitOutput(pi, prepared.targetRoot, ["rev-parse", "HEAD"], signal),
    currentBranch(pi, prepared.targetRoot, signal),
    gitStdout(pi, prepared.targetRoot, ["diff", "--name-only", "--diff-filter=U", "-z"], signal),
  ]);
  if (root !== prepared.targetRoot || gitDir !== prepared.targetGitDir || commonGitDir !== prepared.targetCommonGitDir) {
    failures.push("destination identity changed");
  }
  if (head !== prepared.targetHead || branch !== prepared.targetBranch) failures.push("destination HEAD or branch changed");
  if (parseNulPaths(unmerged).length > 0) failures.push("destination has unresolved conflicts");
  const indexHash = createHash("sha256").update(await fs.promises.readFile(baseline.indexPath)).digest("hex");
  if (indexHash !== baseline.indexSha256) failures.push("destination index was not restored exactly");
  const worktreeTree = await snapshotWorktreeTree(
    pi,
    prepared.targetRoot,
    prepared.targetHead,
    path.join(handoffDir, "destination-postcondition.index"),
    signal,
  );
  if (!baseline.expectedTree || worktreeTree !== baseline.expectedTree) {
    failures.push("destination worktree does not match the precomputed result tree");
  }
  return failures;
}

async function rollbackDestination(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  baseline: DestinationBaseline,
  handoffDir: string,
): Promise<{ rolledBack: boolean; diagnostic?: string }> {
  try {
    const [root, gitDir, commonGitDir, head, branch] = await Promise.all([
      canonicalGitRoot(pi, prepared.targetRoot),
      canonicalGitDir(pi, prepared.targetRoot),
      canonicalCommonGitDir(pi, prepared.targetRoot),
      gitOutput(pi, prepared.targetRoot, ["rev-parse", "HEAD"]),
      currentBranch(pi, prepared.targetRoot),
    ]);
    if (
      root !== prepared.targetRoot || gitDir !== prepared.targetGitDir ||
      commonGitDir !== prepared.targetCommonGitDir || head !== prepared.targetHead ||
      branch !== prepared.targetBranch
    ) {
      return { rolledBack: false, diagnostic: "Destination identity changed; automatic rollback was refused." };
    }
    const currentTree = await snapshotWorktreeTree(
      pi,
      prepared.targetRoot,
      prepared.targetHead,
      path.join(handoffDir, "destination-rollback-ownership.index"),
    );
    const currentIndexHash = createHash("sha256")
      .update(await fs.promises.readFile(baseline.indexPath))
      .digest("hex");
    if (currentTree === baseline.tree && currentIndexHash === baseline.indexSha256) {
      return { rolledBack: true };
    }
    return {
      rolledBack: false,
      diagnostic: "Destination is not already at the exact baseline; destructive automatic rollback was refused to preserve concurrent edits and symlink safety.",
    };
  } catch (error) {
    return { rolledBack: false, diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

async function currentPreflightBlockers(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  signal?: AbortSignal,
): Promise<{ blockers: string[]; blockedPaths: string[] }> {
  const [destinationBlockers, sourceBlockers, currentRoot, currentGitDir, currentCommonGitDir] = await Promise.all([
    repositoryOperationBlockers(pi, prepared.targetRoot, signal),
    repositoryOperationBlockers(pi, prepared.sourceRoot, signal, "Source checkout"),
    canonicalGitRoot(pi, prepared.targetRoot, signal),
    canonicalGitDir(pi, prepared.targetRoot, signal),
    canonicalCommonGitDir(pi, prepared.targetRoot, signal),
  ]);
  const blockers = [...prepared.blockers, ...destinationBlockers, ...sourceBlockers];
  if (
    currentRoot !== prepared.targetRoot ||
    currentGitDir !== prepared.targetGitDir ||
    currentCommonGitDir !== prepared.targetCommonGitDir
  ) {
    blockers.push("Destination checkout identity changed after the apply preview.");
  }
  if (await pathExists(path.join(prepared.targetGitDir, "index.lock"))) {
    blockers.push("Destination Git index is locked by another operation.");
  }
  const currentHead = await gitOutput(pi, prepared.targetRoot, ["rev-parse", "HEAD"], signal);
  const branch = await currentBranch(pi, prepared.targetRoot, signal);
  if (currentHead !== prepared.targetHead || branch !== prepared.targetBranch) {
    blockers.push("Destination HEAD or branch changed after the apply preview; run the command again.");
  }
  if (await priorSnapshotApplied(prepared.targetGitDir, prepared.patchSha256, prepared.targetRoot)) {
    blockers.push("This exact worker snapshot already has an active or applied handoff for this destination.");
  }
  const blockedPaths = overlappingDirtyPaths(
    prepared.touchedPaths,
    await statusPaths(pi, prepared.targetRoot, signal),
  );
  if (blockedPaths.length > 0) {
    blockers.push(`Destination changes overlap the patch: ${blockedPaths.map(displayPath).join(", ")}`);
  }
  const ignoredBlockedPaths = overlappingDirtyPaths(
    prepared.touchedPaths,
    await ignoredPaths(pi, prepared.targetRoot, signal),
  );
  if (ignoredBlockedPaths.length > 0) {
    blockers.push(`Ignored destination entries overlap the patch: ${ignoredBlockedPaths.map(displayPath).join(", ")}`);
  }
  return { blockers, blockedPaths: uniqueSortedPaths([...blockedPaths, ...ignoredBlockedPaths]) };
}

async function tabExists(
  pi: ExtensionAPI,
  job: StoredCodingJob,
): Promise<boolean | undefined> {
  const result = await pi.exec(
    "supacode",
    ["tab", "list", "-w", job.tabWorktreeId],
    { timeout: GIT_TIMEOUT_MS },
  );
  if (result.code !== 0) return undefined;
  return result.stdout.split(/\r?\n/).some((id) => sameSupacodeUuid(id, job.tabId));
}

async function workerPaneExists(
  pi: ExtensionAPI,
  job: StoredCodingJob,
): Promise<boolean | undefined> {
  const listed = await pi.exec(
    "supacode",
    ["surface", "list", "-w", job.tabWorktreeId, "-t", job.tabId],
    { timeout: GIT_TIMEOUT_MS },
  );
  if (listed.code === 0) {
    return listed.stdout
      .split(/\r?\n/)
      .some((id) => sameSupacodeUuid(id, job.surfaceId));
  }
  return await tabExists(pi, job) === false ? false : undefined;
}

async function closeWorkerPane(
  pi: ExtensionAPI,
  job: StoredCodingJob,
): Promise<{ closed: boolean; error?: string }> {
  const closed = await pi.exec(
    "supacode",
    [
      "surface",
      "close",
      "-w",
      job.tabWorktreeId,
      "-t",
      job.tabId,
      "-s",
      job.surfaceId,
    ],
    { timeout: GIT_TIMEOUT_MS },
  );
  let consecutiveMissingChecks = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const exists = await workerPaneExists(pi, job);
    if (exists === false) {
      consecutiveMissingChecks++;
      if (consecutiveMissingChecks >= 2) return { closed: true };
    } else {
      consecutiveMissingChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    closed: false,
    error: closed.code === 0
      ? "Supacode acknowledged worker pane closure, but surface absence was not verified."
      : `Could not close worker pane: ${diagnosticText(closed)}`,
  };
}

function workerRecoveryRef(prepared: PreparedDelegateHandoff): string {
  return `refs/pi-agent-handoffs/${prepared.job.id}/${prepared.id}`;
}

async function createBranchBackup(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
): Promise<{ ref?: string; error?: string }> {
  const branchRef = `refs/heads/${prepared.job.branch}`;
  const branch = await gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", branchRef]);
  if (branch.code !== 0 || branch.stdout.trim() !== prepared.sourceHead) {
    return { error: "Worker branch does not point to the snapshotted worker HEAD; cleanup was stopped." };
  }

  const backupRef = workerRecoveryRef(prepared);
  const zeroObjectId = "0".repeat(prepared.sourceHead.length);
  const created = await gitResult(
    pi,
    prepared.targetRoot,
    ["update-ref", backupRef, prepared.sourceHead, zeroObjectId],
  );
  if (created.code !== 0) {
    return { error: `Could not create the worker recovery ref: ${diagnosticText(created)}` };
  }
  const verified = await gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", backupRef]);
  return verified.code === 0 && verified.stdout.trim() === prepared.sourceHead
    ? { ref: backupRef }
    : { error: "Could not verify the worker recovery ref; cleanup was stopped." };
}

async function prepareSourceForRemoval(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  backupRef: string,
): Promise<{ head?: string; error?: string }> {
  const snapshotCommit = await gitResult(
    pi,
    prepared.sourceRoot,
    [
      "-c",
      "user.name=Pi Handoff",
      "-c",
      "user.email=pi-handoff@localhost",
      "commit-tree",
      prepared.sourceTree,
      "-p",
      prepared.sourceHead,
      "-m",
      `Preserve delegated worker snapshot ${prepared.id}`,
    ],
  );
  const preservedHead = snapshotCommit.stdout.trim();
  if (snapshotCommit.code !== 0 || !OBJECT_ID_PATTERN.test(preservedHead)) {
    return { error: `Could not create the worker snapshot commit: ${diagnosticText(snapshotCommit)}` };
  }

  const backupAdvanced = await gitResult(
    pi,
    prepared.targetRoot,
    ["update-ref", backupRef, preservedHead, prepared.sourceHead],
  );
  if (backupAdvanced.code !== 0) {
    return { error: `Could not advance the worker recovery ref: ${diagnosticText(backupAdvanced)}` };
  }
  const branchRef = `refs/heads/${prepared.job.branch}`;
  const branchAdvanced = await gitResult(
    pi,
    prepared.targetRoot,
    ["update-ref", branchRef, preservedHead, prepared.sourceHead],
  );
  if (branchAdvanced.code !== 0) {
    return { error: `Worker branch changed during cleanup; recovery ref retained at ${backupRef}.` };
  }

  const indexReset = await gitResult(pi, prepared.sourceRoot, ["read-tree", preservedHead]);
  if (indexReset.code !== 0) {
    return { error: `Could not prepare the worker index for safe removal: ${diagnosticText(indexReset)}` };
  }
  const [head, dirtyPaths] = await Promise.all([
    gitOutput(pi, prepared.sourceRoot, ["rev-parse", "HEAD"]),
    statusPaths(pi, prepared.sourceRoot),
  ]);
  if (head !== preservedHead || dirtyPaths.length > 0) {
    return { error: `Worker changed while cleanup was preparing it; recovery ref retained at ${backupRef}.` };
  }
  return { head: preservedHead };
}

async function restoreWorkerBranch(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  backupRef: string,
  expectedHead: string,
  removeBackup: boolean,
): Promise<{ preserved: boolean; error?: string }> {
  const branchRef = `refs/heads/${prepared.job.branch}`;
  let existing = await gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", branchRef]);
  if (existing.code !== 0) {
    const zeroObjectId = "0".repeat(expectedHead.length);
    const restored = await gitResult(
      pi,
      prepared.targetRoot,
      ["update-ref", branchRef, expectedHead, zeroObjectId],
    );
    if (restored.code !== 0) {
      return { preserved: false, error: `Could not restore the worker branch; recovery ref retained at ${backupRef}: ${diagnosticText(restored)}` };
    }
    existing = await gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", branchRef]);
  }
  if (existing.code !== 0 || existing.stdout.trim() !== expectedHead) {
    return { preserved: false, error: `Worker branch no longer points to its snapshotted HEAD; recovery ref retained at ${backupRef}.` };
  }

  if (removeBackup) {
    const removed = await gitResult(
      pi,
      prepared.targetRoot,
      ["update-ref", "-d", backupRef, expectedHead],
    );
    if (removed.code !== 0) {
      return { preserved: true, error: `Worker branch is preserved, but recovery ref cleanup failed: ${diagnosticText(removed)}` };
    }
  }
  return { preserved: true };
}

async function listedSourceWorktreeId(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
): Promise<{ id?: string; error?: string }> {
  const listed = await pi.exec("supacode", ["worktree", "list"], { timeout: GIT_TIMEOUT_MS });
  if (listed.code !== 0) {
    return { error: `Could not verify Supacode worktrees before deletion: ${diagnosticText(listed)}` };
  }
  const id = await listedWorktreeIdForRoot(listed.stdout, prepared.sourceRoot);
  return id
    ? { id }
    : { error: "Supacode no longer lists the snapshotted source worktree; deletion was stopped." };
}

async function cleanupAppliedWorktree(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  onRecoveryRef?: (recoveryRef: string) => Promise<void>,
): Promise<HandoffCleanupResult> {
  const errors: string[] = [];
  const backup = await createBranchBackup(pi, prepared);
  if (!backup.ref) {
    if (backup.error) errors.push(backup.error);
    return { paneClosed: false, worktreeRemoved: false, branchPreserved: false, errors };
  }
  if (onRecoveryRef) {
    try {
      await onRecoveryRef(backup.ref);
    } catch (error) {
      errors.push(`Cleanup stopped because its recovery state could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      errors.push(`Worker recovery ref retained at ${backup.ref}.`);
      return {
        paneClosed: false,
        worktreeRemoved: false,
        branchPreserved: true,
        recoveryRef: backup.ref,
        errors,
      };
    }
  }
  const retained = (paneClosed: boolean, preservedHead?: string): HandoffCleanupResult => ({
    paneClosed,
    worktreeRemoved: false,
    branchPreserved: true,
    recoveryRef: backup.ref,
    preservedHead,
    errors,
  });

  const sourceOperationBlockersBeforeClose = await pathExists(prepared.sourceRoot)
    ? await repositoryOperationBlockers(
        pi,
        prepared.sourceRoot,
        undefined,
        "Source checkout",
      )
    : [];
  if (sourceOperationBlockersBeforeClose.length > 0) {
    errors.push("Worker cleanup stopped because its source checkout has an active Git operation.");
    errors.push(...sourceOperationBlockersBeforeClose);
    errors.push(`Worker recovery ref retained at ${backup.ref}.`);
    return retained(false);
  }

  const pane = await closeWorkerPane(pi, prepared.job);
  if (!pane.closed) {
    if (pane.error) errors.push(pane.error);
    errors.push(`Worker recovery ref retained at ${backup.ref}.`);
    return retained(false);
  }

  if (!await pathExists(prepared.sourceRoot)) {
    const branch = await restoreWorkerBranch(
      pi,
      prepared,
      backup.ref,
      prepared.sourceHead,
      true,
    );
    if (branch.error) errors.push(branch.error);
    return {
      paneClosed: true,
      worktreeRemoved: true,
      branchPreserved: branch.preserved,
      recoveryRef: branch.preserved && !branch.error ? undefined : backup.ref,
      preservedHead: prepared.sourceHead,
      errors,
    };
  }

  const sourceOperationBlockers = await repositoryOperationBlockers(
    pi,
    prepared.sourceRoot,
    undefined,
    "Source checkout",
  );
  if (sourceOperationBlockers.length > 0) {
    errors.push("Worker cleanup stopped because its source checkout has an active Git operation.");
    errors.push(...sourceOperationBlockers);
    errors.push(`Worker recovery ref retained at ${backup.ref}.`);
    return retained(true);
  }

  try {
    const currentHead = await gitOutput(pi, prepared.sourceRoot, ["rev-parse", "HEAD"]);
    const currentTree = await snapshotWorktreeTree(
      pi,
      prepared.sourceRoot,
      currentHead,
      path.join(prepared.job.jobDir, `.cleanup-${prepared.id}.index`),
    );
    if (currentHead !== prepared.sourceHead || currentTree !== prepared.sourceTree) {
      errors.push("Worker changed after the apply preview; its pane is closed but its worktree was retained.");
      errors.push(`Worker recovery ref retained at ${backup.ref}.`);
      return retained(true);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Could not verify the worker before cleanup: ${message}`);
    errors.push(`Worker recovery ref retained at ${backup.ref}.`);
    return retained(true);
  }

  const preservation = await prepareSourceForRemoval(pi, prepared, backup.ref);
  if (!preservation.head) {
    if (preservation.error) errors.push(preservation.error);
    errors.push(`Worker recovery ref retained at ${backup.ref}.`);
    return retained(true);
  }

  const identity = await listedSourceWorktreeId(pi, prepared);
  if (!identity.id) {
    if (identity.error) errors.push(identity.error);
    errors.push(`Worker recovery ref retained at ${backup.ref}.`);
    return retained(true, preservation.head);
  }

  const removedByGit = await gitResult(
    pi,
    prepared.targetRoot,
    ["worktree", "remove", prepared.sourceRoot],
  );
  const worktreeRemoved = removedByGit.code === 0 && !await pathExists(prepared.sourceRoot);
  if (!worktreeRemoved) {
    errors.push(`Git refused to remove the worker safely: ${diagnosticText(removedByGit)}`);
    errors.push(`Worker recovery ref retained at ${backup.ref}.`);
    return retained(true, preservation.head);
  }

  const removedBySupacode = await pi.exec(
    "supacode",
    ["worktree", "delete", "-w", identity.id],
    { timeout: SUPACODE_DELETE_TIMEOUT_MS },
  );
  if (removedBySupacode.code !== 0) {
    errors.push(`Worker files were removed safely, but Supacode resource cleanup failed: ${diagnosticText(removedBySupacode)}`);
  }

  const branch = await restoreWorkerBranch(
    pi,
    prepared,
    backup.ref,
    preservation.head,
    true,
  );
  if (branch.error) errors.push(branch.error);
  return {
    paneClosed: true,
    worktreeRemoved: true,
    branchPreserved: branch.preserved,
    recoveryRef: branch.preserved && !branch.error ? undefined : backup.ref,
    preservedHead: preservation.head,
    errors,
  };
}

async function applyPreparedDelegateHandoffUnlocked(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  signal: AbortSignal | undefined,
): Promise<DelegateHandoffResult> {
  const finalDir = path.join(prepared.job.jobDir, "handoffs", prepared.id);
  const finalParent = path.dirname(finalDir);
  const draftParent = path.dirname(prepared.draftDir);
  await ensureDirectoryDurable(finalParent);
  await fs.promises.rename(prepared.draftDir, finalDir);
  await Promise.all([
    syncDirectory(draftParent),
    syncDirectory(finalParent),
  ]);
  const patchPath = path.join(finalDir, "changes.patch");
  const manifestPath = path.join(finalDir, "manifest.json");
  const emptyCleanup: HandoffCleanupResult = {
    paneClosed: false,
    worktreeRemoved: false,
    branchPreserved: false,
    errors: [],
  };
  await fs.promises.chmod(patchPath, 0o400);
  await writeManifest(manifestPath, manifestFor(prepared, "prepared"));
  await writeDestinationTransaction(prepared, manifestPath, "prepared");

  const preflight = await currentPreflightBlockers(pi, prepared, signal);
  if (preflight.blockers.length > 0) {
    const diagnostic = preflight.blockers.join("\n");
    const apply = {
      appliedPaths: [],
      conflictedPaths: [],
      blockedPaths: preflight.blockedPaths,
      diagnostic,
    };
    await writeManifest(manifestPath, manifestFor(prepared, "blocked", apply, emptyCleanup));
    await writeDestinationTransaction(prepared, manifestPath, "blocked", undefined, diagnostic);
    return {
      id: prepared.id,
      state: "blocked",
      appliedPaths: [],
      conflictedPaths: [],
      blockedPaths: preflight.blockedPaths,
      diagnostic,
      manifestPath,
      patchPath,
      cleanup: emptyCleanup,
    };
  }

  const patchBuffer = await fs.promises.readFile(patchPath);
  const currentHash = createHash("sha256").update(patchBuffer).digest("hex");
  if (patchBuffer.length !== prepared.patchBytes || currentHash !== prepared.patchSha256) {
    const diagnostic = "Stored handoff patch changed after preview; nothing was applied.";
    const apply = { appliedPaths: [], conflictedPaths: [], blockedPaths: [], diagnostic };
    await writeManifest(manifestPath, manifestFor(prepared, "blocked", apply, emptyCleanup));
    await writeDestinationTransaction(prepared, manifestPath, "blocked", undefined, diagnostic);
    return {
      id: prepared.id,
      state: "blocked",
      appliedPaths: [],
      conflictedPaths: [],
      blockedPaths: [],
      diagnostic,
      manifestPath,
      patchPath,
      cleanup: emptyCleanup,
    };
  }

  let baseline: DestinationBaseline;
  try {
    baseline = await captureDestinationBaseline(pi, prepared, finalDir, patchBuffer, signal);
  } catch (error) {
    const diagnostic = `Could not capture destination rollback and postcondition evidence: ${error instanceof Error ? error.message : String(error)}`;
    const apply = { appliedPaths: [], conflictedPaths: [], blockedPaths: [], diagnostic };
    await writeManifest(manifestPath, manifestFor(prepared, "failed", apply, emptyCleanup));
    await writeDestinationTransaction(prepared, manifestPath, "failed", undefined, diagnostic);
    return {
      id: prepared.id,
      state: "failed",
      appliedPaths: [],
      conflictedPaths: [],
      blockedPaths: [],
      diagnostic,
      manifestPath,
      patchPath,
      cleanup: emptyCleanup,
    };
  }
  await writeManifest(manifestPath, manifestFor(prepared, "applying"));
  await writeDestinationTransaction(prepared, manifestPath, "applying", baseline);
  const applyIndexPath = path.join(finalDir, "destination-apply.index");
  await atomicWrite(applyIndexPath, await fs.promises.readFile(baseline.indexBackupPath));
  let applied: CommandResult;
  try {
    applied = await commandWithInput(
      "env",
      [
        `GIT_INDEX_FILE=${applyIndexPath}`,
        "git",
        "-C",
        prepared.targetRoot,
        "apply",
        "--3way",
        "--index",
        "--binary",
        "-",
      ],
      patchBuffer,
      { signal, timeout: GIT_TIMEOUT_MS },
    );
  } catch (error) {
    const rollback = await rollbackDestination(pi, prepared, baseline, finalDir);
    const state = rollback.rolledBack ? "failed" : "indeterminate";
    const diagnostic = [
      `Git apply ended unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      rollback.rolledBack ? "Destination was rolled back to its exact baseline." : rollback.diagnostic,
    ].filter(Boolean).join("\n");
    const apply = { appliedPaths: [], conflictedPaths: [], blockedPaths: [], diagnostic };
    try {
      await writeManifest(manifestPath, manifestFor(prepared, state, apply, emptyCleanup));
      await writeDestinationTransaction(
        prepared,
        manifestPath,
        rollback.rolledBack ? "rolled_back" : "indeterminate",
        baseline,
        diagnostic,
      );
    } catch {
      // The prepared and applying manifests remain as recovery evidence.
    }
    return {
      id: prepared.id,
      state,
      appliedPaths: [],
      conflictedPaths: [],
      blockedPaths: [],
      diagnostic,
      manifestPath,
      patchPath,
      cleanup: emptyCleanup,
    };
  }

  let state: HandoffState;
  let appliedPaths: string[] = [];
  let conflictedPaths: string[] = [];
  let diagnostic: string | undefined;
  let transactionState: DestinationTransaction["state"];
  try {
    conflictedPaths = uniqueSortedPaths(parseNulPaths(await gitStdout(
      pi,
      prepared.targetRoot,
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      signal,
      applyIndexPath,
    )).filter((conflictedPath) =>
      prepared.touchedPaths.some((touchedPath) => delegatePathsOverlap(touchedPath, conflictedPath))));
    const dirtyAfterApply = await statusPaths(pi, prepared.targetRoot, signal);
    appliedPaths = prepared.touchedPaths.filter((touchedPath) =>
      dirtyAfterApply.some((dirtyPath) => delegatePathsOverlap(touchedPath, dirtyPath)));
    const applyOutput = (applied.stderr || applied.stdout).trim();

    if (conflictedPaths.length > 0) {
      await replaceDestinationIndex(baseline, await fs.promises.readFile(applyIndexPath));
      state = "conflicted";
      transactionState = "conflicted";
      diagnostic = applyOutput || undefined;
    } else if (applied.code === 0 && !applied.timedOut) {
      const postconditionFailures = await verifyAppliedPostcondition(
        pi,
        prepared,
        baseline,
        finalDir,
        signal,
      );
      if (postconditionFailures.length === 0) {
        state = "applied";
        transactionState = "applied";
        appliedPaths = [...prepared.touchedPaths];
        diagnostic = applyOutput || undefined;
      } else {
        const rollback = await rollbackDestination(pi, prepared, baseline, finalDir);
        state = rollback.rolledBack ? "failed" : "indeterminate";
        transactionState = rollback.rolledBack ? "rolled_back" : "indeterminate";
        appliedPaths = [];
        diagnostic = [
          `Apply postcondition failed: ${postconditionFailures.join("; ")}.`,
          rollback.rolledBack ? "Destination was rolled back to its exact baseline." : rollback.diagnostic,
        ].filter(Boolean).join("\n");
      }
    } else {
      const rollback = await rollbackDestination(pi, prepared, baseline, finalDir);
      state = rollback.rolledBack ? "failed" : "indeterminate";
      transactionState = rollback.rolledBack ? "rolled_back" : "indeterminate";
      appliedPaths = [];
      diagnostic = [
        applyOutput || `git apply exited ${applied.code}`,
        applied.timedOut ? "Git apply timed out." : undefined,
        rollback.rolledBack ? "Destination was rolled back to its exact baseline." : rollback.diagnostic,
      ].filter(Boolean).join("\n");
    }
  } catch (error) {
    const rollback = await rollbackDestination(pi, prepared, baseline, finalDir);
    state = rollback.rolledBack ? "failed" : "indeterminate";
    transactionState = rollback.rolledBack ? "rolled_back" : "indeterminate";
    appliedPaths = [];
    diagnostic = [
      `Apply result collection or postcondition verification failed: ${error instanceof Error ? error.message : String(error)}`,
      rollback.rolledBack ? "Destination was rolled back to its exact baseline." : rollback.diagnostic,
    ].filter(Boolean).join("\n");
  }

  const apply = { appliedPaths, conflictedPaths, blockedPaths: [], diagnostic };
  await writeManifest(manifestPath, manifestFor(prepared, state, apply, emptyCleanup));
  await writeDestinationTransaction(prepared, manifestPath, transactionState, baseline, diagnostic);
  return {
    id: prepared.id,
    state,
    appliedPaths,
    conflictedPaths,
    blockedPaths: [],
    diagnostic,
    manifestPath,
    patchPath,
    cleanup: emptyCleanup,
  };
}

export async function applyPreparedDelegateHandoff(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  signal?: AbortSignal,
  cleanup = true,
): Promise<DelegateHandoffResult> {
  const lock = await acquireDestinationApplyLock(
    prepared.targetGitDir,
    prepared.id,
    prepared.targetRoot,
  );
  let result: DelegateHandoffResult;
  try {
    result = await applyPreparedDelegateHandoffUnlocked(pi, prepared, signal);
  } finally {
    await releaseDestinationApplyLock(lock);
  }
  if (result.state !== "applied" || !cleanup) return result;

  const apply = {
    appliedPaths: result.appliedPaths,
    conflictedPaths: result.conflictedPaths,
    blockedPaths: result.blockedPaths,
    diagnostic: result.diagnostic,
  };
  let cleanupResult: HandoffCleanupResult;
  const cleanupIntent: HandoffCleanupResult = {
    paneClosed: false,
    worktreeRemoved: false,
    branchPreserved: false,
    errors: [`Cleanup intent recorded before creating ${workerRecoveryRef(prepared)}.`],
  };
  try {
    await writeManifest(
      result.manifestPath,
      manifestFor(prepared, "applied", apply, cleanupIntent),
    );
  } catch (error) {
    return {
      ...result,
      cleanup: {
        ...cleanupIntent,
        errors: [`Cleanup was skipped because its write-ahead intent could not be recorded: ${error instanceof Error ? error.message : String(error)}`],
      },
    };
  }
  try {
    cleanupResult = await cleanupAppliedWorktree(pi, prepared, async (recoveryRef) => {
      const pendingCleanup: HandoffCleanupResult = {
        paneClosed: false,
        worktreeRemoved: false,
        branchPreserved: true,
        recoveryRef,
        errors: ["Cleanup pending; the verified recovery ref preserves the source HEAD."],
      };
      await writeManifest(
        result.manifestPath,
        manifestFor(prepared, "applied", apply, pendingCleanup),
      );
    });
  } catch (error) {
    cleanupResult = {
      paneClosed: false,
      worktreeRemoved: false,
      branchPreserved: false,
      errors: [`Cleanup ended unexpectedly; inspect the source worktree: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  try {
    await writeManifest(
      result.manifestPath,
      manifestFor(prepared, "applied", apply, cleanupResult),
    );
  } catch (error) {
    cleanupResult.errors.push(`Could not record final cleanup state: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...result, cleanup: cleanupResult };
}

export async function recoverDelegateApplyState(
  pi: ExtensionAPI,
  destinationCwd: string,
  signal?: AbortSignal,
): Promise<{ recovered: boolean; message: string; transactions: string[] }> {
  const root = await canonicalGitRoot(pi, destinationCwd, signal);
  const gitDir = await canonicalGitDir(pi, root, signal);
  const lock = await recoverStaleDestinationApplyLock(gitDir);
  const recoveryLock = await acquireDestinationApplyLock(
    gitDir,
    `recovery-${randomUUID()}`,
    root,
  );
  try {
    const transactionsDir = path.join(destinationApplyStateDir(gitDir), "transactions");
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(transactionsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const transactions: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const transactionPath = path.join(transactionsDir, entry.name, "transaction.json");
      const record = await readJsonRecord(transactionPath);
      if (!record) {
        transactions.push(`${entry.name}: corrupt transaction metadata; manual recovery required.`);
        continue;
      }
      const state = stringValue(record, "state");
      if (state !== "applying" && state !== "indeterminate" && state !== "conflicted") continue;
      const destination = isRecord(record.destination) ? record.destination : undefined;
      const baseline = isRecord(record.baseline) ? record.baseline : undefined;
      const expectedRoot = destination && stringValue(destination, "root");
      const expectedGitDir = destination && stringValue(destination, "gitDir");
      const expectedCommonGitDir = destination && stringValue(destination, "commonGitDir");
      const expectedHead = destination && stringValue(destination, "head");
      const expectedBranch = destination && stringValue(destination, "branch");
      const baselineTree = baseline && stringValue(baseline, "tree");
      const expectedTree = baseline && stringValue(baseline, "expectedTree");
      const indexPath = baseline && stringValue(baseline, "indexPath");
      const indexSha256 = baseline && stringValue(baseline, "indexSha256");
      const jobManifestPath = stringValue(record, "jobManifestPath");
      if (
        !expectedRoot || !expectedGitDir || !expectedCommonGitDir || !expectedHead ||
        !baselineTree || !indexPath || !indexSha256 || !jobManifestPath
      ) {
        transactions.push(`${entry.name}: malformed recovery evidence; no state changed.`);
        continue;
      }
      const [observedGitDir, observedCommonGitDir, observedHead, observedBranch] = await Promise.all([
        canonicalGitDir(pi, root, signal),
        canonicalCommonGitDir(pi, root, signal),
        gitOutput(pi, root, ["rev-parse", "HEAD"], signal),
        currentBranch(pi, root, signal),
      ]);
      if (
        expectedRoot !== root || expectedGitDir !== observedGitDir ||
        expectedCommonGitDir !== observedCommonGitDir || expectedHead !== observedHead ||
        expectedBranch !== observedBranch
      ) {
        transactions.push(`${entry.name}: destination identity, HEAD, or branch mismatch; no state changed.`);
        continue;
      }
      if (state === "conflicted") {
        const unresolved = parseNulPaths(await gitStdout(
          pi,
          root,
          ["diff", "--name-only", "--diff-filter=U", "-z"],
          signal,
        ));
        if (unresolved.length > 0) {
          transactions.push(`${entry.name}: conflicts remain unresolved (${unresolved.map(displayPath).join(", ")}).`);
          continue;
        }
        const recoveryDiagnostic = "Manual conflict resolution was observed; destination transaction marked resolved.";
        const jobManifest = await readJsonRecord(jobManifestPath);
        if (
          !jobManifest || stringValue(jobManifest, "id") !== entry.name ||
          stringValue(jobManifest, "jobId") !== stringValue(record, "jobId")
        ) {
          transactions.push(`${entry.name}: job-local manifest identity mismatch; no state changed.`);
          continue;
        }
        await atomicWrite(
          jobManifestPath,
          `${JSON.stringify({
            ...jobManifest,
            updatedAt: new Date().toISOString(),
            apply: {
              ...(isRecord(jobManifest.apply) ? jobManifest.apply : {}),
              diagnostic: recoveryDiagnostic,
            },
          }, null, 2)}\n`,
        );
        await atomicWrite(
          transactionPath,
          `${JSON.stringify({
            ...record,
            state: "resolved",
            updatedAt: new Date().toISOString(),
            diagnostic: recoveryDiagnostic,
          }, null, 2)}\n`,
        );
        transactions.push(`${entry.name}: resolved.`);
        continue;
      }
      const currentTree = await snapshotWorktreeTree(
        pi,
        root,
        observedHead,
        path.join(transactionsDir, entry.name, "recovery.index"),
        signal,
      );
      const currentIndexSha256 = createHash("sha256")
        .update(await fs.promises.readFile(indexPath))
        .digest("hex");
      let recoveredState: DestinationTransaction["state"] | undefined;
      if (currentTree === baselineTree && currentIndexSha256 === indexSha256) {
        recoveredState = "rolled_back";
      } else if (
        expectedTree && currentTree === expectedTree && currentIndexSha256 === indexSha256
      ) {
        recoveredState = "applied";
      }
      if (!recoveredState) {
        transactions.push(`${entry.name}: destination matches neither baseline nor expected result; manual recovery required.`);
        continue;
      }
      const recoveryDiagnostic = `Recovered by exact tree and index postcondition as ${recoveredState}.`;
      const jobManifest = await readJsonRecord(jobManifestPath);
      if (
        !jobManifest || stringValue(jobManifest, "id") !== entry.name ||
        stringValue(jobManifest, "jobId") !== stringValue(record, "jobId")
      ) {
        transactions.push(`${entry.name}: job-local manifest identity mismatch; no state changed.`);
        continue;
      }
      await atomicWrite(
        jobManifestPath,
        `${JSON.stringify({
          ...jobManifest,
          state: recoveredState === "applied" ? "applied" : "failed",
          updatedAt: new Date().toISOString(),
          apply: {
            ...(isRecord(jobManifest.apply) ? jobManifest.apply : {}),
            diagnostic: recoveryDiagnostic,
          },
        }, null, 2)}\n`,
      );
      const updated = {
        ...record,
        state: recoveredState,
        updatedAt: new Date().toISOString(),
        diagnostic: recoveryDiagnostic,
      };
      await atomicWrite(transactionPath, `${JSON.stringify(updated, null, 2)}\n`);
      transactions.push(`${entry.name}: ${recoveredState}.`);
    }
    return { ...lock, transactions };
  } finally {
    await releaseDestinationApplyLock(recoveryLock);
  }
}
