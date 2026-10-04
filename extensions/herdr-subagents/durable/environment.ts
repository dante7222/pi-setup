import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { ExecutionError, err, ok, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { atomic } from "../core.ts";
import { processIdentity } from "../identity.ts";
import { recoverExecution, type ShellRequest } from "./shell-worker.ts";

const worker = fileURLToPath(new URL("./shell-worker.ts", import.meta.url));

/**
 * Run under the host's exclusive directory lease only at GLOBAL idle boundaries:
 * before opening/reopening Harness, before resuming a paused engine, and after
 * close. This cancels every journalled execution, so never call it for a report,
 * single-conversation cancellation, or an already-running engine's resume.
 * Rejects unproven cleanup. Journal recovery never executes commands.
 */
export async function recoverExecutions(directory: string): Promise<void> {
  const root = join(resolve(directory), "executions");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  // Signal all executions first so recovery cost cannot let later shells run on.
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) throw new Error(`Unrecognized shell execution artifact: ${entry.name}`);
    await atomic(join(root, entry.name, "cancel.json"), {});
  }
  const results = await Promise.allSettled(entries.map((entry) => recoverExecution(join(root, entry.name))));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Durable shell cleanup unverified");
}

class DurableEnvironment extends NodeExecutionEnv {
  private readonly directory: string;
  private readonly conversationId: string;
  private readonly active = new Set<Promise<Result<ShellExecResult, ExecutionError>>>();
  private readonly executions = new Set<string>();
  private readonly abort = new AbortController();

  constructor(directory: string, conversationId: string, cwd: string) {
    super({ cwd });
    this.directory = resolve(directory);
    this.conversationId = conversationId;
  }

  override exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const pending = this.execute(command, options, context);
    this.active.add(pending);
    void pending.finally(() => this.active.delete(pending)).catch(() => {});
    return pending;
  }

  private async execute(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, this.abort.signal]) : this.abort.signal;
    if (signal.aborted) return err(new ExecutionError("aborted", "aborted"));
    const timeout = options?.timeout ?? 120;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647) {
      return err(new ExecutionError("timeout", "Invalid timeout: must be positive finite seconds, at most 2147483.647"));
    }
    const cwd = await this.absolutePath(options?.cwd || this.cwd, context);
    if (!cwd.ok) return err(new ExecutionError("spawn_error", cwd.error.message));
    const info = await this.fileInfo(cwd.value, context);
    if (!info.ok || info.value.kind !== "directory") return err(new ExecutionError("spawn_error", `Working directory is not a directory: ${cwd.value}`));
    const directory = join(this.directory, "executions", randomUUID());
    let failure: ExecutionError | undefined;
    let spill: Awaited<ReturnType<typeof open>> | undefined;
    let spilled = false;
    let bytes = 0;
    let newlines = 0;
    const spillPath = join(directory, "output.log");
    let cancelError: unknown;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= atomic(join(directory, "cancel.json"), {}).then(() => {}, (error: unknown) => { cancelError = error; });
    };
    let launched = false;
    let child: ReturnType<typeof spawn> | undefined;
    let environmentPipe: Writable | undefined;
    let exited = false;
    let output: Promise<void> | undefined;
    try {
      // Environment values must never enter the durable journal or argv. Bound
      // the private pipe payload (the gated receiver enforces the same limit).
      const env = { ...(options?.inheritEnv === false ? {} : process.env), ...options?.env, PI_HERDR_WORKER: "1", PI_HERDR_GROUP: "none" };
      let environmentBytes = 0;
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string" || key.includes("\0") || key.includes("=") || value.includes("\0")) {
          return err(new ExecutionError("spawn_error", "Invalid shell environment"));
        }
        environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
        if (environmentBytes > 1024 * 1024) return err(new ExecutionError("spawn_error", "Shell environment exceeds 1 MiB"));
      }
      const environmentPayload = Buffer.from(JSON.stringify(env));
      if (environmentPayload.length > 1024 * 1024) return err(new ExecutionError("spawn_error", "Shell environment exceeds 1 MiB"));
      const coordinator = await processIdentity();
      if (!coordinator) throw new Error("Cannot establish shell coordinator identity");
      await mkdir(join(this.directory, "executions"), { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
      this.executions.add(directory);
      const request: ShellRequest = {
        coordinator, conversationId: this.conversationId, command, cwd: cwd.value, timeout,
      };
      await atomic(join(directory, "request.json"), request, true);
      if (options?.spill) spill = await open(spillPath, "wx", 0o600);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", worker, directory], {
        detached: true, stdio: ["pipe", "pipe", "ignore", "pipe"],
        // In particular, never allow inherited NODE_OPTIONS/loader hooks to run
        // in the supervisor before it claims ownership.
        env: { PATH: "/usr/bin:/bin", PI_HERDR_WORKER: "1", PI_HERDR_GROUP: "none" },
      });
      launched = true;
      child.once("exit", () => { exited = true; });
      child.once("error", (error) => { failure = new ExecutionError("spawn_error", error.message, error); exited = true; });
      child.stdin?.on("error", () => {});
      const pipe = child.stdio[3];
      if (!(pipe instanceof Writable)) throw new Error("Private shell environment pipe unavailable");
      environmentPipe = pipe;
      pipe.on("error", () => {
        // Closing an unreleased reader is expected during cancellation.
        if (signal.aborted || cancellation) return;
        failure ??= new ExecutionError("spawn_error", "Private shell environment transfer failed");
        cancel();
      });
      // Queue at most 1 MiB, but NEVER wait for drain: the reader starts only
      // after the supervisor journals ownership and opens the separate gate.
      // stdin remains open solely as the coordinator-liveness channel.
      pipe.end(environmentPayload);
      const decoders = [new TextDecoder(), new TextDecoder()];
      const emit = (text: string) => {
        if (!text || failure) return;
        try { options?.onOutput?.(text, context); }
        catch (error) { failure = new ExecutionError("callback_error", String(error)); cancel(); }
      };
      output = (async () => {
        let pending = "";
        if (!child?.stdout) throw new Error("Supervisor stdout unavailable");
        for await (const chunk of child.stdout) {
          pending += (chunk as Buffer).toString("ascii");
          let newline: number;
          while ((newline = pending.indexOf("\n")) !== -1) {
            const frame = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!/^[01]:[A-Za-z0-9+/]*={0,2}$/.test(frame) || frame.length > 256 * 1024) throw new Error("Invalid shell output frame");
            const data = Buffer.from(frame.slice(2), "base64");
            emit(decoders[Number(frame[0])].decode(data, { stream: true }));
            if (spill && !failure) {
              // Always spool requested spill output, rather than retain an
              // arbitrarily large caller-supplied threshold in memory. Each
              // awaited write applies pipe backpressure; no unbounded queue.
              await spill.writeFile(data);
              bytes += data.length;
              for (const byte of data) if (byte === 10) newlines++;
              const lines = newlines + (data.at(-1) === 10 ? 0 : 1);
              spilled ||= bytes > options!.spill!.afterBytes || lines > options!.spill!.afterLines;
            }
          }
          if (pending.length > 256 * 1024) throw new Error("Oversized shell output frame");
        }
        if (pending) throw new Error("Truncated shell output frame");
        decoders.forEach((decoder) => emit(decoder.decode()));
      })().catch((error: unknown) => {
        failure ??= new ExecutionError("unknown", `Shell output failed: ${String(error)}`);
        cancel();
      });
      // Do not use Context's awaitWithContext: cancellation of the waiter alone
      // must NEVER let the tool settle before verified process cleanup.
      const deadline = Date.now() + timeout * 1000 + 10_000;
      while (!exited) {
        if (Date.now() >= deadline) { cancel(); break; }
        if (cancellation) {
          await cancellation;
          // Recovery cooperates briefly, then stops only the verified supervisor.
          await recoverExecution(directory);
          break;
        }
        await delay(25);
      }
      const ack = await recoverExecution(directory);
      // Recovery may have killed a wedged supervisor. Bound pipe draining without
      // treating pipe closure itself as process cleanup evidence.
      let drainTimer: NodeJS.Timeout | undefined;
      await Promise.race([output, new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => {
          if (!child?.stdout?.readableEnded) child?.stdout?.destroy(new Error("Supervisor output did not drain"));
          resolve();
        }, 1500);
      })]);
      clearTimeout(drainTimer);
      await output;
      if (cancelError) failure ??= new ExecutionError("unknown", `Shell cancellation failed: ${String(cancelError)}`);
      if (failure) return err(failure);
      if (signal.aborted || ack.error) {
        const error = new ExecutionError(signal.aborted ? "aborted" : ack.error!.code, signal.aborted ? "aborted" : ack.error!.message);
        if (spilled) error.spillPath = spillPath;
        return err(error);
      }
      return ok({ exitCode: ack.exitCode, ...(spilled ? { spillPath } : {}) });
    } catch (error) {
      // Expected execution failures are Result errors. Unknown cleanup remains a
      // durable blocker: cleanup()/startup recovery must reject until repaired.
      if (launched) {
        try { await recoverExecution(directory); }
        catch (cleanup) { return err(new ExecutionError("unknown", `Shell cleanup unverified: ${String(cleanup)}; ${String(error)}`)); }
      }
      return err(new ExecutionError("unknown", String(error)));
    } finally {
      signal.removeEventListener("abort", cancel);
      await cancellation;
      environmentPipe?.destroy();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      await output;
      await spill?.close();
      if (spill && !spilled) await rm(spillPath, { force: true });
    }
  }

  override async cleanup(_context: Context): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.active);
    // An environment may be created per tool call. Do not cancel another call's
    // shell in the same conversation; global recovery belongs to the lease owner.
    const results = await Promise.allSettled([...this.executions].map(recoverExecution));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Durable shell cleanup unverified");
  }
}

/**
 * Filesystem semantics/id remain NodeExecutionEnv's; only exec/cleanup differ.
 * Uses ProcessTree's existing ps identity model, not a sandbox: second-precision
 * PID reuse and daemon escapes between discovery samples remain its limitations.
 * Journals cover process crashes, not loss of un-fsynced writes on host failure.
 */
export function createDurableEnvironment(directory: string, conversationId: string, cwd: string): ExecutionEnv {
  return new DurableEnvironment(directory, conversationId, cwd);
}
