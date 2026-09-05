import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

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
}
export interface Job {
  id: string;
  task: Task;
  pane?: string;
  terminal?: string;
  launched?: boolean;
  closed?: boolean;
  endedAt?: number;
  cursor: number;
  collected?: boolean;
  created: number;
}
export interface Completion {
  state: "done" | "failed" | "cancelled";
  report: string;
  error?: string;
  exitCode?: number | null;
}
interface Pane { pane_id: string; terminal_id: string }
interface Rect { width: number; height: number }
interface Layout { panes: Array<{ pane_id: string; rect: Rect }> }
export interface Scope {
  root: string;
  pane: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

export function scopeFor(session = process.env.PI_SESSION_ID, env = process.env): Scope {
  if (env.PI_HERDR_WORKER === "1") throw new Error("Subagents cannot spawn or control subagents.");
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID || !env.HERDR_WORKSPACE_ID || !session) {
    throw new Error("Run from a Pi session inside Herdr (session ID and caller pane required).");
  }
  const key = createHash("sha256").update(JSON.stringify([env.HERDR_SOCKET_PATH, env.HERDR_PANE_ID, session])).digest("hex").slice(0, 24);
  return {
    root: join(resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")), "herdr-subagents", key),
    pane: env.HERDR_PANE_ID, workspace: env.HERDR_WORKSPACE_ID, env,
  };
}

export async function atomic(path: string, value: unknown, firstWriter = false): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    if (firstWriter) {
      // Atomic publish-if-absent: readers never see partial JSON or a replaced final.
      await link(temporary, path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    } else await rename(temporary, path);
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

interface Claim { pid: number; choosing: boolean; ticket: number }

async function liveClaims(directory: string): Promise<Array<Claim & { id: string }>> {
  const claims: Array<Claim & { id: string }> = [];
  for (const id of (await readdir(directory)).filter((name) => /^[a-f0-9-]+\.json$/.test(name))) {
    const path = join(directory, id);
    const claim = await json<Claim>(path);
    if (!claim) continue;
    try { process.kill(claim.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") { await rm(path, { force: true }); continue; }
      throw error;
    }
    claims.push({ ...claim, id });
  }
  return claims;
}

export async function locked<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
  const directory = join(scope.root, "locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `${randomUUID()}.json`;
  const path = join(directory, id);
  const deadline = Date.now() + 60_000;
  // Bakery lock with immutable claim identities. Reaping a dead process removes
  // only its unique claim, never a shared path which a successor might now own.
  // Atomic file publication makes the choosing/ticket transitions indivisible.
  await atomic(path, { pid: process.pid, choosing: true, ticket: 0 });
  try {
    const ticket = Math.max(0, ...(await liveClaims(directory)).map((claim) => claim.ticket)) + 1;
    await atomic(path, { pid: process.pid, choosing: false, ticket });
    while ((await liveClaims(directory)).some((claim) => claim.id !== id && (claim.choosing || claim.ticket < ticket || (claim.ticket === ticket && claim.id < id)))) {
      if (Date.now() >= deadline) throw new Error("Subagent state is busy; retry.");
      await delay(50);
    }
    return await fn();
  } finally { await rm(path, { force: true }); }
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
      if (!["name", "prompt", "role", "cwd", "model", "thinking", "timeout", "extensions"].includes(key)) throw new Error(`Unknown task field: ${key}`);
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
    const extensions = item.extensions ?? [];
    if (!Array.isArray(extensions) || extensions.some((e: unknown) => typeof e !== "string" || !e.trim())) throw new Error("extensions must be local extension paths.");
    return {
      name: item.name, prompt: item.prompt, role: role as Task["role"], cwd: resolve(cwd, item.cwd as string || "."),
      model: item.model as string | undefined ?? (env.PI_PROVIDER && env.PI_MODEL ? `${env.PI_PROVIDER}/${env.PI_MODEL}` : undefined),
      thinking: item.thinking as string | undefined ?? (item.model ? undefined : env.PI_REASONING_LEVEL),
      timeout, extensions: extensions.map((e: string) => resolve(cwd, e)),
    };
  });
}

export function piArgs(task: Task, directory: string): string[] {
  // Use normal Pi resource discovery and tool configuration for every role.
  const args = ["--mode", "json", "-p", "--no-session", "--name", task.name];
  for (const path of task.extensions) args.push("-e", path);
  if (task.model) args.push("--model", task.model);
  if (task.thinking) args.push("--thinking", task.thinking);
  args.push("--append-system-prompt", join(directory, "system.md"));
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

export async function spawnTasks(scope: Scope, tasks: Task[]): Promise<Job[]> {
  return locked(scope, async () => {
    const existing = (await jobs(scope)).filter((job) => !job.closed);
    if (existing.length + tasks.length > LIMIT) throw new Error("At most 16 open subagent panes per main session; collect and close completed jobs first.");
    if (tasks.some((task) => existing.some((job) => job.task.name === task.name))) throw new Error("An open job already has that name.");
    for (const task of tasks) {
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
    const created: Job[] = [];
    try {
      for (const task of tasks) {
        const job: Job = { id: randomUUID().replaceAll("-", "").slice(0, 12), task, cursor: 0, created: Date.now() };
        const directory = join(scope.root, job.id);
        await mkdir(directory, { mode: 0o700 });
        await save(scope, job);
        created.push(job);
        await writeFile(join(directory, "system.md"), systemPrompt(task), { mode: 0o600 });
        await atomic(join(directory, "launch.json"), { pi, args: piArgs(task, directory) });
        const { layout } = await herdr<{ layout: Layout }>(scope, ["pane", "layout", "--pane", scope.pane]);
        const target = splitTarget(layout, [...existing, ...created].flatMap((j) => j.pane ? [j.pane] : []), scope.pane);
        const { pane } = await herdr<{ pane: Pane }>(scope, ["pane", "split", "--pane", target.pane, "--direction", target.direction, "--cwd", task.cwd, "--no-focus", "--env", `PI_CODING_AGENT_DIR=${resolve(scope.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"))}`]);
        job.pane = pane.pane_id;
        job.terminal = pane.terminal_id;
        await save(scope, job);
        await herdr(scope, ["pane", "rename", job.pane, `${task.role}: ${task.name}`]);
        job.launched = true;
        await save(scope, job);
        await herdr(scope, ["pane", "run", job.pane, `exec ${quote(process.execPath)} ${quote(launcher)} worker ${quote(directory)}`]);
      }
      return created;
    } catch (error) {
      const failures: string[] = [];
      for (const job of created) {
        try { await closeJob(scope, job, true); }
        catch (e) { failures.push(String(e)); }
      }
      throw new Error(`${String(error)}${failures.length ? `; rollback incomplete: ${failures.join("; ")}` : "; new panes rolled back"}`);
    }
  });
}

export async function completion(scope: Scope, job: Job): Promise<Completion | undefined> {
  const directory = join(scope.root, job.id);
  const done = await json<Completion>(join(directory, "done.json"));
  if (done) return done;
  if (job.endedAt === undefined || Date.now() - job.endedAt < 5000) return undefined;
  // Pane close can precede the supervisor's graceful shutdown. Give it time to
  // flush, then publish a stable failure snapshot if it died without a final.
  const report = await readFile(join(directory, "result.md"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  await atomic(join(directory, "done.json"), {
    state: job.closed ? "cancelled" : "failed", report,
    error: "Worker pane ended without a final completion; inspect events.jsonl and stderr.log for partial output.",
  }, true);
  return json<Completion>(join(directory, "done.json"));
}

export async function status(scope: Scope): Promise<unknown[]> {
  return locked(scope, async () => {
    const all = (await jobs(scope)).filter((job) => !job.closed || !job.collected);
    if (!all.length) return [];
    const { panes } = await herdr<{ panes: Pane[] }>(scope, ["pane", "list", "--workspace", scope.workspace]);
    return Promise.all(all.map(async (job) => {
      const done = await completion(scope, job);
      if (!done && job.endedAt === undefined && !panes.some((pane) => pane.pane_id === job.pane && pane.terminal_id === job.terminal)) {
        job.endedAt = Date.now();
        await save(scope, job);
      }
      return { id: job.id, name: job.task.name, state: done?.state || (job.endedAt === undefined ? "running" : "ending"), collected: job.collected || false, closed: job.closed || false };
    }));
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
  while (true) {
    if (Date.now() >= nextReconcile) { await status(scope); nextReconcile = Date.now() + 5000; }
    const all = (await jobs(scope)).filter((job) => !job.collected);
    const ready = await Promise.all(all.map((job) => completion(scope, job)));
    if (ready.some(Boolean) || !all.length || Date.now() >= deadline) break;
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
      const entry = { id: job.id, name: job.task.name, state: done.state, offset: start, complete: job.collected, text: part };
      remaining -= Buffer.byteLength(JSON.stringify(entry));
      reports.push(entry);
      updates.push(job);
    }
    await emit({ reports, pending, ...(pending ? { next: "collect again for remaining reports/pages" } : {}) });
    for (const job of updates) await save(scope, job);
  });
}

export async function closeJob(scope: Scope, job: Job, cancel = false): Promise<void> {
  if (job.closed) return;
  if (!cancel && !job.collected) throw new Error(`${job.task.name}: collect the entire report before closing (or explicitly cancel).`);
  if (job.pane) {
    const { panes } = await herdr<{ panes: Pane[] }>(scope, ["pane", "list", "--workspace", scope.workspace]);
    const pane = panes.find((p) => p.pane_id === job.pane);
    if (pane && pane.terminal_id !== job.terminal) throw new Error(`${job.task.name}: terminal identity changed; refusing to close.`);
    if (job.pane === scope.pane) throw new Error("Refusing to close the main pane.");
    if (pane && cancel && job.launched) {
      const directory = join(scope.root, job.id);
      await atomic(join(directory, "cancel.json"), {});
      const deadline = Date.now() + 10_000;
      // Herdr may SIGKILL the pane supervisor before its group-kill grace period.
      // Cancel out-of-band and require acknowledgement BEFORE closing the PTY.
      while (!(await json<Completion>(join(directory, "done.json")))) {
        if (Date.now() >= deadline) throw new Error(`${job.task.name}: cancellation not acknowledged; pane retained. Inspect it before forcing closure.`);
        await delay(100);
      }
    }
    if (pane) await herdr(scope, ["pane", "close", job.pane]).catch((error: Error & { herdrCode?: string }) => {
      // Herdr can auto-remove a pane when the cancelled supervisor exits.
      if (error.herdrCode !== "pane_not_found") throw error;
    });
  }
  job.closed = true;
  job.endedAt ??= Date.now();
  await save(scope, job);
}

export async function cleanup(scope: Scope, cancel = false): Promise<string[]> {
  // Idle sessions without jobs do no I/O beyond this existence check, and no Herdr calls.
  if (!(await stat(scope.root).catch(() => undefined))) return [];
  return locked(scope, async () => {
    const closed: string[] = [];
    const failures: string[] = [];
    const all = await jobs(scope);
    // Broadcast first so cancellation of 16 workers costs one grace period.
    if (cancel) for (const job of all) {
      if (job.launched && !job.closed) await atomic(join(scope.root, job.id, "cancel.json"), {});
    }
    for (const job of all) {
      if (job.closed || (!cancel && !job.collected)) continue;
      try { await closeJob(scope, job, cancel); closed.push(job.task.name); }
      catch (error) { failures.push(String(error)); }
    }
    if (failures.length) throw new Error(failures.join("; "));
    return closed;
  });
}
