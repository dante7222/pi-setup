import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExclusiveJson, durableAtomicWrite, readJsonStrict } from "./durable-state.ts";
import {
  currentProcessGroup,
  inspectProcessIdentity,
  type ProcessIdentity,
  type ProcessIdentityState,
} from "./process-identity.ts";
import { readRunnerProcess } from "./lifecycle.ts";
import { sameSupacodeUuid } from "./resource-id.ts";
import { validationGateProvesCommandNeverLaunched } from "./validation-process.ts";

export interface SupervisedWorker {
  id: string;
  jobDir: string;
  tabWorktreeId: string;
  tabId: string;
  surfaceId: string;
  launchNonce: string;
}

export interface WorkerTerminationResult {
  surfaceAbsent: boolean;
  processesAbsent: boolean;
  verified: boolean;
  errors: string[];
}

export interface SurfaceObservationState {
  missingCounts: Map<string, number>;
}

interface WorkerLaunchClaimRecord {
  schemaVersion: 2;
  jobId: string;
  launchNonce: string;
  owner: "runner" | "recovery";
  wrapper?: ProcessIdentity;
  claimedAt: string;
}

interface SupacodeCreationCompletion {
  schemaVersion: 2;
  jobId: string;
  launchNonce: string;
  commandStarted: boolean;
  exitCode: number;
  completedAt: string;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validProcessIdentity(value: unknown, launchNonce: string): value is ProcessIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 1 &&
    typeof record.startSignature === "string" && record.startSignature.length > 0 &&
    typeof record.processGroup === "number" && Number.isSafeInteger(record.processGroup) && record.processGroup > 1 &&
    typeof record.command === "string" &&
    record.launchNonce === launchNonce;
}

async function resolveWorkerLaunchClaim(worker: SupervisedWorker): Promise<{
  protocolEnabled: boolean;
  valid: boolean;
  launchPrevented: boolean;
  runnerIdentity?: ProcessIdentity;
  error?: string;
}> {
  const metadata = await readJsonStrict<Record<string, unknown>>(`${worker.jobDir}/job.json`);
  if (metadata?.workerLaunchClaimVersion !== 1) {
    return { protocolEnabled: false, valid: false, launchPrevented: false, error: "Worker launch-claim protocol is not recorded for this job." };
  }
  const claimPath = `${worker.jobDir}/worker-launch-claim.json`;
  await createExclusiveJson(claimPath, {
    schemaVersion: 2,
    jobId: worker.id,
    launchNonce: worker.launchNonce,
    owner: "recovery",
    claimedAt: new Date().toISOString(),
  } satisfies WorkerLaunchClaimRecord);
  const claim = await readJsonStrict<WorkerLaunchClaimRecord>(claimPath);
  if (
    claim?.schemaVersion !== 2 || claim.jobId !== worker.id ||
    claim.launchNonce !== worker.launchNonce ||
    (claim.owner !== "runner" && claim.owner !== "recovery")
  ) return { protocolEnabled: true, valid: false, launchPrevented: false, error: "Worker launch claim is missing or does not match lifecycle intent." };
  if (claim.owner === "recovery") return { protocolEnabled: true, valid: true, launchPrevented: true };
  if (!validProcessIdentity(claim.wrapper, worker.launchNonce)) {
    return { protocolEnabled: true, valid: false, launchPrevented: false, error: "Runner-owned worker launch claim has invalid process identity." };
  }
  return { protocolEnabled: true, valid: true, launchPrevented: false, runnerIdentity: claim.wrapper };
}

export async function reconcileWorkerSurfaceCreation(
  pi: ExtensionAPI,
  worker: SupervisedWorker,
): Promise<{ verified: boolean; error?: string }> {
  let metadata: Record<string, unknown> | undefined;
  try {
    metadata = await readJsonStrict<Record<string, unknown>>(path.join(worker.jobDir, "job.json"));
  } catch (error) {
    return { verified: false, error: `Could not read surface-creation metadata: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (metadata?.surfaceCreationProtocolVersion !== 1) return { verified: true };
  const launchDir = metadataString(metadata, "surfaceLaunchDir");
  const launchJobId = metadataString(metadata, "surfaceLaunchJobId");
  const launchNonce = metadataString(metadata, "surfaceLaunchNonce");
  if (
    !launchDir || !launchJobId || !launchNonce ||
    !path.resolve(launchDir).startsWith(`${path.resolve(worker.jobDir)}${path.sep}`)
  ) return { verified: false, error: "Surface-creation lifecycle identity is missing or outside the worker job directory." };
  try {
    const reconciled = await readJsonStrict<{
      schemaVersion: 1;
      jobId: string;
      launchNonce: string;
      reconciledAt: string;
    }>(path.join(launchDir, "creation-reconciled.json"));
    if (reconciled) {
      return reconciled.schemaVersion === 1 && reconciled.jobId === launchJobId &&
          reconciled.launchNonce === launchNonce
        ? { verified: true }
        : { verified: false, error: "Surface-creation reconciliation does not match lifecycle intent." };
    }
  } catch (error) {
    return { verified: false, error: `Could not read surface-creation reconciliation: ${error instanceof Error ? error.message : String(error)}` };
  }
  let completion: SupacodeCreationCompletion | undefined;
  try {
    completion = await readJsonStrict<SupacodeCreationCompletion>(
      path.join(launchDir, "creation-complete.json"),
    );
  } catch (error) {
    return { verified: false, error: `Could not read surface-creation completion: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (completion) {
    const valid = completion.schemaVersion === 2 && completion.jobId === launchJobId &&
      completion.launchNonce === launchNonce &&
      typeof completion.commandStarted === "boolean" && Number.isSafeInteger(completion.exitCode);
    if (!valid) return { verified: false, error: "Surface-creation completion does not match lifecycle intent." };
    try {
      const completedRunner = await readRunnerProcess(launchDir);
      if (!completedRunner) return { verified: true };
      if (
        completedRunner.jobId !== launchJobId || completedRunner.launchNonce !== launchNonce ||
        completedRunner.wrapper.launchNonce !== launchNonce
      ) return { verified: false, error: "Completed surface creator identity does not match lifecycle intent." };
      return terminateRecordedProcess(completedRunner.wrapper, launchNonce);
    } catch (error) {
      return { verified: false, error: `Could not verify completed surface creator: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try {
    const runner = await readRunnerProcess(launchDir);
    if (runner) {
      if (
        runner.jobId !== launchJobId || runner.launchNonce !== launchNonce ||
        runner.wrapper.launchNonce !== launchNonce
      ) return { verified: false, error: "Surface-creation runner identity does not match lifecycle intent." };
      const state = await inspectProcessIdentity(runner.wrapper);
      if (state === "alive" || state === "unknown") {
        return { verified: false, error: "Surface-creation process is still active or indeterminate." };
      }
      let processGroupAbsent = false;
      try {
        process.kill(-runner.wrapper.processGroup, 0);
      } catch (error) {
        processGroupAbsent = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!processGroupAbsent) {
        return { verified: false, error: "Surface-creation process group is still present." };
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const barrier = await pi.exec("supacode", ["worktree", "list"], { timeout: 30_000 });
        if (barrier.code !== 0) {
          return { verified: false, error: "Supacode server reconciliation barrier failed." };
        }
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await durableAtomicWrite(
        path.join(launchDir, "creation-reconciled.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          jobId: launchJobId,
          launchNonce,
          reconciledAt: new Date().toISOString(),
        }, null, 2)}\n`,
      );
      return { verified: true };
    }
    return await validationGateProvesCommandNeverLaunched(launchDir, launchJobId, launchNonce)
      ? { verified: true }
      : { verified: false, error: "Surface-creation process is not verified absent." };
  } catch (error) {
    return { verified: false, error: `Could not reconcile surface-creation process: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function observeWorkerSurfaces(
  workers: ReadonlyArray<Pick<SupervisedWorker, "id" | "surfaceId">>,
  listedSurfaceIds: ReadonlyArray<string> | undefined,
  state: SurfaceObservationState,
  confirmations: number,
): string[] {
  if (!listedSurfaceIds) {
    state.missingCounts.clear();
    return [];
  }
  const missing: string[] = [];
  for (const worker of workers) {
    const present = listedSurfaceIds.some((surfaceId) => sameSupacodeUuid(surfaceId, worker.surfaceId));
    if (present) {
      state.missingCounts.delete(worker.id);
      continue;
    }
    const count = (state.missingCounts.get(worker.id) ?? 0) + 1;
    state.missingCounts.set(worker.id, count);
    if (count >= confirmations) missing.push(worker.id);
  }
  return missing;
}

async function listedSurfaceIds(
  pi: ExtensionAPI,
  worker: SupervisedWorker,
): Promise<string[] | undefined> {
  const result = await pi.exec(
    "supacode",
    ["surface", "list", "-w", worker.tabWorktreeId, "-t", worker.tabId],
    { timeout: 5000 },
  );
  return result.code === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : undefined;
}

async function surfaceAbsent(pi: ExtensionAPI, worker: SupervisedWorker): Promise<boolean | undefined> {
  const surfaces = await listedSurfaceIds(pi, worker);
  return surfaces
    ? !surfaces.some((surfaceId) => sameSupacodeUuid(surfaceId, worker.surfaceId))
    : undefined;
}

async function waitForSurfaceAbsence(
  pi: ExtensionAPI,
  worker: SupervisedWorker,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let missing = 0;
  while (Date.now() < deadline) {
    const absent = await surfaceAbsent(pi, worker);
    if (absent === true) {
      missing++;
      if (missing >= 2) return true;
    } else {
      missing = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function processGroupState(processGroup: number): Promise<ProcessIdentityState> {
  try {
    process.kill(-processGroup, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "missing";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

async function identityStates(identities: ProcessIdentity[]): Promise<ProcessIdentityState[]> {
  const groups = [...new Set(identities.map((identity) => identity.processGroup))];
  return Promise.all([
    ...identities.map((identity) => inspectProcessIdentity(identity)),
    ...groups.map((group) => processGroupState(group)),
  ]);
}

async function waitForProcessAbsence(
  identities: ProcessIdentity[],
  timeoutMs: number,
): Promise<{ absent: boolean; states: ProcessIdentityState[] }> {
  if (identities.length === 0) return { absent: false, states: ["unknown"] };
  const deadline = Date.now() + timeoutMs;
  let states = await identityStates(identities);
  while (Date.now() < deadline) {
    if (states.every((state) => state === "missing")) return { absent: true, states };
    if (states.some((state) => state === "mismatch" || state === "unknown")) {
      return { absent: false, states };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    states = await identityStates(identities);
  }
  return { absent: states.every((state) => state === "missing"), states };
}

async function signalVerifiedGroups(
  identities: ProcessIdentity[],
  signal: NodeJS.Signals,
): Promise<string[]> {
  const errors: string[] = [];
  const ownGroup = await currentProcessGroup();
  const groups = new Set<number>();
  for (const identity of identities) {
    const state = await inspectProcessIdentity(identity);
    const groupState = await processGroupState(identity.processGroup);
    if (state !== "alive" && !(state === "missing" && groupState === "alive")) continue;
    if (identity.processGroup === ownGroup) {
      errors.push(`Refused to signal worker process group ${identity.processGroup} because it matches the parent.`);
      continue;
    }
    groups.add(identity.processGroup);
  }
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        errors.push(`Could not send ${signal} to worker process group ${group}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return errors;
}

export async function terminateRecordedProcess(
  identity: ProcessIdentity,
  expectedLaunchNonce: string,
): Promise<{ verified: boolean; error?: string }> {
  if (identity.launchNonce !== expectedLaunchNonce) {
    return { verified: false, error: "Recorded process launch nonce does not match the lifecycle intent." };
  }
  let processes = await waitForProcessAbsence([identity], 200);
  const safelySignalable = () =>
    processes.states.some((state) => state === "alive") &&
    processes.states.every((state) => state === "alive" || state === "missing");
  const errors: string[] = [];
  if (!processes.absent && safelySignalable()) {
    errors.push(...await signalVerifiedGroups([identity], "SIGTERM"));
    processes = await waitForProcessAbsence([identity], 2000);
  }
  if (!processes.absent && safelySignalable()) {
    errors.push(...await signalVerifiedGroups([identity], "SIGKILL"));
    processes = await waitForProcessAbsence([identity], 2000);
  }
  if (!processes.absent) {
    errors.push(`Recorded process termination could not be verified (${processes.states.join(", ")}).`);
  }
  return { verified: processes.absent, error: errors.join(" ") || undefined };
}

export async function verifyWorkerProcessesAbsent(
  pi: ExtensionAPI,
  worker: SupervisedWorker,
  workerIdentity?: ProcessIdentity,
  timeoutMs = 2000,
): Promise<{ absent: boolean; states: ProcessIdentityState[] }> {
  if (!(await reconcileWorkerSurfaceCreation(pi, worker)).verified) {
    return { absent: false, states: ["unknown"] };
  }
  if (workerIdentity && workerIdentity.launchNonce !== worker.launchNonce) {
    return { absent: false, states: ["unknown"] };
  }
  let runnerIdentity: ProcessIdentity | undefined;
  let runnerMatches = false;
  try {
    const runner = await readRunnerProcess(worker.jobDir);
    runnerIdentity = runner?.wrapper;
    runnerMatches = runnerIdentity !== undefined && runner?.jobId === worker.id &&
      runner.launchNonce === worker.launchNonce && runnerIdentity.launchNonce === worker.launchNonce;
  } catch {
    runnerMatches = false;
  }
  let launchPrevented = false;
  if (!runnerMatches) {
    const claim = await resolveWorkerLaunchClaim(worker);
    if (!claim.valid) return { absent: false, states: ["unknown"] };
    runnerIdentity = claim.runnerIdentity;
    launchPrevented = claim.launchPrevented;
  }
  const identities = [runnerIdentity, workerIdentity].filter(
    (identity): identity is ProcessIdentity => identity !== undefined,
  );
  if (launchPrevented && identities.length === 0) return { absent: true, states: ["missing"] };
  return waitForProcessAbsence(identities, timeoutMs);
}

export async function terminateWorker(
  pi: ExtensionAPI,
  worker: SupervisedWorker,
  workerIdentity?: ProcessIdentity,
): Promise<WorkerTerminationResult> {
  const errors: string[] = [];
  try {
    const launchBarrier = await resolveWorkerLaunchClaim(worker);
    if (launchBarrier.protocolEnabled && !launchBarrier.valid) {
      return {
        surfaceAbsent: false,
        processesAbsent: false,
        verified: false,
        errors: [launchBarrier.error ?? "Worker launch prevention could not be claimed."],
      };
    }
    if (launchBarrier.runnerIdentity) {
      const stopped = await terminateRecordedProcess(launchBarrier.runnerIdentity, worker.launchNonce);
      if (!stopped.verified) {
        return {
          surfaceAbsent: false,
          processesAbsent: false,
          verified: false,
          errors: [stopped.error ?? "Runner launch claim process could not be terminated."],
        };
      }
    }
  } catch (error) {
    return {
      surfaceAbsent: false,
      processesAbsent: false,
      verified: false,
      errors: [`Could not claim worker launch prevention: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const creation = await reconcileWorkerSurfaceCreation(pi, worker);
  if (!creation.verified) {
    return {
      surfaceAbsent: false,
      processesAbsent: false,
      verified: false,
      errors: [creation.error ?? "Surface-creation process is not verified absent."],
    };
  }
  let runnerIdentity: ProcessIdentity | undefined;
  let processMetadataValid = true;
  let launchPrevented = false;
  let runnerMatches = false;
  try {
    const runner = await readRunnerProcess(worker.jobDir);
    runnerIdentity = runner?.wrapper;
    runnerMatches = runnerIdentity !== undefined && runner?.jobId === worker.id &&
      runner.launchNonce === worker.launchNonce && runnerIdentity.launchNonce === worker.launchNonce;
  } catch {
    runnerMatches = false;
  }
  if (workerIdentity && workerIdentity.launchNonce !== worker.launchNonce) {
    processMetadataValid = false;
    errors.push("Worker process identity launch nonce does not match lifecycle intent.");
  } else if (!runnerMatches) {
    runnerIdentity = undefined;
    try {
      const claim = await resolveWorkerLaunchClaim(worker);
      if (claim.valid) {
        runnerIdentity = claim.runnerIdentity;
        launchPrevented = claim.launchPrevented;
      } else {
        processMetadataValid = false;
        errors.push(claim.error ?? "Runner process identity is missing or does not match the job and launch nonce.");
      }
    } catch (error) {
      processMetadataValid = false;
      errors.push(`Could not resolve worker launch claim: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const verifiedWorkerIdentity = processMetadataValid && workerIdentity?.launchNonce === worker.launchNonce
    ? workerIdentity
    : undefined;
  const identities = [runnerIdentity, verifiedWorkerIdentity].filter(
    (identity): identity is ProcessIdentity => identity !== undefined,
  );
  let processes = launchPrevented && identities.length === 0
    ? { absent: true, states: ["missing" as const] }
    : await waitForProcessAbsence(identities, 1000);
  const safelySignalable = () =>
    processMetadataValid &&
    processes.states.some((state) => state === "alive") &&
    processes.states.every((state) => state === "alive" || state === "missing");
  if (!processes.absent && safelySignalable()) {
    errors.push(...await signalVerifiedGroups(identities, "SIGTERM"));
    processes = await waitForProcessAbsence(identities, 2000);
  }
  if (!processes.absent && safelySignalable()) {
    errors.push(...await signalVerifiedGroups(identities, "SIGKILL"));
    processes = await waitForProcessAbsence(identities, 2000);
  }

  let surfaceIsAbsent = false;
  if (processMetadataValid && processes.absent) {
    const closed = await pi.exec(
      "supacode",
      [
        "surface",
        "close",
        "-w",
        worker.tabWorktreeId,
        "-t",
        worker.tabId,
        "-s",
        worker.surfaceId,
      ],
      { timeout: 5000 },
    );
    if (closed.code !== 0) {
      errors.push(`Supacode surface close failed: ${(closed.stderr || closed.stdout || `exit ${closed.code}`).trim()}`);
    }
    surfaceIsAbsent = await waitForSurfaceAbsence(pi, worker, 3000);
  } else {
    const observedAbsent = await surfaceAbsent(pi, worker);
    surfaceIsAbsent = observedAbsent === true;
    if (!surfaceIsAbsent) {
      errors.push(observedAbsent === false
        ? "Worker surface was retained because process absence is unverified."
        : "Worker surface state is unavailable while process absence is unverified.");
    }
  }
  if (!surfaceIsAbsent) errors.push("Worker surface absence could not be verified.");
  if (!processes.absent) {
    errors.push(`Worker process termination could not be verified (${processes.states.join(", ")}).`);
  }
  return {
    surfaceAbsent: surfaceIsAbsent,
    processesAbsent: processes.absent,
    verified: surfaceIsAbsent && processes.absent && processMetadataValid,
    errors,
  };
}
