import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitStatusTracker,
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
      args: ["status", "--porcelain"],
      options: { cwd: "/repo", timeout: 1_000 },
    },
  ]);

  ensureGitStatus(pi, tracker, () => updates++);
  assert.equal(calls.length, 1);
  assert.equal(updates, 1);
});
