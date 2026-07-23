import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attestCandidateCheckout,
  captureLoopCandidate,
  createCandidateCheckout,
  removeCandidateCheckout,
  verifyLoopCandidateSource,
} from "../extensions/supacode-subagents/candidate-tree.ts";
import { decideLoopTransition } from "../extensions/supacode-subagents/loop-state.ts";
import { runValidationProcess } from "../extensions/supacode-subagents/validation-process.ts";

function execResult(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => resolve({
        stdout,
        stderr,
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        killed: Boolean(error?.killed),
      }),
    );
  });
}

async function checked(command, args) {
  const result = await execResult(command, args);
  assert.equal(result.code, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

async function git(cwd, ...args) {
  return checked("git", ["-C", cwd, ...args]);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-candidate-"));
  const repository = join(root, "repository");
  const worker = join(root, "worker");
  const artifacts = join(root, "artifacts");
  await git(root, "init", "repository");
  await git(repository, "config", "user.name", "Test User");
  await git(repository, "config", "user.email", "test@example.com");
  await writeFile(join(repository, "tracked.txt"), "base\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "base");
  const baseSha = await git(repository, "rev-parse", "HEAD");
  const branch = "pi-agent/aaaaaa/bbbbbb";
  await git(repository, "worktree", "add", "-b", branch, worker, baseSha);
  await mkdir(artifacts, { recursive: true });
  return {
    root,
    repository,
    worker,
    artifacts,
    baseSha,
    branch,
    pi: { exec: execResult },
    workspace: {
      id: "11111111-2222-4333-8444-555555555555",
      worktreePath: worker,
      branch,
      baseSha,
    },
  };
}

async function runGate(fixture, candidate, name, command) {
  const directory = join(fixture.artifacts, name);
  const checkout = join(directory, "checkout");
  const before = await createCandidateCheckout(
    fixture.pi,
    fixture.worker,
    candidate,
    checkout,
  );
  try {
    const process = await runValidationProcess({
      command,
      cwd: checkout,
      logPath: join(directory, "check.log"),
      timeoutMs: 5000,
      maxLogBytes: 1024 * 1024,
      tailBytes: 4096,
    });
    const after = await attestCandidateCheckout(fixture.pi, candidate, checkout);
    return {
      before,
      after,
      passed: process.exitCode === 0 && !process.killed && before.unchanged && after.unchanged,
    };
  } finally {
    await removeCandidateCheckout(fixture.pi, fixture.worker, checkout);
  }
}

test("Git-backed loop gates use isolated checkouts of one immutable candidate tree", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "tracked.txt"), "candidate\n");
    await writeFile(join(fixture.worker, "untracked.txt"), "candidate-only\n");
    await writeFile(join(fixture.worker, "line\nname.txt"), "unusual path\n");
    await writeFile(join(fixture.worker, " trailing .txt"), "leading space\n");
    const iteration = join(fixture.artifacts, "iteration-1");
    await mkdir(iteration, { recursive: true });
    const candidate = await captureLoopCandidate(
      fixture.pi,
      fixture.workspace,
      1,
      iteration,
    );

    assert.equal(await git(fixture.worker, "rev-parse", `${candidate.ref}^{tree}`), candidate.tree);
    assert.equal(candidate.changedPaths.includes("line\nname.txt"), true);
    assert.equal(candidate.changedPaths.includes(" trailing .txt"), true);
    const mutating = await runGate(
      fixture,
      candidate,
      "mutating-gate",
      "printf 'mutated\\n' > tracked.txt",
    );
    assert.equal(mutating.before.unchanged, true);
    assert.equal(mutating.after.unchanged, false);
    assert.equal(mutating.passed, false);
    assert.equal(
      JSON.parse(await readFile(join(fixture.artifacts, "mutating-gate", "checkout-lifecycle.json"), "utf8")).phase,
      "removed",
    );

    const indexMutating = await runGate(
      fixture,
      candidate,
      "index-mutating-gate",
      "git rm --cached -- tracked.txt >/dev/null",
    );
    assert.equal(indexMutating.after.tree, candidate.tree);
    assert.equal(indexMutating.after.statusPaths.includes("tracked.txt"), true);
    assert.equal(indexMutating.after.unchanged, false);
    assert.equal(indexMutating.passed, false);

    const isolated = await runGate(
      fixture,
      candidate,
      "isolated-gate",
      "test \"$(cat tracked.txt)\" = candidate && test \"$(cat untracked.txt)\" = candidate-only",
    );
    assert.equal(isolated.passed, true);

    const sameTreeCommit = await git(
      fixture.worker,
      "commit-tree",
      candidate.tree,
      "-p",
      candidate.commit,
      "-m",
      "same tree, different commit",
    );
    const headDriftDirectory = join(fixture.artifacts, "same-tree-head-drift");
    const headDriftCheckout = join(headDriftDirectory, "checkout");
    await createCandidateCheckout(fixture.pi, fixture.worker, candidate, headDriftCheckout);
    try {
      await git(headDriftCheckout, "reset", "--hard", sameTreeCommit);
      const headDrift = await attestCandidateCheckout(fixture.pi, candidate, headDriftCheckout);
      assert.equal(headDrift.tree, candidate.tree);
      assert.equal(headDrift.unchanged, false);
    } finally {
      await removeCandidateCheckout(fixture.pi, fixture.worker, headDriftCheckout);
    }

    await verifyLoopCandidateSource(
      fixture.pi,
      fixture.workspace,
      candidate,
      join(iteration, "final.index"),
    );

    await git(fixture.worker, "update-ref", candidate.ref, fixture.baseSha, candidate.commit);
    await assert.rejects(
      verifyLoopCandidateSource(
        fixture.pi,
        fixture.workspace,
        candidate,
        join(iteration, "retargeted-ref.index"),
      ),
      /candidate ref changed/,
    );
    await git(fixture.worker, "update-ref", candidate.ref, candidate.commit, fixture.baseSha);

    await writeFile(join(fixture.worker, "after-capture.txt"), "drift\n");
    await assert.rejects(
      verifyLoopCandidateSource(
        fixture.pi,
        fixture.workspace,
        candidate,
        join(iteration, "drift.index"),
      ),
      /changed before acceptance/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Git-backed repair orchestration accepts only the newly gated candidate", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "tracked.txt"), "attempt-one\n");
    const firstDir = join(fixture.artifacts, "attempt-1");
    await mkdir(firstDir, { recursive: true });
    const first = await captureLoopCandidate(fixture.pi, fixture.workspace, 1, firstDir);
    const failedGate = await runGate(fixture, first, "attempt-1-gate", "exit 1");
    const firstTransition = decideLoopTransition({
      attempt: 1,
      maxAttempts: 2,
      checksPassed: failedGate.passed,
      reviewVerdicts: [],
      candidateFingerprint: first.tree,
      previousCandidateFingerprints: new Set(),
    });
    assert.equal(firstTransition.state, "repairing");

    await writeFile(join(fixture.worker, "tracked.txt"), "attempt-two\n");
    const secondDir = join(fixture.artifacts, "attempt-2");
    await mkdir(secondDir, { recursive: true });
    const second = await captureLoopCandidate(fixture.pi, fixture.workspace, 2, secondDir);
    assert.notEqual(second.tree, first.tree);
    const passedGate = await runGate(
      fixture,
      second,
      "attempt-2-gate",
      "test \"$(cat tracked.txt)\" = attempt-two",
    );
    assert.equal(passedGate.passed, true);
    await verifyLoopCandidateSource(
      fixture.pi,
      fixture.workspace,
      second,
      join(secondDir, "accept.index"),
    );
    const transition = decideLoopTransition({
      attempt: 2,
      maxAttempts: 2,
      checksPassed: true,
      reviewVerdicts: ["pass"],
      candidateFingerprint: second.tree,
      previousCandidateFingerprints: new Set([first.tree]),
    });
    assert.equal(transition.state, "awaiting_apply");
    assert.equal(await readFile(join(fixture.worker, "tracked.txt"), "utf8"), "attempt-two\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
