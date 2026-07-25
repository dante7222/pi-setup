import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeRunnerProcess } from "../extensions/supacode-subagents/lifecycle.ts";
import { captureProcessIdentity, inspectProcessIdentity } from "../extensions/supacode-subagents/process-identity.ts";
import {
  claimWorkerTerminationIntent,
  observeWorkerSurfaces,
  readWorkerTerminationIntent,
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

test("orchestrator termination linearizes before a later manual-close observation", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-termination-intent-"));
  const worker = { id: "job", jobDir, launchNonce: "nonce" };
  try {
    const timeout = await claimWorkerTerminationIntent(worker, "timeout", "deadline reached");
    const manual = await claimWorkerTerminationIntent(worker, "manual", "surface disappeared");
    assert.equal(timeout.won, true);
    assert.equal(manual.won, false);
    assert.equal(manual.record.owner, "timeout");
    assert.equal((await readWorkerTerminationIntent(worker)).owner, "timeout");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a manual-close decision prevents a later timeout from issuing destructive cleanup", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-manual-wins-"));
  const worker = {
    id: "manual-job",
    jobDir,
    tabWorktreeId: "/worktree",
    tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
    surfaceId: SECOND.surfaceId,
    launchNonce: "manual-nonce",
  };
  let destructiveCalls = 0;
  try {
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({ workerLaunchClaimVersion: 1 })}\n`);
    await claimWorkerTerminationIntent(worker, "manual", "surface disappeared");
    const result = await terminateWorker({
      exec: async (_command, args) => {
        if (args[0] === "surface" && args[1] === "close") destructiveCalls++;
        if (args[0] === "tab" && args[1] === "list") {
          return { stdout: `${worker.tabId}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
      },
    }, worker, undefined, { owner: "timeout", reason: "deadline reached" });
    assert.equal(result.verified, true);
    assert.equal(result.terminationOwner, "manual");
    assert.equal(result.terminationClaimWon, false);
    assert.equal(destructiveCalls, 0);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("authenticated recovery can finish a crashed termination winner without changing its decision", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-termination-recovery-"));
  const worker = {
    id: "termination-recovery-job",
    jobDir,
    tabWorktreeId: "/worktree",
    tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
    surfaceId: SECOND.surfaceId,
    launchNonce: "termination-recovery-nonce",
  };
  let surfacePresent = true;
  try {
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({ workerLaunchClaimVersion: 1 })}\n`);
    await claimWorkerTerminationIntent(worker, "timeout", "original timeout winner crashed");
    const result = await terminateWorker({
      exec: async (_command, args) => {
        if (args[0] === "tab" && args[1] === "list") {
          return { stdout: `${worker.tabId}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: surfacePresent ? `${worker.surfaceId}\n` : "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          surfacePresent = false;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
      },
    }, worker, undefined, { owner: "recovery", reason: "resume cleanup" });
    assert.equal(result.verified, true);
    assert.equal(result.terminationOwner, "timeout");
    assert.equal(result.terminationReason, "original timeout winner crashed");
    assert.equal(surfacePresent, false);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("recovery wins the durable launch claim before closing a surface whose runner never started", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-prelaunch-recovery-"));
  const worker = {
    id: "prelaunch-job",
    jobDir,
    tabWorktreeId: "/worktree",
    tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
    surfaceId: SECOND.surfaceId,
    launchNonce: "prelaunch-nonce",
  };
  let closed = false;
  try {
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({ workerLaunchClaimVersion: 1 })}\n`);
    const result = await terminateWorker({
      exec: async (_command, args) => {
        if (args[0] === "tab" && args[1] === "list") {
          return { stdout: `${worker.tabId}\n`, stderr: "", code: 0, killed: false };
        }
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
    }, worker);

    assert.equal(result.verified, true);
    assert.equal(result.processesAbsent, true);
    assert.equal(result.surfaceAbsent, true);
    const claim = JSON.parse(await readFile(join(jobDir, "worker-launch-claim.json"), "utf8"));
    assert.equal(claim.schemaVersion, 2);
    assert.equal(claim.jobId, worker.id);
    assert.equal(claim.launchNonce, worker.launchNonce);
    assert.equal(claim.owner, "recovery");
    assert.equal(typeof claim.claimedAt, "string");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("worker termination treats an already closed tab or pane as successful cleanup", async () => {
  for (const missing of ["tab", "surface"]) {
    const jobDir = await mkdtemp(join(tmpdir(), `pi-worker-missing-${missing}-`));
    const worker = {
      id: `missing-${missing}-job`,
      jobDir,
      tabWorktreeId: "/worktree",
      tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
      surfaceId: SECOND.surfaceId,
      launchNonce: `missing-${missing}-nonce`,
    };
    const calls = [];
    try {
      await writeFile(join(jobDir, "job.json"), `${JSON.stringify({ workerLaunchClaimVersion: 1 })}\n`);
      const surfaceList = ["surface", "list", "-w", worker.tabWorktreeId, "-t", worker.tabId];
      const tabList = ["tab", "list", "-w", worker.tabWorktreeId];
      const result = await terminateWorker({
        exec: async (command, args) => {
          assert.equal(command, "supacode");
          calls.push(args);
          if (args[0] === "tab" && args[1] === "list") {
            assert.deepEqual(args, tabList);
            return { stdout: "", stderr: "", code: 0, killed: false };
          }
          if (args[0] === "surface" && args[1] === "list") {
            assert.deepEqual(args, surfaceList);
            return missing === "tab"
              ? { stdout: "", stderr: "tab missing", code: 1, killed: false }
              : { stdout: "", stderr: "", code: 0, killed: false };
          }
          throw new Error(`Unexpected Supacode call: ${args.join(" ")}`);
        },
      }, worker);

      assert.equal(result.verified, true);
      assert.equal(result.surfaceAbsent, true);
      assert.equal(result.processesAbsent, true);
      assert.deepEqual(calls, missing === "tab"
        ? [surfaceList, tabList, surfaceList, tabList]
        : [surfaceList, surfaceList]);
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  }
});

test("surface cleanup waits for creator exit and a Supacode barrier before reconciliation", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-surface-creator-"));
  const launchDir = join(jobDir, "surface-launch");
  const creator = spawn("/bin/zsh", ["-lc", "sleep 30"], { detached: true, stdio: "ignore" });
  const worker = {
    id: "surface-creator-job",
    jobDir,
    tabWorktreeId: "/worktree",
    tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
    surfaceId: SECOND.surfaceId,
    launchNonce: "worker-launch-nonce",
  };
  const creatorNonce = "creator-launch-nonce";
  let closed = false;
  try {
    const creatorIdentity = await captureProcessIdentity(creator.pid, creatorNonce, creator.pid);
    assert.ok(creatorIdentity);
    await writeRunnerProcess(launchDir, {
      schemaVersion: 2,
      jobId: `${worker.id}-surface-launch`,
      launchNonce: creatorNonce,
      wrapper: creatorIdentity,
      startedAt: new Date().toISOString(),
    });
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      workerLaunchClaimVersion: 1,
      surfaceCreationProtocolVersion: 1,
      surfaceLaunchDir: launchDir,
      surfaceLaunchJobId: `${worker.id}-surface-launch`,
      surfaceLaunchNonce: creatorNonce,
    })}\n`);
    const pi = {
      exec: async (_command, args) => {
        if (args[0] === "tab" && args[1] === "list") {
          return { stdout: `${worker.tabId}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          closed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: closed ? "" : `${SECOND.surfaceId}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
      },
    };
    const unsettled = await terminateWorker(pi, worker);
    assert.equal(unsettled.verified, false);
    assert.equal(closed, false);
    assert.equal(await inspectProcessIdentity(creatorIdentity), "alive");
    assert.equal(
      JSON.parse(await readFile(join(jobDir, "worker-launch-claim.json"), "utf8")).owner,
      "recovery",
    );

    process.kill(-creator.pid, "SIGKILL");
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await inspectProcessIdentity(creatorIdentity) === "missing") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const settled = await terminateWorker(pi, worker);
    assert.equal(settled.verified, true);
    assert.equal(await inspectProcessIdentity(creatorIdentity), "missing");
    assert.equal(JSON.parse(await readFile(join(jobDir, "worker-launch-claim.json"), "utf8")).owner, "recovery");
    assert.equal(
      JSON.parse(await readFile(join(launchDir, "creation-reconciled.json"), "utf8")).launchNonce,
      creatorNonce,
    );
  } finally {
    try { process.kill(-creator.pid, "SIGKILL"); } catch {}
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a runner-owned launch claim authenticates termination before runner metadata publication", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-runner-claim-"));
  const child = spawn("/bin/zsh", ["-lc", "sleep 30"], { detached: true, stdio: "ignore" });
  const worker = {
    id: "runner-claim-job",
    jobDir,
    tabWorktreeId: "/worktree",
    tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
    surfaceId: SECOND.surfaceId,
    launchNonce: "runner-claim-nonce",
  };
  let closed = false;
  try {
    const identity = await captureProcessIdentity(child.pid, worker.launchNonce, child.pid);
    assert.ok(identity);
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({ workerLaunchClaimVersion: 1 })}\n`);
    await writeFile(join(jobDir, "worker-launch-claim.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: worker.id,
      launchNonce: worker.launchNonce,
      owner: "runner",
      wrapper: identity,
      claimedAt: new Date().toISOString(),
    })}\n`);
    const result = await terminateWorker({
      exec: async (_command, args) => {
        if (args[0] === "tab" && args[1] === "list") {
          return { stdout: `${worker.tabId}\n`, stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "close") {
          closed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          return { stdout: closed ? "" : `${SECOND.surfaceId}\n`, stderr: "", code: 0, killed: false };
        }
        return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
      },
    }, worker);

    assert.equal(result.verified, true);
    assert.equal(await inspectProcessIdentity(identity), "missing");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await rm(jobDir, { recursive: true, force: true });
  }
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
    const verificationPi = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    };
    const mismatched = await verifyWorkerProcessesAbsent(verificationPi, {
      id: "job",
      jobDir,
      tabWorktreeId: "/worktree",
      tabId: "eeeeeeee-1111-4222-8333-ffffffffffff",
      surfaceId: SECOND.surfaceId,
      launchNonce: "different-nonce",
    }, identity);
    assert.equal(mismatched.absent, false);
    assert.deepEqual(mismatched.states, ["unknown"]);
    const wrongJob = await verifyWorkerProcessesAbsent(verificationPi, {
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
    const expectedSurfaceList = [
      "surface",
      "list",
      "-w",
      "/worktree",
      "-t",
      "eeeeeeee-1111-4222-8333-ffffffffffff",
    ];
    const expectedSurfaceClose = [
      "surface",
      "close",
      "-w",
      "/worktree",
      "-t",
      "eeeeeeee-1111-4222-8333-ffffffffffff",
      "-s",
      SECOND.surfaceId,
    ];
    const pi = {
      exec: async (command, args) => {
        assert.equal(command, "supacode");
        calls.push(args);
        if (args[0] === "surface" && args[1] === "close") {
          assert.deepEqual(args, expectedSurfaceClose);
          closed = true;
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (args[0] === "surface" && args[1] === "list") {
          assert.deepEqual(args, expectedSurfaceList);
          return {
            stdout: closed ? "" : `${SECOND.surfaceId}\n`,
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        throw new Error(`Unexpected Supacode call: ${args.join(" ")}`);
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
    assert.equal(calls.filter((call) => call[0] === "surface" && call[1] === "close").length, 1);
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await rm(jobDir, { recursive: true, force: true });
  }
});
