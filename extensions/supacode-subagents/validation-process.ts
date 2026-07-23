import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { dirname } from "node:path";

export interface ValidationProcessOptions {
  command: string;
  cwd: string;
  logPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxLogBytes: number;
  tailBytes: number;
}

export interface ValidationProcessResult {
  exitCode: number;
  killed: boolean;
  timedOut: boolean;
  outputBytes: number;
  logBytes: number;
  logTruncated: boolean;
  outputTail: string;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function appendTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (limit <= 0) return Buffer.alloc(0);
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}

export async function runValidationProcess(
  options: ValidationProcessOptions,
): Promise<ValidationProcessResult> {
  if (options.signal?.aborted) throw new Error("Validation command aborted");
  await fs.promises.mkdir(dirname(options.logPath), { recursive: true, mode: 0o700 });
  const log = fs.createWriteStream(options.logPath, { flags: "a", mode: 0o600 });

  return new Promise<ValidationProcessResult>((resolve, reject) => {
    const child = spawn("/bin/zsh", ["-lc", options.command], {
      cwd: options.cwd,
      detached: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    let logBytes = 0;
    let logTruncated = false;
    let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const consume = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      tail = appendTail(tail, chunk, options.tailBytes);
      const remaining = Math.max(0, options.maxLogBytes - logBytes);
      if (remaining > 0) {
        const written = chunk.subarray(0, remaining);
        log.write(written);
        logBytes += written.length;
      }
      if (chunk.length > remaining) logTruncated = true;
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);

    const terminate = (reason: "timeout" | "abort"): void => {
      if (settled) return;
      timedOut ||= reason === "timeout";
      aborted ||= reason === "abort";
      try {
        killProcessGroup(child.pid, "SIGTERM");
      } catch {
        // The forced kill below is still attempted.
      }
      forceKillTimer ??= setTimeout(() => {
        try {
          killProcessGroup(child.pid, "SIGKILL");
        } catch {
          // Process exit remains authoritative.
        }
      }, 5000);
    };
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const abort = () => terminate("abort");
    options.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      log.end(() => reject(error));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      try {
        killProcessGroup(child.pid, "SIGKILL");
      } catch {
        // The process group may already be gone.
      }
      log.end(() => {
        if (aborted) {
          reject(new Error("Validation command aborted"));
          return;
        }
        resolve({
          exitCode: timedOut ? 124 : code ?? 1,
          killed: timedOut || code === null,
          timedOut,
          outputBytes,
          logBytes,
          logTruncated,
          outputTail: tail.toString("utf8"),
        });
      });
    });
  });
}
