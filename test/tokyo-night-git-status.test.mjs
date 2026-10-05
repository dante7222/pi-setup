import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitStatusTracker,
  disposeGitStatus,
  invalidateGitStatus,
  ensureGitStatus,
  parseGitStatusOutput,
} from "../extensions/tokyo-night-footer/git-status.ts";

test("parses staged, unstaged, and untracked Git porcelain counts", () => {
  assert.deepEqual(
    parseGitStatusOutput([
      " M unstaged.ts",
      "M  staged.ts",
      "MM both.ts",
      "R  renamed.ts",
      " D deleted.ts",
      "?? untracked.ts",
    ].join("\n")),
    { staged: 3, unstaged: 3, untracked: 1 },
  );
});

test("refreshes Git status asynchronously and reuses the fresh snapshot", async () => {
  const calls = [];
  const pi = {
    async exec(command, args, options) {
      calls.push({ command, args, options });
      return {
        stdout: " M README.md\n?? notes.txt\n",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  };
  const tracker = createGitStatusTracker("/repo");
  let updates = 0;

  ensureGitStatus(pi, tracker, () => updates++);
  const pending = tracker.pending;
  assert.ok(pending);
  await pending;

  assert.deepEqual(tracker.counts, { staged: 0, unstaged: 1, untracked: 1 });
  assert.equal(updates, 1);
  assert.deepEqual(calls, [
    {
      command: "git",
      args: ["--no-optional-locks", "status", "--porcelain"],
      options: { cwd: "/repo", timeout: 1_000, signal: tracker.controller.signal },
    },
  ]);

  ensureGitStatus(pi, tracker, () => updates++);
  assert.equal(calls.length, 1);
  assert.equal(updates, 1);
});

test("overlapping invalidations coalesce into one follow-up without concurrent processes", async () => {
  const tracker = createGitStatusTracker("/repo");
  const completions = [];
  let active = 0, maximum = 0, updates = 0;
  const pi = { exec: () => new Promise((resolve) => {
    active++; maximum = Math.max(maximum, active);
    completions.push((stdout) => { active--; resolve({ code: 0, stdout }); });
  }) };
  ensureGitStatus(pi, tracker, () => updates++);
  const pending = tracker.pending;
  await Promise.resolve();
  for (let i = 0; i < 100; i++) {
    invalidateGitStatus(tracker); ensureGitStatus(pi, tracker, () => updates++);
    assert.equal(tracker.pending, pending);
  }
  assert.equal(completions.length, 1);
  completions[0](" M old\n"); await Promise.resolve();
  assert.equal(completions.length, 2);
  assert.equal(tracker.status, "stale");
  completions[1]("M  new\n"); await pending;
  assert.equal(maximum, 1); assert.equal(updates, 2);
  assert.equal(tracker.status, "fresh");
  assert.deepEqual(tracker.counts, { staged: 1, unstaged: 0, untracked: 0 });
});

test("errors keep last dirty counts stale; first failure stays unknown; successful retry recovers", async () => {
  for (const failure of [() => { throw Error("spawn"); }, () => ({ code: 1, stdout: "" }), () => ({ code: 0, stdout: "", killed: true })]) {
    const tracker = createGitStatusTracker("/repo");
    const pi = { exec: failure };
    ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
    assert.equal(tracker.status, "unknown");
    pi.exec = () => ({ code: 0, stdout: " M dirty\n?? new\n" });
    invalidateGitStatus(tracker); ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
    pi.exec = failure;
    invalidateGitStatus(tracker); ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
    assert.equal(tracker.status, "stale");
    assert.deepEqual(tracker.counts, { staged: 0, unstaged: 1, untracked: 1 });
    pi.exec = () => ({ code: 0, stdout: "" });
    invalidateGitStatus(tracker); ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
    assert.equal(tracker.status, "fresh"); assert.equal(tracker.counts.unstaged, 0);
  }
});

test("dispose aborts an active Git read, suppresses late updates and queued follow-ups", async () => {
  const tracker = createGitStatusTracker("/repo");
  let resolve, signal, calls = 0, updates = 0;
  const pi = { exec: (_cmd, _args, options) => {
    calls++; signal = options.signal;
    return new Promise((done) => { resolve = done; });
  } };
  ensureGitStatus(pi, tracker, () => updates++);
  const pending = tracker.pending; await Promise.resolve();
  invalidateGitStatus(tracker); disposeGitStatus(tracker); disposeGitStatus(tracker);
  assert.equal(signal.aborted, true);
  resolve({ code: 0, stdout: " M late\n" }); await pending;
  ensureGitStatus(pi, tracker, () => updates++);
  assert.equal(calls, 1); assert.equal(updates, 0); assert.equal(tracker.pending, undefined);
  assert.equal(tracker.status, "unknown");
});

test("disposing before the refresh microtask prevents even spawning Git", async () => {
  const tracker = createGitStatusTracker("/repo");
  let calls = 0;
  ensureGitStatus({ exec: async () => { calls++; return { code: 0, stdout: "" }; } }, tracker, () => {});
  const pending = tracker.pending; disposeGitStatus(tracker); await pending;
  assert.equal(calls, 0);
});
