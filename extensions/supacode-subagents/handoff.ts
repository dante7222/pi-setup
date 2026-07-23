import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  decodeSupacodeResourceId,
  sameSupacodeUuid,
} from "./resource-id.ts";

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
  createdAt?: string;
  delegateLoop: boolean;
  loopState?: string;
  acceptedTree?: string;
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

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporaryPath, filePath);
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
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, options.timeout);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: timedOut ? 124 : code ?? 1,
        timedOut,
      });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && !settled) {
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        child.kill("SIGTERM");
        reject(error);
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
  if (!record || stringValue(record, "mode") !== "coding") return undefined;

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
  if (
    !id || !batchId || !batchTitle || !title || !originalCwd || !worktreePath ||
    !branch || !baseSha || !tabWorktreeId || !codeWorktreeId || !tabId || !surfaceId ||
    !UUID_PATTERN.test(id) || !UUID_PATTERN.test(batchId) || !UUID_PATTERN.test(tabId) ||
    !UUID_PATTERN.test(surfaceId) || !OBJECT_ID_PATTERN.test(baseSha) ||
    !path.isAbsolute(originalCwd) || !path.isAbsolute(worktreePath)
  ) {
    return undefined;
  }
  const expectedBranch = `pi-agent/${batchId.slice(0, 6).toLowerCase()}/${id.slice(0, 6).toLowerCase()}`;
  if (branch !== expectedBranch) return undefined;

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
    createdAt: stringValue(record, "createdAt"),
    delegateLoop: booleanValue(record, "delegateLoop"),
    loopState: stringValue(record, "loopState"),
    acceptedTree: stringValue(record, "acceptedTree"),
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
  await fs.promises.rm(indexPath, { force: true });
  try {
    await gitOutput(pi, root, ["read-tree", head], signal, indexPath);
    await gitOutput(pi, root, ["add", "-A", "--", "."], signal, indexPath);
    return await gitOutput(pi, root, ["write-tree"], signal, indexPath);
  } finally {
    await fs.promises.rm(indexPath, { force: true });
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
  jobDir: string,
  patchSha256: string,
  targetRoot: string,
): Promise<boolean> {
  const handoffsDir = path.join(jobDir, "handoffs");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(handoffsDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJsonRecord(path.join(handoffsDir, entry.name, "manifest.json"));
    if (!manifest) continue;
    const patchRecord = isRecord(manifest.patch) ? manifest.patch : undefined;
    const destinationRecord = isRecord(manifest.destination) ? manifest.destination : undefined;
    const state = stringValue(manifest, "state");
    if (
      (state === "applying" || state === "applied" || state === "conflicted" || state === "indeterminate") &&
      patchRecord && stringValue(patchRecord, "sha256") === patchSha256 &&
      destinationRecord && stringValue(destinationRecord, "root") === targetRoot
    ) {
      return true;
    }
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

  const [sourceCommonDir, targetCommonDir, sourceBranch, listedWorktrees] = await Promise.all([
    canonicalCommonGitDir(pi, sourceRoot, signal),
    canonicalCommonGitDir(pi, targetRoot, signal),
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
      if (!job.acceptedTree || !OBJECT_ID_PATTERN.test(job.acceptedTree)) {
        throw new Error("Accepted delegate loop is missing a valid reviewed tree identity.");
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

    const [sourceStatus, targetHead, targetBranch, targetStatus, targetDirtyPaths, operationBlockers] = await Promise.all([
      gitOutput(pi, sourceRoot, ["status", "--short"], signal),
      gitOutput(pi, targetRoot, ["rev-parse", "HEAD"], signal),
      currentBranch(pi, targetRoot, signal),
      gitOutput(pi, targetRoot, ["status", "--short"], signal),
      statusPaths(pi, targetRoot, signal),
      repositoryOperationBlockers(pi, targetRoot, signal),
    ]);
    const blockedPaths = overlappingDirtyPaths(touchedPaths, targetDirtyPaths);
    const blockers = [...operationBlockers];
    if (blockedPaths.length > 0) {
      blockers.push(`Destination changes overlap the patch: ${blockedPaths.map(displayPath).join(", ")}`);
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
    if (await priorSnapshotApplied(job.jobDir, patchSha256, targetRoot)) {
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

async function currentPreflightBlockers(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  signal?: AbortSignal,
): Promise<{ blockers: string[]; blockedPaths: string[] }> {
  const [destinationBlockers, sourceBlockers] = await Promise.all([
    repositoryOperationBlockers(pi, prepared.targetRoot, signal),
    repositoryOperationBlockers(pi, prepared.sourceRoot, signal, "Source checkout"),
  ]);
  const blockers = [...destinationBlockers, ...sourceBlockers];
  const currentHead = await gitOutput(pi, prepared.targetRoot, ["rev-parse", "HEAD"], signal);
  const branch = await currentBranch(pi, prepared.targetRoot, signal);
  if (currentHead !== prepared.targetHead || branch !== prepared.targetBranch) {
    blockers.push("Destination HEAD or branch changed after the apply preview; run the command again.");
  }
  if (await priorSnapshotApplied(prepared.job.jobDir, prepared.patchSha256, prepared.targetRoot)) {
    blockers.push("This exact worker snapshot already has an active or applied handoff for this destination.");
  }
  const blockedPaths = overlappingDirtyPaths(
    prepared.touchedPaths,
    await statusPaths(pi, prepared.targetRoot, signal),
  );
  if (blockedPaths.length > 0) {
    blockers.push(`Destination changes overlap the patch: ${blockedPaths.map(displayPath).join(", ")}`);
  }
  return { blockers, blockedPaths };
}

async function unstagePaths(
  pi: ExtensionAPI,
  root: string,
  paths: string[],
  handoffDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (paths.length === 0) return;
  const pathspecPath = path.join(handoffDir, "applied-paths.pathspec");
  await fs.promises.writeFile(pathspecPath, `${paths.join("\0")}\0`, { encoding: "utf8", mode: 0o600 });
  const result = await gitResult(
    pi,
    root,
    ["reset", "--quiet", "HEAD", `--pathspec-from-file=${pathspecPath}`, "--pathspec-file-nul"],
    signal,
  );
  await fs.promises.rm(pathspecPath, { force: true });
  if (result.code !== 0) throw new Error(`Could not unstage applied paths: ${diagnosticText(result)}`);
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
  if (closed.code === 0) return { closed: true };

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
  return { closed: false, error: `Could not close worker pane: ${diagnosticText(closed)}` };
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
): Promise<HandoffCleanupResult> {
  const errors: string[] = [];
  const backup = await createBranchBackup(pi, prepared);
  if (!backup.ref) {
    if (backup.error) errors.push(backup.error);
    return { paneClosed: false, worktreeRemoved: false, branchPreserved: false, errors };
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

async function acquireApplyLock(jobDir: string): Promise<string> {
  const handoffsDir = path.join(jobDir, "handoffs");
  await fs.promises.mkdir(handoffsDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(handoffsDir, ".apply.lock");
  try {
    const handle = await fs.promises.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.close();
    return lockPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another apply is active or needs recovery. Inspect ${lockPath}.`);
    }
    throw error;
  }
}

async function applyPreparedDelegateHandoffUnlocked(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  signal: AbortSignal | undefined,
  cleanup: boolean,
): Promise<DelegateHandoffResult> {
  const finalDir = path.join(prepared.job.jobDir, "handoffs", prepared.id);
  await fs.promises.rename(prepared.draftDir, finalDir);
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

  await writeManifest(manifestPath, manifestFor(prepared, "applying"));
  let applied: CommandResult;
  try {
    applied = await commandWithInput(
      "git",
      ["-C", prepared.targetRoot, "apply", "--3way", "--index", "--binary", "-"],
      patchBuffer,
      { signal, timeout: GIT_TIMEOUT_MS },
    );
  } catch (error) {
    const diagnostic = `Git apply ended unexpectedly and the destination needs inspection: ${error instanceof Error ? error.message : String(error)}`;
    const apply = { appliedPaths: [], conflictedPaths: [], blockedPaths: [], diagnostic };
    try {
      await writeManifest(manifestPath, manifestFor(prepared, "indeterminate", apply, emptyCleanup));
    } catch {
      // The prepared and applying manifests remain as recovery evidence.
    }
    return {
      id: prepared.id,
      state: "indeterminate",
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
  try {
    conflictedPaths = uniqueSortedPaths(parseNulPaths(await gitStdout(
      pi,
      prepared.targetRoot,
      ["diff", "--name-only", "--diff-filter=U", "-z"],
      signal,
    )).filter((conflictedPath) =>
      prepared.touchedPaths.some((touchedPath) => delegatePathsOverlap(touchedPath, conflictedPath))));
    const dirtyAfterApply = await statusPaths(pi, prepared.targetRoot, signal);
    appliedPaths = prepared.touchedPaths.filter((touchedPath) =>
      dirtyAfterApply.some((dirtyPath) => delegatePathsOverlap(touchedPath, dirtyPath)));
    const cleanAppliedPaths = appliedPaths.filter((appliedPath) =>
      !conflictedPaths.some((conflictedPath) => delegatePathsOverlap(appliedPath, conflictedPath)));

    let resetError: string | undefined;
    try {
      await unstagePaths(pi, prepared.targetRoot, cleanAppliedPaths, finalDir, signal);
    } catch (error) {
      resetError = error instanceof Error ? error.message : String(error);
    }
    const applyOutput = (applied.stderr || applied.stdout).trim();
    const timeoutDiagnostic = applied.timedOut
      ? "Git apply timed out and the destination may be partially changed."
      : undefined;
    diagnostic = [applyOutput || undefined, timeoutDiagnostic, resetError].filter(Boolean).join("\n") || undefined;
    state = applied.timedOut || resetError
      ? "indeterminate"
      : conflictedPaths.length > 0
        ? "conflicted"
        : applied.code !== 0 && appliedPaths.length > 0
          ? "indeterminate"
          : applied.code === 0
            ? "applied"
            : "failed";
    const apply = { appliedPaths, conflictedPaths, blockedPaths: [], diagnostic };
    await writeManifest(manifestPath, manifestFor(prepared, state, apply, emptyCleanup));
  } catch (error) {
    state = "indeterminate";
    diagnostic = `Git changed the destination, but result collection failed: ${error instanceof Error ? error.message : String(error)}`;
    const apply = { appliedPaths, conflictedPaths, blockedPaths: [], diagnostic };
    try {
      await writeManifest(manifestPath, manifestFor(prepared, state, apply, emptyCleanup));
    } catch {
      // The applying manifest remains as recovery evidence.
    }
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

  const apply = { appliedPaths, conflictedPaths, blockedPaths: [], diagnostic };
  let cleanupResult = emptyCleanup;
  if (state === "applied" && cleanup) {
    const recoveryRef = workerRecoveryRef(prepared);
    const pendingCleanup: HandoffCleanupResult = {
      paneClosed: false,
      worktreeRemoved: false,
      branchPreserved: false,
      recoveryRef,
      errors: ["Cleanup pending; inspect the recovery ref and source worktree if this process stops."],
    };
    try {
      await writeManifest(manifestPath, manifestFor(prepared, state, apply, pendingCleanup));
    } catch (error) {
      cleanupResult = {
        ...emptyCleanup,
        errors: [`Cleanup was skipped because its recovery state could not be recorded: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    if (cleanupResult.errors.length === 0) {
      try {
        cleanupResult = await cleanupAppliedWorktree(pi, prepared);
      } catch (error) {
        cleanupResult = {
          paneClosed: false,
          worktreeRemoved: false,
          branchPreserved: false,
          recoveryRef,
          errors: [`Cleanup ended unexpectedly; inspect the recovery ref and source worktree: ${error instanceof Error ? error.message : String(error)}`],
        };
      }
    }
  }
  try {
    await writeManifest(manifestPath, manifestFor(prepared, state, apply, cleanupResult));
  } catch (error) {
    cleanupResult.errors.push(`Could not record final cleanup state: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    id: prepared.id,
    state,
    appliedPaths,
    conflictedPaths,
    blockedPaths: [],
    diagnostic,
    manifestPath,
    patchPath,
    cleanup: cleanupResult,
  };
}

export async function applyPreparedDelegateHandoff(
  pi: ExtensionAPI,
  prepared: PreparedDelegateHandoff,
  signal?: AbortSignal,
  cleanup = true,
): Promise<DelegateHandoffResult> {
  const lockPath = await acquireApplyLock(prepared.job.jobDir);
  try {
    return await applyPreparedDelegateHandoffUnlocked(pi, prepared, signal, cleanup);
  } finally {
    await fs.promises.rm(lockPath, { force: true });
  }
}
