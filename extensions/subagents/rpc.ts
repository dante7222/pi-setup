import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type RpcEvent = { type: string } & Record<string, unknown>;

export interface ExitInfo { code: number | null; signal: NodeJS.Signals | null; stderr: string }

export interface Invocation { command: string; prefix: string[] }

/** The child did not answer in time; unlike an error response, it may still act on the request. */
export class RpcTimeoutError extends Error {}

const STDERR_LIMIT = 4096;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

// Every live worker process, across extension reloads. A single process-exit hook
// sends SIGTERM to each worker group: Pi then stops its own detached bash groups,
// which a SIGKILL would orphan.
const LIVE_KEY = Symbol.for("ventris.pi-subagents.live-processes");
type LiveSet = Set<RpcProcess>;
const globals = globalThis as typeof globalThis & { [LIVE_KEY]?: LiveSet };
function liveProcesses(): LiveSet {
  if (!globals[LIVE_KEY]) {
    const live: LiveSet = new Set();
    globals[LIVE_KEY] = live;
    process.once("exit", () => { for (const rpc of live) rpc.terminate(); });
  }
  return globals[LIVE_KEY];
}

/** Same resolution as Pi's subagent example: rerun the current CLI when possible. */
export function piInvocation(): Invocation {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) return { command: process.execPath, prefix: [script] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, prefix: [] };
  return { command: "pi", prefix: [] };
}

/**
 * One `pi --mode rpc` child in its own process group. Owns framing, request
 * correlation, headless dialog cancellation, and termination. It knows nothing
 * about tasks or reports.
 */
export class RpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private stderr = "";
  private exitInfo: ExitInfo | undefined;
  private closing: Promise<void> | undefined;
  readonly exited: Promise<ExitInfo>;

  constructor(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; invocation?: Invocation }, onEvent: (event: RpcEvent) => void) {
    const { command, prefix } = options.invocation ?? piInvocation();
    // detached: a dedicated process group lets termination reach tool descendants.
    this.child = spawn(command, [...prefix, ...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const live = liveProcesses();
    live.add(this);
    this.exited = new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exitInfo) return;
        // Set before rejecting, so rejection handlers already observe !alive.
        this.exitInfo = { code, signal, stderr: this.stderr };
        for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(`Worker exited (${signal ?? code}).`)); }
        this.pending.clear();
        resolve(this.exitInfo);
      };
      // 'exit' can precede the last stdout/stderr data. Prefer 'close', but bound
      // the wait: a detached descendant may hold the pipes open indefinitely.
      this.child.once("close", (code, signal) => finish(code, signal));
      this.child.once("exit", (code, signal) => { setTimeout(() => finish(code, signal), 500).unref(); });
      this.child.once("error", (error) => { this.appendStderr(`${error.message}\n`); finish(null, null); });
    });
    // Strict LF framing: readline would also split on U+2028/U+2029 inside JSON strings.
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) this.line(line, onEvent);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString("utf8")));
    this.child.stdin.on("error", () => {});
  }

  get alive(): boolean { return !this.exitInfo; }

  private appendStderr(text: string): void {
    this.stderr = (this.stderr + text).slice(-STDERR_LIMIT);
  }

  private line(line: string, onEvent: (event: RpcEvent) => void): void {
    let record: RpcEvent;
    try {
      record = JSON.parse(line) as RpcEvent;
      if (!record || typeof record.type !== "string") return;
    } catch { return; }
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.success === true) pending.resolve(record.data);
      else pending.reject(new Error(typeof record.error === "string" ? record.error : `${String(record.command)} failed.`));
      return;
    }
    // Workers are headless: answer dialogs immediately so extensions never block a run.
    if (record.type === "extension_ui_request") {
      if (typeof record.id === "string" && DIALOG_METHODS.has(String(record.method))) this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
      return;
    }
    onEvent(record);
  }

  private write(value: unknown): void {
    if (this.alive && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request<T = unknown>(command: Record<string, unknown> & { type: string }, timeoutMs = 30_000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error("Worker process is not running."));
    const id = `r${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcTimeoutError(`RPC ${command.type} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      this.write({ ...command, id });
    });
  }

  /** Signal the whole group, also after the leader exited: descendants may remain. */
  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); } catch {
      if (this.alive) try { this.child.kill(signal); } catch { /* already gone */ }
    }
  }

  /** Whether any process of the group (leader or descendant) still exists. */
  private groupAlive(): boolean {
    if (!this.child.pid) return false;
    try { process.kill(-this.child.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }

  /**
   * Graceful stdin EOF, then TERM and KILL for the whole process group until it is
   * empty, independent of when the leader exits. Idempotent.
   */
  close(graceMs = 2000): Promise<void> {
    return this.closing ??= (async () => {
      // Referenced timers: callers await this, and once the leader exited nothing else
      // keeps the event loop alive. The whole sequence is bounded to a few seconds.
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const settle = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (this.groupAlive() && Date.now() < deadline) await sleep(50);
        return !this.groupAlive();
      };
      this.child.stdin.end();
      await Promise.race([this.exited, sleep(graceMs)]);
      if (this.groupAlive()) {
        this.signal("SIGTERM");
        if (!await settle(1500)) {
          this.signal("SIGKILL");
          await settle(1000);
        }
      }
      await Promise.race([this.exited, sleep(1000)]);
      liveProcesses().delete(this);
    })();
  }

  /** Synchronous SIGTERM for process-exit paths, where nothing can be awaited. */
  terminate(): void { if (this.groupAlive()) this.signal("SIGTERM"); }
}
