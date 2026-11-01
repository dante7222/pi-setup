// Background dispatcher, started by launchd every 60s under plain node (no Pi imports).
//
//   node dispatch.ts tick       run due jobs: record the slot, spawn a detached runner, exit
//   node dispatch.ts run <id>   one run: spawn `pi -p` in the job's cwd, enforce the timeout, notify
//
// Environment (written into the LaunchAgent plist by launchd.ts):
//   PI_SCHEDULE_DIR   job store directory
//   PI_SCHEDULE_PI    JSON argv prefix that starts Pi, e.g. ["/path/node", "/path/pi"]
//   PI_SCHEDULE_NOTIFY=0 disables macOS notifications (tests)
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lastDue } from "./parse.ts";
import { appendRun, claimJob, pruneRuns, readJobs, readLastRunAt, releaseJob, writeLastRunAt, type BackgroundJob, type RunRecord } from "./store.ts";

/** A slot this late still counts as on time: ticks are 60s apart and launchd may delay one. */
export const ON_TIME_MS = 2 * 60_000;
/** Catch-up looks back this far; an older missed slot is recorded as missed. */
export const LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** One-shots catch up only this late: "in 20m deploy staging" must not run days later on wake. */
export const ONCE_CATCH_UP_MS = 60 * 60_000;
const KILL_GRACE_MS = 10_000;
const OUTPUT_LIMIT = 8000;
const LOG_LIMIT = 1024 * 1024;

export interface Decision { job: BackgroundJob; slot: number; action: "run" | "missed" }

/**
 * Due work for one tick. Only the latest slot after the last recorded run counts, so a Mac
 * that was off for a week runs a daily job once, not seven times.
 */
export function decide(jobs: readonly BackgroundJob[], lastRunAt: (id: string) => number | undefined, now: number, onError: (job: BackgroundJob, error: unknown) => void = () => {}): Decision[] {
  const decisions: Decision[] = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    // One broken job (say, a hand-edited schedule) must not stop the others.
    let slot: number | undefined;
    try { slot = lastDue(job.schedule, now, Math.max(lastRunAt(job.id) ?? 0, job.createdAt, job.resumedAt ?? 0)); } catch (error) { onError(job, error); continue; }
    if (slot === undefined) continue;
    const late = now - slot;
    const limit = job.schedule.kind === "once" ? ONCE_CATCH_UP_MS : LOOKBACK_MS;
    const action = late <= ON_TIME_MS || (job.catchUp && late <= limit) ? "run" : "missed";
    decisions.push({ job, slot, action });
  }
  return decisions;
}

export const claimMaxAge = (job: BackgroundJob) => job.timeoutSec * 1000 + KILL_GRACE_MS + 60_000;

const scheduleDir = () => {
  const dir = process.env.PI_SCHEDULE_DIR;
  if (!dir) throw new Error("PI_SCHEDULE_DIR is not set.");
  return dir;
};

const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runners write here too (append mode, like launchd), so their outcome and crashes are visible. */
export function openLog(dir: string): number {
  mkdirSync(join(dir, "logs"), { recursive: true });
  return openSync(join(dir, "logs", "dispatch.log"), "a");
}

function tick(dir: string): void {
  // launchd appends to this file forever; keep it bounded.
  const logFile = join(dir, "logs", "dispatch.log");
  try { if (statSync(logFile).size > LOG_LIMIT) truncateSync(logFile, 0); } catch { /* no log yet */ }
  const now = Date.now();
  const due = decide(readJobs(dir), (id) => readLastRunAt(dir, id), now, (job, error) => log(`${job.id} cannot be scheduled: ${errorText(error)}`));
  if (!due.length) return;
  const output = openLog(dir);
  for (const { job, slot, action } of due) {
    // Record the slot before acting: a crash loses this run instead of repeating it.
    writeLastRunAt(dir, job.id, slot);
    if (action === "missed") {
      appendRun(dir, { id: job.id, status: "missed", slot, startedAt: now, endedAt: now, output: "Slot passed while the Mac was off or asleep; catch-up is off or too late." });
      log(`${job.id} missed slot ${new Date(slot).toISOString()}`);
      continue;
    }
    // Detached and unreferenced: the tick exits now, and the plist's AbandonProcessGroup keeps launchd from killing the runner.
    spawn(process.execPath, [fileURLToPath(import.meta.url), "run", job.id, String(slot)], { detached: true, stdio: ["ignore", output, output], env: process.env }).unref();
    log(`${job.id} started for slot ${new Date(slot).toISOString()}`);
  }
  closeSync(output);
}

function piCommand(): string[] {
  const value = JSON.parse(process.env.PI_SCHEDULE_PI ?? "null") as unknown;
  if (!Array.isArray(value) || !value.length || !value.every((part) => typeof part === "string")) throw new Error("PI_SCHEDULE_PI must be a JSON array of strings.");
  return value as string[];
}

const preview = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

interface Outcome { status: "ok" | "error" | "timeout"; output: string }

/** Process group of the running Pi, for the interrupt handler in run(). */
let activeGroup: number | undefined;

/** Run Pi in its own process group; on timeout, TERM then KILL the whole group. */
function execute(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolveOutcome) => {
    const [command, ...args] = argv;
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    activeGroup = child.pid;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    const signalGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* group gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    const finish = (code: number | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      activeGroup = undefined;
      // Pi may exit on TERM while a helper in its group ignores it; the KILL timer is unreferenced
      // and would die with this process, so finish the job now.
      if (timedOut) signalGroup("SIGKILL");
      // A descendant may still hold the pipes; release them so this runner can exit.
      child.stdout.destroy();
      child.stderr.destroy();
      const output = stdout.trim().slice(0, OUTPUT_LIMIT);
      if (timedOut) resolveOutcome({ status: "timeout", output: output || `Timed out after ${Math.round(timeoutMs / 1000)}s.` });
      else if (error || code !== 0) resolveOutcome({ status: "error", output: (error?.message ?? stderr.trim()) || `pi exited with code ${code}.` });
      else resolveOutcome({ status: "ok", output });
    };
    child.once("error", (error) => finish(null, error));
    // 'close' waits for the pipes; a detached descendant may hold them open, so bound the wait after 'exit'.
    child.once("close", (code) => finish(code));
    child.once("exit", (code) => { setTimeout(() => finish(code), 1000).unref(); });
  });
}

/** Notification text travels as argv, so no AppleScript quoting is needed. */
function notify(title: string, subtitle: string, body: string): void {
  if (process.env.PI_SCHEDULE_NOTIFY === "0") return;
  spawnSync("osascript", [
    "-e", "on run argv",
    "-e", "display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)",
    "-e", "end run",
    title, subtitle, body,
  ], { timeout: 5000, stdio: "ignore" });
}

async function run(dir: string, id: string, slot?: number): Promise<void> {
  const job = readJobs(dir).find((candidate) => candidate.id === id);
  if (!job) { log(`${id} not found`); return; }
  const startedAt = Date.now();
  const sessionId = randomUUID();
  const record = (fields: Pick<RunRecord, "status" | "output"> & { sessionId?: string }) =>
    appendRun(dir, { id, slot, startedAt, endedAt: Date.now(), ...fields });
  // Skip, never queue: a slow run must not pile up behind itself.
  if (!claimJob(dir, id, { pid: process.pid, startedAt, sessionId }, claimMaxAge(job))) {
    record({ status: "skipped", output: "Previous run was still in progress." });
    log(`${id} skipped: previous run still in progress`);
    return;
  }
  // Logout or shutdown: stop Pi and leave a record instead of a stale claim and silence.
  const interrupt = (signal: NodeJS.Signals) => {
    try { if (activeGroup) process.kill(-activeGroup, "SIGTERM"); } catch { /* group gone */ }
    record({ status: "error", output: `Interrupted by ${signal} (logout or shutdown).`, sessionId });
    releaseJob(dir, id);
    process.exit(1);
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGHUP", interrupt);
  // launchd cannot wake a sleeping Mac, but a started run must not be cut off by idle sleep.
  // -w ties the assertion to this runner, so it is released when the runner exits, even if killed.
  if (process.platform === "darwin") spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).on("error", () => {}).unref();
  try {
    let outcome: Outcome;
    try {
      if (!existsSync(job.cwd)) outcome = { status: "error", output: `Working directory not found: ${job.cwd}` };
      else {
        const argv = [...piCommand(), "-p", "--session-id", sessionId, "--name", `schedule ${id}: ${preview(job.prompt, 40)}`];
        if (job.model) argv.push("--model", job.model);
        if (job.tools) argv.push("--tools", job.tools);
        // `--` ends option parsing, so a prompt starting with "-" stays a prompt. Pi still reads an
        // argument starting with "@" as a file to attach; a leading space keeps it text.
        argv.push("--", job.prompt.startsWith("@") ? ` ${job.prompt}` : job.prompt);
        // PI_SCHEDULE_RUN makes the child's own copy of this extension stay inert.
        outcome = await execute(argv, job.cwd, { ...process.env, PI_SCHEDULE_RUN: id }, job.timeoutSec * 1000);
      }
    } catch (error) {
      outcome = { status: "error", output: `The runner failed: ${errorText(error)}` };
    }
    record({ status: outcome.status, output: outcome.output, sessionId });
    pruneRuns(dir, id);
    const late = slot !== undefined && startedAt - slot > ON_TIME_MS ? " (catch-up)" : "";
    notify(`Pi schedule ${id}: ${outcome.status}${late}`, `${basename(job.cwd)} - session ${sessionId.slice(0, 8)}`, preview(outcome.output, 200) || "(no output)");
    log(`${id} ${outcome.status} session ${sessionId}`);
  } finally {
    releaseJob(dir, id);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, id, slot] = argv;
  if (command === "tick") tick(scheduleDir());
  else if (command === "run" && id) await run(scheduleDir(), id, slot ? Number(slot) : undefined);
  else throw new Error("Usage: dispatch.ts tick | run <id> [slot]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
