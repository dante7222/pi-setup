import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeRunnerProcess } from "../extensions/supacode-subagents/lifecycle.ts";
import { captureProcessIdentity, inspectProcessIdentity } from "../extensions/supacode-subagents/process-identity.ts";
import {
  observeWorkerSurfaces,
  terminateWorker,
  verifyWorkerProcessesAbsent,
} from "../extensions/supacode-subagents/worker-supervisor.ts";

const FIRST = { id: "first", surfaceId: "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb" };
const SECOND = { id: "second", surfaceId: "cccccccc-1111-4222-8333-dddddddddddd" };

test("surface monitoring confirms each missing worker independently", () => {
  const state = { missingCounts: new Map() };
  assert.deepEqual(
    observeWorkerSurfaces([FIRST, SECOND], [FIRST.surfaceId], state, 2),
    [],
  );
  assert.deepEqual(observeWorkerSurfaces([FIRST, SECOND], undefined, state, 2), []);
  assert.deepEqual(
    observeWorkerSurfaces([FIRST, SECOND], [FIRST.surfaceId], state, 2),
    [],
  );
  assert.deepEqual(
    observeWorkerSurfaces([FIRST, SECOND], [FIRST.surfaceId], state, 2),
    ["second"],
  );
  assert.deepEqual(
    observeWorkerSurfaces([FIRST, SECOND], [FIRST.surfaceId, SECOND.surfaceId], state, 2),
    [],
  );
  assert.deepEqual(
    observeWorkerSurfaces([FIRST, SECOND], undefined, state, 2),
    [],
  );
});

test("worker termination verifies both exact surface and recorded process group absence", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-supervisor-"));
  const child = spawn("/bin/zsh", ["-lc", "sleep 30"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    const identity = await captureProcessIdentity(child.pid, "launch-nonce", child.pid);
    assert.ok(identity);
    assert.equal(await captureProcessIdentity(child.pid, "launch-nonce", child.pid + 1), undefined);
    await writeRunnerProcess(jobDir, {
      schemaVersion: 2,
      jobId: "job",
      launchNonce: "launch-nonce",
      wrapper: identity,
      startedAt: new Date().toISOString(),
    });
    const mismatched = await verifyWorkerProcessesAbsent({
      id: "job",
      jobDir,
      tabWorktreeId: "/worktree",
      tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
      surfaceId: SECOND.surfaceId,
      launchNonce: "different-nonce",
    }, identity);
    assert.equal(mismatched.absent, false);
    assert.deepEqual(mismatched.states, ["unknown"]);
    const wrongJob = await verifyWorkerProcessesAbsent({
      id: "different-job",
      jobDir,
      tabWorktreeId: "/worktree",
      tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
      surfaceId: SECOND.surfaceId,
      launchNonce: "launch-nonce",
    }, identity);
    assert.equal(wrongJob.absent, false);
    assert.deepEqual(wrongJob.states, ["unknown"]);

    let closed = false;
    const calls = [];
    const pi = {
      exec: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "surface" && args[1] === "close") {
          closed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return {
            stdout: closed ? "" : `${SECOND.surfaceId}\n`,
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
      },
    };
    const refused = await terminateWorker(pi, {
      id: "different-job",
      jobDir,
      tabWorktreeId: "/worktree",
      tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
      surfaceId: SECOND.surfaceId,
      launchNonce: "launch-nonce",
    }, identity);
    assert.equal(refused.verified, false);
    assert.equal(await inspectProcessIdentity(identity), "alive");
    closed = false;

    const result = await terminateWorker(pi, {
      id: "job",
      jobDir,
      tabWorktreeId: "/worktree",
      tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
      surfaceId: SECOND.surfaceId,
      launchNonce: "launch-nonce",
    }, identity);

    assert.equal(result.surfaceAbsent, true);
    assert.equal(result.processesAbsent, true);
    assert.equal(result.verified, true);
    assert.equal(await inspectProcessIdentity(identity), "missing");
    assert.equal(
      calls.some((call) => call.join(" ").includes(`surface close -w /worktree`) && call.includes(SECOND.surfaceId)),
      true,
    );
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await rm(jobDir, { recursive: true, force: true });
  }
});
