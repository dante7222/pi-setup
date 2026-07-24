import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { durableAtomicWrite, ensureDirectoryDurable, readJsonStrict } from "./durable-state.ts";
import {
  writeRunnerExit,
  writeRunnerProcess,
} from "./lifecycle.ts";
import {
  captureProcessIdentity,
  inspectProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.ts";

export const VALIDATION_WRAPPER_SCRIPT = 'IFS= read -r _ || exit 74; exec /bin/zsh -lc "$1"';

interface ValidationGateIntent {
  schemaVersion: 2;
  jobId: string;
  launchNonce: string;
  launcher: ProcessIdentity;
  createdAt: string;
}

function validationGatePath(jobDir: string): string {
  return join(jobDir, "validation-gate.json");
}

function validProcessIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.pid === "number" && Number.isSafeInteger(identity.pid) && identity.pid > 1 &&
    typeof identity.startSignature === "string" && identity.startSignature.length > 0 &&
    typeof identity.processGroup === "number" && Number.isSafeInteger(identity.processGroup) && identity.processGroup > 1 &&
    typeof identity.command === "string" &&
    typeof identity.launchNonce === "string" && identity.launchNonce.length > 0;
}

async function readValidationGateIntent(jobDir: string): Promise<ValidationGateIntent | undefined> {
  const filePath = validationGatePath(jobDir);
  const intent = await readJsonStrict<ValidationGateIntent>(filePath);
  if (!intent) return undefined;
  if (
    intent.schemaVersion !== 2 || typeof intent.jobId !== "string" ||
    typeof intent.launchNonce !== "string" || typeof intent.createdAt !== "string" ||
    !validProcessIdentity(intent.launcher) || intent.launcher.launchNonce !== intent.launchNonce
  ) throw new Error(`Unsupported validation gate intent at ${filePath}.`);
  return intent;
}

export async function recordValidationGateIntent(
  jobDir: string,
  jobId: string,
  launchNonce: string,
): Promise<void> {
  const existing = await readValidationGateIntent(jobDir);
  if (existing) {
    if (existing.jobId !== jobId || existing.launchNonce !== launchNonce) {
      throw new Error(
        `Validation gate intent ${existing.jobId}/${existing.launchNonce} does not match ${jobId}/${launchNonce}.`,
      );
    }
    return;
  }
  const launcher = await captureProcessIdentity(process.pid, launchNonce);
  if (!launcher) throw new Error("Could not capture the validation launcher process identity.");
  await durableAtomicWrite(
    validationGatePath(jobDir),
    `${JSON.stringify({
      schemaVersion: 2,
      jobId,
      launchNonce,
      launcher,
      createdAt: new Date().toISOString(),
    } satisfies ValidationGateIntent, null, 2)}\n`,
  );
}

export async function validationGateProvesCommandNeverLaunched(
  jobDir: string,
  jobId: string,
  launchNonce: string,
): Promise<boolean> {
  const intent = await readValidationGateIntent(jobDir);
  if (!intent || intent.jobId !== jobId || intent.launchNonce !== launchNonce) return false;
  const launcherState = await inspectProcessIdentity(intent.launcher);
  return launcherState === "missing" || launcherState === "mismatch";
}

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
  preserveStartedProcessOnAbort?: boolean;
}

export class ValidationProcessFailure extends Error {
  terminationVerified: boolean;
  commandStarted: boolean;

  constructor(message: string, terminationVerified: boolean, commandStarted = false) {
    super(message);
    this.name = "ValidationProcessFailure";
    this.terminationVerified = terminationVerified;
    this.commandStarted = commandStarted;
  }
}

export interface ValidationProcessResult {
  exitCode: number;
  killed: boolean;
  timedOut: boolean;
  terminationVerified: boolean;
  commandStarted: boolean;
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
  try {
    if (options.signal?.aborted) throw new ValidationProcessFailure("Validation command aborted", true);
    await ensureDirectoryDurable(dirname(options.logPath));
    const probe = await fs.promises.open(options.logPath, "a", 0o600);
    await probe.close();
    await options.beforeSpawn?.();
    if (options.signal?.aborted) {
      throw new ValidationProcessFailure("Validation command aborted before launch", true);
    }
    if (options.processLifecycle) {
      await recordValidationGateIntent(
        options.processLifecycle.jobDir,
        options.processLifecycle.jobId,
        options.processLifecycle.launchNonce,
      );
    }
    if (options.signal?.aborted) {
      throw new ValidationProcessFailure("Validation command aborted before launch", true);
    }
  } catch (error) {
    if (error instanceof ValidationProcessFailure) throw error;
    throw new ValidationProcessFailure(
      `Validation command could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
      true,
      false,
    );
  }
  const log = fs.createWriteStream(options.logPath, { flags: "a", mode: 0o600 });

  return new Promise<ValidationProcessResult>((resolve, reject) => {
    const child = spawn(
      "/bin/zsh",
      ["-c", VALIDATION_WRAPPER_SCRIPT, "pi-validation", options.command],
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
    let commandStarted = false;
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
    const abort = () => {
      aborted = true;
      if (!options.preserveStartedProcessOnAbort || !commandStarted) terminate("abort");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

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
      if (!fatalError && !aborted && !timedOut && !settled) {
        commandStarted = true;
        child.stdin.end("\n");
      }
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
            commandStarted,
          ));
          return;
        }
        if (fatalError) {
          reject(new ValidationProcessFailure(
            `${fatalError.message}${terminationVerified ? "" : " Process-group termination is indeterminate."}`,
            terminationVerified,
            commandStarted,
          ));
          return;
        }
        resolve({
          exitCode: timedOut ? 124 : code ?? 1,
          killed: timedOut || code === null,
          timedOut,
          terminationVerified,
          commandStarted,
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
