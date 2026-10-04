import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { bootIdentity, identityAlive, processIdentity, type ProcessIdentity } from "./identity.ts";
import { snapshotProcesses } from "./process-tree.ts";
import type { WorkerProgress } from "./progress.ts";

const exec = promisify(execFile);
export const LIMIT = 16;
export const PAGE_BYTES = 12_000;
export const launcher = fileURLToPath(new URL("../../skills/herdr-subagents/run.mjs", import.meta.url));
const roles = {
  reviewer: "Review only; do not edit. Report actionable defects with severity, file:line, evidence and a fix suggestion. Say when no defects were found.",
  explorer: "Explore only; do not edit. Report relevant file paths, symbols, relationships and concrete answers.",
  tester: "Run relevant tests. Report exact commands, outcomes and failures. Do not modify source or tests unless explicitly assigned.",
  worker: "Complete the assigned task. Report changes, validation and remaining risks.",
};
export interface Task {
  name: string;
  prompt: string;
  role: keyof typeof roles;
  cwd: string;
  model?: string;
  thinking?: string;
  timeout: number;
  extensions: string[];
  persistent?: boolean;
  presentation?: "quiet" | "agent";
  maxTokens?: number;
  maxCost?: number;
}
export interface Job {
  id: string;
  task: Task;
  pane?: string;
  terminal?: string;
  launched?: boolean;
  creating?: boolean;
  closed?: boolean;
  endedAt?: number;
  cursor: number;
  collected?: boolean;
  created: number;
  conversationId?: string;
  previousId?: string;
}
export interface Completion {
  state: "done" | "failed" | "cancelled";
  report: string;
  error?: string;
  exitCode?: number | null;
  cleanupError?: string;
}
interface Pane { pane_id: string; terminal_id: string }
interface Rect { width: number; height: number }
interface Layout { panes: Array<{ pane_id: string; rect: Rect }> }
export interface Scope {
  root: string;
  ownerPid?: number;
  authority?: { token: string; identity: ProcessIdentity };
  pane: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

export function agentDirectory(env = process.env): string {
  const path = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  if (path.startsWith("file://")) return fileURLToPath(path);
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

export function scopeFor(session = process.env.PI_SESSION_ID, env = process.env): Scope {
  if (env.PI_HERDR_WORKER === "1") throw new Error("Subagents cannot spawn or control subagents.");
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID || !env.HERDR_WORKSPACE_ID || !session) {
    throw new Error("Run from a Pi session inside Herdr (session ID and caller pane required).");
  }
  // Session ownership outlives its display pane or Herdr server incarnation.
  // A fork gets a fresh session ID and therefore never inherits worker control.
  const key = createHash("sha256").update(JSON.stringify(["session-v2", session])).digest("hex").slice(0, 24);
  return {
    root: join(agentDirectory(env), "herdr-subagents", key),
    ownerPid: env.PI_HERDR_OWNER_PID ? Number(env.PI_HERDR_OWNER_PID) : process.pid,
    pane: env.HERDR_PANE_ID, workspace: env.HERDR_WORKSPACE_ID, env,
  };
}

export async function atomic(path: string, value: unknown, firstWriter = false, signal?: AbortSignal): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    signal?.throwIfAborted();
    if (firstWriter) {
      // Atomic publish-if-absent: readers never see partial JSON or a replaced final.
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    } else await rename(temporary, path);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function json<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

interface Claim { pid: number; identity: ProcessIdentity; choosing: boolean; ticket: number }

async function liveClaims(directory: string): Promise<Array<Claim & { id: string }>> {
  const claims: Array<Claim & { id: string }> = [];
  // Enumerate before sampling: every listed claim was published before this
  // snapshot. Sampling first could erase a contender born between ps and readdir.
  const ids = (await readdir(directory)).filter((name) => /^[a-f0-9-]+\.json$/.test(name));
  const [processes, boot] = await Promise.all([snapshotProcesses(), bootIdentity()]);
  for (const id of ids) {
    const path = join(directory, id);
    const claim = await json<Claim>(path);
    if (!claim) continue;
    const live = processes.find((entry) => entry.pid === claim.pid && !/^[ZX]/.test(entry.state));
    if (live && !claim.identity) throw new Error("Unversioned live subagent lock; finish the old operation and reload Pi.");
    if (!live || claim.identity.boot !== boot || claim.identity.start !== live.start) {
      await rm(path, { force: true });
      continue;
    }
    claims.push({ ...claim, id });
  }
  return claims;
}

export async function locked<T>(scope: Scope, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const directory = join(scope.root, "locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `${randomUUID()}.json`;
  const path = join(directory, id);
  const deadline = Date.now() + 60_000;
  // Bakery lock with immutable claim identities. Reaping a dead process removes
  // only its unique claim, never a shared path which a successor might now own.
  // Atomic file publication makes the choosing/ticket transitions indivisible.
  const identity = await processIdentity();
  if (!identity) throw new Error("Cannot establish lock process identity.");
  await atomic(path, { pid: process.pid, identity, choosing: true, ticket: 0 });
  try {
    const ticket = Math.max(0, ...(await liveClaims(directory)).map((claim) => claim.ticket)) + 1;
    await atomic(path, { pid: process.pid, identity, choosing: false, ticket });
    while ((await liveClaims(directory)).some((claim) => claim.id !== id && (claim.choosing || claim.ticket < ticket || (claim.ticket === ticket && claim.id < id)))) {
      if (Date.now() >= deadline) throw new Error("Subagent state is busy; retry.");
      await delay(50, undefined, { signal });
    }
    signal?.throwIfAborted();
    // CLI calls can outlive their parent or wait for stdin before mutation. Fence
    // their captured lease INSIDE admission, not merely at command startup.
    if (scope.authority) await assertAuthority(scope);
    // Authority verification awaits filesystem/process I/O. Cancellation during
    // that check must still fence mutation at the final admission boundary.
    signal?.throwIfAborted();
    return await fn();
  } finally { await rm(path, { force: true }); }
}

export async function assertAuthority(scope: Scope): Promise<void> {
  const owner = await json<{ token: string; identity: ProcessIdentity }>(join(scope.root, "owner.json"));
  const expected = scope.authority;
  if (!expected || owner?.token !== expected.token || owner.identity.pid !== expected.identity.pid ||
    owner.identity.start !== expected.identity.start || owner.identity.boot !== expected.identity.boot ||
    !await identityAlive(expected.identity)) throw new Error("Parent ownership changed or ended; this operation is fenced. Reconnect from the current parent.");
}

export async function herdr<T>(scope: Scope, args: string[]): Promise<T> {
  try {
    const { stdout } = await exec(scope.env.HERDR_BIN_PATH || "herdr", args, {
      env: scope.env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    // Herdr's pane run command exits successfully without printing JSON.
    if (!stdout.trim() && args[0] === "pane" && args[1] === "run") return {} as T;
    const response = JSON.parse(stdout) as { result?: T; error?: unknown };
    if (response.error || !response.result) throw new Error(JSON.stringify(response.error || response));
    return response.result;
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    let herdrCode: string | undefined;
    try { herdrCode = (JSON.parse(detail.stderr || "{}") as { error?: { code?: string } }).error?.code; } catch { /* CLI syntax/process error, not an API error. */ }
    throw Object.assign(new Error(`Herdr ${args.slice(0, 2).join(" ")}: ${(detail.stderr || detail.message).slice(0, 1500)}`), { herdrCode });
  }
}

export async function jobs(scope: Scope): Promise<Job[]> {
  const entries = await readdir(scope.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result: Job[] = [];
  for (const id of entries.filter((entry) => /^[a-f0-9]{12}$/.test(entry))) {
    const job = await json<Job>(join(scope.root, id, "job.json"));
    if (job) result.push(job);
  }
  return result.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}

export async function save(scope: Scope, job: Job): Promise<void> {
  await atomic(join(scope.root, job.id, "job.json"), job);
}

export function validateTasks(input: unknown, env = process.env, cwd = process.cwd()): Task[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > LIMIT) throw new Error("Expected a JSON array of 1..16 tasks.");
  const names = new Set<string>();
  return input.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each task must be an object.");
    const item = value as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!["name", "prompt", "role", "cwd", "model", "thinking", "timeout", "extensions", "persistent", "presentation", "maxTokens", "maxCost"].includes(key)) throw new Error(`Unknown task field: ${key}`);
    }
    if (typeof item.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.name)) throw new Error("Task name must match [a-z][a-z0-9_-]{0,31}.");
    if (names.has(item.name)) throw new Error(`Duplicate task name: ${item.name}`);
    names.add(item.name);
    if (typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 100_000) throw new Error("A nonempty prompt (up to 100000 characters) is required.");
    const role = item.role ?? "worker";
    if (typeof role !== "string" || !Object.hasOwn(roles, role)) throw new Error("Role must be reviewer, explorer, tester or worker.");
    for (const key of ["cwd", "model", "thinking"]) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || !(item[key] as string).trim())) throw new Error(`Invalid ${key}.`);
    }
    if (item.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(item.thinking as string)) throw new Error("Invalid thinking level.");
    const timeout = item.timeout ?? 1800;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 86400) throw new Error("timeout must be 1..86400 seconds.");
    if (item.persistent !== undefined && typeof item.persistent !== "boolean") throw new Error("persistent must be boolean.");
    if (item.presentation !== undefined && !["quiet", "agent"].includes(String(item.presentation))) throw new Error("presentation must be quiet or agent.");
    if (item.maxTokens !== undefined && (!Number.isSafeInteger(item.maxTokens) || Number(item.maxTokens) < 1)) throw new Error("maxTokens must be a positive integer.");
    if (item.maxCost !== undefined && (typeof item.maxCost !== "number" || !Number.isFinite(item.maxCost) || item.maxCost <= 0)) throw new Error("maxCost must be positive and finite.");
    const extensions = item.extensions ?? [];
    if (!Array.isArray(extensions) || extensions.some((e: unknown) => typeof e !== "string" || !e.trim())) throw new Error("extensions must be local extension paths.");
    return {
      name: item.name, prompt: item.prompt, role: role as Task["role"], cwd: resolve(cwd, item.cwd as string || "."),
      model: item.model as string | undefined ?? (env.PI_PROVIDER && env.PI_MODEL ? `${env.PI_PROVIDER}/${env.PI_MODEL}` : undefined),
      thinking: item.thinking as string | undefined ?? (item.model ? undefined : env.PI_REASONING_LEVEL),
      timeout, extensions: extensions.map((e: string) => resolve(cwd, e)),
      persistent: item.persistent === true, presentation: item.presentation === "agent" ? "agent" : "quiet",
      maxTokens: item.maxTokens as number | undefined, maxCost: item.maxCost as number | undefined,
    };
  });
}

export function piArgs(task: Task, session?: { id: string; directory: string }): string[] {
  // Use normal Pi resource discovery and tool configuration for every role.
  if (task.persistent && !session) throw new Error("Persistent workers require a private conversation directory.");
  const args = task.persistent && session
    ? ["--mode", "rpc", "--session-id", session.id, "--session-dir", session.directory, "--name", task.name]
    : ["--mode", "json", "-p", "--no-session", "--name", task.name];
  for (const path of task.extensions) args.push("-e", path);
  if (task.model) args.push("--model", task.model);
  if (task.thinking) args.push("--thinking", task.thinking);
  // An append CLI flag suppresses Pi's normal APPEND_SYSTEM.md discovery.
  // This last, additive extension appends the role instructions after discovery.
  args.push("-e", fileURLToPath(new URL("./prompt.ts", import.meta.url)));
  // Stdin carries the prompt literally: no shell expansion, @file expansion or argv limit.
  return args;
}

export function systemPrompt(task: Task): string {
  return `You are an isolated ${task.role} named ${task.name}. ${roles[task.role]}\nWork only on your assigned task. Do not spawn agents, control Herdr, coordinate with peers, or inspect other agents' files. Do not commit. Follow AGENTS.md. You cannot ask interactive questions: report blockers instead. Finish with a concise report (aim for 1500 characters; include all critical evidence). No preamble.\n`;
}

export function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function splitTarget(layout: Layout, owned: string[], parent: string): { pane: string; direction: string } {
  const available = layout.panes.filter((p) => owned.includes(p.pane_id));
  const pane = (available.length ? available.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height) : layout.panes.filter((p) => p.pane_id === parent))[0];
  if (!pane) throw new Error("Caller/owned pane is no longer in the current layout.");
  // Terminal cells are approximately twice as tall as they are wide.
  return { pane: pane.pane_id, direction: available.length === 0 || pane.rect.width >= pane.rect.height * 2 ? "right" : "down" };
}

/** Object key order is not caller intent; array order and explicit fields are. */
export function requestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest("hex");
}

export interface RequestStatus {
  requestId: string;
  scope: string;
  found: boolean;
  admissionState?: "prepared" | "starting" | "done" | "failed";
  jobs: Array<{ id: string; name?: string; closed?: boolean; collected?: boolean; artifactMissing: boolean }>;
  jobsOmitted?: number;
  artifactsIncomplete?: boolean;
}

export type RequestDiagnosticCode = "REQUEST_ID_CONFLICT" | "REQUEST_NOT_REPLAYABLE" | "REQUEST_ARTIFACT_MISSING";

export class RequestDiagnosticError extends Error {
  readonly code: RequestDiagnosticCode;
  readonly diagnostic: RequestStatus;
  readonly inspection: { action: "request_status"; requestId: string };

  constructor(code: RequestDiagnosticCode, message: string, diagnostic: RequestStatus) {
    super(message);
    this.name = "RequestDiagnosticError";
    this.code = code;
    this.diagnostic = diagnostic;
    this.inspection = { action: "request_status", requestId: diagnostic.requestId };
  }
}

function requestPath(scope: Scope, requestId: string): string {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) throw new Error("Invalid spawn requestId (1..128 letters, digits, . _ : -).");
  return join(scope.root, "requests", `${createHash("sha256").update(requestId).digest("hex")}.json`);
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonIntent(value: unknown, ancestors = new Set<object>()): void {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value))) throw new Error("Non-JSON value");
  if (!value || typeof value !== "object") return;
  const prototype: unknown = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) || ancestors.has(value)) throw new Error("Non-JSON object");
  ancestors.add(value);
  const array = Array.isArray(value);
  if (array && Object.keys(value).length !== value.length) throw new Error("Non-JSON array");
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) ||
      (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error("Non-JSON property");
    assertJsonIntent(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function snapshotTaskIntent(input: unknown): unknown[] {
  let snapshot: unknown;
  try {
    // Reject non-JSON values rather than silently dropping explicit fields. Do
    // this synchronously: caller mutation after the first await cannot alter it.
    assertJsonIntent(input);
    snapshot = JSON.parse(JSON.stringify(input)) as unknown;
  } catch { throw new Error("Tasks must contain only explicit JSON values."); }
  if (!Array.isArray(snapshot)) throw new Error("Expected 1..16 valid explicit tasks.");
  // Core also runs under plain Node (CLI/workers), without Pi's peer aliases.
  // Reuse its syntax validator with inert defaults, discarding normalized values;
  // never consult the parent or expand presets while preserving the raw snapshot.
  validateTasks(snapshot.map((task: unknown) => {
    if (!objectRecord(task) || Object.values(task).some((value) => value === null)) throw new Error("Invalid explicit task.");
    const { preset, ...fields } = task;
    if (preset !== undefined && (typeof preset !== "string" || !preset.trim())) throw new Error("Invalid task preset.");
    return fields;
  }), {}, "/");
  return snapshot;
}

async function privateRequestsDirectory(scope: Scope): Promise<void> {
  const directory = join(scope.root, "requests");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Requests directory must not be a symlink.");
}

/** Persist intent only: ordinary ownership checks, but no defaults or worker launch. */
export async function prepareTasks(scope: Scope, input: unknown, signal?: AbortSignal): Promise<{ requestId: string }> {
  signal?.throwIfAborted();
  const intent = snapshotTaskIntent(input);
  const fingerprint = requestFingerprint([intent, undefined]);
  const record = { state: "prepared", prepared: true, requestId: randomUUID(), intent, fingerprint, jobs: [] };
  if (Buffer.byteLength(JSON.stringify(record)) > 16 * 1024 * 1024) throw new Error("Prepared request exceeds 16 MiB.");
  return locked(scope, async () => {
    await privateRequestsDirectory(scope);
    // Use the same live-owner and abort admission fence as other scoped writes.
    // First-writer publication also protects against a historical UUID collision.
    for (let attempt = 0; attempt < 8; attempt++) {
      signal?.throwIfAborted();
      if (await atomic(requestPath(scope, record.requestId), record, true, signal)) return { requestId: record.requestId };
      record.requestId = randomUUID();
    }
    throw new Error("Unable to allocate a fresh prepared request ID.");
  }, signal);
}

// The journal contains private execution snapshots. Bound reads before parsing,
// never surface parser errors (which may quote prompts), and do not follow saved
// IDs or symlinked artifact directories outside this scope. A corrupt/unreadable
// artifact is not evidence that a request never existed.
async function requestArtifact(directory: string, filename: string, maxBytes: number): Promise<{ missing?: true; value?: unknown }> {
  try {
    if (!(await lstat(directory)).isDirectory()) return {};
    const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes) return {};
      const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > info.size) return {}; // changed outside admission; retry inspection
      return { value: JSON.parse(buffer.toString("utf8", 0, length)) as unknown };
    } finally { await file.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { missing: true } : {};
  }
}

// Caller holds the scope lock. Both inspection and spawn must consult precisely
// this journal, not status()'s filtered live-job view; never nest admission locks.
async function inspectRequest(scope: Scope, requestId: string, signal?: AbortSignal): Promise<{
  diagnostic: RequestStatus; fingerprint?: string; replayJobs: Job[]; journalValid: boolean; preparedIntent?: unknown[];
}> {
  const path = requestPath(scope, requestId);
  signal?.throwIfAborted();
  const artifact = await requestArtifact(join(scope.root, "requests"), basename(path), 32 * 1024 * 1024);
  signal?.throwIfAborted();
  const diagnostic: RequestStatus = { requestId, scope: basename(scope.root), found: !artifact.missing, jobs: [] };
  const replayJobs: Job[] = [];
  if (artifact.missing) return { diagnostic, replayJobs, journalValid: false };
  const record = objectRecord(artifact.value) ? artifact.value : {};
  const fingerprint = typeof record.fingerprint === "string" && /^[a-f0-9]{64}$/.test(record.fingerprint) ? record.fingerprint : undefined;
  if (record.state === "prepared" || record.state === "starting" || record.state === "done" || record.state === "failed") diagnostic.admissionState = record.state;
  const ids: unknown[] = Array.isArray(record.jobs) ? record.jobs : [];
  const taskCount = Array.isArray(record.tasks) ? record.tasks.length : 0;
  let preparedIntent: unknown[] | undefined;
  const preparedOrigin = Object.hasOwn(record, "prepared") || Object.hasOwn(record, "requestId") || record.state === "prepared";
  if (preparedOrigin && record.prepared === true && record.requestId === requestId &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId) &&
    Object.keys(record).every((key) => ["state", "prepared", "requestId", "intent", "fingerprint", "jobs", "tasks", "pi"].includes(key))) {
    try {
      const snapshot = snapshotTaskIntent(record.intent);
      if (requestFingerprint([snapshot, undefined]) === fingerprint) preparedIntent = snapshot;
    } catch { /* Private payload corruption must never escape through diagnostics. */ }
  }
  let journalValid = !!fingerprint && !!diagnostic.admissionState && Array.isArray(record.jobs) && ids.length <= LIMIT &&
    (!preparedOrigin || !!preparedIntent) && (record.state === "prepared"
      ? !!preparedIntent && ids.length === 0 && !Object.hasOwn(record, "tasks") && !Object.hasOwn(record, "pi")
      : taskCount >= 1 && taskCount <= LIMIT && (!preparedIntent || taskCount === preparedIntent.length) &&
        (record.state !== "done" || ids.length === taskCount));
  if (ids.length > LIMIT) diagnostic.jobsOmitted = ids.length - LIMIT;
  const seen = new Set<string>();
  for (const id of ids.slice(0, LIMIT)) {
    if (typeof id !== "string" || !/^[a-f0-9]{12}$/.test(id) || seen.has(id)) {
      journalValid = false;
      diagnostic.jobsOmitted = (diagnostic.jobsOmitted ?? 0) + 1;
      continue;
    }
    seen.add(id);
    const saved = await requestArtifact(join(scope.root, id), "job.json", 4 * 1024 * 1024);
    signal?.throwIfAborted();
    const job = objectRecord(saved.value) && saved.value.id === id ? saved.value : undefined;
    const task = job && objectRecord(job.task) ? job.task : undefined;
    const name = task && typeof task.name === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(task.name) ? task.name : undefined;
    const valid = !!job && !!name && typeof task?.prompt === "string" && typeof task.cwd === "string" &&
      typeof job.cursor === "number" && Number.isFinite(job.cursor) && typeof job.created === "number" && Number.isFinite(job.created) &&
      (job.closed === undefined || typeof job.closed === "boolean") && (job.collected === undefined || typeof job.collected === "boolean");
    diagnostic.jobs.push({
      id, ...(name ? { name } : {}),
      ...(typeof job?.closed === "boolean" ? { closed: job.closed } : {}),
      ...(typeof job?.collected === "boolean" ? { collected: job.collected } : {}),
      artifactMissing: !valid,
    });
    if (valid) replayJobs.push(job as unknown as Job);
    else diagnostic.artifactsIncomplete = true;
  }
  if (!journalValid) diagnostic.artifactsIncomplete = true;
  return { diagnostic, fingerprint, replayJobs, journalValid, ...(preparedIntent ? { preparedIntent } : {}) };
}

/** Metadata-only historical lookup; does not contact Herdr or reconcile jobs. */
export async function requestStatus(scope: Scope, requestId: string, signal?: AbortSignal): Promise<RequestStatus> {
  signal?.throwIfAborted();
  requestPath(scope, requestId);
  return locked(scope, async () => (await inspectRequest(scope, requestId, signal)).diagnostic, signal);
}

export interface SpawnPlan {
  intent?: unknown;
  // Called under admission only for a new or prepared ID, never for a done retry.
  resolve: (intent: unknown) => Promise<Task[]>;
}

export async function spawnTasks(scope: Scope, input: Task[] | SpawnPlan, requestId?: string, signal?: AbortSignal, previousId?: string): Promise<Job[]> {
  signal?.throwIfAborted();
  const supplied = Array.isArray(input) ? input : input.intent;
  let intent: unknown = supplied === undefined ? undefined : JSON.parse(JSON.stringify(supplied));
  let fingerprint = requestFingerprint([intent, previousId]);
  const journalPath = requestId === undefined ? undefined : requestPath(scope, requestId);
  return locked(scope, async () => {
    const request = requestId === undefined ? undefined : await inspectRequest(scope, requestId, signal);
    const prepared = request?.journalValid && request.preparedIntent !== undefined;
    if ((intent === undefined && !prepared) || (prepared && previousId !== undefined)) {
      throw new RequestDiagnosticError("REQUEST_NOT_REPLAYABLE", "ID-only spawn requires a valid prepared request in this scope; prepared IDs cannot continue conversations. Inspect request_status.",
        request?.diagnostic ?? { requestId: requestId ?? "", scope: basename(scope.root), found: false, jobs: [] });
    }
    if (prepared && intent === undefined) {
      intent = request.preparedIntent;
      fingerprint = request.fingerprint!;
    }
    if (request?.diagnostic.found) {
      const { diagnostic } = request;
      if (request.fingerprint && request.fingerprint !== fingerprint) throw new RequestDiagnosticError("REQUEST_ID_CONFLICT", "Spawn requestId already belongs to different tasks.", diagnostic);
      if (!request.journalValid || (diagnostic.admissionState !== "done" && !(prepared && diagnostic.admissionState === "prepared"))) throw new RequestDiagnosticError("REQUEST_NOT_REPLAYABLE", `Spawn request ${requestId} is ${diagnostic.admissionState ?? "unreadable"}; inspect request_status before recovery. It will not be replayed.`, diagnostic);
      if (diagnostic.admissionState === "done") {
        const missing = diagnostic.jobs.find((job) => job.artifactMissing);
        if (missing) throw new RequestDiagnosticError("REQUEST_ARTIFACT_MISSING", `Spawn request artifact missing: ${missing.id}`, diagnostic);
        return request.replayJobs;
      }
    }
    // Resolvers may mutate their input. Never give one the journal's immutable
    // prepared snapshot, even when explicit matching tasks accompanied the ID.
    if (prepared) intent = request.preparedIntent;
    const tasks = Array.isArray(input) ? intent as Task[] : await input.resolve(prepared ? structuredClone(intent) : intent);
    signal?.throwIfAborted();
    const allJobs = await jobs(scope);
    const previous = previousId ? allJobs.find((job) => job.id === previousId) : undefined;
    if (previousId) {
      if (!previous?.conversationId || !previous.task.persistent || tasks.length !== 1) throw new Error("Continuation requires one persistent worker.");
      if (!previous.collected) throw new Error("Acknowledge the previous report before continuing.");
      const latest = allJobs.filter((job) => job.conversationId === previous.conversationId).at(-1);
      if (latest?.id !== previousId) throw new Error("A newer attempt already owns this conversation; use its job ID.");
      if (!(await json<ShutdownAck>(join(scope.root, previous.id, "shutdown.json")))?.verified) throw new Error("Previous execution cleanup is unverified; recover before continuing.");
      if (!previous.closed) await closeJob(scope, previous);
    }
    const existing = allJobs.filter((job) => !job.closed);
    if (existing.length + tasks.length > LIMIT) throw new Error("At most 16 open subagent panes per main session; collect and close completed jobs first.");
    if (tasks.some((task) => existing.some((job) => job.task.name === task.name))) throw new Error("An open job already has that name.");
    for (const task of tasks) {
      // Prepared ID-only retries must remain readable by inspectRequest. Leave
      // room for job metadata in its 4 MiB artifact budget before any launch.
      if (prepared && Buffer.byteLength(JSON.stringify(task)) > 4 * 1024 * 1024 - 1024) throw new Error("Prepared execution task exceeds the 4 MiB job artifact budget.");
      if (!(await stat(task.cwd)).isDirectory()) throw new Error(`Not a directory: ${task.cwd}`);
      for (const path of task.extensions) await stat(path);
    }
    // Resolve Pi before opening panes. Do not guess the Herdr server's PATH.
    let pi = scope.env.PI_HERDR_PI_BIN;
    if (!pi) {
      for (const directory of (scope.env.PATH || "").split(delimiter)) {
        const candidate = join(directory, "pi");
        if ((await stat(candidate).catch(() => undefined))?.isFile()) { pi = resolve(candidate); break; }
      }
    }
    if (!pi) throw new Error("pi executable not found on PATH.");
    const { pane: parent } = await herdr<{ pane: Pane }>(scope, ["pane", "current", "--current"]);
    const { panes } = await herdr<{ panes: Pane[] }>(scope, ["pane", "list"]);
    const owned = panes.filter((pane) => existing.some((job) => job.terminal === pane.terminal_id)).map((pane) => pane.pane_id);
    const created: Job[] = [];
    const record = async (state: string) => {
      if (!journalPath) return;
      await privateRequestsDirectory(scope);
      // Publish caller intent and the first execution snapshot together, before
      // any launch. Interrupted/failed records still forbid blind replay.
      const value = { fingerprint, intent, ...(prepared ? { prepared: true, requestId } : {}), tasks, pi, jobs: created.map((job) => job.id), state };
      if (prepared && Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024 - (created.length ? 0 : 1024)) throw new Error("Prepared admission exceeds the 32 MiB request artifact budget.");
      await atomic(journalPath, value);
    };
    signal?.throwIfAborted();
    await record("starting");
    try {
      for (const task of tasks) {
        signal?.throwIfAborted();
        const job: Job = { id: randomUUID().replaceAll("-", "").slice(0, 12), task, cursor: 0, created: Date.now() };
        if (task.persistent) {
          job.conversationId = previous?.conversationId || job.id;
          if (previous) job.previousId = previous.id;
        }
        const directory = join(scope.root, job.id);
        await mkdir(directory, { mode: 0o700 });
        await save(scope, job);
        created.push(job);
        await record("starting");
        await writeFile(join(directory, "system.md"), systemPrompt(task), { mode: 0o600 });
        const conversation = job.conversationId ? { id: job.conversationId, directory: join(scope.root, "conversations", job.conversationId) } : undefined;
        if (conversation) await mkdir(conversation.directory, { recursive: true, mode: 0o700 });
        await atomic(join(directory, "launch.json"), { pi, args: piArgs(task, conversation) });
        const { layout } = await herdr<{ layout: Layout }>(scope, ["pane", "layout", "--pane", parent.pane_id]);
        const target = splitTarget(layout, [...owned, ...created.flatMap((j) => j.pane ? [j.pane] : [])], parent.pane_id);
        signal?.throwIfAborted();
        job.creating = true;
        await save(scope, job);
        try {
          const { pane } = await herdr<{ pane: Pane }>(scope, ["pane", "split", "--pane", target.pane, "--direction", target.direction, "--cwd", task.cwd, "--no-focus", "--env", `PI_CODING_AGENT_DIR=${agentDirectory(scope.env)}`]);
          job.pane = pane.pane_id;
          job.terminal = pane.terminal_id;
          job.creating = false;
        } catch (error) {
          // A server rejection is definite; a lost response may hide a created pane.
          if ((error as { herdrCode?: string }).herdrCode) job.creating = false;
          await save(scope, job);
          throw error;
        }
        await save(scope, job);
        await herdr(scope, ["pane", "rename", job.pane, `${task.role}: ${task.name}`]);
        signal?.throwIfAborted();
        job.launched = true;
        await save(scope, job);
        await herdr(scope, ["pane", "run", job.pane, `exec ${quote(process.execPath)} ${quote(launcher)} worker ${quote(directory)}`]);
      }
      signal?.throwIfAborted();
      await record("done");
      return created;
    } catch (error) {
      let trackingError = "";
      try { await record("failed"); } catch (failure) { trackingError = `; request tracking failed: ${String(failure)}`; }
      try { await closeJobs(scope, created, true); }
      catch (rollback) { throw new Error(`${String(error)}${trackingError}; rollback incomplete: ${String(rollback)}`); }
      throw new Error(`${String(error)}${trackingError}; new panes rolled back`);
    }
  }, signal);
}

export async function completion(scope: Scope, job: Job): Promise<Completion | undefined> {
  const directory = join(scope.root, job.id);
  const done = await json<Completion>(join(directory, "done.json"));
  if (done) return done;
  if (job.endedAt === undefined || Date.now() - job.endedAt < 5000) return undefined;
  const claim = await json<WorkerClaim>(join(directory, "worker.json"));
  // A delayed startup or handoff can recover after reconciliation set endedAt.
  // Never freeze a synthetic result while that supervisor can still publish one.
  if (claim?.identity && await identityAlive(claim.identity)) return undefined;
  // Pane close can precede the supervisor's graceful shutdown. Give it time to
  // flush, then publish a stable failure snapshot if it died without a final.
  const checkpoint = await json<{ report: string }>(join(directory, "checkpoint.json"));
  const report = checkpoint?.report ?? await readFile(join(directory, "result.md"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  await atomic(join(directory, "done.json"), {
    state: job.closed ? "cancelled" : "failed", report,
    error: "Worker pane ended without a final completion; inspect events.jsonl and stderr.log for partial output.",
  }, true);
  return json<Completion>(join(directory, "done.json"));
}

export interface WorkerClaim { pid?: number; identity?: ProcessIdentity; cancelled?: boolean }
export interface ShutdownAck { verified: true }

export async function status(scope: Scope, offset = 0): Promise<{ jobs: unknown[]; next?: number }> {
  return locked(scope, async () => {
    const all = (await jobs(scope)).filter((job) => !job.closed || !job.collected);
    if (!all.length) return { jobs: [] };
    const { panes } = await herdr<{ panes: Pane[] }>(scope, ["pane", "list"]);
    const entries = await Promise.all(all.map(async (job) => {
      const done = await completion(scope, job);
      const claim = await json<WorkerClaim>(join(scope.root, job.id, "worker.json"));
      const alive = claim?.identity ? await identityAlive(claim.identity) : undefined;
      if (!done && alive && job.endedAt !== undefined) {
        delete job.endedAt;
        await save(scope, job);
      }
      const missing = !panes.some((pane) => pane.terminal_id === job.terminal);
      // Terminal IDs change on Herdr handoff. A proven live supervisor is not a
      // vanished worker; retain ownership as unresolved until explicit reattachment.
      const unattached = !done && missing && alive === true;
      if (!done && job.endedAt === undefined && (alive === false || (missing && !unattached))) {
        job.endedAt = Date.now();
        await save(scope, job);
      }
      const progress = await json<WorkerProgress>(join(scope.root, job.id, "progress.json"));
      const queued = await json(join(scope.root, job.id, "waiting.json")) !== undefined;
      return {
        ...(progress ? { progress } : {}),
        ...(job.conversationId ? { conversationId: job.conversationId, ...(job.previousId ? { previousId: job.previousId } : {}) } : {}),
        id: job.id, name: job.task.name, state: done?.state || (unattached ? "unattached" : job.endedAt !== undefined ? "ending" : queued ? "queued" : "running"),
        ...(job.collected ? { collected: true } : {}), ...(job.closed ? { closed: true } : {}),
      };
    }));
    return { jobs: entries.slice(offset, offset + LIMIT), ...(offset + LIMIT < entries.length ? { next: offset + LIMIT } : {}) };
  });
}

// One JSON record stays below Bash's byte AND line caps, even for control characters.
// Cursor is in UTF-16 units, advanced only after the caller successfully writes stdout.
export function reportPage(text: string, cursor: number, budget: number): string {
  let result = "";
  let bytes = 0;
  for (const character of text.slice(cursor)) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return result;
}

export async function collect(scope: Scope, wait: number, emit: (value: unknown) => Promise<void>): Promise<void> {
  const deadline = Date.now() + wait * 1000;
  let nextReconcile = 0;
  let warning: string | undefined;
  while (true) {
    const all = (await jobs(scope)).filter((job) => !job.collected);
    const ready = await Promise.all(all.map((job) => completion(scope, job)));
    // Saved reports never depend on a live Herdr connection.
    if (ready.some(Boolean) || !all.length) break;
    if (Date.now() >= nextReconcile) {
      try { await status(scope); warning = undefined; }
      catch (error) { warning = reportPage(String(error), 0, 1500); }
      nextReconcile = Date.now() + 5000;
    }
    if (Date.now() >= deadline) break;
    await delay(500);
  }
  await locked(scope, async () => {
    const reports: unknown[] = [];
    const updates: Job[] = [];
    let remaining = PAGE_BYTES - 2000;
    let pending = 0;
    for (const job of (await jobs(scope)).filter((j) => !j.collected)) {
      const done = await completion(scope, job);
      if (!done) { pending++; continue; }
      if (remaining < 1000) { pending++; continue; }
      const text = `${done.error ? `${done.error}\n\n` : ""}${done.report || "(no final report)"}`;
      const part = reportPage(text, job.cursor, remaining - 500);
      const start = job.cursor;
      job.cursor += part.length;
      job.collected = job.cursor >= text.length;
      if (!job.collected) pending++;
      const entry = { id: job.id, name: job.task.name, state: done.state, ...(start ? { offset: start } : {}), complete: job.collected, text: part };
      remaining -= Buffer.byteLength(JSON.stringify(entry));
      reports.push(entry);
      updates.push(job);
    }
    await emit({ reports, pending, ...(warning ? { warning } : {}) });
    for (const job of updates) await save(scope, job);
  });
}

async function ownedPane(scope: Scope, job: Job): Promise<Pane | undefined> {
  const { panes } = await herdr<{ panes: Pane[] }>(scope, ["pane", "list"]);
  // Cross-workspace moves change pane IDs, but terminal identity survives.
  const pane = panes.find((p) => p.terminal_id === job.terminal);
  if (!pane && panes.some((p) => p.pane_id === job.pane)) throw new Error(`${job.task.name}: terminal identity changed; refusing to close.`);
  if (job.pane === scope.pane || pane?.pane_id === scope.pane) throw new Error("Refusing to close the main pane.");
  return pane;
}

export async function closeJob(scope: Scope, job: Job, cancel = false, deadline = Date.now() + 10_000): Promise<void> {
  if (job.closed) return;
  if (job.creating) throw new Error(`${job.task.name}: pane creation response was lost; ownership is unresolved. Inspect Herdr before retrying; no unknown pane was closed.`);
  if (!cancel && !job.collected) throw new Error(`${job.task.name}: collect the entire report before closing (or explicitly cancel).`);
  if (job.pane) {
    await ownedPane(scope, job);
    if (cancel && job.launched) {
      const directory = join(scope.root, job.id);
      await atomic(join(directory, "cancel.json"), {});
      // Race the worker's atomic startup claim. Winning fences all delayed launches;
      // losing requires the running supervisor's acknowledgement before closing PTY.
      const fenced = await atomic(join(directory, "worker.json"), { cancelled: true }, true);
      // Recover a parent crash between fencing startup and publishing completion.
      if (fenced || (await json<WorkerClaim>(join(directory, "worker.json")))?.cancelled) {
        await atomic(join(directory, "shutdown.json"), { verified: true }, true);
        await atomic(join(directory, "done.json"), { state: "cancelled", report: "", error: "Cancelled before worker startup." }, true);
      }
      while (true) {
        const completion = await json<Completion>(join(directory, "done.json"));
        const acknowledgement = await json<ShutdownAck>(join(directory, "shutdown.json"));
        if (completion?.cleanupError || (completion && acknowledgement?.verified)) break;
        if (Date.now() >= deadline) throw new Error(`${job.task.name}: cancellation not acknowledged; pane retained. Inspect it before forcing closure.`);
        await delay(100);
      }
    }
    const done = await json<Completion>(join(scope.root, job.id, "done.json"));
    if (done?.cleanupError && !(await json<ShutdownAck>(join(scope.root, job.id, "recovery.json")))?.verified) {
      throw new Error(`${job.task.name}: ${done.cleanupError}; pane retained for inspection.`);
    }
    // A synthetic/partial report is never proof that detached execution stopped.
    if (job.launched && !(await json<ShutdownAck>(join(scope.root, job.id, "shutdown.json")))?.verified) {
      throw new Error(`${job.task.name}: process cleanup not verified; pane retained for inspection.`);
    }
    // Never rely on the identity observed before a potentially long cancellation wait.
    const pane = await ownedPane(scope, job);
    if (pane) await herdr(scope, ["pane", "close", pane.pane_id]).catch((error: Error & { herdrCode?: string }) => {
      if (error.herdrCode !== "pane_not_found") throw error;
    });
  }
  job.closed = true;
  job.endedAt ??= Date.now();
  await save(scope, job);
}

export async function closeJobs(scope: Scope, all: Job[], cancel = false, grace = 10_000): Promise<string[]> {
  const closed: string[] = [];
  const failures: string[] = [];
  if (cancel) for (const job of all) {
    if (!job.launched || job.closed) continue;
    try { await atomic(join(scope.root, job.id, "cancel.json"), {}); }
    catch (error) { failures.push(`${job.task.name}: ${String(error)}`); }
  }
  const deadline = Date.now() + grace;
  for (const job of all) {
    if (job.closed || (!cancel && !job.collected)) continue;
    try { await closeJob(scope, job, cancel, deadline); closed.push(job.task.name); }
    catch (error) { failures.push(String(error)); }
  }
  if (failures.length) throw new Error(failures.join("; "));
  return closed;
}

export async function cleanup(scope: Scope, cancel = false, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  if (!(await stat(scope.root).catch(() => undefined))) return [];
  return locked(scope, async () => closeJobs(scope, await jobs(scope), cancel), signal);
}
