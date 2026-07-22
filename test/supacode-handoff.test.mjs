import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  applyPreparedDelegateHandoff,
  discardPreparedDelegateHandoff,
  formatDelegateHandoffPreview,
  prepareDelegateHandoff,
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

async function createFixture() {
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
  await git(parent, "add", ".");
  await git(parent, "commit", "-m", "base");
  const baseSha = await git(parent, "rev-parse", "HEAD");
  const branch = "pi-agent/aaaaaa/111111";
  await git(parent, "worktree", "add", "-b", branch, worker, baseSha);

  await mkdir(jobDir, { recursive: true });
  await writeFile(
    join(jobDir, "job.json"),
    `${JSON.stringify({
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
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
  await writeFile(join(jobDir, "status.json"), JSON.stringify({ state: "completed" }));

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

test("handoff serializes apply attempts with a per-job lock", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.worker, "a.txt"), "one\nworker\nthree\n");
    const prepared = await prepareDelegateHandoff(
      fixture.pi,
      JOB_ID,
      undefined,
      fixture.agentDir,
    );
    const handoffsDir = join(fixture.jobDir, "handoffs");
    await mkdir(handoffsDir, { recursive: true });
    await writeFile(join(handoffsDir, ".apply.lock"), "active\n");

    await assert.rejects(
      applyPreparedDelegateHandoff(fixture.pi, prepared, undefined, false),
      /Another apply is active/,
    );
    await discardPreparedDelegateHandoff(prepared);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8"), "one\ntwo\nthree\n");
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

    assert.equal(result.state, "conflicted");
    assert.deepEqual(result.conflictedPaths, ["a.txt"]);
    assert.equal(result.cleanup.worktreeRemoved, false);
    assert.equal(await readFile(join(fixture.parent, "a.txt"), "utf8").then((text) => text.includes("<<<<<<< ours")), true);
    assert.equal(await readFile(join(fixture.worker, "a.txt"), "utf8"), "one\nworker\nthree\n");
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
    const pi = {
      exec: async (command, args, options) => {
        if (command !== "supacode") return execResult(command, args, options);
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: `${encodeURIComponent(fixture.parent)}\n${encodeURIComponent(fixture.worker)}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: `${SURFACE_ID}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
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
          return { stdout: "", stderr: "", code: 0, killed: false };
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
          return { stdout: "", stderr: "", code: 0, killed: false };
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
    const pi = {
      exec: async (command, args, options) => {
        if (command !== "supacode") return execResult(command, args, options);
        supacodeCalls.push(args.join(" "));
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: `${SURFACE_ID}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
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
