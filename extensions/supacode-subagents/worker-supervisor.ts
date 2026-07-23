import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  currentProcessGroup,
  inspectProcessIdentity,
  type ProcessIdentity,
  type ProcessIdentityState,
} from "./process-identity.ts";
import { readRunnerProcess } from "./lifecycle.ts";
import { sameSupacodeUuid } from "./resource-id.ts";

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
  worker: SupervisedWorker,
  workerIdentity?: ProcessIdentity,
  timeoutMs = 2000,
): Promise<{ absent: boolean; states: ProcessIdentityState[] }> {
  const runner = await readRunnerProcess(worker.jobDir);
  if (
    !runner?.wrapper ||
    runner.jobId !== worker.id ||
    runner.launchNonce !== worker.launchNonce ||
    runner.wrapper.launchNonce !== worker.launchNonce ||
    (workerIdentity && workerIdentity.launchNonce !== worker.launchNonce)
  ) return { absent: false, states: ["unknown"] };
  const identities = [runner.wrapper, workerIdentity].filter(
    (identity): identity is ProcessIdentity => identity !== undefined,
  );
  return waitForProcessAbsence(identities, timeoutMs);
}

export async function terminateWorker(
  pi: ExtensionAPI,
  worker: SupervisedWorker,
  workerIdentity?: ProcessIdentity,
): Promise<WorkerTerminationResult> {
  const errors: string[] = [];
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

  let runnerIdentity: ProcessIdentity | undefined;
  let processMetadataValid = true;
  try {
    const runner = await readRunnerProcess(worker.jobDir);
    runnerIdentity = runner?.wrapper;
    if (
      !runnerIdentity ||
      runner?.jobId !== worker.id ||
      runner.launchNonce !== worker.launchNonce ||
      runnerIdentity.launchNonce !== worker.launchNonce ||
      (workerIdentity && workerIdentity.launchNonce !== worker.launchNonce)
    ) {
      runnerIdentity = undefined;
      processMetadataValid = false;
      errors.push("Runner process identity is missing or does not match the job and launch nonce.");
    }
  } catch (error) {
    processMetadataValid = false;
    errors.push(`Could not read runner process identity: ${error instanceof Error ? error.message : String(error)}`);
  }
  const verifiedWorkerIdentity = processMetadataValid && workerIdentity?.launchNonce === worker.launchNonce
    ? workerIdentity
    : undefined;
  const identities = [runnerIdentity, verifiedWorkerIdentity].filter(
    (identity): identity is ProcessIdentity => identity !== undefined,
  );
  const surfaceIsAbsent = await waitForSurfaceAbsence(pi, worker, 3000);
  let processes = await waitForProcessAbsence(identities, 1000);
  const safelySignalable = () =>
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
