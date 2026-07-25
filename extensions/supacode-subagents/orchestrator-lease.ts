import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createExclusiveJson,
  durableAtomicWrite,
  readJsonStrict,
} from "./durable-state.ts";
import {
  captureProcessIdentity,
  inspectProcessIdentity,
  type ProcessIdentity,
  type ProcessIdentityState,
} from "./process-identity.ts";

const HEARTBEAT_INTERVAL_MS = 5_000;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

interface OrchestratorLeaseClaim {
  schemaVersion: 2;
  protocolVersion: 1;
  jobId: string;
  ownerToken: string;
  owner: ProcessIdentity;
  acquiredAt: string;
}

interface OrchestratorLeaseHeartbeat {
  schemaVersion: 2;
  protocolVersion: 1;
  jobId: string;
  ownerToken: string;
  sequence: number;
  renewedAt: string;
}

interface OrchestratorLeaseRelease {
  schemaVersion: 2;
  protocolVersion: 1;
  jobId: string;
  ownerToken: string;
  releasedAt: string;
}

interface OrchestratorRecoveryClaim {
  schemaVersion: 2;
  protocolVersion: 1;
  generation: number;
  jobId: string;
  ownerToken: string;
  owner: ProcessIdentity;
  acquiredAt: string;
}

interface OrchestratorRecoveryRelease {
  schemaVersion: 2;
  protocolVersion: 1;
  generation: number;
  jobId: string;
  ownerToken: string;
  releasedAt: string;
}

export interface OrchestratorRecoveryAuthorization {
  allowed: boolean;
  reason: string;
  ownerState?: ProcessIdentityState;
}

function claimPath(jobDir: string): string {
  return path.join(jobDir, "orchestrator-lease.json");
}

function heartbeatPath(jobDir: string): string {
  return path.join(jobDir, "orchestrator-heartbeat.json");
}

function releasePath(jobDir: string): string {
  return path.join(jobDir, "orchestrator-release.json");
}

function recoveryClaimPath(jobDir: string, generation: number): string {
  return path.join(jobDir, `orchestrator-recovery-${String(generation).padStart(6, "0")}-claim.json`);
}

function recoveryReleasePath(jobDir: string, generation: number): string {
  return path.join(jobDir, `orchestrator-recovery-${String(generation).padStart(6, "0")}-release.json`);
}

function validIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.pid === "number" && Number.isSafeInteger(identity.pid) && identity.pid > 1 &&
    typeof identity.startSignature === "string" && identity.startSignature.length > 0 &&
    typeof identity.processGroup === "number" && Number.isSafeInteger(identity.processGroup) && identity.processGroup > 1 &&
    typeof identity.command === "string" && typeof identity.launchNonce === "string" &&
    identity.launchNonce.length > 0;
}

async function readClaim(jobDir: string, expectedJobId: string): Promise<OrchestratorLeaseClaim | undefined> {
  const filePath = claimPath(jobDir);
  const claim = await readJsonStrict<OrchestratorLeaseClaim>(filePath);
  if (!claim) return undefined;
  if (
    claim.schemaVersion !== 2 || claim.protocolVersion !== 1 ||
    claim.jobId !== expectedJobId || !UUID_PATTERN.test(claim.ownerToken) ||
    !validIdentity(claim.owner) || typeof claim.acquiredAt !== "string"
  ) throw new Error(`Unsupported orchestrator lease claim at ${filePath}.`);
  return claim;
}

async function readHeartbeat(
  jobDir: string,
  claim: OrchestratorLeaseClaim,
): Promise<OrchestratorLeaseHeartbeat | undefined> {
  const filePath = heartbeatPath(jobDir);
  const heartbeat = await readJsonStrict<OrchestratorLeaseHeartbeat>(filePath);
  if (!heartbeat) return undefined;
  if (
    heartbeat.schemaVersion !== 2 || heartbeat.protocolVersion !== 1 ||
    heartbeat.jobId !== claim.jobId || heartbeat.ownerToken !== claim.ownerToken ||
    !Number.isSafeInteger(heartbeat.sequence) || heartbeat.sequence < 1 ||
    typeof heartbeat.renewedAt !== "string"
  ) throw new Error(`Unsupported orchestrator heartbeat at ${filePath}.`);
  return heartbeat;
}

async function readRelease(
  jobDir: string,
  claim: OrchestratorLeaseClaim,
): Promise<OrchestratorLeaseRelease | undefined> {
  const filePath = releasePath(jobDir);
  const release = await readJsonStrict<OrchestratorLeaseRelease>(filePath);
  if (!release) return undefined;
  if (
    release.schemaVersion !== 2 || release.protocolVersion !== 1 ||
    release.jobId !== claim.jobId || release.ownerToken !== claim.ownerToken ||
    typeof release.releasedAt !== "string"
  ) throw new Error(`Unsupported orchestrator lease release at ${filePath}.`);
  return release;
}

export class OrchestratorLease {
  readonly jobDir: string;
  readonly jobId: string;
  readonly ownerToken: string;
  readonly owner: ProcessIdentity;
  private sequence = 1;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatQueue: Promise<void> = Promise.resolve();
  private released = false;

  constructor(jobDir: string, jobId: string, ownerToken: string, owner: ProcessIdentity) {
    this.jobDir = jobDir;
    this.jobId = jobId;
    this.ownerToken = ownerToken;
    this.owner = owner;
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer || this.released) return;
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatQueue = this.heartbeatQueue
        .then(() => this.writeHeartbeat())
        .catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private async writeHeartbeat(): Promise<void> {
    if (this.released) return;
    this.sequence++;
    await durableAtomicWrite(
      heartbeatPath(this.jobDir),
      `${JSON.stringify({
        schemaVersion: 2,
        protocolVersion: 1,
        jobId: this.jobId,
        ownerToken: this.ownerToken,
        sequence: this.sequence,
        renewedAt: new Date().toISOString(),
      } satisfies OrchestratorLeaseHeartbeat, null, 2)}\n`,
    );
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.heartbeatQueue;
    const record = {
      schemaVersion: 2,
      protocolVersion: 1,
      jobId: this.jobId,
      ownerToken: this.ownerToken,
      releasedAt: new Date().toISOString(),
    } satisfies OrchestratorLeaseRelease;
    const created = await createExclusiveJson(releasePath(this.jobDir), record);
    if (created) return;
    const claim = await readClaim(this.jobDir, this.jobId);
    if (!claim) throw new Error(`Orchestrator lease claim disappeared for ${this.jobId}.`);
    const existing = await readRelease(this.jobDir, claim);
    if (!existing) throw new Error(`Orchestrator lease release disappeared for ${this.jobId}.`);
  }
}

export async function acquireOrchestratorLease(
  jobDir: string,
  jobId: string,
): Promise<OrchestratorLease> {
  const ownerToken = randomUUID();
  const owner = await captureProcessIdentity(process.pid, randomUUID());
  if (!owner) throw new Error(`Could not capture orchestrator process identity for ${jobId}.`);
  const claim = {
    schemaVersion: 2,
    protocolVersion: 1,
    jobId,
    ownerToken,
    owner,
    acquiredAt: new Date().toISOString(),
  } satisfies OrchestratorLeaseClaim;
  if (!await createExclusiveJson(claimPath(jobDir), claim)) {
    throw new Error(`Orchestrator lease already exists for ${jobId}.`);
  }
  await durableAtomicWrite(
    heartbeatPath(jobDir),
    `${JSON.stringify({
      schemaVersion: 2,
      protocolVersion: 1,
      jobId,
      ownerToken,
      sequence: 1,
      renewedAt: claim.acquiredAt,
    } satisfies OrchestratorLeaseHeartbeat, null, 2)}\n`,
  );
  const lease = new OrchestratorLease(jobDir, jobId, ownerToken, owner);
  lease.startHeartbeat();
  return lease;
}

async function latestRecoveryGeneration(jobDir: string): Promise<number> {
  const entries = await fs.promises.readdir(jobDir);
  let latest = 0;
  for (const entry of entries) {
    const match = /^orchestrator-recovery-(\d{6})-claim\.json$/.exec(entry);
    if (!match) continue;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error(`Invalid orchestrator recovery generation in ${entry}.`);
    }
    latest = Math.max(latest, generation);
  }
  return latest;
}

async function readRecoveryClaim(
  jobDir: string,
  jobId: string,
  generation: number,
): Promise<OrchestratorRecoveryClaim | undefined> {
  const filePath = recoveryClaimPath(jobDir, generation);
  const claim = await readJsonStrict<OrchestratorRecoveryClaim>(filePath);
  if (!claim) return undefined;
  if (
    claim.schemaVersion !== 2 || claim.protocolVersion !== 1 || claim.generation !== generation ||
    claim.jobId !== jobId || !UUID_PATTERN.test(claim.ownerToken) ||
    !validIdentity(claim.owner) || typeof claim.acquiredAt !== "string"
  ) throw new Error(`Unsupported orchestrator recovery claim at ${filePath}.`);
  return claim;
}

async function readRecoveryRelease(
  jobDir: string,
  claim: OrchestratorRecoveryClaim,
): Promise<OrchestratorRecoveryRelease | undefined> {
  const filePath = recoveryReleasePath(jobDir, claim.generation);
  const release = await readJsonStrict<OrchestratorRecoveryRelease>(filePath);
  if (!release) return undefined;
  if (
    release.schemaVersion !== 2 || release.protocolVersion !== 1 ||
    release.generation !== claim.generation || release.jobId !== claim.jobId ||
    release.ownerToken !== claim.ownerToken || typeof release.releasedAt !== "string"
  ) throw new Error(`Unsupported orchestrator recovery release at ${filePath}.`);
  return release;
}

export class OrchestratorRecoveryLease {
  readonly jobDir: string;
  readonly jobId: string;
  readonly generation: number;
  readonly ownerToken: string;
  private released = false;

  constructor(jobDir: string, jobId: string, generation: number, ownerToken: string) {
    this.jobDir = jobDir;
    this.jobId = jobId;
    this.generation = generation;
    this.ownerToken = ownerToken;
  }

  async release(): Promise<void> {
    if (this.released) return;
    const record = {
      schemaVersion: 2,
      protocolVersion: 1,
      generation: this.generation,
      jobId: this.jobId,
      ownerToken: this.ownerToken,
      releasedAt: new Date().toISOString(),
    } satisfies OrchestratorRecoveryRelease;
    if (!await createExclusiveJson(recoveryReleasePath(this.jobDir, this.generation), record)) {
      const claim = await readRecoveryClaim(this.jobDir, this.jobId, this.generation);
      if (!claim || claim.ownerToken !== this.ownerToken) {
        throw new Error(`Orchestrator recovery claim changed for ${this.jobId}.`);
      }
      const existing = await readRecoveryRelease(this.jobDir, claim);
      if (!existing) throw new Error(`Orchestrator recovery release disappeared for ${this.jobId}.`);
    }
    this.released = true;
  }
}

export type OrchestratorRecoveryLeaseAcquisition =
  | { acquired: true; reason: string; lease: OrchestratorRecoveryLease }
  | { acquired: false; reason: string; ownerState?: ProcessIdentityState };

export async function authorizeOrchestratorRecovery(
  jobDir: string,
  jobId: string,
  protocolVersion: unknown,
): Promise<OrchestratorRecoveryAuthorization> {
  if (protocolVersion !== undefined && protocolVersion !== 1) {
    return { allowed: false, reason: `Unsupported orchestrator lease protocol ${String(protocolVersion)}.` };
  }
  if (protocolVersion === undefined) {
    const artifactPaths = [claimPath(jobDir), heartbeatPath(jobDir), releasePath(jobDir)];
    const artifactPresence = await Promise.all(artifactPaths.map(async (filePath) => {
      try {
        await fs.promises.access(filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }));
    if (!artifactPresence.some(Boolean)) {
      return { allowed: true, reason: "Delegation predates authenticated orchestrator leases." };
    }
    if (!artifactPresence[0]) {
      return { allowed: false, reason: "Orchestrator lease artifacts exist without an authenticated claim." };
    }
  }
  const claim = await readClaim(jobDir, jobId);
  if (!claim) {
    return { allowed: false, reason: "Authenticated orchestrator lease claim is missing." };
  }
  const [heartbeat, release] = await Promise.all([
    readHeartbeat(jobDir, claim),
    readRelease(jobDir, claim),
  ]);
  if (!heartbeat) {
    return { allowed: false, reason: "Authenticated orchestrator heartbeat is missing." };
  }
  if (release) {
    return { allowed: true, reason: `Orchestrator lease was released at ${release.releasedAt}.` };
  }
  const ownerState = await inspectProcessIdentity(claim.owner);
  if (ownerState === "missing" || ownerState === "mismatch") {
    return {
      allowed: true,
      ownerState,
      reason: `Orchestrator owner is ${ownerState}; recovery may take ownership.`,
    };
  }
  return {
    allowed: false,
    ownerState,
    reason: ownerState === "alive"
      ? `Orchestrator ${claim.owner.pid} still owns this delegation; recovery was not started.`
      : "Orchestrator identity is indeterminate; recovery was refused.",
  };
}

export async function acquireOrchestratorRecoveryLease(
  jobDir: string,
  jobId: string,
  protocolVersion: unknown,
  options: { allowLiveOrchestrator?: boolean } = {},
): Promise<OrchestratorRecoveryLeaseAcquisition> {
  const authorization = await authorizeOrchestratorRecovery(jobDir, jobId, protocolVersion);
  const liveOrchestratorCancellation = !authorization.allowed &&
    options.allowLiveOrchestrator === true && authorization.ownerState === "alive";
  if (!authorization.allowed && !liveOrchestratorCancellation) {
    return {
      acquired: false,
      reason: authorization.reason,
      ownerState: authorization.ownerState,
    };
  }
  const authorizationReason = liveOrchestratorCancellation
    ? `${authorization.reason} An exclusive cancellation generation may coexist with that owner.`
    : authorization.reason;
  for (let retry = 0; retry < 4; retry++) {
    const latest = await latestRecoveryGeneration(jobDir);
    if (latest > 0) {
      const priorClaim = await readRecoveryClaim(jobDir, jobId, latest);
      if (!priorClaim) continue;
      const priorRelease = await readRecoveryRelease(jobDir, priorClaim);
      if (!priorRelease) {
        const ownerState = await inspectProcessIdentity(priorClaim.owner);
        if (ownerState === "alive" || ownerState === "unknown") {
          return {
            acquired: false,
            ownerState,
            reason: ownerState === "alive"
              ? `Recovery generation ${latest} is owned by process ${priorClaim.owner.pid}.`
              : `Recovery generation ${latest} has indeterminate process ownership.`,
          };
        }
      }
    }
    const generation = latest + 1;
    if (!Number.isSafeInteger(generation) || generation > 999_999) {
      return { acquired: false, reason: "Orchestrator recovery generation limit was reached." };
    }
    const ownerToken = randomUUID();
    const owner = await captureProcessIdentity(process.pid, randomUUID());
    if (!owner) return { acquired: false, reason: `Could not capture recovery process identity for ${jobId}.` };
    const claim = {
      schemaVersion: 2,
      protocolVersion: 1,
      generation,
      jobId,
      ownerToken,
      owner,
      acquiredAt: new Date().toISOString(),
    } satisfies OrchestratorRecoveryClaim;
    if (!await createExclusiveJson(recoveryClaimPath(jobDir, generation), claim)) continue;
    return {
      acquired: true,
      reason: `${authorizationReason} Recovery generation ${generation} was acquired.`,
      lease: new OrchestratorRecoveryLease(jobDir, jobId, generation, ownerToken),
    };
  }
  return { acquired: false, reason: "Another process won the orchestrator recovery claim." };
}
