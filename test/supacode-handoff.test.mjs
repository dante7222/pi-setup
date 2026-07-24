import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import {
  acquireDestinationApplyLock,
  releaseDestinationApplyLock,
} from "../extensions/supacode-subagents/apply-lock.ts";
import {
  claimJobDecision,
  claimWorkerTerminal,
  initializeJobLifecycle,
  writeRunnerExit,
  writeRunnerProcess,
} from "../extensions/supacode-subagents/lifecycle.ts";
import {
  applyPreparedDelegateHandoff,
  discardPreparedDelegateHandoff,
  formatDelegateHandoffPreview,
  prepareDelegateHandoff,
  recoverDelegateApplyState,
} from "../extensions/supacode-subagents/handoff.ts";

const JOB_ID = "11111111-2222-4333-8444-555555555555";
const BATCH_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TAB_ID = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
const SURFACE_ID = "cccccccc-1111-4222-8333-dddddddddddd";

function execResult(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        signal: options.signal,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const numericCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout, stderr, code: numericCode, killed: Boolean(error?.killed) });
      },
    );
  });
}

async function checked(command, args, options) {
  const result = await execResult(command, args, options);
  assert.equal(result.code, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

async function git(cwd, ...args) {
  return checked("git", ["-C", cwd, ...args]);
}

async function createFixture(setupBase) {
  const root = await mkdtemp(join(tmpdir(), "pi-handoff-"));
  const parent = join(root, "repo");
  const worker = join(root, "worker");
  const agentDir = join(root, "agent");
  const jobDir = join(agentDir, "subagents", BATCH_ID, JOB_ID);

  await git(root, "init", "repo");
  await git(parent, "config", "user.email", "test@example.com");
  await git(parent, "config", "user.name", "Test User");
  await writeFile(join(parent, ".gitignore"), "ignored.txt\n");
  await writeFile(join(parent, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(join(parent, "b.txt"), "base\n");
  await writeFile(join(parent, "destination-only.txt"), "base destination\n");
  await setupBase?.({ root, parent });
  await git(parent, "add", ".");
  await git(parent, "commit", "-m", "base");
  const baseSha = await git(parent, "rev-parse", "HEAD");
  const branch = "pi-agent/aaaaaa/111111";
  await git(parent, "worktree", "add", "-b", branch, worker, baseSha);

  await mkdir(jobDir, { recursive: true });
  await writeFile(
    join(jobDir, "job.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      id: JOB_ID,
      batchId: BATCH_ID,
      batchTitle: "agents: handoff test",
      title: "handoff test",
      mode: "coding",
      originalCwd: parent,
      workerCwd: worker,
      tabWorktreeId: encodeURIComponent(worker),
      codeWorktreeId: encodeURIComponent(worker),
      worktreePath: worker,
      branch,
      baseSha,
      tabId: TAB_ID,
      surfaceId: SURFACE_ID,
      launchNonce: "fixture",
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
  await initializeJobLifecycle(jobDir, JOB_ID, BATCH_ID, "completed");
  const missingIdentity = {
    pid: 999_999_999,
    startSignature: "missing",
    processGroup: 999_999_999,
    command: "missing",
    launchNonce: "fixture",
  };
  await writeRunnerProcess(jobDir, {
    schemaVersion: 2,
    jobId: JOB_ID,
    launchNonce: "fixture",
    wrapper: missingIdentity,
    startedAt: new Date().toISOString(),
  });
  await writeRunnerExit(jobDir, {
    schemaVersion: 2,
    jobId: JOB_ID,
    launchNonce: "fixture",
    wrapperPid: missingIdentity.pid,
    exitCode: 0,
    exitedAt: new Date().toISOString(),
  });
  await claimWorkerTerminal(jobDir, JOB_ID, "worker", {
    state: "completed",
    stopReason: "stop",
    processIdentity: missingIdentity,
  }, "fixture complete");

  return {
    root,
    parent,
    worker,
    agentDir,
    jobDir,
    baseSha,
    branch,
    pi: {
      exec: (command, args, options) => command === "supacode" && args[0] === "worktree" && args[1] === "list"
        ? Promise.resolve({
            stdout: `${encodeURIComponent(parent)}\n${encodeURIComponent(worker)}\n`,
            stderr: "",
            code: 0,
            killed: false,
          })
        : execResult(command, args, options),
    },
  };
}

async function removeFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

test("handoff applies the final worker filesystem without changing the source index", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker commit\nthree\n");
    await git(fixture.worker, "add", "a.txt");
    await git(fixture.worker, "commit", "-m", "worker commit");
    await writeFile(join(fixture.worker, "b.txt"), "worker dirty\n");
    await writeFile(join(fixture.worker, "staged.txt"), "staged source\n");
    await git(fixture.worker, "add", "staged.txt");
    await writeFile(join(fixture.worker, "untracked.txt"), "untracked source\n");
    await writeFile(join(fixture.worker, "ignored.txt"), "ignored source\n");
    await writeFile(join(fixture.parent, "unrelated.txt"), "keep me\n");
    await writeFile(join(fixture.parent, "destination-only.txt"), "staged destination\n");
    await git(fixture.parent, "add", "destination-only.txt");

    const sourceStatusBefore = await git(fixture.worker, "status", "--porcelain=v1");
    const sourceIndexBefore = await git(fixture.worker, "diff", "--cached", "--binary");
    const destinationIndexPath = resolve(
      fixture.parent,
      await git(fixture.parent, "rev-parse", "--git-path", "index"),
    );
    const destinationIndexBefore = await readFile(destinationIndexPath);
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );

    assert.deepEqual(prepared.blockers, []);
    assert.deepEqual(
      prepared.touchedPaths,
      ["a.txt", "b.txt", "staged.txt", "untracked.txt"],
    );
    assert.equal(prepared.warnings.some((warning) => warning.includes("Unrelated destination")), true);

    const result = await applyPreparedDelegateHandoff(fixture.pi, prepared, undefined, false);
    assert.equal(result.state, "applied");
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), "one\nworker commit\nthree\n");
    assert.equal(await readFile(join(fixture.parent, "b.txt"), "utf8"), "worker dirty\n");
    assert.equal(await readFile(join(fixture.parent, "staged.txt"), "utf8"), "staged source\n");
    assert.equal(await readFile(join(fixture.parent, "untracked.txt"), "utf8"), "untracked source\n");
    assert.equal(await readFile(join(fixture.parent, "unrelated.txt"), "utf8"), "keep me\n");
    assert.equal(await readFile(join(fixture.parent, "destination-only.txt"), "utf8"), "staged destination\n");
    assert.equal(await git(fixture.parent, "diff", "--cached", "--name-only"), "destination-only.txt");
    assert.deepEqual(await readFile(destinationIndexPath), destinationIndexBefore);
    assert.equal(await git(fixture.worker, "status", "--porcelain=v1"), sourceStatusBefore);
    assert.equal(await git(fixture.worker, "diff", "--cached", "--binary"), sourceIndexBefore);
    assert.equal(await readFile(result.patchPath, "utf8").then((patch) => patch.includes("ignored.txt")), false);

    const duplicate = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    assert.equal(duplicate.blockers.some((blocker) => blocker.includes("already applied")), true);
    await discardPreparedDelegateHandoff(duplicate);
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff rejects worker terminal claims without an authenticated runner exit", async () => {
  const fixture = await createFixture();
  try {
    await rm(join(fixture.jobDir, "runner-exit.json"));
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /no authenticated normal runner exit/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff rejects an ordinary cancel decision even when control publication was interrupted", async () => {
  const fixture = await createFixture();
  try {
    await claimJobDecision(fixture.jobDir, JOB_ID, "cancel");
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /No coding worker matches|cancel/i,
    );
    await assert.rejects(readFile(join(fixture.jobDir, "control.json")));
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff binds terminal and lifecycle records to the selected job and batch", async () => {
  const fixture = await createFixture();
  try {
    const terminalPath = join(fixture.jobDir, "terminal.json");
    const terminal = JSON.parse(await readFile(terminalPath, "utf8"));
    await writeFile(terminalPath, `${JSON.stringify({ ...terminal, jobId: "22222222-3333-4444-8555-666666666666" }, null, 2)}\n`);
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /terminal identity|metadata is corrupt/,
    );

    await writeFile(terminalPath, `${JSON.stringify({ ...terminal, status: {} }, null, 2)}\n`);
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /terminal status|metadata is corrupt/,
    );

    await writeFile(terminalPath, `${JSON.stringify(terminal, null, 2)}\n`);
    const terminalOutput = await readFile(terminal.resultFile, "utf8");
    const outsideResult = join(fixture.root, "outside-terminal.md");
    await writeFile(outsideResult, terminalOutput);
    await rm(terminal.resultFile);
    await symlink(outsideResult, terminal.resultFile);
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /metadata is corrupt|terminal/i,
    );
    await rm(terminal.resultFile);
    await writeFile(terminal.resultFile, terminalOutput);

    const jobPath = join(fixture.jobDir, "job.json");
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    const outsideRuntime = join(fixture.root, "outside-runtime");
    const linkedRuntime = join(fixture.jobDir, "active-runtime");
    await mkdir(outsideRuntime);
    await symlink(outsideRuntime, linkedRuntime);
    job.activeWorkerJobDir = linkedRuntime;
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /runtime directory escapes|metadata is corrupt/,
    );
    delete job.activeWorkerJobDir;
    job.batchId = "aaaaaaab-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /lifecycle identity|metadata is corrupt/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff binds declared job identities to directory paths and rejects duplicates", async () => {
  const fixture = await createFixture();
  const misplacedId = "22222222-3333-4444-8555-666666666666";
  const duplicateBatchId = "aaaaaaab-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    const job = JSON.parse(await readFile(join(fixture.jobDir, "job.json"), "utf8"));
    const misplacedDir = join(fixture.agentDir, "subagents", BATCH_ID, misplacedId);
    await mkdir(misplacedDir, { recursive: true });
    await writeFile(join(misplacedDir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, misplacedId, undefined, fixture.agentDir),
      /metadata is corrupt|directories/,
    );

    const duplicateDir = join(fixture.agentDir, "subagents", duplicateBatchId, JOB_ID);
    await mkdir(duplicateDir, { recursive: true });
    await writeFile(join(duplicateDir, "job.json"), `${JSON.stringify({
      ...job,
      batchId: duplicateBatchId,
    }, null, 2)}\n`);
    await initializeJobLifecycle(duplicateDir, JOB_ID, duplicateBatchId, "completed");
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /ambiguous/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("corrupt sibling coding metadata does not block a valid targeted handoff", async () => {
  const fixture = await createFixture();
  const corruptId = "22222222-3333-4444-8555-666666666666";
  try {
    const corruptDir = join(fixture.agentDir, "subagents", BATCH_ID, corruptId);
    await mkdir(corruptDir, { recursive: true });
    const validJob = JSON.parse(await readFile(join(fixture.jobDir, "job.json"), "utf8"));
    await writeFile(join(corruptDir, "job.json"), `${JSON.stringify({
      ...validJob,
      id: corruptId,
      branch: "pi-agent/aaaaaa/222222",
    }, null, 2)}\n`);
    await writeFile(join(corruptDir, "lifecycle.json"), "{not-json\n");
    await writeFile(join(fixture.worker, "b.txt"), "worker change\n");

    const prepared = await prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir);
    await discardPreparedDelegateHandoff(prepared);
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, corruptId, undefined, fixture.agentDir),
      /metadata is corrupt/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff preserves binary files, executable modes, and symlinks", async () => {
  const fixture = await createFixture();
  try {
    const binary = Buffer.from([0, 255, 1, 254, 2, 253]);
    const invalidUtf8Text = Buffer.from([255, 254, 253, 10]);
    await writeFile(join(fixture.worker, "binary.dat"), binary);
    await writeFile(join(fixture.worker, "invalid-utf8.txt"), invalidUtf8Text);
    await writeFile(join(fixture.worker, "run.sh"), "#!/bin/sh\necho applied\n");
    await chmod(join(fixture.worker, "run.sh"), 0o755);
    await symlink("run.sh", join(fixture.worker, "run-link"));

    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    const result = await applyPreparedDelegateHandoff(fixture.pi, prepared, undefined, false);

    assert.equal(result.state, "applied");
    assert.deepEqual(await readFile(join(fixture.parent, "binary.dat")), binary);
    assert.deepEqual(await readFile(join(fixture.parent, "invalid-utf8.txt")), invalidUtf8Text);
    assert.equal((await lstat(join(fixture.parent, "run.sh"))).mode & 0o111, 0o111);
    assert.equal(await readlink(join(fixture.parent, "run-link")), "run.sh");
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff safely transfers and displays unusual UTF-8 paths", async () => {
  const fixture = await createFixture();
  try {
    const names = [
      "space name.txt",
      "-leading-dash.txt",
      "tab\tname.txt",
      "line\nname.txt",
      "snowman-☃.txt",
    ];
    for (const name of names) await writeFile(join(fixture.worker, name), `${name}\n`);

    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    const preview = formatDelegateHandoffPreview(prepared);
    assert.equal(preview.includes("tab\\tname.txt"), true);
    assert.equal(preview.includes("line\\nname.txt"), true);
    const result = await applyPreparedDelegateHandoff(fixture.pi, prepared, undefined, false);

    assert.equal(result.state, "applied");
    for (const name of names) {
      assert.equal(await readFile(join(fixture.parent, name), "utf8"), `${name}\n`);
    }
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff rejects non-UTF-8 paths instead of applying lossy names", async (context) => {
  const fixture = await createFixture();
  try {
    const invalidPath = Buffer.concat([
      Buffer.from(`${fixture.worker}${sep}invalid-`),
      Buffer.from([255]),
      Buffer.from(".txt"),
    ]);
    try {
      await writeFile(invalidPath, "invalid path\n");
    } catch (error) {
      if (error?.code === "EILSEQ") {
        context.skip("filesystem rejects non-UTF-8 filenames");
        return;
      }
      throw error;
    }

    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /not valid UTF-8/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff rejects persisted worktree identity mismatches", async () => {
  const fixture = await createFixture();
  try {
    const jobPath = join(fixture.jobDir, "job.json");
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.codeWorktreeId = encodeURIComponent(fixture.parent);
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);

    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /does not map.*source checkout/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff rejects persisted pane worktree identity mismatches", async () => {
  const fixture = await createFixture();
  try {
    const jobPath = join(fixture.jobDir, "job.json");
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.tabWorktreeId = encodeURIComponent(fixture.parent);
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);

    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /pane Supacode worktree ID.*source checkout/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff rejects an active Git operation in the source checkout", async () => {
  const fixture = await createFixture();
  try {
    const mergeHeadPath = await git(fixture.worker, "rev-parse", "--git-path", "MERGE_HEAD");
    await writeFile(mergeHeadPath, `${fixture.baseSha}\n`);

    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /source checkout with an active Git operation/i,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff rechecks source Git operations after preview", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    const mergeHeadPath = await git(fixture.worker, "rev-parse", "--git-path", "MERGE_HEAD");
    await writeFile(mergeHeadPath, `${fixture.baseSha}\n`);

    const result = await applyPreparedDelegateHandoff(fixture.pi, prepared, undefined, false);
    assert.equal(result.state, "blocked");
    assert.match(result.diagnostic, /Source checkout has an active Git operation/);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff rejects submodules and embedded Git repositories", async () => {
  const fixture = await createFixture();
  try {
    const embedded = join(fixture.worker, "embedded");
    await checked("git", ["init", embedded]);
    await git(embedded, "config", "user.email", "test@example.com");
    await git(embedded, "config", "user.name", "Test User");
    await writeFile(join(embedded, "nested.txt"), "nested\n");
    await git(embedded, "add", "nested.txt");
    await git(embedded, "commit", "-m", "nested");

    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /Submodules and embedded Git repositories are not supported.*embedded/i,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff applies only the immutable tree accepted by a delegate loop", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\naccepted\nthree\n");
    const snapshot = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    const acceptedTree = snapshot.sourceTree;
    const acceptedCommit = await git(
      fixture.worker,
      "-c",
      "user.name=Pi Delegate Loop",
      "-c",
      "user.email=pi-delegate-loop@localhost",
      "commit-tree",
      acceptedTree,
      "-p",
      snapshot.sourceHead,
      "-m",
      "accepted candidate",
    );
    const acceptedRef = `refs/pi-agent-candidates/${JOB_ID}/001`;
    await git(fixture.worker, "update-ref", acceptedRef, acceptedCommit);
    await discardPreparedDelegateHandoff(snapshot);

    const jobPath = join(fixture.jobDir, "job.json");
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    Object.assign(job, {
      delegateLoop: true,
      loopState: "awaiting_apply",
      acceptedTree,
      acceptedCommit,
      acceptedRef,
    });
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    await claimJobDecision(fixture.jobDir, JOB_ID, "accept");

    const accepted = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    assert.equal(accepted.sourceTree, acceptedTree);
    await discardPreparedDelegateHandoff(accepted);

    await writeFile(join(fixture.parent, "parent-advanced.txt"), "new destination\n");
    await git(fixture.parent, "add", "parent-advanced.txt");
    await git(fixture.parent, "commit", "-m", "advance destination");
    const drifted = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    assert.equal(
      drifted.blockers.some((blocker) => blocker.includes("rerun the loop")),
      true,
    );
    await discardPreparedDelegateHandoff(drifted);

    await writeFile(join(fixture.worker, "after-review.txt"), "unreviewed\n");
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /changed after acceptance/,
    );

    job.loopState = "blocked";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /only accepted loops can be applied/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff refuses a patch changed after preview", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    await chmod(prepared.draftPatchPath, 0o600);
    await writeFile(prepared.draftPatchPath, "tampered patch\n");
    const result = await applyPreparedDelegateHandoff(fixture.pi, prepared, undefined, false);

    assert.equal(result.state, "blocked");
    assert.match(result.diagnostic, /changed after preview/);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff serializes apply attempts with a destination-scoped lock", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    const lock = await acquireDestinationApplyLock(
      prepared.targetGitDir,
      "active-handoff",
      prepared.targetRoot,
    );
    try {
      await assert.rejects(
        applyPreparedDelegateHandoff(fixture.pi, prepared, undefined, false),
        /Another apply is active/,
      );
    } finally {
      await releaseDestinationApplyLock(lock);
    }
    await discardPreparedDelegateHandoff(prepared);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff blocks ignored destination entries that overlap the patch", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "ignored.txt"), "worker tracked content\n");
    await git(fixture.worker, "add", "-f", "ignored.txt");
    await git(fixture.worker, "commit", "-m", "track ignored path");
    await writeFile(join(fixture.parent, "ignored.txt"), "destination ignored content\n");

    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    assert.equal(
      prepared.blockers.some((blocker) => blocker.includes("Ignored destination entries") && blocker.includes("ignored.txt")),
      true,
    );
    await discardPreparedDelegateHandoff(prepared);
    assert.equal(await readFile(join(fixture.parent, "ignored.txt"), "utf8"), "destination ignored content\n");
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff preserves concurrent destination changes when its postcondition is violated", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    const indexPath = resolve(fixture.parent, await git(fixture.parent, "rev-parse", "--git-path", "index"));
    const indexBefore = await readFile(indexPath);
    let injected = false;
    const pi = {
      exec: async (command, args, options) => {
        if (command === "git" && args.includes("--diff-filter=U") && !injected) {
          const current = await readFile(join(fixture.parent, "a.txt"), "utf8");
          if (current.includes("worker")) {
            injected = true;
            await writeFile(join(fixture.parent, "a.txt"), "postcondition corruption\n");
          }
        }
        return fixture.pi.exec(command, args, options);
      },
    };

    const result = await applyPreparedDelegateHandoff(pi, prepared, undefined, false);
    assert.equal(injected, true);
    assert.equal(result.state, "indeterminate");
    assert.match(result.diagnostic, /postcondition failed/i);
    assert.match(result.diagnostic, /automatic rollback was refused/i);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), "postcondition corruption\n");
    assert.deepEqual(
      await readFile(indexPath),
      indexBefore,
    );
    const transaction = JSON.parse(await readFile(
      join(prepared.targetGitDir, "pi-delegate-handoffs", "transactions", prepared.id, "transaction.json"),
      "utf8",
    ));
    assert.equal(transaction.state, "indeterminate");
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff preserves a concurrent destination index update", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    await writeFile(join(fixture.parent, "destination-only.txt"), "concurrent destination\n");
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    let indexUpdated = false;
    const pi = {
      exec: async (command, args, options) => {
        if (
          !indexUpdated && (command === "git" || args.includes("git")) &&
          args.includes("--diff-filter=U")
        ) {
          const applied = await readFile(join(fixture.parent, "a.txt"), "utf8");
          if (applied.includes("worker")) {
            await git(fixture.parent, "add", "destination-only.txt");
            indexUpdated = true;
          }
        }
        return fixture.pi.exec(command, args, options);
      },
    };

    const result = await applyPreparedDelegateHandoff(pi, prepared, undefined, false);
    assert.equal(indexUpdated, true);
    assert.equal(result.state, "indeterminate");
    assert.equal(await git(fixture.parent, "diff", "--cached", "--name-only"), "destination-only.txt");
    assert.equal(await readFile(join(fixture.parent, "destination-only.txt"), "utf8"), "concurrent destination\n");
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), "one\nworker\nthree\n");
  } finally {
    await removeFixture(fixture);
  }
});

test("rollback refuses symlink-to-directory transitions without traversing outside the destination", async () => {
  const fixture = await createFixture(async ({ root, parent }) => {
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "secret.txt"), "preserve me\n");
    await symlink("../outside", join(parent, "link"));
  });
  try {
    await rm(join(fixture.worker, "link"), { force: true });
    await mkdir(join(fixture.worker, "link"));
    await writeFile(join(fixture.worker, "link", "worker.txt"), "worker\n");
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    assert.equal(prepared.touchedPaths.includes("link"), true);
    assert.equal(prepared.touchedPaths.includes("link/worker.txt"), true);
    let applyObserved = false;
    let identityFailureInjected = false;
    const pi = {
      exec: async (command, args, options) => {
        if ((command === "git" || args.includes("git")) && args.includes("--diff-filter=U")) {
          try {
            applyObserved = (await lstat(join(fixture.parent, "link"))).isDirectory();
          } catch {
            applyObserved = false;
          }
        }
        if (
          command === "git" && applyObserved && !identityFailureInjected &&
          args.includes("rev-parse") && args.includes("--show-toplevel")
        ) {
          identityFailureInjected = true;
          return { stdout: `${fixture.parent}-wrong\n`, stderr: "", code: 0, killed: false };
        }
        return fixture.pi.exec(command, args, options);
      },
    };

    const result = await applyPreparedDelegateHandoff(pi, prepared, undefined, false);
    assert.equal(identityFailureInjected, true);
    assert.equal(result.state, "indeterminate");
    assert.match(result.diagnostic, /destructive automatic rollback was refused/);
    assert.equal((await lstat(join(fixture.parent, "link"))).isDirectory(), true);
    assert.equal(await readFile(join(fixture.parent, "link", "worker.txt"), "utf8"), "worker\n");
    assert.equal(await readFile(join(fixture.root, "outside", "secret.txt"), "utf8"), "preserve me\n");
  } finally {
    await removeFixture(fixture);
  }
});

test("apply recovery classifies an interrupted journal by exact tree and index state", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    const result = await applyPreparedDelegateHandoff(fixture.pi, prepared, undefined, false);
    assert.equal(result.state, "applied");
    const transactionPath = join(
      prepared.targetGitDir,
      "pi-delegate-handoffs",
      "transactions",
      prepared.id,
      "transaction.json",
    );
    const transaction = JSON.parse(await readFile(transactionPath, "utf8"));
    transaction.state = "applying";
    await writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
    await writeFile(join(
      prepared.targetGitDir,
      "pi-delegate-handoffs",
      "transactions",
      prepared.id,
      "recovery.index.lock",
    ), "stale\n");

    const recovered = await recoverDelegateApplyState(fixture.pi, fixture.parent);
    assert.equal(recovered.transactions.some((message) => message.includes(`${prepared.id}: applied`)), true);
    assert.equal(JSON.parse(await readFile(transactionPath, "utf8")).state, "applied");
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff blocks a different patch while a destination transaction is unresolved", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    const targetGitDir = resolve(
      fixture.parent,
      await git(fixture.parent, "rev-parse", "--absolute-git-dir"),
    );
    const transactionDir = join(
      targetGitDir,
      "pi-delegate-handoffs",
      "transactions",
      "unresolved-transaction",
    );
    await mkdir(transactionDir, { recursive: true });
    await writeFile(join(transactionDir, "transaction.json"), `${JSON.stringify({
      version: 1,
      id: "unresolved-transaction",
      jobId: "other-job",
      state: "indeterminate",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      destination: { root: await realpath(fixture.parent), gitDir: targetGitDir, commonGitDir: targetGitDir, head: fixture.baseSha },
      patch: { sha256: "a".repeat(64), bytes: 1, touchedPaths: ["other.txt"] },
      jobManifestPath: join(transactionDir, "missing-manifest.json"),
    }, null, 2)}\n`);

    await assert.rejects(
      prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir),
      /unresolved indeterminate transaction/,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff blocks overlapping destination changes without mutation", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    await writeFile(join(fixture.parent, "a.txt"), "one\nparent dirty\nthree\n");
    const parentBefore = await readFile(join(fixture.parent, "a.txt"), "utf8");

    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    assert.equal(prepared.blockers.some((blocker) => blocker.includes("a.txt")), true);
    await discardPreparedDelegateHandoff(prepared);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), parentBefore);
  } finally {
    await removeFixture(fixture);
  }
});

test("initial conflict-index publication failure remains recoverable after manual staging", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    await git(fixture.worker, "add", "a.txt");
    await git(fixture.worker, "commit", "-m", "worker change");
    await writeFile(join(fixture.parent, "a.txt"), "one\nparent\nthree\n");
    await git(fixture.parent, "add", "a.txt");
    await git(fixture.parent, "commit", "-m", "parent change");

    const prepared = await prepareDelegateHandoff(fixture.pi, JOB_ID, undefined, fixture.agentDir);
    const indexPath = resolve(fixture.parent, await git(fixture.parent, "rev-parse", "--git-path", "index"));
    const transactionPath = join(
      prepared.targetGitDir,
      "pi-delegate-handoffs",
      "transactions",
      prepared.id,
      "transaction.json",
    );
    let injected = false;
    fixture.pi.__beforeConflictIndexPublicationForTests = async () => {
      await writeFile(`${indexPath}.lock`, "block publication\n");
      injected = true;
    };
    const result = await applyPreparedDelegateHandoff(fixture.pi, prepared);
    await rm(`${indexPath}.lock`, { force: true });

    assert.equal(injected, true);
    assert.equal(result.state, "conflicted", result.diagnostic);
    assert.equal(JSON.parse(await readFile(transactionPath, "utf8")).conflictIndex.phase, "pending");
    await writeFile(join(fixture.parent, "a.txt"), "one\nmanual resolution\nthree\n");
    await git(fixture.parent, "add", "a.txt");
    const recovered = await recoverDelegateApplyState(fixture.pi, fixture.parent);
    assert.equal(
      recovered.transactions.some((message) => message.includes("conflict resolution requires explicit confirmation")),
      true,
      JSON.stringify(recovered),
    );
    assert.equal(JSON.parse(await readFile(transactionPath, "utf8")).conflictIndex.phase, "superseded");
  } finally {
    await removeFixture(fixture);
  }
});

test("handoff leaves three-way conflicts and preserves the source worktree", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    await git(fixture.worker, "add", "a.txt");
    await git(fixture.worker, "commit", "-m", "worker change");
    await writeFile(join(fixture.parent, "a.txt"), "one\nparent\nthree\n");
    await git(fixture.parent, "add", "a.txt");
    await git(fixture.parent, "commit", "-m", "parent change");

    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    assert.deepEqual(prepared.blockers, []);
    const result = await applyPreparedDelegateHandoff(fixture.pi, prepared);

    assert.equal(result.state, "conflicted", result.diagnostic);
    assert.deepEqual(result.conflictedPaths, ["a.txt"]);
    assert.equal(result.cleanup.worktreeRemoved, false);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8").then((text) => text.includes("<<<<<<< ours")), true);
    assert.equal(await readFile(join(fixture.worker, "a.txt"), "utf8"), "one\nworker\nthree\n");

    const interruptedTransactionPath = join(
      prepared.targetGitDir,
      "pi-delegate-handoffs",
      "transactions",
      prepared.id,
      "transaction.json",
    );
    const interruptedTransaction = JSON.parse(await readFile(interruptedTransactionPath, "utf8"));
    delete interruptedTransaction.conflictIndex;
    interruptedTransaction.state = "applying";
    await writeFile(interruptedTransactionPath, `${JSON.stringify(interruptedTransaction, null, 2)}\n`);
    await writeFile(
      interruptedTransaction.baseline.indexPath,
      await readFile(interruptedTransaction.baseline.indexBackupPath),
    );
    const interruptedManifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    interruptedManifest.state = "applying";
    await writeFile(result.manifestPath, `${JSON.stringify(interruptedManifest, null, 2)}\n`);
    const resumedConflict = await recoverDelegateApplyState(fixture.pi, fixture.parent);
    assert.equal(resumedConflict.transactions.some((message) => message.includes("conflicts remain unresolved")), true);
    const resumedTransaction = JSON.parse(await readFile(interruptedTransactionPath, "utf8"));
    assert.equal(resumedTransaction.state, "conflicted");
    assert.equal(resumedTransaction.conflictIndex.phase, "published");

    resumedTransaction.conflictIndex.phase = "pending";
    await writeFile(interruptedTransactionPath, `${JSON.stringify(resumedTransaction, null, 2)}\n`);
    const republished = await recoverDelegateApplyState(fixture.pi, fixture.parent);
    assert.equal(republished.transactions.some((message) => message.includes("conflicts remain unresolved")), true);
    const publishedTransaction = JSON.parse(await readFile(interruptedTransactionPath, "utf8"));
    assert.equal(publishedTransaction.conflictIndex.phase, "published");

    publishedTransaction.conflictIndex.phase = "pending";
    await writeFile(interruptedTransactionPath, `${JSON.stringify(publishedTransaction, null, 2)}\n`);
    await git(fixture.parent, "checkout", "--ours", "--", "a.txt");
    await git(fixture.parent, "add", "a.txt");
    const resolvedWhilePending = await recoverDelegateApplyState(fixture.pi, fixture.parent);
    assert.equal(
      resolvedWhilePending.transactions.some((message) => message.includes("conflict resolution requires explicit confirmation")),
      true,
      JSON.stringify(resolvedWhilePending),
    );
    assert.equal(
      JSON.parse(await readFile(interruptedTransactionPath, "utf8")).conflictIndex.phase,
      "superseded",
    );

    const victimPath = join(fixture.root, "must-not-be-replaced.txt");
    await writeFile(victimPath, "unchanged\n");
    const redirectedTransaction = {
      ...publishedTransaction,
      baseline: { ...publishedTransaction.baseline, indexPath: victimPath },
      conflictIndex: { ...publishedTransaction.conflictIndex, phase: "pending" },
    };
    await writeFile(interruptedTransactionPath, `${JSON.stringify(redirectedTransaction, null, 2)}\n`);
    const refusedRedirect = await recoverDelegateApplyState(fixture.pi, fixture.parent);
    assert.equal(refusedRedirect.transactions.some((message) => message.includes("index path mismatch")), true);
    assert.equal(await readFile(victimPath, "utf8"), "unchanged\n");
    await writeFile(interruptedTransactionPath, `${JSON.stringify(publishedTransaction, null, 2)}\n`);

    await git(fixture.parent, "checkout", "--ours", "--", "a.txt");
    await git(fixture.parent, "add", "a.txt");
    const pending = await recoverDelegateApplyState(fixture.pi, fixture.parent);
    assert.equal(
      pending.transactions.some((message) => message.includes("conflict resolution requires explicit confirmation")),
      true,
      JSON.stringify(pending),
    );
    const transactionPath = join(
      prepared.targetGitDir,
      "pi-delegate-handoffs",
      "transactions",
      prepared.id,
      "transaction.json",
    );
    assert.equal(JSON.parse(await readFile(transactionPath, "utf8")).state, "conflicted");

    const recovered = await recoverDelegateApplyState(fixture.pi, fixture.parent, undefined, true);
    assert.equal(recovered.transactions.some((message) => message.includes(`${prepared.id}: resolved by explicit confirmation`)), true);
    const transaction = JSON.parse(await readFile(transactionPath, "utf8"));
    assert.equal(transaction.state, "resolved");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.state, "resolved");
    assert.equal(JSON.parse(await readFile(transaction.resolutionIntentPath, "utf8")).tree.length, 40);

    await writeFile(transactionPath, `${JSON.stringify({
      ...transaction,
      state: "conflicted",
      resolutionIntentPath: undefined,
    }, null, 2)}\n`);
    await writeFile(result.manifestPath, `${JSON.stringify({ ...manifest, state: "conflicted" }, null, 2)}\n`);
    const resumedAcceptance = await recoverDelegateApplyState(fixture.pi, fixture.parent);
    assert.equal(
      resumedAcceptance.transactions.some((message) => message.includes("resolved by explicit confirmation")),
      true,
      JSON.stringify(resumedAcceptance),
    );
    assert.equal(JSON.parse(await readFile(transactionPath, "utf8")).state, "resolved");
  } finally {
    await removeFixture(fixture);
  }
});

test("cleanup checks source Git operations before closing the worker pane", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\napplied\nthree\n");
    const mergeHeadPath = await git(fixture.worker, "rev-parse", "--git-path", "MERGE_HEAD");
    const branchRef = `refs/heads/${fixture.branch}`;
    let injectedOperation = false;
    let paneClosed = false;
    let worktreeDeleted = false;
    const pi = {
      exec: async (command, args, options) => {
        if (command !== "supacode") {
          const result = await execResult(command, args, options);
          if (
            command === "git" && !injectedOperation && result.code === 0 &&
            args.includes("rev-parse") && args.includes("--verify") && args.includes(branchRef)
          ) {
            injectedOperation = true;
            await writeFile(mergeHeadPath, `${fixture.baseSha}\n`);
          }
          return result;
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: `${encodeURIComponent(fixture.parent)}\n${encodeURIComponent(fixture.worker)}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          paneClosed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: paneClosed ? "" : `${SURFACE_ID}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "delete") {
          worktreeDeleted = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
      },
    };

    const prepared = await prepareDelegateHandoff(pi, JOB_ID, undefined, fixture.agentDir);
    const result = await applyPreparedDelegateHandoff(pi, prepared);

    assert.equal(result.state, "applied");
    assert.equal(injectedOperation, true);
    assert.equal(paneClosed, false);
    assert.equal(result.cleanup.worktreeRemoved, false);
    assert.equal(result.cleanup.errors.some((error) => error.includes("active Git operation")), true);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), "one\napplied\nthree\n");

    await rm(mergeHeadPath, { force: true });
    const recovered = await recoverDelegateApplyState(pi, fixture.parent);
    assert.equal(
      recovered.transactions.some((message) => message.includes(`${prepared.id}: applied handoff cleanup recovered`)),
      true,
      JSON.stringify(recovered),
    );
    assert.equal(paneClosed, true);
    assert.equal(worktreeDeleted, true);
    await assert.rejects(lstat(fixture.worker), { code: "ENOENT" });
  } finally {
    await removeFixture(fixture);
  }
});

test("cleanup recovery accepts its authenticated preservation commit after interruption", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\napplied\nthree\n");
    let paneClosed = false;
    let failRemovalIdentity = true;
    let worktreeDeleted = false;
    const pi = {
      exec: async (command, args, options) => {
        if (command !== "supacode") return execResult(command, args, options);
        if (args[0] === "surface" && args[1] === "close") {
          paneClosed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: paneClosed ? "" : `${SURFACE_ID}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          if (paneClosed && failRemovalIdentity) {
            failRemovalIdentity = false;
            return { stdout: "", stderr: "simulated list failure", code: 1, killed: false };
          }
          return { stdout: `${encodeURIComponent(fixture.parent)}\n${encodeURIComponent(fixture.worker)}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "delete") {
          worktreeDeleted = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
      },
    };

    const prepared = await prepareDelegateHandoff(pi, JOB_ID, undefined, fixture.agentDir);
    const result = await applyPreparedDelegateHandoff(pi, prepared);
    assert.equal(result.state, "applied");
    assert.equal(result.cleanup.worktreeRemoved, false);
    assert.ok(result.cleanup.preservedHead);
    assert.equal(await git(fixture.worker, "rev-parse", "HEAD"), result.cleanup.preservedHead);

    const recovered = await recoverDelegateApplyState(pi, fixture.parent);
    assert.equal(
      recovered.transactions.some((message) => message.includes(`${prepared.id}: applied handoff cleanup recovered`)),
      true,
      JSON.stringify(recovered),
    );
    assert.equal(worktreeDeleted, true);
    await assert.rejects(lstat(fixture.worker), { code: "ENOENT" });
  } finally {
    await removeFixture(fixture);
  }
});

test("cleanup does not delete after a transient missing-surface snapshot", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\napplied\nthree\n");
    await git(fixture.worker, "add", "a.txt");
    await git(fixture.worker, "commit", "-m", "worker change");
    const surfaceSnapshots = ["", `${SURFACE_ID}\n`, ""];
    let deleteCalled = false;
    const pi = {
      exec: async (command, args, options) => {
        if (command !== "supacode") return execResult(command, args, options);
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: `${encodeURIComponent(fixture.parent)}\n${encodeURIComponent(fixture.worker)}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          return { stdout: "", stderr: "close failed", code: 1, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: surfaceSnapshots.shift() ?? "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "delete") {
          deleteCalled = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected Supacode call", code: 1, killed: false };
      },
    };

    const prepared = await prepareDelegateHandoff(pi, JOB_ID, undefined, fixture.agentDir);
    const result = await applyPreparedDelegateHandoff(pi, prepared);

    assert.equal(result.state, "applied");
    assert.equal(result.cleanup.paneClosed, false);
    assert.equal(result.cleanup.worktreeRemoved, false);
    assert.equal(deleteCalled, false);
    assert.equal(result.cleanup.errors.some((error) => error.includes("Could not close")), true);
  } finally {
    await removeFixture(fixture);
  }
});

test("cleanup retains a worker that changed after the apply preview", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\npreviewed\nthree\n");
    await git(fixture.worker, "add", "a.txt");
    await git(fixture.worker, "commit", "-m", "previewed change");
    let deleteCalled = false;
    let paneClosed = false;
    const pi = {
      exec: async (command, args, options) => {
        if (command !== "supacode") return execResult(command, args, options);
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: `${encodeURIComponent(fixture.parent)}\n${encodeURIComponent(fixture.worker)}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: paneClosed ? "" : `${SURFACE_ID}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          paneClosed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "delete") {
          deleteCalled = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected Supacode call", code: 1, killed: false };
      },
    };

    const prepared = await prepareDelegateHandoff(pi, JOB_ID, undefined, fixture.agentDir);
    await writeFile(join(fixture.worker, "after-preview.txt"), "retain me\n");
    const result = await applyPreparedDelegateHandoff(pi, prepared);

    assert.equal(result.state, "applied");
    assert.equal(result.cleanup.paneClosed, true);
    assert.equal(result.cleanup.worktreeRemoved, false);
    assert.equal(result.cleanup.errors.some((error) => error.includes("changed after")), true);
    assert.equal(deleteCalled, false);
    assert.equal(await readFile(join(fixture.worker, "after-preview.txt"), "utf8"), "retain me\n");
  } finally {
    await removeFixture(fixture);
  }
});

test("non-force removal retains source changes created during cleanup", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\napplied\nthree\n");
    await git(fixture.worker, "add", "a.txt");
    await git(fixture.worker, "commit", "-m", "worker change");
    let injectedRace = false;
    let supacodeDeleteCalled = false;
    let paneClosed = false;
    const pi = {
      exec: async (command, args, options) => {
        if (command === "git" && args.includes("worktree") && args.includes("remove")) {
          injectedRace = true;
          await writeFile(join(fixture.worker, "during-cleanup.txt"), "retain race\n");
          return execResult(command, args, options);
        }
        if (command !== "supacode") return execResult(command, args, options);
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: `${encodeURIComponent(fixture.parent)}\n${encodeURIComponent(fixture.worker)}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          paneClosed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: paneClosed ? "" : `${SURFACE_ID}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "delete") {
          supacodeDeleteCalled = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected Supacode call", code: 1, killed: false };
      },
    };

    const prepared = await prepareDelegateHandoff(pi, JOB_ID, undefined, fixture.agentDir);
    const result = await applyPreparedDelegateHandoff(pi, prepared);

    assert.equal(result.state, "applied");
    assert.equal(injectedRace, true);
    assert.equal(result.cleanup.worktreeRemoved, false);
    assert.equal(supacodeDeleteCalled, false);
    assert.equal(result.cleanup.errors.some((error) => error.includes("Git refused")), true);
    assert.equal(await readFile(join(fixture.worker, "during-cleanup.txt"), "utf8"), "retain race\n");
    assert.ok(result.cleanup.recoveryRef);
  } finally {
    await removeFixture(fixture);
  }
});

test("branch restoration never overwrites a concurrently created branch", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\napplied\nthree\n");
    await git(fixture.worker, "add", "a.txt");
    await git(fixture.worker, "commit", "-m", "worker change");
    const sourceHead = await git(fixture.worker, "rev-parse", "HEAD");
    const branchRef = `refs/heads/${fixture.branch}`;
    let injectConcurrentBranch = false;
    let paneClosed = false;
    const pi = {
      exec: async (command, args, options) => {
        if (
          command === "git" && injectConcurrentBranch &&
          args.includes("update-ref") && args.includes(branchRef)
        ) {
          injectConcurrentBranch = false;
          await git(fixture.parent, "update-ref", branchRef, fixture.baseSha);
        }
        if (command !== "supacode") return execResult(command, args, options);
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: `${encodeURIComponent(fixture.parent)}\n${encodeURIComponent(fixture.worker)}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          paneClosed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: paneClosed ? "" : `${SURFACE_ID}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "delete") {
          await git(fixture.parent, "branch", "-D", fixture.branch);
          injectConcurrentBranch = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected Supacode call", code: 1, killed: false };
      },
    };

    const prepared = await prepareDelegateHandoff(pi, JOB_ID, undefined, fixture.agentDir);
    const result = await applyPreparedDelegateHandoff(pi, prepared);

    assert.equal(result.state, "applied");
    assert.equal(result.cleanup.worktreeRemoved, true);
    assert.equal(result.cleanup.branchPreserved, false);
    assert.equal(await git(fixture.parent, "rev-parse", fixture.branch), fixture.baseSha);
    assert.ok(result.cleanup.recoveryRef);
    assert.ok(result.cleanup.preservedHead);
    assert.notEqual(result.cleanup.preservedHead, sourceHead);
    assert.equal(await git(fixture.parent, "rev-parse", result.cleanup.recoveryRef), result.cleanup.preservedHead);
  } finally {
    await removeFixture(fixture);
  }
});

test("successful cleanup closes the pane, removes the worktree, and restores a deleted branch", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\napplied\nthree\n");
    await git(fixture.worker, "add", "a.txt");
    await git(fixture.worker, "commit", "-m", "worker change");
    const sourceHead = await git(fixture.worker, "rev-parse", "HEAD");
    const supacodeCalls = [];
    let paneClosed = false;
    const pi = {
      exec: async (command, args, options) => {
        if (command !== "supacode") return execResult(command, args, options);
        supacodeCalls.push(args.join(" "));
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: paneClosed ? "" : `${SURFACE_ID}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          paneClosed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: `${encodeURIComponent(fixture.parent)}\n${encodeURIComponent(fixture.worker)}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "delete") {
          await git(fixture.parent, "branch", "-D", fixture.branch);
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected Supacode call", code: 1, killed: false };
      },
    };

    const prepared = await prepareDelegateHandoff(pi, JOB_ID, undefined, fixture.agentDir);
    const result = await applyPreparedDelegateHandoff(pi, prepared);

    assert.equal(result.state, "applied");
    assert.deepEqual(result.cleanup.errors, []);
    assert.equal(result.cleanup.paneClosed, true);
    assert.equal(result.cleanup.worktreeRemoved, true);
    assert.equal(result.cleanup.branchPreserved, true);
    assert.ok(result.cleanup.preservedHead);
    assert.notEqual(result.cleanup.preservedHead, sourceHead);
    assert.equal(await git(fixture.parent, "rev-parse", fixture.branch), result.cleanup.preservedHead);
    assert.equal(
      (await execResult("git", ["-C", fixture.parent, "merge-base", "--is-ancestor", sourceHead, result.cleanup.preservedHead])).code,
      0,
    );
    assert.equal(await git(fixture.parent, "for-each-ref", "--format=%(refname)", "refs/pi-agent-handoffs"), "");
    const closeCall = supacodeCalls.find((call) => call.startsWith("surface close"));
    assert.ok(closeCall);
    assert.equal(closeCall.includes(`-w ${encodeURIComponent(fixture.worker)}`), true);
    assert.equal(supacodeCalls.some((call) => call.startsWith("worktree delete")), true);
  } finally {
    await removeFixture(fixture);
  }
});
