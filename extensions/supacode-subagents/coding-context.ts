import * as fs from "node:fs";
import * as path from "node:path";

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

export async function repositoryRelativeCwd(
  repositoryRoot: string,
  originalCwd: string,
): Promise<string> {
  const [canonicalRoot, canonicalCwd] = await Promise.all([
    fs.promises.realpath(repositoryRoot),
    fs.promises.realpath(originalCwd),
  ]);
  const relativePath = path.relative(canonicalRoot, canonicalCwd);
  if (escapesRoot(relativePath)) {
    throw new Error(`Working directory is outside its Git repository: ${originalCwd}`);
  }
  return relativePath;
}

export async function codingWorkerCwd(
  worktreeRoot: string,
  relativeCwd: string,
): Promise<string> {
  const canonicalRoot = await fs.promises.realpath(worktreeRoot);
  const candidate = path.resolve(canonicalRoot, relativeCwd);
  if (escapesRoot(path.relative(canonicalRoot, candidate))) {
    throw new Error(`Delegated working directory escapes its coding worktree: ${relativeCwd}`);
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = await fs.promises.realpath(candidate);
  } catch {
    throw new Error(`Delegated working directory is absent from the coding worktree: ${relativeCwd || "."}`);
  }
  if (escapesRoot(path.relative(canonicalRoot, canonicalCandidate))) {
    throw new Error(`Delegated working directory resolves outside its coding worktree: ${relativeCwd}`);
  }
  const stat = await fs.promises.stat(canonicalCandidate);
  if (!stat.isDirectory()) {
    throw new Error(`Delegated working directory is not a directory: ${relativeCwd || "."}`);
  }
  return canonicalCandidate;
}
