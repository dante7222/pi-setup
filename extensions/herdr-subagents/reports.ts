import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomic, completion, jobs, json, locked, LIMIT, PAGE_BYTES, reportPage, save, status, type Completion, type Job, type Scope } from "./core.ts";
import type { WorkerProgress } from "./progress.ts";

export interface ReportPage {
  id: string;
  name: string;
  state: Completion["state"];
  /** UTF-16 offset, always at a Unicode code point boundary. */
  offset: number;
  next?: number;
  complete: boolean;
  text: string;
  receipt: string;
}

interface Receipt {
  format: 1;
  scope: string;
  id: string;
  version: string;
  offset: number;
  end: number;
  total: number;
}

// Keep acknowledgement and cursor in the same atomic job.json replacement. A
// separate acknowledgement write would lose idempotency on a parent crash.
interface ReportJob extends Job { reportAcknowledgements?: string[] }

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function report(scope: Scope, id: string): Promise<{ job: ReportJob; done: Completion; text: string; version: string }> {
  if (typeof id !== "string" || !/^[a-f0-9]{12}$/.test(id)) throw new Error("Invalid report job ID.");
  const job = await json<ReportJob>(join(scope.root, id, "job.json"));
  if (!job || job.id !== id) throw new Error("Unknown report job.");
  const done = await completion(scope, job);
  if (!done) throw new Error("Report is not complete yet.");
  return {
    job, done,
    text: `${done.error ? `${done.error}\n\n` : ""}${done.report || "(no final report)"}`,
    // Bind the immutable completion and job incarnation, not mutable progress.
    version: digest([1, job.id, job.created, job.task, done]),
  };
}

/** Caller holds the scope lock; the allowance includes the entire serialized page. */
async function issuePage(scope: Scope, id: string, offset: number | undefined, allowance: number): Promise<ReportPage> {
  const { job, done, text, version } = await report(scope, id);
  const start = offset === undefined ? job.cursor : offset;
  if (!Number.isSafeInteger(start) || start < 0 || start > text.length) throw new Error("Invalid report offset.");
  if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]) && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) {
    throw new Error("Report offset splits a Unicode code point.");
  }
  const page: ReportPage = {
    id, name: job.task.name, state: done.state, offset: start,
    next: text.length, complete: false, text: "", receipt: `${id}.${"0".repeat(64)}`,
  };
  // Include every serialized metadata field and reserve the largest possible
  // next offset; reportPage counts JSON escaping as well as UTF-8 bytes.
  const budget = allowance - Buffer.byteLength(JSON.stringify(page));
  if (budget < 0) throw new Error("Report metadata exceeds the page budget.");
  page.text = reportPage(text, start, budget);
  const end = start + page.text.length;
  if (start < text.length && end === start) throw new Error("Report page cannot make progress within the byte budget.");
  page.complete = end === text.length;
  if (page.complete) delete page.next;
  else page.next = end;
  const issued: Receipt = { format: 1, scope: scope.root, id, version, offset: start, end, total: text.length };
  page.receipt = `${id}.${digest(issued)}`;
  const directory = join(scope.root, id, "receipts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Content-addressing makes identical reads replay identically and avoids
  // unbounded receipt creation on retries. Possession alone is insufficient:
  // acknowledgements must find this exact previously issued private record.
  await atomic(join(directory, `${page.receipt}.json`), issued, true);
  return page;
}

/** Reading issues a private receipt, but never consumes report text. */
export async function readReport(scope: Scope, id: string, offset?: number): Promise<ReportPage> {
  return locked(scope, () => issuePage(scope, id, offset, PAGE_BYTES - 257));
}

export interface ReportBatch {
  reports: ReportPage[];
  errors: Array<{ id: string; error: string }>;
}

/** One page per job at its acknowledged cursor. Composite callers reserve their metadata too. */
export async function readManyReports(scope: Scope, ids: string[], signal?: AbortSignal, reservedBytes = 0): Promise<ReportBatch> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > LIMIT || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{12}$/.test(id))) {
    throw new Error("Expected 1..16 unique report job IDs.");
  }
  // Even a failed page needs space for its ID and a bounded error entry.
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > PAGE_BYTES - 256 - ids.length * 64) {
    throw new Error("Report metadata exceeds the batch budget.");
  }
  return locked(scope, async () => {
    const batch: ReportBatch = { reports: [], errors: [] };
    // Reserve the native tool/codemode envelope. Share remaining space fairly so
    // a large first report cannot starve the other requested jobs. Small reports
    // leave their unused share for later pages. No cursor is advanced here.
    const limit = PAGE_BYTES - 256 - reservedBytes;
    for (const [index, id] of ids.entries()) {
      signal?.throwIfAborted();
      const allowance = Math.floor((limit - Buffer.byteLength(JSON.stringify(batch))) / (ids.length - index)) - 1;
      try { batch.reports.push(await issuePage(scope, id, undefined, allowance)); }
      catch (error) {
        const entry = { id, error: "" };
        const message = error instanceof Error ? error.message : String(error);
        entry.error = reportPage(message, 0, allowance - Buffer.byteLength(JSON.stringify(entry)) - 3);
        if (entry.error.length < message.length) entry.error += "...";
        batch.errors.push(entry);
      }
    }
    signal?.throwIfAborted();
    return batch;
  }, signal);
}

export async function acknowledgeReport(scope: Scope, receipt: string, signal?: AbortSignal): Promise<{ id: string; collected: boolean; cursor: number }> {
  if (typeof receipt !== "string" || !/^[a-f0-9]{12}\.[a-f0-9]{64}$/.test(receipt)) throw new Error("Invalid report receipt.");
  return locked(scope, async () => {
    const id = receipt.slice(0, 12);
    const issued = await json<Receipt>(join(scope.root, id, "receipts", `${receipt}.json`));
    if (!issued || `${id}.${digest(issued)}` !== receipt || issued.format !== 1 || issued.scope !== scope.root || issued.id !== id) {
      throw new Error("Unknown or tampered report receipt.");
    }
    const { job, text, version } = await report(scope, id);
    if (issued.version !== version || issued.total !== text.length) throw new Error("Stale report receipt.");
    if (!job.reportAcknowledgements?.includes(receipt)) {
      if (issued.offset !== job.cursor) throw new Error("Report acknowledgements must be contiguous; stale or out-of-order receipt.");
      job.cursor = issued.end;
      job.collected = job.cursor === text.length;
      job.reportAcknowledgements = [...(job.reportAcknowledgements ?? []), receipt];
      await save(scope, job);
    }
    return { id, collected: job.collected === true, cursor: job.cursor };
  }, signal);
}

export interface PendingWorker {
  id: string;
  name: string;
  phase: WorkerProgress["phase"] | "queued" | "ending";
  /** Time since submission, including queue time; not active execution time. */
  elapsedSeconds: number;
  /** Last structured progress event, not a liveness heartbeat or stall diagnosis. */
  lastEventAgeSeconds?: number;
  tool?: string;
}
export interface ReportsReady {
  ready: string[];
  pending: number;
  warning?: string;
  pendingWorkers?: PendingWorker[];
  pendingWorkersOmitted?: number;
}

async function readiness(scope: Scope, details: boolean): Promise<ReportsReady> {
  const all = (await jobs(scope)).filter((job) => !job.collected);
  const completed = await Promise.all(all.map(async (job) => await completion(scope, job) ? job.id : undefined));
  // Unlisted ready jobs remain pending until a later bounded poll; historical
  // unread backlogs must not overflow a tool result.
  const ready = completed.filter((id): id is string => id !== undefined).slice(0, LIMIT);
  const result: ReportsReady = { ready, pending: all.length - ready.length };
  if (details) {
    const unfinished = all.filter((_job, index) => completed[index] === undefined);
    result.pendingWorkers = await Promise.all(unfinished.slice(0, LIMIT).map(async (job): Promise<PendingWorker> => {
      const directory = join(scope.root, job.id);
      const [progress, waiting] = await Promise.all([
        json<WorkerProgress>(join(directory, "progress.json")), json(join(directory, "waiting.json")),
      ]);
      const now = Date.now();
      const phase = progress && ["starting", "working", "tool", "retry", "compacting", "settled"].includes(progress.phase) ? progress.phase : "starting";
      return {
        id: job.id, name: reportPage(job.task.name, 0, 64),
        phase: job.endedAt !== undefined ? "ending" : waiting !== undefined ? "queued" : phase,
        elapsedSeconds: Number.isFinite(job.created) ? Math.max(0, Math.floor((now - job.created) / 1000)) : 0,
        ...(progress && Number.isFinite(progress.updatedAt) ? { lastEventAgeSeconds: Math.max(0, Math.floor((now - progress.updatedAt) / 1000)) } : {}),
        ...(typeof progress?.tool === "string" ? { tool: reportPage(progress.tool, 0, 100) } : {}),
      };
    }));
    if (unfinished.length > LIMIT) result.pendingWorkersOmitted = unfinished.length - LIMIT;
  }
  return result;
}

// status has no AbortSignal API. Race only the caller's waiting: reconciliation
// may finish afterward, but this module never cancels or closes worker processes.
async function cancellable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.race([operation, Promise.reject(signal.reason)]);
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Poll for unacknowledged immutable completions, without injecting reports. */
export async function waitForReports(scope: Scope, seconds: number, signal?: AbortSignal, details = false): Promise<ReportsReady> {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error("Wait seconds must be 0..60.");
  if (typeof details !== "boolean") throw new Error("Wait details must be boolean.");
  signal?.throwIfAborted();
  const deadline = Date.now() + seconds * 1000;
  let snapshot: ReportsReady = { ready: [], pending: 1 };
  let scanned = false;
  // A zero-second poll performs one reconciliation but no polling sleep. Its
  // I/O is bounded by core's lock/backend timeouts; positive waits also race
  // reconciliation against the requested deadline.
  const timeout = seconds > 0 ? AbortSignal.timeout(Math.max(0, Math.ceil(deadline - Date.now()))) : undefined;
  const waiting = timeout ? AbortSignal.any(signal ? [signal, timeout] : [timeout]) : signal;
  let nextReconcile = 0;
  let warning: string | undefined;
  try {
    snapshot = await cancellable(readiness(scope, details), waiting);
    scanned = true;
    if (snapshot.ready.length || !snapshot.pending) return snapshot;
    while (true) {
      if (Date.now() >= nextReconcile) {
        try { await cancellable(status(scope), waiting); warning = undefined; }
        catch (error) {
          waiting?.throwIfAborted();
          warning = reportPage(String(error), 0, 1500);
        }
        nextReconcile = Date.now() + 5000;
      }
      // Reconciliation can publish a synthetic final or discover recovery.
      snapshot = await cancellable(readiness(scope, details), waiting);
      if (snapshot.ready.length || !snapshot.pending || Date.now() >= deadline) {
        return { ...snapshot, ...(warning ? { warning } : {}) };
      }
      await delay(Math.max(0, Math.min(250, deadline - Date.now())), undefined, { signal: waiting });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!timeout?.aborted) throw error;
    if (!scanned) warning = "Initial readiness scan exceeded the wait deadline; pending is unknown (reported as 1). Poll again.";
    return { ...snapshot, ...(warning ? { warning } : {}) };
  }
}
