import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcProcess, RpcTimeoutError, type Invocation, type RpcEvent } from "./rpc.ts";
import { expandHome, NAME, rpcArgs, systemPrompt, type Task } from "./tasks.ts";

export type WorkerState = "queued" | "running" | "idle" | "failed" | "stopped";

export interface Report {
  name: string;
  state: "done" | "failed" | "cancelled";
  text: string;
  error?: string;
  /** Full report text on disk; one file per run. */
  path: string;
  /** Worker session; tells a replaced worker's reports from its same-name successor's. */
  sessionId: string;
  /** Delivery batch: one `run` call, or one `send` that started a new run. */
  batch: number;
  seconds: number;
  tokens: number;
  cost: number;
  /** Absolute paths the run changed through edit/write. Absent in reports of a manager that predates it, adopted across /reload. */
  files?: readonly string[];
  /** Edited paths that subagents running at the same time also edited, with their names. */
  overlaps?: Record<string, string[]>;
  /** The run was asked to wrap up before its deadline. */
  partial?: boolean;
}

export interface Limits {
  /** Workers with a run in progress. Further runs wait in a FIFO queue. */
  maxRunning: number;
  /** Per-run deadline. */
  runTimeoutMs: number;
  /** This long before the deadline, a running worker is steered to stop and report; 0 disables. */
  wrapUpMs: number;
  /** Idle worker processes exit after this; `send` restarts them from their session. */
  idleMs: number;
  /** After abort, a run that has not settled within this is ended by closing the process. */
  abortGraceMs: number;
  /** `send` stops waiting for a steer reply after this and reports "sent". */
  steerReplyMs: number;
  /** Finished workers that keep their process for a fast `send`; beyond it the longest-idle process is closed. */
  maxIdle: number;
  /** Assistant turns per run after which the worker is steered to stop and report; 0 disables. */
  maxTurns: number;
  /** Turns a run may take after that steer before it is ended. */
  wrapUpTurns: number;
  /** A closing process gets this long to exit after stdin EOF before SIGTERM, and as long again before SIGKILL. */
  closeGraceMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRunning: 6, runTimeoutMs: 30 * 60_000, wrapUpMs: 5 * 60_000, idleMs: 10 * 60_000, abortGraceMs: 10_000, steerReplyMs: 15_000,
  maxIdle: 4, maxTurns: 150, wrapUpTurns: 10, closeGraceMs: 5000,
};

interface Usage { tokens: number; cost: number }

export class Worker {
  readonly task: Task;
  readonly sessionId: string;
  state: WorkerState = "queued";
  rpc: RpcProcess | undefined;
  /** Processes of this worker that are still shutting down; a new one waits, so two never share the session. */
  closing: Promise<void> | undefined;
  /** Message for the next run; also collects messages sent while a run is ending. */
  pendingPrompt: string;
  /** The child emitted agent_start for the current run (abort is effective only then). */
  runActive = false;
  /** Steer prompts sent but not yet answered; one may start a run after settlement. */
  steersInFlight = 0;
  /** A stop arrived while a steer was in flight: a run it starts is cancelled at once. */
  cancelNextStart: string | undefined;
  runs = 0;
  /** Delivery batch of the current or next run. */
  batch = 0;
  tool: string | undefined;
  /** Tokens in the current context, from the latest response or compaction; survives runs. */
  contextTokens: number | undefined;
  runStarted = 0;
  /** Assistant messages of the current run. */
  turns = 0;
  run: Usage = { tokens: 0, cost: 0 };
  total: Usage = { tokens: 0, cost: 0 };
  lastAssistant: Record<string, unknown> | undefined;
  /** Latest non-empty assistant text of the run, kept when a run is aborted. */
  lastText = "";
  /** Files the current or latest run changed through edit/write (absolute paths). */
  readonly edited = new Set<string>();
  /** edit/write calls in flight by tool call id; a path counts once its call succeeded. */
  readonly pendingEdits = new Map<string, string>();
  /** The current run was steered to wrap up before its deadline or turn limit. */
  wrappedUp = false;
  /** Acknowledgement that the wrap-up steer was processed, not merely written to stdin. */
  wrapUpRequest: Promise<unknown> | undefined;
  /** The previous run's wrap-up steer and queue clear must finish before another prompt. */
  wrapUpCleanup: Promise<void> | undefined;
  report: Report | undefined;
  /** When the latest run ended; the widget shows finished workers briefly. */
  finishedAt: number | undefined;
  /** Set by the parent (stop, timeout); overrides the outcome of the current run. */
  endReason: { state: "cancelled" | "failed"; error: string } | undefined;
  timer: NodeJS.Timeout | undefined;
  escalation: NodeJS.Timeout | undefined;
  wrapTimer: NodeJS.Timeout | undefined;

  constructor(task: Task, sessionId: string) {
    this.task = task;
    this.sessionId = sessionId;
    this.pendingPrompt = task.task;
  }
}

export interface ManagerHooks {
  /** A worker finished a run; its report is in the outbox. */
  report(report: Report): void;
  changed(): void;
}

function timer(callback: () => void, ms: number): NodeJS.Timeout {
  const handle = setTimeout(callback, ms);
  handle.unref();
  return handle;
}

function clearTimers(worker: Worker): void {
  clearTimeout(worker.timer);
  clearTimeout(worker.escalation);
  clearTimeout(worker.wrapTimer);
  worker.timer = worker.escalation = worker.wrapTimer = undefined;
}

/** `{report:name}` in a task or message; a leading backslash keeps it as text. */
const REPORT_REF = new RegExp(`(\\\\?)\\{report:(${NAME})\\}`, "g");

/** Pi's edit/write path resolution: an optional leading @, ~ for home, otherwise relative to cwd. */
function editedPath(path: string, cwd: string): string {
  return resolve(cwd, expandHome(path.startsWith("@") ? path.slice(1) : path));
}

/** Pi runs a prompt that starts with "/" as a command, skill or template; a leading space keeps it a message. */
function plain(message: string): string {
  return message.startsWith("/") ? ` ${message}` : message;
}

function assistantText(message: Record<string, unknown> | undefined): string {
  const content = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : [];
  return content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n").trim();
}

/** Classifies the end of a run from its final assistant message. */
export function classify(message: Record<string, unknown> | undefined, aborted: boolean): { state: Report["state"]; error?: string } {
  const content = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : [];
  if (aborted || message?.stopReason === "aborted") return { state: "cancelled", error: "Run aborted." };
  if (!message) return { state: "failed", error: "No assistant reply." };
  if (message.stopReason === "error") return { state: "failed", error: typeof message.errorMessage === "string" ? message.errorMessage : "Provider error." };
  if (message.stopReason !== "stop" || content.some((part) => part.type === "toolCall")) return { state: "failed", error: `Stopped before completing (${String(message.stopReason)}).` };
  if (!assistantText(message)) return { state: "failed", error: "No final text report." };
  return { state: "done" };
}

/**
 * Owns all workers of one parent session. Workers are `pi --mode rpc` children;
 * each keeps its own session file, so it can be continued after a report and
 * revived after an idle shutdown.
 *
 * A run is tracked from `startRun` (or an unsolicited `agent_start`) until
 * `agent_settled`, process exit, or a failed prompt; `finish` publishes exactly
 * one report per run. Events from a replaced process are ignored (`worker.rpc`).
 */
export class SubagentManager {
  readonly workers = new Map<string, Worker>();
  /** Reports not yet consumed by `wait` or taken by the host for delivery. */
  readonly outbox: Report[] = [];
  private readonly queue: Worker[] = [];
  private batches = 0;
  private readonly waiters = new Set<() => void>();
  private disposed = false;
  private readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;
  private hooks: ManagerHooks;
  private readonly promptExtension: string;
  private readonly invocation: Invocation | undefined;
  readonly limits: Limits;

  constructor(options: { dir: string; env: NodeJS.ProcessEnv; hooks: ManagerHooks; promptExtension: string; limits?: Partial<Limits>; invocation?: Invocation }) {
    this.dir = options.dir;
    this.env = options.env;
    this.hooks = options.hooks;
    this.promptExtension = options.promptExtension;
    this.invocation = options.invocation;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  /** Replace host callbacks, e.g. after an extension reload. */
  setHooks(hooks: ManagerHooks): void { this.hooks = hooks; }

  get running(): number {
    return [...this.workers.values()].filter((worker) => worker.state === "running").length;
  }

  /** Names that a new `run` may not take: workers that are queued, running, or may still start a run. */
  busyNames(): Set<string> {
    return new Set([...this.workers.values()].filter((worker) => worker.state === "queued" || worker.state === "running" || worker.steersInFlight > 0).map((worker) => worker.task.name));
  }

  /** Start new workers. A finished worker with the same name is replaced; its session file stays on disk. */
  spawn(tasks: readonly Task[]): Worker[] {
    if (this.disposed) throw new Error("Subagents are shut down for this session.");
    const busy = this.busyNames();
    const clash = tasks.find((task) => busy.has(task.name));
    if (clash) throw new Error(`Name "${clash.name}" is already in use.`);
    // Before same-name workers are replaced: a task may cite the report of the worker it replaces.
    const expanded = tasks.map((task) => ({ ...task, task: this.expand(task.task) }));
    for (const task of expanded) {
      const old = this.workers.get(task.name);
      if (!old) continue;
      clearTimers(old);
      const rpc = old.rpc;
      old.rpc = undefined;
      if (rpc) void rpc.close();
    }
    const batch = ++this.batches;
    const created = expanded.map((task) => {
      const worker = new Worker(task, `sub-${task.name}-${Date.now().toString(36)}`);
      worker.batch = batch;
      this.workers.set(task.name, worker);
      this.queue.push(worker);
      return worker;
    });
    this.schedule();
    this.hooks.changed();
    return created;
  }

  /**
   * Replace each `{report:name}` with that subagent's latest full report, so results pass
   * between subagents without the parent reading and restating them.
   */
  expand(text: string): string {
    return text.replace(REPORT_REF, (match, escaped: string, name: string) => {
      if (escaped) return match.slice(1);
      const report = this.workers.get(name)?.report;
      if (!report) throw new Error(`{report:${name}}: "${name}" has no finished report. For the literal text write \\{report:${name}}.`);
      return `<report from="${name}">\n${report.text}\n</report>`;
    });
  }

  get(name: string): Worker {
    const worker = this.workers.get(name);
    if (!worker) throw new Error(`No subagent named "${name}". Known: ${[...this.workers.keys()].join(", ") || "none"}.`);
    return worker;
  }

  /**
   * Steer a running worker, or start a new run with full history for any other state.
   * A steer is answered after Pi's preflight, which can compact for minutes when it
   * starts a run; past `limits.steerReplyMs` or on abort this returns "sent" and the
   * reply is still tracked in the background.
   */
  async send(name: string, message: string, signal?: AbortSignal): Promise<"steered" | "queued" | "started" | "sent"> {
    if (this.disposed) throw new Error("Subagents are shut down for this session.");
    const worker = this.get(name);
    const text = this.expand(message);
    const append = () => { worker.pendingPrompt = [worker.pendingPrompt, text].filter(Boolean).join("\n\n"); };
    // A queued worker, a run still starting (a second prompt could start a parallel
    // run inside Pi's preflight), or a run already wrapping up/stopping takes the message next.
    if (worker.state === "queued" || (worker.state === "running" && (!worker.runActive || worker.wrappedUp || worker.endReason || !worker.rpc?.alive))) {
      append();
      return "queued";
    }
    // An unanswered steer may be starting a run inside Pi's preflight, where a bare prompt
    // is rejected as busy; this message runs after it is reconciled.
    if (worker.state !== "running" && worker.steersInFlight > 0) {
      append();
      return "queued";
    }
    if (worker.state === "running" && worker.rpc) {
      // A prompt with steer behaviour, unlike a bare steer, also starts a run when the
      // child settled before this arrived; the unsolicited agent_start is then tracked.
      worker.steersInFlight++;
      let started = false;
      // Buffered output can deliver this prompt's whole run (agent_start through
      // agent_settled) before the response is processed; that run is already tracked.
      const runsBefore = worker.runs;
      const rpc = worker.rpc;
      const reply = (async () => { try {
        // When the child already settled, the prompt starts a run and Pi replies only after
        // its preflight, which may compact first; a short deadline would misreport that.
        let data: { disposition?: string } | undefined;
        try {
          data = await rpc.request<{ disposition?: string }>({ type: "prompt", message: plain(text), streamingBehavior: "steer" }, this.limits.runTimeoutMs);
        } catch (error) {
          // An error response (e.g. compaction in progress) means nothing started. A child that
          // did not answer may still start the run, unseen and past any stop: discard it, and
          // end a tracked run here because the exit handler ignores a detached process.
          if (error instanceof RpcTimeoutError && worker.rpc === rpc) {
            if (worker.state === "running") this.failRun(worker, rpc, error.message);
            else this.release(worker);
          }
          throw error;
        }
        if (data?.disposition === "handled") throw new Error("A worker extension consumed the message; it did not reach the subagent.");
        started = data?.disposition === "started";
        // The child settled before this arrived, so the prompt started a new run. Track it
        // now: its agent_start may come in a later stdout chunk, and until then the worker
        // must not look idle to wait/stop. A stop made while it was in flight cancels it.
        if (started && worker.state !== "running" && worker.rpc && worker.runs === runsBefore) {
          this.dequeue(worker);
          worker.batch = ++this.batches;
          this.beginRun(worker);
          worker.runActive = false;
          if (worker.cancelNextStart) worker.endReason = { state: "cancelled", error: worker.cancelNextStart };
          worker.cancelNextStart = undefined;
          this.hooks.changed();
        }
        return started ? "started" as const : "steered" as const;
      } finally {
        worker.steersInFlight--;
        // A started prompt's agent_start may arrive in a later stdout chunk; it consumes
        // the pending cancel then. Otherwise no run can come from it, so drop the cancel.
        if (!started && !worker.steersInFlight && worker.state !== "running") worker.cancelNextStart = undefined;
        if (!worker.steersInFlight && worker.state !== "running" && worker.state !== "queued") {
          // Messages sent while the steer was unanswered start the next run; otherwise
          // restore the idle shutdown the timer skipped meanwhile.
          if (worker.pendingPrompt && !this.disposed) this.enqueue(worker);
          else this.armIdle(worker);
        }
        // Waits count an in-flight steer as pending; let them re-check.
        this.wake();
      } })();
      // Settled in the background when the caller stops waiting.
      reply.catch(() => {});
      let release: (() => void) | undefined;
      const gaveUp = new Promise<"sent">((resolve) => {
        const done = () => { clearTimeout(handle); signal?.removeEventListener("abort", done); resolve("sent"); };
        const handle = setTimeout(done, this.limits.steerReplyMs);
        handle.unref();
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
        release = done;
      });
      try { return await Promise.race([reply, gaveUp]); } finally { release?.(); }
    }
    append();
    worker.endReason = undefined;
    this.enqueue(worker);
    return (worker.state as WorkerState) === "running" ? "started" : "queued";
  }

  stop(names: readonly string[], reason = "Stopped by parent."): string[] {
    // Validate first: an unknown name must not leave earlier names stopped without wake/changed.
    const workers = names.map((name) => this.get(name));
    const stopped: string[] = [];
    for (const worker of workers) {
      const name = worker.task.name;
      if (worker.state === "queued") {
        worker.state = "stopped";
        // A worker that never ran keeps its task, so a later `send` adds to it instead of replacing it.
        if (worker.runs > 0) worker.pendingPrompt = "";
        this.dequeue(worker);
        // A queued continuation may hold an idle process; restore its idle shutdown.
        this.armIdle(worker);
        stopped.push(name);
      } else if (worker.state === "running") {
        worker.pendingPrompt = "";
        if (worker.steersInFlight) worker.cancelNextStart = reason;
        this.end(worker, { state: "cancelled", error: reason });
        stopped.push(name);
      } else if (worker.steersInFlight && worker.rpc) {
        // Settled, but a steer prompt in flight may still start a run: cancel it on start.
        worker.cancelNextStart = reason;
        worker.pendingPrompt = "";
        stopped.push(name);
      } else {
        // Nothing to cancel: free the idle process. `send` revives the session.
        this.release(worker);
      }
    }
    if (stopped.length) { this.wake(); this.hooks.changed(); }
    return stopped;
  }

  /**
   * Resolve with undelivered reports for `names` (all workers when empty). By default
   * returns as soon as one exists; with `all`, once none of them is queued, running,
   * or awaiting a steer reply.
   * Either way it returns at the deadline, on abort, or when nothing more can arrive.
   */
  async wait(names: readonly string[], seconds: number, signal?: AbortSignal, all = false): Promise<{ reports: Report[]; pending: string[] }> {
    for (const name of names) this.get(name);
    const targets = (worker: Worker) => names.length === 0 || names.includes(worker.task.name);
    // A named wait targets the current worker only; reports of a replaced same-name worker
    // stay for automatic delivery.
    const matches = (report: Report) => names.length === 0 || (names.includes(report.name) && this.workers.get(report.name)?.sessionId === report.sessionId);
    const pending = () => [...this.workers.values()].filter((worker) => targets(worker) && (worker.state === "queued" || worker.state === "running" || worker.steersInFlight > 0)).map((worker) => worker.task.name);
    const deadline = Date.now() + seconds * 1000;
    const satisfied = () => all ? !pending().length : this.outbox.some(matches) || !pending().length;
    while (!satisfied() && Date.now() < deadline && !signal?.aborted && !this.disposed) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(handle); signal?.removeEventListener("abort", done); this.waiters.delete(done); resolve(); };
        const handle = setTimeout(done, Math.max(0, deadline - Date.now()));
        signal?.addEventListener("abort", done, { once: true });
        this.waiters.add(done);
      });
    }
    return { reports: this.take(matches), pending: pending() };
  }

  /** A report is ready for automatic delivery once no other run of its batch is queued or running. */
  isReady(report: Report): boolean {
    for (const worker of this.workers.values()) {
      if (worker.batch === report.batch && (worker.state === "queued" || worker.state === "running")) return false;
    }
    return true;
  }

  /** Remove and return outbox reports, oldest first. */
  take(filter: (report: Report) => boolean = () => true): Report[] {
    const taken: Report[] = [];
    for (let index = 0; index < this.outbox.length;) {
      if (filter(this.outbox[index])) taken.push(...this.outbox.splice(index, 1));
      else index++;
    }
    return taken;
  }

  /** Stop everything; resolves once worker processes exited or were signalled. */
  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    const closing: Promise<void>[] = [];
    for (const worker of this.workers.values()) {
      clearTimers(worker);
      if (worker.state === "queued" || worker.state === "running") worker.state = "stopped";
      const rpc = worker.rpc;
      worker.rpc = undefined;
      if (rpc) closing.push(rpc.close());
    }
    this.queue.length = 0;
    this.wake();
    return Promise.all(closing).then(() => {});
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /** Queue a continuation (a `send`), which forms its own delivery batch. */
  private enqueue(worker: Worker): void {
    clearTimers(worker);
    worker.batch = ++this.batches;
    worker.state = "queued";
    // The previous outcome no longer describes this worker; a stopped continuation must not show it.
    worker.finishedAt = undefined;
    this.queue.push(worker);
    this.schedule();
    this.hooks.changed();
  }

  /** A queued worker whose child started a run on its own runs that instead of its queue slot. */
  private dequeue(worker: Worker): void {
    const index = this.queue.indexOf(worker);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private schedule(): void {
    while (!this.disposed && this.queue.length && this.running < this.limits.maxRunning) void this.startRun(this.queue.shift()!);
  }

  /** Close the worker's process after the idle period; `send` revives it from its session. */
  private armIdle(worker: Worker): void {
    const rpc = worker.rpc;
    if (!rpc || worker.wrapUpCleanup) return;
    clearTimeout(worker.timer);
    worker.timer = timer(() => {
      // A steer in flight may be starting a run inside a slow preflight; it re-arms when answered.
      if (worker.rpc !== rpc || worker.state === "running" || worker.state === "queued" || worker.steersInFlight) return;
      this.release(worker);
      this.hooks.changed();
    }, this.limits.idleMs);
    // A wide run must not leave a process per subagent behind for the whole idle period.
    const idle = [...this.workers.values()]
      .filter((other) => other.rpc?.alive && other.state !== "running" && other.state !== "queued" && !other.steersInFlight && !other.wrapUpCleanup)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const other of idle.slice(0, Math.max(0, idle.length - this.limits.maxIdle))) this.release(other);
  }

  /** Detach the worker's process and close it. Its next run waits for the exit (`closing`). */
  private release(worker: Worker): void {
    const rpc = worker.rpc;
    if (!rpc) return;
    worker.rpc = undefined;
    const closing: Promise<void> = Promise.all([worker.closing, rpc.close()]).then(() => { if (worker.closing === closing) worker.closing = undefined; });
    worker.closing = closing;
  }

  /** Reset per-run tracking; shared by requested runs and unsolicited ones. */
  private beginRun(worker: Worker): void {
    clearTimers(worker);
    worker.state = "running";
    worker.runs++;
    worker.runStarted = Date.now();
    worker.turns = 0;
    worker.run = { tokens: 0, cost: 0 };
    worker.lastAssistant = undefined;
    worker.lastText = "";
    worker.tool = undefined;
    worker.report = undefined;
    worker.edited.clear();
    worker.pendingEdits.clear();
    worker.wrappedUp = false;
    worker.wrapUpRequest = undefined;
    worker.timer = timer(() => this.end(worker, { state: "failed", error: `Timed out after ${Math.round(this.limits.runTimeoutMs / 1000)}s.` }), this.limits.runTimeoutMs);
    const wrapAt = this.limits.runTimeoutMs - this.limits.wrapUpMs;
    if (this.limits.wrapUpMs > 0 && wrapAt > 0) worker.wrapTimer = timer(() => this.wrapUp(worker), wrapAt);
  }

  /** Ask a run nearing its deadline or turn limit for its report, so the limit does not discard the work. */
  private wrapUp(worker: Worker, limit: "time" | "turn" = "time"): void {
    const rpc = worker.rpc;
    // Only a started run takes a steer; a run that is ending or already asked needs none.
    if (worker.state !== "running" || !worker.runActive || worker.wrappedUp || worker.endReason || !rpc?.alive) return;
    // An ordinary steer can start another run across settlement. Let it reconcile
    // first; after wrap-up is issued, send() queues messages locally instead.
    if (worker.steersInFlight) {
      const run = worker.runs;
      worker.wrapTimer = timer(() => { if (worker.runs === run) this.wrapUp(worker, limit); }, 100);
      return;
    }
    worker.wrappedUp = true;
    worker.wrapUpRequest = rpc.request({ type: "steer", message: `Your ${limit} limit is almost reached. Stop starting new work and reply now with your final report: what is done, what remains, and any risks.` }, 5000);
    // Keep rejection observable to cleanup even if the run has not settled yet.
    void worker.wrapUpRequest.catch(() => {});
  }

  /** Clear only after Pi processed the steer; command handlers are concurrent. */
  private async clearWrapUp(worker: Worker, rpc: RpcProcess, request: Promise<unknown>): Promise<void> {
    try {
      await request;
      if (worker.rpc === rpc) await rpc.request({ type: "clear_queue" }, 2000);
    } catch {
      // A failed or unanswered request leaves the child's queues uncertain. Close
      // this process before a continuation can revive the session in a fresh one.
      if (worker.rpc === rpc) this.release(worker);
      await rpc.close();
    }
  }

  private async startRun(worker: Worker): Promise<void> {
    this.beginRun(worker);
    worker.runActive = false;
    const run = worker.runs;
    const cleanup = worker.wrapUpCleanup;
    const message = worker.pendingPrompt;
    worker.pendingPrompt = "";
    const current = () => !this.disposed && this.workers.get(worker.task.name) === worker && worker.runs === run && worker.state === "running";
    // Reserve the running slot while waiting, so the concurrency limit still holds.
    if (cleanup) await cleanup;
    if (!current()) return;
    // Cleanup may detach the child before its exit callback can finish this run,
    // or acknowledge while stop's close is still in progress. Never expose that
    // closing process to another continuation when publishing cancellation.
    if (worker.endReason) {
      const reason = worker.endReason;
      const rpc = worker.rpc;
      worker.rpc = undefined;
      if (rpc) await rpc.close();
      if (current()) this.finish(worker, reason);
      return;
    }
    // A process that is shutting down takes no prompt (e.g. a settlement that was already
    // buffered when a stop closed it), and its successor must not open the session beside it.
    if (worker.rpc && !worker.rpc.alive) this.release(worker);
    if (worker.closing) {
      await worker.closing;
      // A stop during the wait found no process and ended the run.
      if (!current()) return;
    }
    if (!worker.rpc?.alive) {
      try { worker.rpc = this.launch(worker); }
      catch (error) {
        // A synchronous failure (e.g. the session dir cannot be created) has no exit event
        // to end the run, and must not escape schedule(), which runs from event handlers.
        this.finish(worker, { state: "failed", error: `Could not start worker: ${error instanceof Error ? error.message : String(error)}` });
        // Restored after finish(), which would otherwise retry it at once; a later send retries it.
        worker.pendingPrompt = message;
        return;
      }
    }
    const rpc = worker.rpc;
    // Pi replies after preflight, which includes extension loading on a fresh process and
    // may compact a revived session; the run timeout already bounds the whole run.
    rpc.request<{ disposition?: string }>({ type: "prompt", message: plain(message) }, this.limits.runTimeoutMs).then((data) => {
      if (data?.disposition === "handled") this.failRun(worker, rpc, "Prompt was handled without starting a run.");
      else if (data?.disposition === "queued") this.failRun(worker, rpc, "Worker was unexpectedly busy.");
    }, (error: unknown) => {
      // A dead process is reported by the exit handler, which has the stderr tail.
      if (rpc.alive) this.failRun(worker, rpc, error instanceof Error ? error.message : String(error));
    });
  }

  /** End a run that cannot settle normally; the process is discarded so nothing runs unseen. */
  private failRun(worker: Worker, rpc: RpcProcess, error: string): void {
    if (worker.rpc !== rpc || worker.state !== "running") return;
    this.release(worker);
    this.finish(worker, { state: "failed", error });
  }

  /**
   * Parent-requested end (stop, timeout). Before agent_start, Pi's abort is a no-op
   * and the prompt would still start, so the process is closed instead; the exit
   * handler then publishes the report. After it, abort keeps the process and session.
   */
  private end(worker: Worker, reason: { state: "cancelled" | "failed"; error: string }): void {
    if (worker.state !== "running" || worker.endReason) return;
    worker.endReason = reason;
    const rpc = worker.rpc;
    // Without a process nothing can settle the run; end it here.
    if (!rpc) { this.finish(worker, reason); return; }
    if (!worker.runActive) { void rpc.close(); return; }
    clearTimeout(worker.escalation);
    // Cleared in finish(): only settlement proves the run ended.
    worker.escalation = timer(() => { if (worker.rpc === rpc) void rpc.close(); }, this.limits.abortGraceMs);
    // Clear first: abort alone lets queued steering continue the run. The run may
    // settle meanwhile and a queued follow-up start; never abort that next run.
    const run = worker.runs;
    void rpc.request({ type: "clear_queue" }, 2000).catch(() => {})
      .then(() => {
        if (worker.rpc === rpc && worker.runs === run && worker.state === "running") return rpc.request({ type: "abort" }, this.limits.abortGraceMs);
      }).catch(() => {});
  }

  private launch(worker: Worker): RpcProcess {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...this.env, PI_SUBAGENT: "1", PI_SUBAGENT_PROMPT: systemPrompt(worker.task.role), PI_SKIP_VERSION_CHECK: "1" };
    // These describe the parent session to its shell tools; a worker has its own.
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
    const args = rpcArgs(worker.task, { id: worker.sessionId, dir: this.dir }, this.promptExtension);
    const rpc = new RpcProcess(args, { cwd: worker.task.cwd, env, invocation: this.invocation, graceMs: this.limits.closeGraceMs }, (event) => this.event(worker, rpc, event));
    void rpc.exited.then((exit) => {
      // Descendants can outlive the leader, e.g. after a crash; sweep the group.
      void rpc.close();
      if (worker.rpc !== rpc) return;
      worker.rpc = undefined;
      if (worker.state === "running") {
        const detail = exit.stderr.trim().split("\n").slice(-8).join("\n").slice(-800);
        this.finish(worker, { state: "failed", error: `Worker exited (${exit.signal ?? exit.code})${detail ? `: ${detail}` : "."}` });
      } else {
        clearTimers(worker);
        this.hooks.changed();
      }
    });
    return rpc;
  }

  private event(worker: Worker, rpc: RpcProcess, event: RpcEvent): void {
    if (worker.rpc !== rpc) return;
    switch (event.type) {
      case "agent_start":
        // A steer that raced settlement starts a run we did not request.
        if (worker.state !== "running") {
          this.dequeue(worker);
          worker.batch = ++this.batches;
          this.beginRun(worker);
          // It was stopped while that steer was in flight: cancel the run it started.
          if (worker.cancelNextStart) worker.endReason = { state: "cancelled", error: worker.cancelNextStart };
        }
        worker.cancelNextStart = undefined;
        worker.runActive = true;
        // A stop or timeout that arrived during startup: abort is effective now.
        if (worker.endReason) {
          const reason = worker.endReason;
          worker.endReason = undefined;
          this.end(worker, reason);
        }
        break;
      case "message_end": {
        const message = event.message as Record<string, unknown> | undefined;
        if (message?.role !== "assistant") return;
        worker.lastAssistant = message;
        worker.lastText = assistantText(message) || worker.lastText;
        const usage = message.usage as { totalTokens?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } } | undefined;
        // Pi's calculateContextTokens: totalTokens, else the sum of its parts.
        const parts = [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
        const context = (typeof usage?.totalTokens === "number" && usage.totalTokens) || parts;
        if (context > 0) worker.contextTokens = context;
        // Billed tokens without cacheRead: totalTokens re-counts the cached prefix on every turn.
        const tokens = [usage?.input, usage?.output, usage?.cacheWrite].reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
        const cost = typeof usage?.cost?.total === "number" ? usage.cost.total : 0;
        worker.run.tokens += tokens; worker.run.cost += cost;
        worker.total.tokens += tokens; worker.total.cost += cost;
        // A looping worker is asked for its report long before the deadline, then ended.
        worker.turns++;
        if (this.limits.maxTurns > 0 && worker.state === "running") {
          if (worker.turns >= this.limits.maxTurns + this.limits.wrapUpTurns) this.end(worker, { state: "failed", error: `Stopped after ${worker.turns} turns.` });
          // With a steer in flight this waits for the next turn instead of wrapUp's timer, which belongs to the deadline.
          else if (worker.turns >= this.limits.maxTurns && !worker.steersInFlight) this.wrapUp(worker, "turn");
        }
        break;
      }
      case "compaction_end": {
        const after = (event.result as { estimatedTokensAfter?: unknown } | undefined)?.estimatedTokensAfter;
        if (typeof after === "number" && after > 0) worker.contextTokens = after;
        break;
      }
      case "tool_execution_start": {
        worker.tool = typeof event.toolName === "string" ? event.toolName : "tool";
        // Changes made through bash are not seen here.
        const path = (event.args as { path?: unknown } | undefined)?.path;
        if ((event.toolName === "edit" || event.toolName === "write") && typeof path === "string") {
          worker.pendingEdits.set(String(event.toolCallId), editedPath(path, worker.task.cwd));
        }
        break;
      }
      case "tool_execution_end": {
        worker.tool = undefined;
        const id = String(event.toolCallId);
        const path = worker.pendingEdits.get(id);
        worker.pendingEdits.delete(id);
        if (path && event.isError !== true) worker.edited.add(path);
        break;
      }
      case "agent_settled":
        worker.runActive = false;
        if (worker.state === "running") this.finish(worker, classify(worker.lastAssistant, event.aborted === true));
        return;
      default: return;
    }
    this.hooks.changed();
  }

  private finish(worker: Worker, outcome: { state: Report["state"]; error?: string }): void {
    clearTimers(worker);
    worker.runActive = false;
    const state = worker.endReason?.state ?? outcome.state;
    const error = worker.endReason?.error ?? outcome.error;
    worker.endReason = undefined;
    // The session id keeps names reused by a later manager of this session distinct.
    const path = join(this.dir, `${worker.sessionId}-${worker.runs}.md`);
    const files = [...worker.edited];
    const overlaps: Record<string, string[]> = {};
    for (const other of this.workers.values()) {
      // Another subagent whose run overlapped this one in time and edited the same file.
      const concurrent = other.state === "running" || (other.finishedAt ?? 0) > worker.runStarted;
      if (other === worker || !concurrent) continue;
      for (const file of files) if (other.edited.has(file)) (overlaps[file] ??= []).push(other.task.name);
    }
    const report: Report = {
      name: worker.task.name, state, text: assistantText(worker.lastAssistant) || worker.lastText, ...(error && state !== "done" ? { error } : {}),
      path, sessionId: worker.sessionId, batch: worker.batch, seconds: Math.round((Date.now() - worker.runStarted) / 1000), tokens: worker.run.tokens, cost: worker.run.cost,
      files, ...(Object.keys(overlaps).length ? { overlaps } : {}), ...(worker.wrappedUp ? { partial: true } : {}),
    };
    const rpc = worker.rpc;
    if (worker.wrapUpRequest && rpc?.alive) {
      const cleanup = this.clearWrapUp(worker, rpc, worker.wrapUpRequest);
      worker.wrapUpCleanup = cleanup;
      void cleanup.then(() => {
        if (worker.wrapUpCleanup !== cleanup) return;
        worker.wrapUpCleanup = undefined;
        if (this.disposed || this.workers.get(worker.task.name) !== worker) return;
        if (worker.state !== "running" && worker.state !== "queued") this.armIdle(worker);
        this.wake();
        this.hooks.changed();
      });
    }
    worker.report = report;
    worker.finishedAt = Date.now();
    worker.tool = undefined;
    // The report holds the text; drop the full message (thinking, tool calls) between runs.
    worker.lastAssistant = undefined;
    worker.state = state === "done" ? "idle" : state === "cancelled" ? "stopped" : "failed";
    try { writeFileSync(path, report.text, { mode: 0o600 }); } catch { /* report stays in memory */ }
    this.outbox.push(report);
    // Messages sent while the run was ending start the next run. With a steer in flight that
    // may itself start one, the steer's settlement enqueues instead: a bare prompt during
    // its preflight would be rejected as busy.
    if (worker.pendingPrompt && !worker.steersInFlight) this.enqueue(worker);
    else if (!worker.pendingPrompt) this.armIdle(worker);
    this.wake();
    this.schedule();
    this.hooks.changed();
    this.hooks.report(report);
  }
}
