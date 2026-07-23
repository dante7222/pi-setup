import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { dirname } from "node:path";
import {
  writeRunnerExit,
  writeRunnerProcess,
} from "./lifecycle.ts";
import { captureProcessIdentity } from "./process-identity.ts";

export interface ValidationProcessOptions {
  command: string;
  cwd: string;
  logPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxLogBytes: number;
  tailBytes: number;
  processLifecycle?: {
    jobDir: string;
    jobId: string;
    launchNonce: string;
  };
  beforeSpawn?: () => Promise<void>;
}

export class ValidationProcessFailure extends Error {
  terminationVerified: boolean;

  constructor(message: string, terminationVerified: boolean) {
    super(message);
    this.name = "ValidationProcessFailure";
    this.terminationVerified = terminationVerified;
  }
}

export interface ValidationProcessResult {
  exitCode: number;
  killed: boolean;
  timedOut: boolean;
  terminationVerified: boolean;
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

function processGroupExists(pid: number | undefined): boolean | undefined {
  if (!pid) return undefined;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? false : undefined;
  }
}

async function verifyProcessGroupAbsent(pid: number | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (processGroupExists(pid) === false) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return processGroupExists(pid) === false;
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
  const probe = await fs.promises.open(options.logPath, "a", 0o600);
  await probe.close();
  await options.beforeSpawn?.();
  if (options.signal?.aborted) throw new Error("Validation command aborted before launch");
  const log = fs.createWriteStream(options.logPath, { flags: "a", mode: 0o600 });

  return new Promise<ValidationProcessResult>((resolve, reject) => {
    const child = spawn(
      "/bin/zsh",
      ["-c", 'IFS= read -r _; /bin/zsh -lc "$1"', "pi-validation", options.command],
      {
        cwd: options.cwd,
        detached: true,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let outputBytes = 0;
    let logBytes = 0;
    let logTruncated = false;
    let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
    let childClosed = false;
    let settled = false;
    let fatalError: Error | undefined;
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

    const terminate = (reason: "timeout" | "abort" | "failure"): void => {
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

    const processLifecycle = options.processLifecycle;
    const processIdentityReady = processLifecycle
      ? (async () => {
          const identity = await captureProcessIdentity(
            child.pid ?? -1,
            processLifecycle.launchNonce,
            child.pid,
          );
          if (!identity) {
            if (childClosed) return;
            throw new Error("Could not capture the validation process identity.");
          }
          await writeRunnerProcess(processLifecycle.jobDir, {
            schemaVersion: 2,
            jobId: processLifecycle.jobId,
            launchNonce: processLifecycle.launchNonce,
            wrapper: identity,
            startedAt: new Date().toISOString(),
          });
        })().catch((error: unknown) => {
          fatalError ??= error instanceof Error ? error : new Error(String(error));
          terminate("failure");
        })
      : Promise.resolve();
    void processIdentityReady.then(() => {
      if (!fatalError && !aborted && !timedOut && !settled) child.stdin.end("\n");
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || settled) return;
      fatalError ??= error;
      terminate("failure");
    });
    log.on("error", (error) => {
      if (settled) return;
      fatalError ??= error;
      log.destroy();
      terminate("failure");
    });
    child.on("error", (error) => {
      if (settled) return;
      fatalError ??= error;
      terminate("failure");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      childClosed = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      try {
        killProcessGroup(child.pid, "SIGKILL");
      } catch {
        // The process group may already be gone.
      }

      const finish = async (): Promise<void> => {
        await processIdentityReady;
        if (processLifecycle && child.pid) {
          try {
            await writeRunnerExit(processLifecycle.jobDir, {
              schemaVersion: 2,
              jobId: processLifecycle.jobId,
              launchNonce: processLifecycle.launchNonce,
              wrapperPid: child.pid,
              exitCode: timedOut ? 124 : code ?? 1,
              exitedAt: new Date().toISOString(),
            });
          } catch (error) {
            fatalError ??= error instanceof Error ? error : new Error(String(error));
          }
        }
        const terminationVerified = await verifyProcessGroupAbsent(child.pid);
        if (aborted) {
          reject(new ValidationProcessFailure(
            terminationVerified
              ? "Validation command aborted"
              : "Validation command aborted, but process-group termination is indeterminate",
            terminationVerified,
          ));
          return;
        }
        if (fatalError) {
          reject(new ValidationProcessFailure(
            `${fatalError.message}${terminationVerified ? "" : " Process-group termination is indeterminate."}`,
            terminationVerified,
          ));
          return;
        }
        resolve({
          exitCode: timedOut ? 124 : code ?? 1,
          killed: timedOut || code === null,
          timedOut,
          terminationVerified,
          outputBytes,
          logBytes,
          logTruncated,
          outputTail: tail.toString("utf8"),
        });
      };
      if (log.destroyed || log.closed) {
        void finish();
      } else {
        log.end(() => void finish());
      }
    });
  });
}
