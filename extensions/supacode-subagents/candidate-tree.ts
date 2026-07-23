import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { durableAtomicWrite, readJsonStrict } from "./durable-state.ts";
import {
  gitlinkPathsForTree,
  repositoryOperationBlockers,
  snapshotWorktreeTree,
} from "./handoff.ts";

const GIT_TIMEOUT_MS = 60_000;
const OBJECT_ID_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CandidateWorkspace {
  id: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
}

export interface LoopCandidate {
  attempt: number;
  tree: string;
  commit: string;
  ref: string;
  head: string;
  branch: string;
  patchPath: string;
  patchSha256: string;
  patchBytes: number;
  patchPreview: string;
  patchPreviewTruncated: boolean;
  changedPaths: string[];
  gitlinkPaths: string[];
}

export interface CandidateAttestation {
  candidateTree: string;
  candidateCommit: string;
  checkoutPath: string;
  head: string;
  tree: string;
  unchanged: boolean;
  statusPaths: string[];
  gitlinkPaths: string[];
  observedAt: string;
}

async function gitResult(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  return pi.exec("git", ["-C", cwd, ...args], { signal, timeout: GIT_TIMEOUT_MS });
}

async function gitStdout(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await gitResult(pi, cwd, args, signal);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`);
  }
  return result.stdout;
}

async function gitOutput(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return (await gitStdout(pi, cwd, args, signal)).trim();
}

function parseNulPaths(output: string): string[] {
  const values = output.split("\0").filter(Boolean);
  if (values.some((value) => value.includes("\uFFFD"))) {
    throw new Error("Candidate contains a path that is not valid UTF-8.");
  }
  return values;
}

async function readFilePrefix(
  filePath: string,
  maxBytes: number,
): Promise<{ content: string; bytes: number; truncated: boolean }> {
  const file = await fs.promises.open(filePath, "r");
  try {
    const stat = await file.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await file.read(buffer, 0, length, 0);
    return { content: buffer.toString("utf8"), bytes: stat.size, truncated: stat.size > maxBytes };
  } finally {
    await file.close();
  }
}

function candidateRef(workspace: CandidateWorkspace, attempt: number): string {
  return `refs/pi-agent-candidates/${workspace.id}/${String(attempt).padStart(3, "0")}`;
}

export async function captureLoopCandidate(
  pi: ExtensionAPI,
  workspace: CandidateWorkspace,
  attempt: number,
  iterationDir: string,
  signal?: AbortSignal,
): Promise<LoopCandidate> {
  const lifecyclePath = path.join(iterationDir, "candidate-lifecycle.json");
  await durableAtomicWrite(
    lifecyclePath,
    `${JSON.stringify({
      schemaVersion: 1,
      phase: "capturing",
      loopId: workspace.id,
      attempt,
      worktreePath: workspace.worktreePath,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
  const blockers = await repositoryOperationBlockers(
    pi,
    workspace.worktreePath,
    signal,
    "Candidate checkout",
  );
  if (blockers.length > 0) throw new Error(blockers.join("\n"));
  const [headBefore, branchBefore] = await Promise.all([
    gitOutput(pi, workspace.worktreePath, ["rev-parse", "HEAD"], signal),
    gitOutput(pi, workspace.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
  ]);
  if (branchBefore !== workspace.branch) {
    throw new Error(`Candidate checkout is on ${branchBefore}, not ${workspace.branch}.`);
  }

  const firstTree = await snapshotWorktreeTree(
    pi,
    workspace.worktreePath,
    headBefore,
    path.join(iterationDir, "candidate-first.index"),
    signal,
  );
  const secondTree = await snapshotWorktreeTree(
    pi,
    workspace.worktreePath,
    headBefore,
    path.join(iterationDir, "candidate-second.index"),
    signal,
  );
  const [headAfter, branchAfter] = await Promise.all([
    gitOutput(pi, workspace.worktreePath, ["rev-parse", "HEAD"], signal),
    gitOutput(pi, workspace.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
  ]);
  if (firstTree !== secondTree || headBefore !== headAfter || branchBefore !== branchAfter) {
    throw new Error("Candidate checkout changed while its immutable tree was being captured.");
  }

  const createdCommit = await gitOutput(
    pi,
    workspace.worktreePath,
    [
      "-c",
      "user.name=Pi Delegate Loop",
      "-c",
      "user.email=pi-delegate-loop@localhost",
      "commit-tree",
      firstTree,
      "-p",
      headBefore,
      "-m",
      `Delegate loop ${workspace.id} candidate ${attempt}`,
    ],
    signal,
  );
  if (!OBJECT_ID_PATTERN.test(createdCommit)) throw new Error("Git returned an invalid candidate commit.");
  const ref = candidateRef(workspace, attempt);
  const zeroObject = "0".repeat(createdCommit.length);
  const createdRef = await gitResult(
    pi,
    workspace.worktreePath,
    ["update-ref", ref, createdCommit, zeroObject],
    signal,
  );
  if (createdRef.code !== 0) {
    const existing = await gitOutput(pi, workspace.worktreePath, ["rev-parse", "--verify", ref], signal);
    if (existing !== createdCommit) {
      throw new Error(`Candidate ref ${ref} already identifies a different commit.`);
    }
  }
  const refTree = await gitOutput(pi, workspace.worktreePath, ["rev-parse", `${ref}^{tree}`], signal);
  if (refTree !== firstTree) throw new Error(`Candidate ref ${ref} does not preserve tree ${firstTree}.`);

  const patchPath = path.join(iterationDir, "candidate.patch");
  const patch = await gitResult(
    pi,
    workspace.worktreePath,
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-renames",
      `--output=${patchPath}`,
      workspace.baseSha,
      firstTree,
      "--",
    ],
    signal,
  );
  if (patch.code !== 0) {
    throw new Error(`Could not construct candidate patch: ${(patch.stderr || patch.stdout).trim()}`);
  }
  await fs.promises.chmod(patchPath, 0o400);
  const patchBuffer = await fs.promises.readFile(patchPath);
  const changedPaths = parseNulPaths(await gitStdout(
    pi,
    workspace.worktreePath,
    ["diff", "--name-only", "-z", "--no-renames", workspace.baseSha, firstTree, "--"],
    signal,
  ));
  const preview = await readFilePrefix(patchPath, 32 * 1024);
  const candidate = {
    attempt,
    tree: firstTree,
    commit: createdCommit,
    ref,
    head: headBefore,
    branch: branchBefore,
    patchPath,
    patchSha256: createHash("sha256").update(patchBuffer).digest("hex"),
    patchBytes: patchBuffer.length,
    patchPreview: preview.content,
    patchPreviewTruncated: preview.truncated,
    changedPaths,
    gitlinkPaths: await gitlinkPathsForTree(pi, workspace.worktreePath, firstTree, signal),
  } satisfies LoopCandidate;
  await durableAtomicWrite(
    path.join(iterationDir, "candidate.json"),
    `${JSON.stringify(candidate, null, 2)}\n`,
  );
  await durableAtomicWrite(
    lifecyclePath,
    `${JSON.stringify({
      schemaVersion: 1,
      phase: "ready",
      loopId: workspace.id,
      attempt,
      candidateTree: candidate.tree,
      candidateCommit: candidate.commit,
      candidateRef: candidate.ref,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
  return candidate;
}

export async function createCandidateCheckout(
  pi: ExtensionAPI,
  repositoryRoot: string,
  candidate: LoopCandidate,
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<CandidateAttestation> {
  try {
    await fs.promises.lstat(checkoutPath);
    throw new Error(`Candidate evaluator checkout already exists: ${checkoutPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lifecyclePath = path.join(path.dirname(checkoutPath), "checkout-lifecycle.json");
  await fs.promises.mkdir(path.dirname(checkoutPath), { recursive: true, mode: 0o700 });
  await durableAtomicWrite(
    lifecyclePath,
    `${JSON.stringify({
      schemaVersion: 1,
      phase: "provisioning",
      checkoutPath,
      candidateTree: candidate.tree,
      candidateCommit: candidate.commit,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
  const added = await gitResult(
    pi,
    repositoryRoot,
    ["worktree", "add", "--detach", checkoutPath, candidate.commit],
    signal,
  );
  if (added.code !== 0) {
    await durableAtomicWrite(
      lifecyclePath,
      `${JSON.stringify({
        schemaVersion: 1,
        phase: "recovery_required",
        checkoutPath,
        candidateTree: candidate.tree,
        candidateCommit: candidate.commit,
        error: (added.stderr || added.stdout).trim(),
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    throw new Error(`Could not create candidate evaluator checkout: ${(added.stderr || added.stdout).trim()}`);
  }
  try {
    await durableAtomicWrite(
      lifecyclePath,
      `${JSON.stringify({
        schemaVersion: 1,
        phase: "ready",
        checkoutPath,
        candidateTree: candidate.tree,
        candidateCommit: candidate.commit,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    const attestation = await attestCandidateCheckout(pi, candidate, checkoutPath, signal);
    if (!attestation.unchanged) {
      throw new Error("Fresh evaluator checkout did not match the immutable candidate tree.");
    }
    return attestation;
  } catch (error) {
    await gitResult(pi, repositoryRoot, ["worktree", "remove", "--force", checkoutPath])
      .catch(() => undefined);
    throw error;
  }
}

export async function attestCandidateCheckout(
  pi: ExtensionAPI,
  candidate: LoopCandidate,
  checkoutPath: string,
  signal?: AbortSignal,
): Promise<CandidateAttestation> {
  const head = await gitOutput(pi, checkoutPath, ["rev-parse", "HEAD"], signal);
  const tree = await snapshotWorktreeTree(
    pi,
    checkoutPath,
    head,
    path.join(path.dirname(checkoutPath), `.${path.basename(checkoutPath)}.attest.index`),
    signal,
  );
  const status = await gitStdout(
    pi,
    checkoutPath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    signal,
  );
  const statusPaths = parseNulPaths(status).map((record) => record.length >= 4 ? record.slice(3) : record);
  const gitlinkPaths = await gitlinkPathsForTree(pi, checkoutPath, tree, signal);
  return {
    candidateTree: candidate.tree,
    candidateCommit: candidate.commit,
    checkoutPath,
    head,
    tree,
    unchanged: head === candidate.commit && tree === candidate.tree &&
      statusPaths.length === 0 && gitlinkPaths.length === 0,
    statusPaths,
    gitlinkPaths,
    observedAt: new Date().toISOString(),
  };
}

export async function recordCandidateEvaluatorProcessIntent(
  checkoutPath: string,
  jobId: string,
  launchNonce: string,
  processJobDir = path.dirname(checkoutPath),
): Promise<void> {
  const lifecyclePath = path.join(path.dirname(checkoutPath), "checkout-lifecycle.json");
  const lifecycle = await readJsonStrict<Record<string, unknown>>(lifecyclePath);
  if (!lifecycle || lifecycle.phase !== "ready" || lifecycle.checkoutPath !== checkoutPath) {
    throw new Error(`Candidate evaluator lifecycle is not ready: ${lifecyclePath}`);
  }
  await durableAtomicWrite(
    lifecyclePath,
    `${JSON.stringify({
      ...lifecycle,
      phase: "evaluating",
      processJobId: jobId,
      processJobDir: path.resolve(processJobDir),
      processLaunchNonce: launchNonce,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

export async function removeCandidateCheckout(
  pi: ExtensionAPI,
  repositoryRoot: string,
  checkoutPath: string,
): Promise<void> {
  const lifecyclePath = path.join(path.dirname(checkoutPath), "checkout-lifecycle.json");
  await durableAtomicWrite(
    lifecyclePath,
    `${JSON.stringify({
      schemaVersion: 1,
      phase: "removing",
      checkoutPath,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
  const removed = await gitResult(
    pi,
    repositoryRoot,
    ["worktree", "remove", "--force", checkoutPath],
  );
  if (removed.code !== 0) {
    await durableAtomicWrite(
      lifecyclePath,
      `${JSON.stringify({
        schemaVersion: 1,
        phase: "recovery_required",
        checkoutPath,
        error: (removed.stderr || removed.stdout).trim(),
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    throw new Error(`Could not remove candidate evaluator checkout: ${(removed.stderr || removed.stdout).trim()}`);
  }
  await durableAtomicWrite(
    lifecyclePath,
    `${JSON.stringify({
      schemaVersion: 1,
      phase: "removed",
      checkoutPath,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

export async function verifyLoopCandidateSource(
  pi: ExtensionAPI,
  workspace: CandidateWorkspace,
  candidate: LoopCandidate,
  verificationIndexPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const blockers = await repositoryOperationBlockers(
    pi,
    workspace.worktreePath,
    signal,
    "Candidate checkout",
  );
  if (blockers.length > 0) throw new Error(blockers.join("\n"));
  const [head, branch, refCommit, refTree] = await Promise.all([
    gitOutput(pi, workspace.worktreePath, ["rev-parse", "HEAD"], signal),
    gitOutput(pi, workspace.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
    gitOutput(pi, workspace.worktreePath, ["rev-parse", "--verify", candidate.ref], signal),
    gitOutput(pi, workspace.worktreePath, ["rev-parse", `${candidate.ref}^{tree}`], signal),
  ]);
  const sourceTree = await snapshotWorktreeTree(
    pi,
    workspace.worktreePath,
    head,
    verificationIndexPath,
    signal,
  );
  if (
    head !== candidate.head || branch !== candidate.branch ||
    refCommit !== candidate.commit || refTree !== candidate.tree || sourceTree !== candidate.tree
  ) {
    throw new Error("Candidate source or immutable candidate ref changed before acceptance.");
  }
}
