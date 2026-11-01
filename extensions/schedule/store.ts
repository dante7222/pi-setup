// Background job store. No Pi imports: the launchd dispatcher runs this under plain node.
//
// Files are replaced atomically (temp file + rename) and have few writers, so there is no global lock:
//   jobs.json          /schedule in any Pi window (read-modify-write in one synchronous step)
//   state/<id>.json    the dispatcher tick (lastRunAt)
//   running/<id>.json  the runner holding the job (atomic exclusive create, see claimJob)
//   runs/<id>.jsonl    runners and the tick append; the claim holder prunes
import { appendFileSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Schedule } from "./parse.ts";

export interface BackgroundJob {
  id: string;
  prompt: string;
  cwd: string;
  schedule: Schedule;
  enabled: boolean;
  /** Run once for the latest slot missed while the Mac was off or asleep. */
  catchUp: boolean;
  timeoutSec: number;
  /** `provider/id[:thinking]`, passed to `pi --model`. */
  model?: string;
  /** Comma-separated allowlist, passed to `pi --tools`. */
  tools?: string;
  createdAt: number;
  /** Set on resume: slots that passed while paused are not caught up. */
  resumedAt?: number;
}

export type RunStatus = "ok" | "error" | "timeout" | "skipped" | "missed";

export interface RunRecord {
  id: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number;
  /** Scheduled slot; absent for manual runs. */
  slot?: number;
  sessionId?: string;
  /** Final assistant text (capped) or the reason for skipping/failing. */
  output?: string;
}

export interface Claim { pid: number; startedAt: number; sessionId: string }

const RUNS_KEPT = 100;

const jobsFile = (dir: string) => join(dir, "jobs.json");
const stateFile = (dir: string, id: string) => join(dir, "state", `${id}.json`);
const claimFile = (dir: string, id: string) => join(dir, "running", `${id}.json`);
const runsFile = (dir: string, id: string) => join(dir, "runs", `${id}.jsonl`);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Write to a temp file, then rename: readers never see a half-written file. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

/** Corrupt JSON throws rather than reading as empty: a later write would otherwise wipe every job. */
export function readJobs(dir: string): BackgroundJob[] {
  const data = readJson(jobsFile(dir)) as { jobs?: unknown } | undefined;
  return Array.isArray(data?.jobs) ? data.jobs as BackgroundJob[] : [];
}

export function writeJobs(dir: string, jobs: BackgroundJob[]): void {
  writeJson(jobsFile(dir), { jobs });
}

/** A torn or corrupt state file reads as "never ran" instead of stopping every job. */
export function readLastRunAt(dir: string, id: string): number | undefined {
  let data: { lastRunAt?: unknown } | undefined;
  try { data = readJson(stateFile(dir, id)) as typeof data; } catch { return undefined; }
  return typeof data?.lastRunAt === "number" ? data.lastRunAt : undefined;
}

export function writeLastRunAt(dir: string, id: string, lastRunAt: number): void {
  writeJson(stateFile(dir, id), { lastRunAt });
}

export function appendRun(dir: string, record: RunRecord): void {
  const path = runsFile(dir, record.id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export function readRuns(dir: string, id: string, limit = RUNS_KEPT): RunRecord[] {
  let text: string;
  try { text = readFileSync(runsFile(dir, id), "utf8"); } catch { return []; }
  const records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as RunRecord); } catch { /* torn line */ }
  }
  return records.slice(-limit);
}

/** Keep the newest records. Called only by the claim holder, the job's single runner. */
export function pruneRuns(dir: string, id: string): void {
  const records = readRuns(dir, id, Infinity);
  if (records.length <= RUNS_KEPT) return;
  const path = runsFile(dir, id);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, records.slice(-RUNS_KEPT).map((record) => `${JSON.stringify(record)}\n`).join(""));
  renameSync(temp, path);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * The live claim for a job, or undefined. A claim older than `maxAgeMs` is stale even if
 * its pid is alive: runners always stop at their timeout, so the pid was reused.
 */
export function readClaim(dir: string, id: string, maxAgeMs: number): Claim | undefined {
  let claim: Claim | undefined;
  try { claim = readJson(claimFile(dir, id)) as Claim | undefined; } catch { return undefined; }
  if (!claim || typeof claim.pid !== "number") return undefined;
  return alive(claim.pid) && Date.now() - claim.startedAt < maxAgeMs ? claim : undefined;
}

/**
 * At most one runner per job. The claim is written to a temp file and hard-linked into place, so it
 * appears atomically with its content (an empty, half-written claim would look stale). Replaces a
 * stale claim once.
 */
export function claimJob(dir: string, id: string, claim: Claim, maxAgeMs: number): boolean {
  const path = claimFile(dir, id);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(claim));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(temp, path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (readClaim(dir, id, maxAgeMs)) return false;
        rmSync(path, { force: true });
      }
    }
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function releaseJob(dir: string, id: string, pid = process.pid): void {
  const path = claimFile(dir, id);
  try {
    if ((readJson(path) as Claim | undefined)?.pid === pid) rmSync(path, { force: true });
  } catch { /* already gone or unreadable */ }
}

/** Remove everything the job left behind except a live claim. */
export function forgetJob(dir: string, id: string): void {
  rmSync(stateFile(dir, id), { force: true });
  rmSync(runsFile(dir, id), { force: true });
}
