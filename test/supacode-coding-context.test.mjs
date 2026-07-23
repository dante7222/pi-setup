import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codingWorkerCwd,
  repositoryRelativeCwd,
} from "../extensions/supacode-subagents/coding-context.ts";

test("coding workers preserve the parent repository-relative directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-coding-context-"));
  try {
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    const nested = join("packages", "api");
    await mkdir(join(repository, nested), { recursive: true });
    await mkdir(join(worktree, nested), { recursive: true });

    const relative = await repositoryRelativeCwd(repository, join(repository, nested));
    assert.equal(relative, nested);
    assert.equal(await codingWorkerCwd(worktree, relative), await realpath(join(worktree, nested)));
    assert.equal(await repositoryRelativeCwd(repository, repository), "");
    assert.equal(await codingWorkerCwd(worktree, ""), await realpath(worktree));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding worker directories cannot escape through paths or symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-coding-context-"));
  try {
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    const outside = join(root, "outside");
    await mkdir(repository);
    await mkdir(worktree);
    await mkdir(outside);
    await symlink(outside, join(worktree, "escape"));

    await assert.rejects(repositoryRelativeCwd(repository, outside), /outside its Git repository/);
    await assert.rejects(codingWorkerCwd(worktree, "../outside"), /escapes its coding worktree/);
    await assert.rejects(codingWorkerCwd(worktree, "escape"), /resolves outside/);
    await assert.rejects(codingWorkerCwd(worktree, "missing"), /absent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
