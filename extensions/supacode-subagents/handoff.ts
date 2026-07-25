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
import { inspectProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { decodeSupacodeResourceId } from "./resource-id.ts";
import {
  observeSupacodeSurface,
  observeSupacodeWorktree,
  type SupacodeResourcePresence,
} from "./resource-state.ts";
import {
  recordValidationGateIntent,
  runValidationProcess,
  validationGateProvesCommandNeverLaunched,
} from "./validation-process.ts";
import { verifyWorkerProcessesAbsent } from "./worker-supervisor.ts";

const HANDOFF_VERSION = 1;
const GIT_TIMEOUT_MS = 60_000;
const SUPACODE_DELETE_TIMEOUT_MS = 190_000;
const MAX_DIAGNOSTIC_LENGTH = 16_000;
const MIN_JOB_ID_PREFIX_LENGTH = 4;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OBJECT_ID_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

type WorkerCompletionState = "running" | "completed" | "failed" | "unknown";
type HandoffState = "prepared" | "applying" | "applied" | "blocked" | "conflicted" | "resolved" | "failed" | "indeterminate";

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
  worktreeId?: string;
  supacodeWorktreeDeletionIntentAt?: string;
  supacodeWorktreeDeletionVerifiedAt?: string;
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

interface ApplyProcessIntent {
  jobDir: string;
  jobId: string;
  launchNonce: string;
}

interface ConflictIndexIntent {
  path: string;
  sha256: string;
  phase: "pending" | "published" | "superseded";
  supersededByIndexSha256?: string;
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
  applyProcess?: ApplyProcessIntent;
  conflictIndex?: ConflictIndexIntent;
  diagnostic?: string;
  jobManifestPath: string;
}

interface ExtensionAPIWithHandoffTestHook extends ExtensionAPI {
  __beforeConflictIndexPublicationForTests?: () => Promise<void>;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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

async function readJsonRecordStrictOptional(filePath: string): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`JSON metadata is not an object: ${filePath}`);
  return parsed;
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

async function readWorkerState(jobDir: string, jobId: string): Promise<WorkerCompletionState> {
  const terminal = await readWorkerTerminal<Record<string, unknown>>(jobDir);
  if (terminal) {
    if (terminal.jobId !== jobId) {
      throw new Error(`Coding worker terminal identity is malformed: ${jobDir}`);
    }
    const terminalState = stringValue(terminal.status, "state");
    if (terminalState === "completed" || terminalState === "failed") return terminalState;
    throw new Error(`Coding worker terminal status is malformed: ${jobDir}`);
  }
  const status = await readJsonRecord(path.join(jobDir, "status.json"));
  const state = status && stringValue(status, "state");
  return state === "running" || state === "completed" || state === "failed" ? state : "unknown";
}

async function parseStoredJob(jobDir: string): Promise<StoredCodingJob | undefined> {
  const record = await readJsonRecordStrictOptional(path.join(jobDir, "job.json"));
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
    throw new Error(`Coding worker metadata is malformed: ${jobDir}`);
  }
  if (
    path.basename(jobDir).toLowerCase() !== id.toLowerCase() ||
    path.basename(path.dirname(jobDir)).toLowerCase() !== batchId.toLowerCase()
  ) {
    throw new Error(`Coding worker metadata does not match its job and batch directories: ${jobDir}`);
  }
  const expectedBranch = `pi-agent/${batchId.slice(0, 6).toLowerCase()}/${id.slice(0, 6).toLowerCase()}`;
  if (branch !== expectedBranch) throw new Error(`Coding worker branch identity is malformed: ${jobDir}`);
  const lifecycle = await readJobLifecycle(jobDir);
  if (!lifecycle || lifecycle.jobId !== id || lifecycle.batchId !== batchId) {
    throw new Error(`Coding worker lifecycle identity is malformed: ${jobDir}`);
  }
  const control = await readJsonRecordStrictOptional(path.join(jobDir, "control.json"));
  if (control) {
    if (stringValue(control, "jobId") !== id || stringValue(control, "action") !== "cancel") {
      throw new Error(`Coding worker control identity is malformed: ${jobDir}`);
    }
    return undefined;
  }
  const decision = await readJobDecision(jobDir);
  if (decision && decision.jobId !== id) {
    throw new Error(`Coding worker decision identity is malformed: ${jobDir}`);
  }
  if (decision?.owner === "cancel") return undefined;
  if (booleanValue(record, "delegateLoop")) {
    if (!decision || decision.owner !== "accept") return undefined;
  }
  const resolvedJobDir = await fs.promises.realpath(jobDir);
  const configuredWorkerJobDir = stringValue(record, "activeWorkerJobDir");
  const activeWorkerJobDir = configuredWorkerJobDir
    ? await fs.promises.realpath(configuredWorkerJobDir)
    : resolvedJobDir;
  if (
    activeWorkerJobDir !== resolvedJobDir &&
    !activeWorkerJobDir.startsWith(`${resolvedJobDir}${path.sep}`)
  ) throw new Error(`Coding worker runtime directory escapes its job directory: ${jobDir}`);

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
    workerState: await readWorkerState(jobDir, id),
  };
}

interface CodingJobScanError {
  id: string;
  message: string;
}

async function scanCodingJobs(
  agentDir: string,
): Promise<{ jobs: StoredCodingJob[]; errors: CodingJobScanError[] }> {
  const root = path.join(agentDir, "subagents");
  let batches: fs.Dirent[];
  try {
    batches = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { jobs: [], errors: [] };
  }

  const jobs: StoredCodingJob[] = [];
  const errors: CodingJobScanError[] = [];
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
      try {
        const job = await parseStoredJob(path.join(batchPath, entry.name));
        if (job) jobs.push(job);
      } catch (error) {
        if (UUID_PATTERN.test(entry.name)) {
          errors.push({
            id: entry.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  jobs.sort((left, right) =>
    (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  return { jobs, errors };
}

async function codingJobs(agentDir: string): Promise<StoredCodingJob[]> {
  return (await scanCodingJobs(agentDir)).jobs;
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

  const scan = await scanCodingJobs(agentDir);
  const corruptMatches = scan.errors.filter((error) =>
    error.id.toLowerCase() === requested || error.id.toLowerCase().startsWith(requested));
  if (corruptMatches.length > 0) {
    throw new Error(
      corruptMatches.length === 1
        ? `Coding worker ${corruptMatches[0].id} metadata is corrupt: ${corruptMatches[0].message}`
        : `Worker ID prefix ${jobId} matches corrupt coding metadata and is unsafe to resolve.`,
    );
  }
  const matches = scan.jobs.filter((job) =>
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
  const terminalState = stringValue(terminal.status, "state");
  if (terminal.jobId !== job.id || (terminalState !== "completed" && terminalState !== "failed")) {
    throw new Error(`Worker ${job.id} terminal claim identity or status is malformed.`);
  }
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
    pi,
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
  applyProcess?: ApplyProcessIntent,
  conflictIndex?: ConflictIndexIntent,
): Promise<void> {
  const transactionPath = destinationTransactionPath(prepared);
  const prior = await readJsonRecord(transactionPath);
  const createdAt = prior && stringValue(prior, "createdAt") || new Date().toISOString();
  const priorApplyProcess = prior && isRecord(prior.applyProcess)
    ? {
        jobDir: stringValue(prior.applyProcess, "jobDir"),
        jobId: stringValue(prior.applyProcess, "jobId"),
        launchNonce: stringValue(prior.applyProcess, "launchNonce"),
      }
    : undefined;
  const retainedApplyProcess = priorApplyProcess?.jobDir && priorApplyProcess.jobId && priorApplyProcess.launchNonce
    ? priorApplyProcess as ApplyProcessIntent
    : undefined;
  const priorConflictIndex = prior && isRecord(prior.conflictIndex)
    ? {
        path: stringValue(prior.conflictIndex, "path"),
        sha256: stringValue(prior.conflictIndex, "sha256"),
        phase: stringValue(prior.conflictIndex, "phase"),
      }
    : undefined;
  const retainedConflictIndex = priorConflictIndex?.path && priorConflictIndex.sha256 &&
      (priorConflictIndex.phase === "pending" || priorConflictIndex.phase === "published" ||
        priorConflictIndex.phase === "superseded")
    ? priorConflictIndex as ConflictIndexIntent
    : undefined;
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
    applyProcess: applyProcess ?? retainedApplyProcess,
    conflictIndex: conflictIndex ?? (state === "conflicted" ? retainedConflictIndex : undefined),
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

async function workerPanePresence(
  pi: ExtensionAPI,
  job: StoredCodingJob,
): Promise<SupacodeResourcePresence> {
  return observeSupacodeSurface(
    pi,
    job.tabWorktreeId,
    job.tabId,
    job.surfaceId,
    { timeoutMs: GIT_TIMEOUT_MS },
  );
}

async function closeWorkerPane(
  pi: ExtensionAPI,
  job: StoredCodingJob,
): Promise<{ closed: boolean; error?: string }> {
  let previousPresence: SupacodeResourcePresence | undefined;
  let confirmedPresent = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const presence = await workerPanePresence(pi, job);
    if (presence !== "unknown" && presence === previousPresence) {
      if (presence === "absent") return { closed: true };
      confirmedPresent = true;
      break;
    }
    previousPresence = presence === "unknown" ? undefined : presence;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!confirmedPresent) {
    return {
      closed: false,
      error: "Could not establish stable worker-pane presence; destructive close was not issued.",
    };
  }

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
    const presence = await workerPanePresence(pi, job);
    if (presence === "absent") {
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
  const backupRef = workerRecoveryRef(prepared);
  const [branch, existingBackup] = await Promise.all([
    gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", branchRef]),
    gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", backupRef]),
  ]);
  if (existingBackup.code === 0) {
    const backupHead = existingBackup.stdout.trim();
    const [backupTree, backupParent] = await Promise.all([
      gitResult(pi, prepared.targetRoot, ["rev-parse", `${backupHead}^{tree}`]),
      gitResult(pi, prepared.targetRoot, ["rev-parse", `${backupHead}^`]),
    ]);
    const validPreservedSnapshot = backupTree.code === 0 && backupTree.stdout.trim() === prepared.sourceTree &&
      backupParent.code === 0 && backupParent.stdout.trim() === prepared.sourceHead;
    if (backupHead !== prepared.sourceHead && !validPreservedSnapshot) {
      return { error: `Worker recovery ref ${backupRef} does not match the snapshotted source; cleanup was stopped.` };
    }
    if (
      branch.code === 0 && branch.stdout.trim() !== prepared.sourceHead &&
      branch.stdout.trim() !== backupHead
    ) return { error: "Worker branch changed after cleanup began; recovery ref was retained." };
    return { ref: backupRef };
  }
  if (branch.code !== 0) {
    return { error: "Worker branch does not point to the snapshotted worker HEAD; cleanup was stopped." };
  }
  let backupHead = branch.stdout.trim();
  if (backupHead !== prepared.sourceHead) {
    const [branchTree, branchParent] = await Promise.all([
      gitResult(pi, prepared.targetRoot, ["rev-parse", `${backupHead}^{tree}`]),
      gitResult(pi, prepared.targetRoot, ["rev-parse", `${backupHead}^`]),
    ]);
    if (
      branchTree.code !== 0 || branchTree.stdout.trim() !== prepared.sourceTree ||
      branchParent.code !== 0 || branchParent.stdout.trim() !== prepared.sourceHead
    ) return { error: "Worker branch does not preserve the snapshotted source; cleanup was stopped." };
  }

  const zeroObjectId = "0".repeat(prepared.sourceHead.length);
  const created = await gitResult(
    pi,
    prepared.targetRoot,
    ["update-ref", backupRef, backupHead, zeroObjectId],
  );
  if (created.code !== 0) {
    return { error: `Could not create the worker recovery ref: ${diagnosticText(created)}` };
  }
  const verified = await gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", backupRef]);
  return verified.code === 0 && verified.stdout.trim() === backupHead
    ? { ref: backupRef }
    : { error: "Could not verify the worker recovery ref; cleanup was stopped." };
}

async function prepareSourceForRemoval(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  backupRef: string,
): Promise<{ head?: string; error?: string }> {
  const existingBackup = await gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", backupRef]);
  const existingHead = existingBackup.stdout.trim();
  if (existingBackup.code === 0 && existingHead !== prepared.sourceHead) {
    const [tree, parent, branch] = await Promise.all([
      gitResult(pi, prepared.targetRoot, ["rev-parse", `${existingHead}^{tree}`]),
      gitResult(pi, prepared.targetRoot, ["rev-parse", `${existingHead}^`]),
      gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", `refs/heads/${prepared.job.branch}`]),
    ]);
    if (
      tree.code !== 0 || tree.stdout.trim() !== prepared.sourceTree ||
      parent.code !== 0 || parent.stdout.trim() !== prepared.sourceHead
    ) return { error: `Recovery ref ${backupRef} does not preserve the snapshotted source.` };
    if (branch.code !== 0 || (branch.stdout.trim() !== prepared.sourceHead && branch.stdout.trim() !== existingHead)) {
      return { error: "Worker branch changed while cleanup was interrupted." };
    }
    if (branch.stdout.trim() === prepared.sourceHead) {
      const advanced = await gitResult(
        pi,
        prepared.targetRoot,
        ["update-ref", `refs/heads/${prepared.job.branch}`, existingHead, prepared.sourceHead],
      );
      if (advanced.code !== 0) return { error: `Could not resume worker branch preservation: ${diagnosticText(advanced)}` };
    }
    const indexReset = await gitResult(pi, prepared.sourceRoot, ["read-tree", existingHead]);
    if (indexReset.code !== 0) return { error: `Could not restore the worker index during cleanup recovery: ${diagnosticText(indexReset)}` };
    const [head, dirtyPaths] = await Promise.all([
      gitOutput(pi, prepared.sourceRoot, ["rev-parse", "HEAD"]),
      statusPaths(pi, prepared.sourceRoot),
    ]);
    return head === existingHead && dirtyPaths.length === 0
      ? { head: existingHead }
      : { error: `Worker changed while cleanup recovery was preparing ${backupRef}.` };
  }
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

type SupacodeWorktreeRemovalOutcome =
  | { removed: true; intentAt?: string; verifiedAt: string }
  | { removed: false; intentAt?: string; error: string };

interface AppliedWorktreeCleanupProtocol {
  onRecoveryRef?: (recoveryRef: string) => Promise<void>;
  onWorktreeIdentity?: (worktreeId: string, preservedHead: string) => Promise<void>;
  priorDeletionIntent?: { worktreeId: string; intentAt: string };
  onDeletionIntent?: (
    worktreeId: string,
    preservedHead: string,
    intentAt: string,
  ) => Promise<void>;
}

async function removeSupacodeWorktreeResource(
  pi: ExtensionAPI,
  worktreeId: string,
  priorIntentAt?: string,
  onDeletionIntent?: (intentAt: string) => Promise<void>,
): Promise<SupacodeWorktreeRemovalOutcome> {
  const verifyAbsence = async (): Promise<string | undefined> => {
    let consecutiveAbsence = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const presence = await observeSupacodeWorktree(pi, worktreeId, { timeoutMs: GIT_TIMEOUT_MS });
      if (presence === "absent") {
        consecutiveAbsence++;
        if (consecutiveAbsence >= 2) return new Date().toISOString();
      } else {
        consecutiveAbsence = 0;
      }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return undefined;
  };

  if (priorIntentAt) {
    const verifiedAt = await verifyAbsence();
    return verifiedAt
      ? { removed: true, intentAt: priorIntentAt, verifiedAt }
      : {
          removed: false,
          intentAt: priorIntentAt,
          error: "A prior Supacode worktree-deletion intent remains unsettled; deletion was not reissued.",
        };
  }

  let previousPresence: SupacodeResourcePresence | undefined;
  let confirmedPresent = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const presence = await observeSupacodeWorktree(pi, worktreeId, { timeoutMs: GIT_TIMEOUT_MS });
    if (presence !== "unknown" && presence === previousPresence) {
      if (presence === "absent") {
        return { removed: true, verifiedAt: new Date().toISOString() };
      }
      confirmedPresent = true;
      break;
    }
    previousPresence = presence === "unknown" ? undefined : presence;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!confirmedPresent) {
    return {
      removed: false,
      error: "Could not establish stable Supacode worktree presence; destructive deletion was not issued.",
    };
  }
  if (!onDeletionIntent) {
    return {
      removed: false,
      error: "Supacode worktree-deletion intent could not be made durable; destructive deletion was not issued.",
    };
  }

  const intentAt = new Date().toISOString();
  try {
    await onDeletionIntent(intentAt);
  } catch (error) {
    return {
      removed: false,
      error: `Supacode worktree-deletion intent could not be made durable; destructive deletion was not issued: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const deleted = await pi.exec(
    "supacode",
    ["worktree", "delete", "-w", worktreeId],
    { timeout: SUPACODE_DELETE_TIMEOUT_MS },
  );
  const verifiedAt = await verifyAbsence();
  if (verifiedAt) return { removed: true, intentAt, verifiedAt };
  return {
    removed: false,
    intentAt,
    error: deleted.code === 0
      ? "Supacode acknowledged worktree deletion, but resource absence was not verified."
      : diagnosticText(deleted),
  };
}

async function cleanupAppliedWorktree(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  protocol: AppliedWorktreeCleanupProtocol = {},
): Promise<HandoffCleanupResult> {
  const errors: string[] = [];
  const removeSupacodeResource = async (
    worktreeId: string,
    preservedHead: string,
  ): Promise<SupacodeWorktreeRemovalOutcome> => {
    if (
      protocol.priorDeletionIntent &&
      protocol.priorDeletionIntent.worktreeId !== worktreeId
    ) {
      return {
        removed: false,
        intentAt: protocol.priorDeletionIntent.intentAt,
        error: "Durable Supacode worktree-deletion intent does not match the authenticated cleanup identity; deletion was refused.",
      };
    }
    const onDeletionIntent = protocol.onDeletionIntent;
    return removeSupacodeWorktreeResource(
      pi,
      worktreeId,
      protocol.priorDeletionIntent?.intentAt,
      onDeletionIntent
        ? async (intentAt) => onDeletionIntent(worktreeId, preservedHead, intentAt)
        : undefined,
    );
  };
  const removalMetadata = (
    outcome: SupacodeWorktreeRemovalOutcome,
  ): Pick<
    HandoffCleanupResult,
    "supacodeWorktreeDeletionIntentAt" | "supacodeWorktreeDeletionVerifiedAt"
  > => ({
    ...(outcome.intentAt ? { supacodeWorktreeDeletionIntentAt: outcome.intentAt } : {}),
    ...("verifiedAt" in outcome
      ? { supacodeWorktreeDeletionVerifiedAt: outcome.verifiedAt }
      : {}),
  });
  const backup = await createBranchBackup(pi, prepared);
  if (!backup.ref) {
    if (backup.error) errors.push(backup.error);
    return { paneClosed: false, worktreeRemoved: false, branchPreserved: false, errors };
  }
  if (protocol.onRecoveryRef) {
    try {
      await protocol.onRecoveryRef(backup.ref);
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
    const backupHeadResult = await gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", backup.ref]);
    const backupHead = backupHeadResult.code === 0 ? backupHeadResult.stdout.trim() : prepared.sourceHead;
    const removedBySupacode = await removeSupacodeResource(
      prepared.job.codeWorktreeId,
      backupHead,
    );
    if (!removedBySupacode.removed) {
      errors.push(`Supacode resource cleanup failed: ${removedBySupacode.error}`);
    }
    const branch = await restoreWorkerBranch(
      pi,
      prepared,
      backup.ref,
      backupHead,
      true,
    );
    if (branch.error) errors.push(branch.error);
    return {
      paneClosed: true,
      worktreeRemoved: true,
      branchPreserved: branch.preserved,
      recoveryRef: branch.preserved && !branch.error ? undefined : backup.ref,
      preservedHead: backupHead,
      worktreeId: prepared.job.codeWorktreeId,
      ...removalMetadata(removedBySupacode),
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
    let authenticatedPreservation = currentHead === prepared.sourceHead;
    if (!authenticatedPreservation && currentTree === prepared.sourceTree) {
      const [parent, backupHead, branchHead] = await Promise.all([
        gitResult(pi, prepared.targetRoot, ["rev-parse", `${currentHead}^`]),
        gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", backup.ref]),
        gitResult(pi, prepared.targetRoot, ["rev-parse", "--verify", `refs/heads/${prepared.job.branch}`]),
      ]);
      authenticatedPreservation = parent.code === 0 && parent.stdout.trim() === prepared.sourceHead &&
        backupHead.code === 0 && backupHead.stdout.trim() === currentHead &&
        branchHead.code === 0 && branchHead.stdout.trim() === currentHead;
    }
    if (!authenticatedPreservation || currentTree !== prepared.sourceTree) {
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
  if (protocol.onWorktreeIdentity) {
    try {
      await protocol.onWorktreeIdentity(identity.id, preservation.head);
    } catch (error) {
      errors.push(`Cleanup stopped because worktree-removal intent could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      errors.push(`Worker recovery ref retained at ${backup.ref}.`);
      return { ...retained(true, preservation.head), worktreeId: identity.id };
    }
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

  const removedBySupacode = await removeSupacodeResource(identity.id, preservation.head);
  if (!removedBySupacode.removed) {
    errors.push(`Worker files were removed safely, but Supacode resource cleanup failed: ${removedBySupacode.error}`);
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
    worktreeId: identity.id,
    ...removalMetadata(removedBySupacode),
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
  const applyProcess = {
    jobDir: path.join(finalDir, "apply-process"),
    jobId: `${prepared.id}-apply`,
    launchNonce: randomUUID(),
  } satisfies ApplyProcessIntent;
  await recordValidationGateIntent(
    applyProcess.jobDir,
    applyProcess.jobId,
    applyProcess.launchNonce,
  );
  await writeManifest(manifestPath, manifestFor(prepared, "applying"));
  await writeDestinationTransaction(prepared, manifestPath, "applying", baseline, undefined, applyProcess);
  const applyIndexPath = path.join(finalDir, "destination-apply.index");
  await atomicWrite(applyIndexPath, await fs.promises.readFile(baseline.indexBackupPath));
  let applied: CommandResult;
  try {
    const applyResult = await runValidationProcess({
      command: [
        `GIT_INDEX_FILE=${shellQuote(applyIndexPath)}`,
        "git",
        "-C",
        shellQuote(prepared.targetRoot),
        "apply",
        "--3way",
        "--index",
        "--binary",
        shellQuote(patchPath),
      ].join(" "),
      cwd: prepared.targetRoot,
      logPath: path.join(applyProcess.jobDir, "apply.log"),
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
      maxLogBytes: 5 * 1024 * 1024,
      tailBytes: MAX_DIAGNOSTIC_LENGTH,
      processLifecycle: applyProcess,
    });
    applied = {
      stdout: applyResult.outputTail,
      stderr: "",
      code: applyResult.exitCode,
      timedOut: applyResult.timedOut,
    };
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
  let conflictIndexIntent: ConflictIndexIntent | undefined;
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
      const conflictIndex = await fs.promises.readFile(applyIndexPath);
      conflictIndexIntent = {
        path: applyIndexPath,
        sha256: createHash("sha256").update(conflictIndex).digest("hex"),
        phase: "pending",
      };
      state = "conflicted";
      transactionState = "conflicted";
      diagnostic = applyOutput || undefined;
      const conflictApply = { appliedPaths, conflictedPaths, blockedPaths: [], diagnostic };
      await writeManifest(manifestPath, manifestFor(prepared, state, conflictApply, emptyCleanup));
      await writeDestinationTransaction(
        prepared,
        manifestPath,
        transactionState,
        baseline,
        diagnostic,
        undefined,
        conflictIndexIntent,
      );
      await (pi as ExtensionAPIWithHandoffTestHook).__beforeConflictIndexPublicationForTests?.();
      await replaceDestinationIndex(baseline, conflictIndex);
      conflictIndexIntent = { ...conflictIndexIntent, phase: "published" };
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
    if (conflictIndexIntent) {
      state = "conflicted";
      transactionState = "conflicted";
      diagnostic = [
        `Conflict-index publication was interrupted: ${error instanceof Error ? error.message : String(error)}`,
        "The authenticated conflict index remains journaled for conservative recovery.",
      ].join("\n");
    } else {
      const rollback = await rollbackDestination(pi, prepared, baseline, finalDir);
      state = rollback.rolledBack ? "failed" : "indeterminate";
      transactionState = rollback.rolledBack ? "rolled_back" : "indeterminate";
      appliedPaths = [];
      diagnostic = [
        `Apply result collection or postcondition verification failed: ${error instanceof Error ? error.message : String(error)}`,
        rollback.rolledBack ? "Destination was rolled back to its exact baseline." : rollback.diagnostic,
      ].filter(Boolean).join("\n");
    }
  }

  const apply = { appliedPaths, conflictedPaths, blockedPaths: [], diagnostic };
  await writeManifest(manifestPath, manifestFor(prepared, state, apply, emptyCleanup));
  await writeDestinationTransaction(
    prepared,
    manifestPath,
    transactionState,
    baseline,
    diagnostic,
    undefined,
    conflictIndexIntent,
  );
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
  let cleanupRecoveryRef: string | undefined;
  let deletionIntent: { worktreeId: string; preservedHead: string; intentAt: string } | undefined;
  try {
    cleanupResult = await cleanupAppliedWorktree(pi, prepared, {
      onRecoveryRef: async (recoveryRef) => {
        cleanupRecoveryRef = recoveryRef;
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
      },
      onWorktreeIdentity: async (worktreeId, preservedHead) => {
        const pendingRemoval: HandoffCleanupResult = {
          paneClosed: true,
          worktreeRemoved: false,
          branchPreserved: true,
          recoveryRef: cleanupRecoveryRef,
          preservedHead,
          worktreeId,
          errors: ["Worktree removal pending; exact source identity is durable."],
        };
        await writeManifest(
          result.manifestPath,
          manifestFor(prepared, "applied", apply, pendingRemoval),
        );
      },
      onDeletionIntent: async (worktreeId, preservedHead, intentAt) => {
        const pendingDeletion: HandoffCleanupResult = {
          paneClosed: true,
          worktreeRemoved: true,
          branchPreserved: true,
          recoveryRef: cleanupRecoveryRef,
          preservedHead,
          worktreeId,
          supacodeWorktreeDeletionIntentAt: intentAt,
          errors: ["Supacode worktree deletion may have started; absence verification is pending."],
        };
        await writeManifest(
          result.manifestPath,
          manifestFor(prepared, "applied", apply, pendingDeletion),
        );
        deletionIntent = { worktreeId, preservedHead, intentAt };
      },
    });
  } catch (error) {
    cleanupResult = {
      paneClosed: false,
      worktreeRemoved: false,
      branchPreserved: false,
      errors: [`Cleanup ended unexpectedly; inspect the source worktree: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (deletionIntent && !cleanupResult.supacodeWorktreeDeletionIntentAt) {
    cleanupResult = {
      ...cleanupResult,
      paneClosed: true,
      worktreeRemoved: true,
      branchPreserved: true,
      recoveryRef: cleanupRecoveryRef,
      preservedHead: deletionIntent.preservedHead,
      worktreeId: deletionIntent.worktreeId,
      supacodeWorktreeDeletionIntentAt: deletionIntent.intentAt,
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

async function preparedFromAppliedManifest(
  manifestPath: string,
): Promise<{ prepared: PreparedDelegateHandoff; manifest: HandoffManifest } | undefined> {
  const manifestRecord = await readJsonRecord(manifestPath);
  if (!manifestRecord || stringValue(manifestRecord, "state") !== "applied") return undefined;
  const source = isRecord(manifestRecord.source) ? manifestRecord.source : undefined;
  const destination = isRecord(manifestRecord.destination) ? manifestRecord.destination : undefined;
  const patch = isRecord(manifestRecord.patch) ? manifestRecord.patch : undefined;
  const id = stringValue(manifestRecord, "id");
  const sourceRoot = source && stringValue(source, "root");
  const sourceHead = source && stringValue(source, "head");
  const sourceTree = source && stringValue(source, "tree");
  const sourceStatus = source && typeof source.status === "string" ? source.status : undefined;
  const baseSha = source && stringValue(source, "baseSha");
  const targetRoot = destination && stringValue(destination, "root");
  const targetGitDir = destination && stringValue(destination, "gitDir");
  const targetCommonGitDir = destination && stringValue(destination, "commonGitDir");
  const targetHead = destination && stringValue(destination, "head");
  const patchSha256 = patch && stringValue(patch, "sha256");
  const patchBytes = patch?.bytes;
  const touchedPaths = patch?.touchedPaths;
  const finalDir = path.dirname(manifestPath);
  const jobDir = path.dirname(path.dirname(finalDir));
  const job = await parseStoredJob(jobDir);
  if (
    !id || !job || stringValue(manifestRecord, "jobId") !== job.id ||
    !sourceRoot || !sourceHead || !sourceTree || sourceStatus === undefined || !baseSha ||
    !targetRoot || !targetGitDir || !targetCommonGitDir || !targetHead || !patchSha256 ||
    typeof patchBytes !== "number" || !Number.isSafeInteger(patchBytes) || patchBytes < 0 ||
    !Array.isArray(touchedPaths) || touchedPaths.some((value) => typeof value !== "string")
  ) return undefined;
  const prepared = {
    id,
    job,
    draftDir: finalDir,
    draftPatchPath: path.join(finalDir, "changes.patch"),
    sourceRoot,
    sourceHead,
    sourceTree,
    sourceStatus,
    baseSha,
    baseIsAncestor: true,
    targetRoot,
    targetGitDir,
    targetCommonGitDir,
    targetHead,
    targetBranch: destination && stringValue(destination, "branch"),
    targetStatus: "",
    patchSha256,
    patchBytes,
    touchedPaths: touchedPaths as string[],
    blockers: [],
    warnings: [],
    createdAt: stringValue(manifestRecord, "createdAt") ?? new Date().toISOString(),
  } satisfies PreparedDelegateHandoff;
  return { prepared, manifest: manifestRecord as unknown as HandoffManifest };
}

async function recoverAppliedHandoffCleanup(
  pi: ExtensionAPI,
  manifestPath: string,
  destinationRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const reconstructed = await preparedFromAppliedManifest(manifestPath);
  if (!reconstructed) return "applied handoff cleanup metadata is incomplete; manual recovery required.";
  const { prepared, manifest } = reconstructed;
  const [observedGitDir, observedCommonGitDir, observedHead, observedBranch] = await Promise.all([
    canonicalGitDir(pi, destinationRoot, signal),
    canonicalCommonGitDir(pi, destinationRoot, signal),
    gitOutput(pi, destinationRoot, ["rev-parse", "HEAD"], signal),
    currentBranch(pi, destinationRoot, signal),
  ]);
  if (
    prepared.targetRoot !== destinationRoot || prepared.targetGitDir !== observedGitDir ||
    prepared.targetCommonGitDir !== observedCommonGitDir || prepared.targetHead !== observedHead ||
    prepared.targetBranch !== observedBranch
  ) return "destination identity changed; applied handoff cleanup was not resumed.";
  const cleanupRecord = isRecord(manifest.cleanup) ? manifest.cleanup : undefined;
  let durableWorktreeId = cleanupRecord && stringValue(cleanupRecord, "worktreeId");
  let durablePreservedHead = cleanupRecord && stringValue(cleanupRecord, "preservedHead");
  let durableDeletionIntentAt = cleanupRecord && stringValue(
    cleanupRecord,
    "supacodeWorktreeDeletionIntentAt",
  );
  let durableDeletionVerifiedAt = cleanupRecord && stringValue(
    cleanupRecord,
    "supacodeWorktreeDeletionVerifiedAt",
  );
  if (
    manifest.cleanup?.paneClosed && manifest.cleanup.worktreeRemoved &&
    manifest.cleanup.branchPreserved && !manifest.cleanup.recoveryRef &&
    manifest.cleanup.errors.length === 0 &&
    (!durableDeletionIntentAt || durableDeletionVerifiedAt)
  ) return "applied handoff cleanup is already complete.";
  const apply = manifest.apply ?? {
    appliedPaths: prepared.touchedPaths,
    conflictedPaths: [],
    blockedPaths: [],
  };
  const durableDeletionMetadata = (): Partial<HandoffCleanupResult> => ({
    ...(durableWorktreeId ? { worktreeId: durableWorktreeId } : {}),
    ...(durablePreservedHead ? { preservedHead: durablePreservedHead } : {}),
    ...(durableDeletionIntentAt
      ? { supacodeWorktreeDeletionIntentAt: durableDeletionIntentAt }
      : {}),
    ...(durableDeletionVerifiedAt
      ? { supacodeWorktreeDeletionVerifiedAt: durableDeletionVerifiedAt }
      : {}),
  });
  let recoveryRef = manifest.cleanup?.recoveryRef;
  let cleanup = await cleanupAppliedWorktree(pi, prepared, {
    priorDeletionIntent: durableWorktreeId && durableDeletionIntentAt
      ? { worktreeId: durableWorktreeId, intentAt: durableDeletionIntentAt }
      : undefined,
    onRecoveryRef: async (nextRecoveryRef) => {
      recoveryRef = nextRecoveryRef;
      await writeManifest(
        manifestPath,
        manifestFor(prepared, "applied", apply, {
          paneClosed: false,
          worktreeRemoved: false,
          branchPreserved: true,
          recoveryRef: nextRecoveryRef,
          ...durableDeletionMetadata(),
          errors: ["Cleanup recovery is in progress."],
        }),
      );
    },
    onWorktreeIdentity: async (worktreeId, preservedHead) => {
      if (durableDeletionIntentAt && durableWorktreeId !== worktreeId) {
        throw new Error("Durable Supacode worktree-deletion intent does not match the recovered cleanup identity.");
      }
      durableWorktreeId = worktreeId;
      durablePreservedHead = preservedHead;
      await writeManifest(
        manifestPath,
        manifestFor(prepared, "applied", apply, {
          paneClosed: true,
          worktreeRemoved: false,
          branchPreserved: true,
          recoveryRef,
          ...durableDeletionMetadata(),
          errors: ["Worktree removal recovery is in progress."],
        }),
      );
    },
    onDeletionIntent: async (worktreeId, preservedHead, intentAt) => {
      if (durableDeletionIntentAt) {
        throw new Error("A durable Supacode worktree-deletion intent already exists; deletion was not reissued.");
      }
      await writeManifest(
        manifestPath,
        manifestFor(prepared, "applied", apply, {
          paneClosed: true,
          worktreeRemoved: true,
          branchPreserved: true,
          recoveryRef,
          preservedHead,
          worktreeId,
          supacodeWorktreeDeletionIntentAt: intentAt,
          errors: ["Supacode worktree deletion may have started; absence verification is pending."],
        }),
      );
      durableWorktreeId = worktreeId;
      durablePreservedHead = preservedHead;
      durableDeletionIntentAt = intentAt;
    },
  });
  if (durableDeletionIntentAt && !cleanup.supacodeWorktreeDeletionIntentAt) {
    cleanup = {
      ...cleanup,
      paneClosed: true,
      worktreeRemoved: true,
      branchPreserved: true,
      recoveryRef,
      ...durableDeletionMetadata(),
    };
  }
  if (cleanup.supacodeWorktreeDeletionVerifiedAt) {
    durableDeletionVerifiedAt = cleanup.supacodeWorktreeDeletionVerifiedAt;
  }
  await writeManifest(manifestPath, manifestFor(prepared, "applied", apply, cleanup));
  return cleanup.paneClosed && cleanup.worktreeRemoved && cleanup.branchPreserved && cleanup.errors.length === 0
    ? "applied handoff cleanup recovered."
    : `applied handoff cleanup remains incomplete: ${cleanup.errors.join(" ") || "unknown cleanup state"}`;
}

async function transactionApplyProcessAbsent(
  record: Record<string, unknown>,
): Promise<boolean> {
  const processRecord = isRecord(record.applyProcess) ? record.applyProcess : undefined;
  const jobDir = processRecord && stringValue(processRecord, "jobDir");
  const jobId = processRecord && stringValue(processRecord, "jobId");
  const launchNonce = processRecord && stringValue(processRecord, "launchNonce");
  if (!jobDir || !jobId || !launchNonce || !path.isAbsolute(jobDir)) return false;
  const runner = await readRunnerProcess(jobDir);
  if (!runner) return validationGateProvesCommandNeverLaunched(jobDir, jobId, launchNonce);
  if (
    runner.jobId !== jobId || runner.launchNonce !== launchNonce ||
    runner.wrapper.launchNonce !== launchNonce
  ) return false;
  const state = await inspectProcessIdentity(runner.wrapper);
  if (state === "alive" || state === "unknown") return false;
  try {
    process.kill(-runner.wrapper.processGroup, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function recoverDelegateApplyState(
  pi: ExtensionAPI,
  destinationCwd: string,
  signal?: AbortSignal,
  acceptResolvedConflicts = false,
): Promise<{ recovered: boolean; message: string; transactions: string[] }> {
  const root = await canonicalGitRoot(pi, destinationCwd, signal);
  const gitDir = await canonicalGitDir(pi, root, signal);
  const lock = await recoverStaleDestinationApplyLock(gitDir, async (lockRecord) => {
    const transaction = await readJsonRecordStrictOptional(path.join(
      destinationApplyStateDir(gitDir),
      "transactions",
      lockRecord.handoffId,
      "transaction.json",
    ));
    if (!transaction) return true;
    const transactionState = stringValue(transaction, "state");
    if (!transactionState) {
      throw new Error("Destination transaction state is missing; lock recovery was refused.");
    }
    return transactionState !== "applying"
      ? true
      : transactionApplyProcessAbsent(transaction);
  });
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
      let record = await readJsonRecord(transactionPath);
      if (!record) {
        transactions.push(`${entry.name}: corrupt transaction metadata; manual recovery required.`);
        continue;
      }
      let state = stringValue(record, "state");
      if (state === "applied") {
        const manifestPath = stringValue(record, "jobManifestPath");
        transactions.push(manifestPath
          ? `${entry.name}: ${await recoverAppliedHandoffCleanup(pi, manifestPath, root, signal)}`
          : `${entry.name}: applied transaction has no job-local manifest; manual cleanup required.`);
        continue;
      }
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
      const transactionJobId = stringValue(record, "jobId");
      if (
        !expectedRoot || !expectedGitDir || !expectedCommonGitDir || !expectedHead ||
        !baselineTree || !indexPath || !indexSha256 || !jobManifestPath || !transactionJobId
      ) {
        transactions.push(`${entry.name}: malformed recovery evidence; no state changed.`);
        continue;
      }
      const [observedGitDir, observedCommonGitDir, observedHead, observedBranch, observedIndexOutput] = await Promise.all([
        canonicalGitDir(pi, root, signal),
        canonicalCommonGitDir(pi, root, signal),
        gitOutput(pi, root, ["rev-parse", "HEAD"], signal),
        currentBranch(pi, root, signal),
        gitOutput(pi, root, ["rev-parse", "--git-path", "index"], signal),
      ]);
      const observedIndexPath = path.resolve(root, observedIndexOutput);
      if (
        expectedRoot !== root || expectedGitDir !== observedGitDir ||
        expectedCommonGitDir !== observedCommonGitDir || expectedHead !== observedHead ||
        expectedBranch !== observedBranch || indexPath !== observedIndexPath
      ) {
        transactions.push(`${entry.name}: destination identity, HEAD, branch, or index path mismatch; no state changed.`);
        continue;
      }
      if (state === "applying" && !await transactionApplyProcessAbsent(record)) {
        transactions.push(`${entry.name}: apply process absence is not verified; destination classification was deferred.`);
        continue;
      }
      const transactionDir = path.join(transactionsDir, entry.name);
      const interruptedApplyIndexPath = path.join(path.dirname(jobManifestPath), "destination-apply.index");
      if (state === "applying") {
        const interruptedIndexExists = await pathExists(interruptedApplyIndexPath);
        const interruptedConflicts = interruptedIndexExists
          ? parseNulPaths(await gitStdout(
              pi,
              root,
              ["diff", "--name-only", "--diff-filter=U", "-z"],
              signal,
              interruptedApplyIndexPath,
            ))
          : parseNulPaths(await gitStdout(
              pi,
              root,
              ["diff", "--name-only", "--diff-filter=U", "-z"],
              signal,
            ));
        if (interruptedConflicts.length > 0) {
          const conflictIndex = await fs.promises.readFile(
            interruptedIndexExists ? interruptedApplyIndexPath : indexPath,
          );
          if (!interruptedIndexExists) await atomicWrite(interruptedApplyIndexPath, conflictIndex);
          const conflictIndexIntent: ConflictIndexIntent = {
            path: interruptedApplyIndexPath,
            sha256: createHash("sha256").update(conflictIndex).digest("hex"),
            phase: "pending",
          };
          const recoveryDiagnostic = "Interrupted apply was recovered as conflicted from its durable unmerged index.";
          const jobManifest = await readJsonRecord(jobManifestPath);
          if (
            !jobManifest || stringValue(jobManifest, "id") !== entry.name ||
            stringValue(jobManifest, "jobId") !== stringValue(record, "jobId")
          ) {
            transactions.push(`${entry.name}: job-local manifest identity mismatch; no state changed.`);
            continue;
          }
          record = {
            ...record,
            state: "conflicted",
            updatedAt: new Date().toISOString(),
            diagnostic: recoveryDiagnostic,
            conflictIndex: conflictIndexIntent,
          };
          await atomicWrite(transactionPath, `${JSON.stringify(record, null, 2)}\n`);
          await atomicWrite(
            jobManifestPath,
            `${JSON.stringify({
              ...jobManifest,
              state: "conflicted",
              updatedAt: new Date().toISOString(),
              apply: {
                ...(isRecord(jobManifest.apply) ? jobManifest.apply : {}),
                conflictedPaths: uniqueSortedPaths(interruptedConflicts),
                diagnostic: recoveryDiagnostic,
              },
            }, null, 2)}\n`,
          );
          state = "conflicted";
        }
      }
      if (state === "conflicted" && isRecord(record.conflictIndex)) {
        const conflictJobManifest = await readJsonRecord(jobManifestPath);
        if (
          !conflictJobManifest || stringValue(conflictJobManifest, "id") !== entry.name ||
          stringValue(conflictJobManifest, "jobId") !== stringValue(record, "jobId")
        ) {
          transactions.push(`${entry.name}: job-local manifest identity mismatch; no state changed.`);
          continue;
        }
        const conflictIndexPath = stringValue(record.conflictIndex, "path");
        const conflictIndexSha256 = stringValue(record.conflictIndex, "sha256");
        const conflictIndexPhase = stringValue(record.conflictIndex, "phase");
        if (
          !conflictIndexPath || conflictIndexPath !== interruptedApplyIndexPath ||
          !conflictIndexSha256 ||
          (conflictIndexPhase !== "pending" && conflictIndexPhase !== "published" &&
            conflictIndexPhase !== "superseded")
        ) {
          transactions.push(`${entry.name}: malformed conflict-index publication intent; no state changed.`);
          continue;
        }
        if (conflictIndexPhase === "pending") {
          const prepublicationTree = await snapshotWorktreeTree(
            pi,
            root,
            observedHead,
            path.join(transactionDir, "prepublication-recovery.index"),
            signal,
          );
          const prepublicationIndexSha256 = createHash("sha256")
            .update(await fs.promises.readFile(indexPath))
            .digest("hex");
          const alreadyClassifiable =
            (prepublicationTree === baselineTree && prepublicationIndexSha256 === indexSha256) ||
            (expectedTree !== undefined && prepublicationTree === expectedTree && prepublicationIndexSha256 === indexSha256);
          if (alreadyClassifiable) {
            // A user reset or completed result takes precedence over an interrupted index publication.
          } else {
          const conflictIndex = await fs.promises.readFile(conflictIndexPath);
          const observedSha256 = createHash("sha256").update(conflictIndex).digest("hex");
          if (observedSha256 !== conflictIndexSha256) {
            transactions.push(`${entry.name}: conflict index authentication failed; no state changed.`);
            continue;
          }
          const destinationIndexSha256 = createHash("sha256")
            .update(await fs.promises.readFile(indexPath))
            .digest("hex");
          let completedConflictIndex: ConflictIndexIntent;
          if (destinationIndexSha256 !== conflictIndexSha256 && destinationIndexSha256 !== indexSha256) {
            completedConflictIndex = {
              path: conflictIndexPath,
              sha256: conflictIndexSha256,
              phase: "superseded",
              supersededByIndexSha256: destinationIndexSha256,
            };
          } else {
            if (destinationIndexSha256 === indexSha256) {
              await replaceDestinationIndex({
                indexPath,
                indexBackupPath: "",
                indexSha256,
                tree: baselineTree,
                expectedTree,
              }, conflictIndex);
            }
            completedConflictIndex = {
              path: conflictIndexPath,
              sha256: conflictIndexSha256,
              phase: "published",
            };
          }
          record = {
            ...record,
            updatedAt: new Date().toISOString(),
            conflictIndex: completedConflictIndex,
          };
          await atomicWrite(transactionPath, `${JSON.stringify(record, null, 2)}\n`);
          }
        }
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
      if (state === "conflicted" && !recoveredState) {
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
        const resolutionIntentPath = path.join(transactionsDir, entry.name, "conflict-resolution.json");
        const jobManifest = await readJsonRecord(jobManifestPath);
        if (
          !jobManifest || stringValue(jobManifest, "id") !== entry.name ||
          stringValue(jobManifest, "jobId") !== transactionJobId
        ) {
          transactions.push(`${entry.name}: job-local manifest identity mismatch; no state changed.`);
          continue;
        }
        let existingResolutionIntent: Record<string, unknown> | undefined;
        try {
          existingResolutionIntent = await readJsonRecordStrictOptional(resolutionIntentPath);
        } catch {
          transactions.push(`${entry.name}: conflict-resolution intent is corrupt or unreadable; no state changed.`);
          continue;
        }
        if (existingResolutionIntent) {
          if (
            existingResolutionIntent.version !== 1 ||
            stringValue(existingResolutionIntent, "id") !== entry.name ||
            stringValue(existingResolutionIntent, "jobId") !== transactionJobId ||
            stringValue(existingResolutionIntent, "tree") !== currentTree ||
            stringValue(existingResolutionIntent, "indexSha256") !== currentIndexSha256 ||
            !stringValue(existingResolutionIntent, "confirmedAt")
          ) {
            transactions.push(`${entry.name}: conflict-resolution intent does not match the current tree and index; no state changed.`);
            continue;
          }
        } else {
          if (!acceptResolvedConflicts) {
            transactions.push(`${entry.name}: conflict resolution requires explicit confirmation; no state changed.`);
            continue;
          }
          await atomicWrite(
            resolutionIntentPath,
            `${JSON.stringify({
              version: 1,
              id: entry.name,
              jobId: transactionJobId,
              tree: currentTree,
              indexSha256: currentIndexSha256,
              confirmedAt: new Date().toISOString(),
            }, null, 2)}\n`,
          );
        }
        const recoveryDiagnostic = "Manual conflict resolution was explicitly confirmed and bound to the observed tree and index.";
        await atomicWrite(
          jobManifestPath,
          `${JSON.stringify({
            ...jobManifest,
            state: "resolved",
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
            resolutionIntentPath,
          }, null, 2)}\n`,
        );
        transactions.push(`${entry.name}: resolved by explicit confirmation.`);
        continue;
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
      if (recoveredState === "applied") {
        transactions.push(
          `${entry.name}: applied; ${await recoverAppliedHandoffCleanup(pi, jobManifestPath, root, signal)}`,
        );
      } else {
        transactions.push(`${entry.name}: ${recoveredState}.`);
      }
    }
    return { ...lock, transactions };
  } finally {
    await releaseDestinationApplyLock(recoveryLock);
  }
}
