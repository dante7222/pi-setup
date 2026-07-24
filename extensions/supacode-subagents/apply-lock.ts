import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import {
  captureProcessIdentity,
  inspectProcessIdentity,
  type ProcessIdentity,
} from "./process-identity.ts";

const OBJECT_ID_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

export interface DestinationApplyLockRecord {
  schemaVersion: 2;
  ownerToken: string;
  pid: number;
  hostname: string;
  process: ProcessIdentity;
  handoffId: string;
  destinationRoot: string;
  targetGitDir: string;
  acquiredAt: string;
}

export interface DestinationApplyLock {
  path: string;
  ref: string;
  objectId: string;
  targetGitDir: string;
  record: DestinationApplyLockRecord;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

function gitCommand(
  targetGitDir: string,
  args: string[],
  input?: string,
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--git-dir", targetGitDir, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      code: code ?? 1,
    }));
    child.stdin.end(input);
  });
}

function canonicalGitDirectory(targetGitDir: string): string {
  return realpathSync(targetGitDir);
}

function lockRef(targetGitDir: string): string {
  const namespace = createHash("sha256").update(canonicalGitDirectory(targetGitDir)).digest("hex");
  return `refs/pi-delegate-locks/${namespace}`;
}

async function currentLockObject(
  targetGitDir: string,
  ref: string,
): Promise<string | undefined> {
  const result = await gitCommand(targetGitDir, ["rev-parse", "--verify", "--quiet", ref]);
  if (result.code !== 0) return undefined;
  const objectId = result.stdout.trim();
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new Error(`Destination apply lock ref has an invalid object ID: ${ref}`);
  }
  return objectId;
}

async function readLockRecord(
  targetGitDir: string,
  objectId: string,
): Promise<DestinationApplyLockRecord> {
  const result = await gitCommand(targetGitDir, ["cat-file", "blob", objectId]);
  if (result.code !== 0) throw new Error(`Could not read destination apply lock ${objectId}: ${result.stderr.trim()}`);
  let record: DestinationApplyLockRecord;
  try {
    record = JSON.parse(result.stdout) as DestinationApplyLockRecord;
  } catch (error) {
    throw new Error(`Destination apply lock metadata is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    record.schemaVersion !== 2 || typeof record.ownerToken !== "string" ||
    typeof record.handoffId !== "string" || !record.handoffId ||
    typeof record.hostname !== "string" || typeof record.destinationRoot !== "string" ||
    typeof record.targetGitDir !== "string" || !record.process ||
    !Number.isSafeInteger(record.process.pid) || record.process.pid <= 1 ||
    typeof record.process.startSignature !== "string" || !record.process.startSignature ||
    !Number.isSafeInteger(record.process.processGroup) || record.process.processGroup <= 1 ||
    typeof record.process.launchNonce !== "string" ||
    path.resolve(record.targetGitDir) !== path.resolve(targetGitDir)
  ) {
    throw new Error(`Destination apply lock metadata is malformed: ${objectId}`);
  }
  return record;
}

export function destinationApplyStateDir(targetGitDir: string): string {
  return path.join(targetGitDir, "pi-delegate-handoffs");
}

export function destinationApplyLockPath(targetGitDir: string): string {
  return lockRef(targetGitDir);
}

export async function acquireDestinationApplyLock(
  targetGitDir: string,
  handoffId: string,
  destinationRoot: string,
): Promise<DestinationApplyLock> {
  const canonicalGitDir = canonicalGitDirectory(targetGitDir);
  const processIdentity = await captureProcessIdentity(process.pid, handoffId);
  if (!processIdentity) throw new Error("Could not capture the apply process identity.");
  const record = {
    schemaVersion: 2,
    ownerToken: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    process: processIdentity,
    handoffId,
    destinationRoot,
    targetGitDir: canonicalGitDir,
    acquiredAt: new Date().toISOString(),
  } satisfies DestinationApplyLockRecord;
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const object = await gitCommand(canonicalGitDir, ["hash-object", "-w", "--stdin"], serialized);
  const objectId = object.stdout.trim();
  if (object.code !== 0 || !OBJECT_ID_PATTERN.test(objectId)) {
    throw new Error(`Could not persist destination apply lock metadata: ${(object.stderr || object.stdout).trim()}`);
  }
  const ref = lockRef(canonicalGitDir);
  const zero = "0".repeat(objectId.length);
  const acquired = await gitCommand(canonicalGitDir, ["update-ref", ref, objectId, zero]);
  if (acquired.code !== 0) {
    throw new Error(`Another apply is active or needs recovery for this destination. Inspect Git ref ${ref}.`);
  }
  return { path: ref, ref, objectId, targetGitDir: canonicalGitDir, record };
}

export async function releaseDestinationApplyLock(lock: DestinationApplyLock): Promise<void> {
  const released = await gitCommand(
    lock.targetGitDir,
    ["update-ref", "-d", lock.ref, lock.objectId],
  );
  if (released.code !== 0) {
    throw new Error(`Refused to release an apply lock no longer owned by this process: ${lock.ref}`);
  }
}

export async function recoverStaleDestinationApplyLock(
  targetGitDir: string,
  verifyOwnerResourcesAbsent?: (record: DestinationApplyLockRecord) => Promise<boolean>,
): Promise<{ recovered: boolean; message: string }> {
  const canonicalGitDir = canonicalGitDirectory(targetGitDir);
  const ref = lockRef(canonicalGitDir);
  const objectId = await currentLockObject(canonicalGitDir, ref);
  if (!objectId) return { recovered: false, message: "No destination apply lock exists." };
  const record = await readLockRecord(canonicalGitDir, objectId);
  if (record.hostname !== hostname()) {
    throw new Error(`Destination apply lock belongs to host ${record.hostname}; liveness cannot be verified here.`);
  }
  const state = await inspectProcessIdentity(record.process);
  if (state === "alive" || state === "unknown") {
    throw new Error(`Destination apply lock owner is ${state}; recovery was refused.`);
  }
  if (verifyOwnerResourcesAbsent && !await verifyOwnerResourcesAbsent(record)) {
    throw new Error("Destination apply child process absence is not verified; lock recovery was refused.");
  }
  const recovered = await gitCommand(canonicalGitDir, ["update-ref", "-d", ref, objectId]);
  if (recovered.code !== 0) {
    throw new Error(`Destination apply lock changed during recovery; no replacement owner was removed: ${ref}`);
  }
  return {
    recovered: true,
    message: `Recovered stale destination apply lock owned by PID ${record.pid} (${state}).`,
  };
}
