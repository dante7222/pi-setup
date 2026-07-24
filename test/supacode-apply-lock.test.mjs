import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireDestinationApplyLock,
  destinationApplyLockPath,
  recoverStaleDestinationApplyLock,
  releaseDestinationApplyLock,
} from "../extensions/supacode-subagents/apply-lock.ts";
import { captureProcessIdentity } from "../extensions/supacode-subagents/process-identity.ts";

function execResult(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => resolve({
      stdout,
      stderr,
      code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
    }));
  });
}

async function git(cwd, ...args) {
  const result = await execResult("git", ["-C", cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function gitDir(gitDirectory, ...args) {
  const result = await execResult("git", ["--git-dir", gitDirectory, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function writeLockObject(fixture, record, name) {
  const recordPath = join(fixture.root, name);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return gitDir(fixture.gitDir, "hash-object", "-w", recordPath);
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-apply-lock-"));
  const repository = join(root, "repository");
  const linked = join(root, "linked");
  await git(root, "init", "repository");
  await git(repository, "config", "user.name", "Test User");
  await git(repository, "config", "user.email", "test@example.com");
  await writeFile(join(repository, "tracked.txt"), "base\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "base");
  await git(repository, "worktree", "add", "-b", "linked", linked, "HEAD");
  return {
    root,
    repository,
    linked,
    gitDir: await realpath(await git(repository, "rev-parse", "--absolute-git-dir")),
    linkedGitDir: await realpath(await git(linked, "rev-parse", "--absolute-git-dir")),
  };
}

test("destination locks serialize jobs, preserve replacement owners, and isolate linked worktrees", async () => {
  const fixture = await repositoryFixture();
  try {
    const lock = await acquireDestinationApplyLock(fixture.gitDir, "handoff-one", fixture.repository);
    await assert.rejects(
      acquireDestinationApplyLock(fixture.gitDir, "handoff-two", fixture.repository),
      /Another apply is active/,
    );
    const linkedLock = await acquireDestinationApplyLock(
      fixture.linkedGitDir,
      "handoff-linked",
      fixture.linked,
    );
    await releaseDestinationApplyLock(linkedLock);

    const replacement = { ...lock.record, ownerToken: "replacement-owner" };
    const replacementObject = await writeLockObject(fixture, replacement, "replacement-lock.json");
    await gitDir(fixture.gitDir, "update-ref", lock.ref, replacementObject, lock.objectId);
    await assert.rejects(releaseDestinationApplyLock(lock), /no longer owned/);
    assert.equal(await gitDir(fixture.gitDir, "rev-parse", lock.ref), replacementObject);
    await gitDir(fixture.gitDir, "update-ref", "-d", lock.ref, replacementObject);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("stale destination locks require process-identity proof before recovery", async () => {
  const fixture = await repositoryFixture();
  try {
    const live = await acquireDestinationApplyLock(fixture.gitDir, "live", fixture.repository);
    await assert.rejects(
      recoverStaleDestinationApplyLock(fixture.gitDir),
      /owner is alive/,
    );
    await releaseDestinationApplyLock(live);

    const identity = await captureProcessIdentity(process.pid, "stale");
    assert.ok(identity);
    const lockRef = destinationApplyLockPath(fixture.gitDir);
    const staleObject = await writeLockObject(fixture, {
      schemaVersion: 2,
      ownerToken: "stale-owner",
      pid: process.pid,
      hostname: hostname(),
      process: { ...identity, startSignature: `${identity.startSignature}-stale` },
      handoffId: "stale",
      destinationRoot: fixture.repository,
      targetGitDir: fixture.gitDir,
      acquiredAt: new Date().toISOString(),
    }, "stale-lock.json");
    await gitDir(fixture.gitDir, "update-ref", lockRef, staleObject, "0".repeat(staleObject.length));
    await assert.rejects(
      recoverStaleDestinationApplyLock(fixture.gitDir, async () => false),
      /child process absence is not verified/,
    );
    const recovered = await recoverStaleDestinationApplyLock(fixture.gitDir, async () => true);
    assert.equal(recovered.recovered, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("canonical checkout aliases resolve to one destination lock namespace", async () => {
  const fixture = await repositoryFixture();
  const alias = join(fixture.root, "alias");
  const gitDirAlias = join(fixture.root, "git-dir-alias");
  try {
    await symlink(fixture.repository, alias);
    await symlink(fixture.gitDir, gitDirAlias);
    const lock = await acquireDestinationApplyLock(gitDirAlias, "alias", await realpath(alias));
    await assert.rejects(
      acquireDestinationApplyLock(fixture.gitDir, "canonical", fixture.repository),
      /Another apply is active/,
    );
    await releaseDestinationApplyLock(lock);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
