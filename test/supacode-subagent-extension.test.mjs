import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  claimJobDecision,
  claimWorkerTerminal,
  initializeJobLifecycle,
  readJobLifecycle,
  readWorkerReport,
  readWorkerReportOutput,
  readWorkerTerminal,
  updateJobLifecycle,
  writeJobControl,
  writeRunnerExit,
  writeRunnerProcess,
} from "../extensions/supacode-subagents/lifecycle.ts";
import { captureProcessIdentity, inspectProcessIdentity } from "../extensions/supacode-subagents/process-identity.ts";

const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalModules, "@earendil-works", "pi-coding-agent");
const runtimePackages = new Map([
  ["@earendil-works/pi-ai", join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")],
  ["@earendil-works/pi-coding-agent", join(piRoot, "dist", "index.js")],
  ["typebox", join(piRoot, "node_modules", "typebox", "build", "index.mjs")],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const filePath = runtimePackages.get(specifier);
      if (filePath) return { url: pathToFileURL(filePath).href, shortCircuit: true };
      throw error;
    }
  },
});
const { default: supacodeSubagents } = createRequire(import.meta.url)("../extensions/supacode-subagents/index.ts");

const WORKER_JOB_ENV = "PI_SUPACODE_SUBAGENT_JOB_DIR";

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
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout, stderr, code, killed: Boolean(error?.killed) });
      },
    );
  });
}

async function checked(command, args, options) {
  const result = await execResult(command, args, options);
  assert.equal(result.code, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function registerExtension(execute = execResult) {
  const tools = new Map();
  const commands = new Map();
  const pi = {
    exec: execute,
    getSessionName: () => "test",
    getThinkingLevel: () => "medium",
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
  };
  supacodeSubagents(pi);
  return { pi, tools, commands };
}

function baseContext(cwd, confirm) {
  return {
    cwd,
    model: undefined,
    hasUI: true,
    abort() {},
    ui: {
      confirm,
    },
  };
}

function usage(multiplier) {
  return {
    input: 10 * multiplier,
    output: 5 * multiplier,
    cacheRead: 3 * multiplier,
    cacheWrite: 2 * multiplier,
    reasoning: multiplier,
    totalTokens: 20 * multiplier,
    cost: {
      input: 0.1 * multiplier,
      output: 0.2 * multiplier,
      cacheRead: 0.03 * multiplier,
      cacheWrite: 0.02 * multiplier,
      total: 0.35 * multiplier,
    },
  };
}

function assistantEntry(text, stopReason, multiplier) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "test-model",
      stopReason,
      usage: usage(multiplier),
    },
  };
}

async function captureWorker(entries) {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-capture-"));
  const prior = process.env[WORKER_JOB_ENV];
  const handlers = new Map();
  try {
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      schemaVersion: 2,
      id: "11111111-2222-4333-8444-555555555555",
      launchNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    }));
    process.env[WORKER_JOB_ENV] = jobDir;
    supacodeSubagents({
      on: (event, handler) => handlers.set(event, handler),
    });
    await handlers.get("agent_start")();
    await handlers.get("agent_settled")({}, {
      sessionManager: { getEntries: () => entries },
    });
    const report = await readWorkerReport(
      jobDir,
      "11111111-2222-4333-8444-555555555555",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    assert.ok(report);
    assert.equal(await readWorkerTerminal(jobDir), undefined);
    return {
      status: report.status,
      result: await readWorkerReportOutput(report),
    };
  } finally {
    if (prior === undefined) delete process.env[WORKER_JOB_ENV];
    else process.env[WORKER_JOB_ENV] = prior;
    await rm(jobDir, { recursive: true, force: true });
  }
}

test("all delegation tools execute sequentially", () => {
  const { tools, commands } = registerExtension();
  assert.deepEqual([...tools.keys()].sort(), [
    "delegate",
    "delegate_apply",
    "delegate_loop",
    "delegate_parallel",
  ]);
  for (const tool of tools.values()) assert.equal(tool.executionMode, "sequential");
  assert.deepEqual([...commands.keys()].sort(), [
    "delegate-apply",
    "delegate-cancel",
    "delegate-recover",
    "delegate-status",
  ]);
});

test("worker completion requires a normal stop and aggregates all turn usage", async () => {
  const completed = await captureWorker([
    assistantEntry("working", "toolUse", 1),
    { type: "compaction", usage: usage(3) },
    assistantEntry("done", "stop", 2),
  ]);
  assert.equal(completed.status.state, "completed");
  assert.equal(completed.status.stopReason, "stop");
  assert.equal(completed.status.usage.input, 60);
  assert.equal(completed.status.usage.output, 30);
  assert.equal(completed.status.usage.reasoning, 6);
  assert.equal(completed.result, "done\n");

  const incomplete = await captureWorker([
    assistantEntry("partial answer", "length", 1),
  ]);
  assert.equal(incomplete.status.state, "failed");
  assert.match(incomplete.status.errorMessage, /stopped with length/);
  assert.equal(incomplete.result, "partial answer\n");
});

test("delegation inputs reject whitespace-only tasks, models, and skills before launch", async () => {
  const { tools } = registerExtension();
  const context = baseContext(process.cwd(), async () => false);

  await assert.rejects(
    tools.get("delegate").execute("call", { task: " \n " }, undefined, undefined, context),
    /delegate\.task.*non-whitespace/,
  );
  await assert.rejects(
    tools.get("delegate").execute("call", { task: "valid", model: "  " }, undefined, undefined, context),
    /delegate\.model.*non-whitespace/,
  );
  await assert.rejects(
    tools.get("delegate_parallel").execute(
      "call",
      { tasks: [{ task: "\t" }] },
      undefined,
      undefined,
      context,
    ),
    /delegate_parallel\.tasks\[0\]\.task.*non-whitespace/,
  );
  await assert.rejects(
    tools.get("delegate_loop").execute(
      "call",
      {
        task: "valid",
        checks: [{ command: "true" }],
        reviewers: [{ focus: "review", skills: ["  "] }],
      },
      undefined,
      undefined,
      context,
    ),
    /empty skill path/,
  );
});

test("worktree creation is preceded by durable job and lifecycle intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-order-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorWorktreeId = process.env.SUPACODE_WORKTREE_ID;
  try {
    await checked("git", ["init", repository]);
    await checked("git", ["-C", repository, "config", "user.name", "Test User"]);
    await checked("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await writeFile(join(repository, "tracked.txt"), "base\n");
    await checked("git", ["-C", repository, "add", "."]);
    await checked("git", ["-C", repository, "commit", "-m", "base"]);
    const canonicalRepository = await realpath(repository);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.SUPACODE_WORKTREE_ID = encodeURIComponent(canonicalRepository);
    let observedIntents = 0;
    const execute = async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "repo" && args[1] === "list") {
        return { stdout: `${encodeURIComponent(canonicalRepository)}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "repo" && args[1] === "worktree-new") {
        const batches = await readdir(join(agentDir, "subagents"));
        const jobRecords = [];
        for (const batch of batches) {
          for (const entry of await readdir(join(agentDir, "subagents", batch), { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const jobDir = join(agentDir, "subagents", batch, entry.name);
            const job = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
            const lifecycle = JSON.parse(await readFile(join(jobDir, "lifecycle.json"), "utf8"));
            if (lifecycle.phase === "provisioning_worktree") jobRecords.push({ job, lifecycle });
          }
        }
        assert.equal(jobRecords.length >= 1, true);
        const latest = jobRecords.at(-1);
        assert.equal(latest.job.schemaVersion, 2);
        assert.match(latest.job.workspacePlan.branch, /^pi-agent\//);
        assert.equal(latest.lifecycle.schemaVersion, 2);
        observedIntents++;
        return { stdout: "", stderr: "simulated provisioning failure", code: 1, killed: false };
      }
      return { stdout: "", stderr: `unexpected Supacode command: ${args.join(" ")}`, code: 1, killed: false };
    };
    const { tools } = registerExtension(execute);
    const context = baseContext(repository, async () => true);
    const delegated = await tools.get("delegate").execute(
      "call",
      { task: "coding intent", mode: "coding" },
      undefined,
      undefined,
      context,
    );
    assert.equal(delegated.details.results[0].state, "failed");
    await assert.rejects(
      tools.get("delegate_loop").execute(
        "call",
        {
          task: "loop intent",
          checks: [{ command: "true" }],
          reviewers: [{ focus: "review" }],
        },
        undefined,
        undefined,
        context,
      ),
      /simulated provisioning failure/,
    );
    assert.equal(observedIntents, 2);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorWorktreeId === undefined) delete process.env.SUPACODE_WORKTREE_ID;
    else process.env.SUPACODE_WORKTREE_ID = priorWorktreeId;
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancellation racing surface creation closes the launched surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-prelaunch-cancel-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorWorktreeId = process.env.SUPACODE_WORKTREE_ID;
  try {
    await checked("git", ["init", repository]);
    const canonicalRepository = await realpath(repository);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.SUPACODE_WORKTREE_ID = encodeURIComponent(canonicalRepository);
    let surfaceLaunched = false;
    let launchedSurfaceId;
    let surfaceClosed = false;
    let tabClosed = false;
    const { tools } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "repo" && args[1] === "list") {
        return { stdout: `${encodeURIComponent(canonicalRepository)}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "new") {
        const tabId = args[args.indexOf("-n") + 1];
        return { stdout: `${tabId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "split") {
        surfaceLaunched = true;
        launchedSurfaceId = args[args.indexOf("-n") + 1];
        const batches = await readdir(join(agentDir, "subagents"));
        const batchDir = join(agentDir, "subagents", batches[0]);
        const workerEntry = (await readdir(batchDir, { withFileTypes: true })).find((entry) => entry.isDirectory());
        assert.ok(workerEntry);
        const jobDir = join(batchDir, workerEntry.name);
        const job = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
        await claimJobDecision(jobDir, job.id, "cancel");
        await writeJobControl(jobDir, job.id, "cancel during surface creation");
        return { stdout: `${launchedSurfaceId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "close") {
        surfaceClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        return {
          stdout: surfaceClosed || !launchedSurfaceId ? "" : `${launchedSurfaceId}\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (args[0] === "tab" && args[1] === "close") {
        tabClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: tabClosed ? "" : `${args[args.indexOf("-t") + 1]}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `unexpected command: ${args.join(" ")}`, code: 1, killed: false };
    });

    const result = await tools.get("delegate").execute(
      "call",
      { task: "prelaunch cancellation", keepOpen: false },
      undefined,
      undefined,
      baseContext(repository, async () => true),
    );
    assert.equal(surfaceLaunched, true);
    assert.equal(surfaceClosed, true);
    assert.equal(result.details.results[0].state, "failed");
    const jobs = await readdir(join(agentDir, "subagents"));
    const batchDir = join(agentDir, "subagents", jobs[0]);
    const workerEntry = (await readdir(batchDir, { withFileTypes: true })).find((entry) => entry.isDirectory());
    const workerJobDir = join(batchDir, workerEntry.name);
    assert.equal((await readJobLifecycle(workerJobDir)).phase, "recovery_required");
    assert.equal(await readWorkerTerminal(workerJobDir), undefined);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorWorktreeId === undefined) delete process.env.SUPACODE_WORKTREE_ID;
    else process.env.SUPACODE_WORKTREE_ID = priorWorktreeId;
    await rm(root, { recursive: true, force: true });
  }
});

test("status, cancel, and recover commands reconcile durable worker state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-commands-"));
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const tabId = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
  const surfaceId = "cccccccc-1111-4222-8333-dddddddddddd";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(jobDir, { recursive: true });
    const launchNonce = "launch-nonce";
    const missingIdentity = {
      pid: 999_999_999,
      startSignature: "missing",
      processGroup: 999_999_999,
      command: "missing",
      launchNonce,
    };
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: command test",
      title: "command test",
      mode: "research",
      originalCwd: root,
      workerCwd: root,
      launchNonce,
      tabWorktreeId: encodeURIComponent(root),
      tabId,
      surfaceId,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "running");
    await writeFile(join(jobDir, "status.json"), JSON.stringify({
      state: "running",
      pid: missingIdentity.pid,
      processIdentity: missingIdentity,
      launchNonce,
    }));
    await writeRunnerProcess(jobDir, {
      schemaVersion: 2,
      jobId,
      launchNonce,
      wrapper: missingIdentity,
      startedAt: new Date().toISOString(),
    });
    let surfaceClosed = false;
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "surface" && args[1] === "close") {
        surfaceClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        return { stdout: surfaceClosed ? "" : `${surfaceId}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
    });
    const notifications = [];
    const context = {
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        confirm: async () => true,
        notify: (message, level) => notifications.push({ message, level }),
        setStatus() {},
      },
    };
    await commands.get("delegate-cancel").handler(jobId, context);
    assert.equal(surfaceClosed, true);
    assert.equal((await readWorkerTerminal(jobDir)).owner, "cancel");
    assert.equal((await readJobLifecycle(jobDir)).phase, "cancelled");

    await commands.get("delegate-status").handler(jobId, context);
    assert.equal(notifications.some((notification) => notification.message.includes("Phase: cancelled")), true);
    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal((await readJobLifecycle(jobDir)).phase, "cancelled");
    assert.equal(notifications.some((notification) => notification.message.includes("recorded processes are absent")), true);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation does not terminalize an indeterminate worker process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cancel-indeterminate-"));
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const tabId = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
  const surfaceId = "cccccccc-1111-4222-8333-dddddddddddd";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(jobDir, { recursive: true });
    const launchNonce = "indeterminate-nonce";
    const actualIdentity = await captureProcessIdentity(process.pid, launchNonce, process.pid);
    const mismatchedIdentity = { ...actualIdentity, startSignature: "mismatched-start-signature" };
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: indeterminate cancellation",
      title: "indeterminate cancellation",
      mode: "research",
      originalCwd: root,
      workerCwd: root,
      launchNonce,
      tabWorktreeId: encodeURIComponent(root),
      tabId,
      surfaceId,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "running");
    await writeFile(join(jobDir, "status.json"), JSON.stringify({
      state: "running",
      pid: mismatchedIdentity.pid,
      processIdentity: mismatchedIdentity,
      launchNonce,
    }));
    await writeRunnerProcess(jobDir, {
      schemaVersion: 2,
      jobId,
      launchNonce,
      wrapper: mismatchedIdentity,
      startedAt: new Date().toISOString(),
    });
    let surfaceClosed = false;
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "surface" && args[1] === "close") {
        surfaceClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        return { stdout: surfaceClosed ? "" : `${surfaceId}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
    });
    const notifications = [];
    await commands.get("delegate-cancel").handler(jobId, {
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        confirm: async () => true,
        notify: (message, level) => notifications.push({ message, level }),
        setStatus() {},
      },
    });

    assert.equal(surfaceClosed, true);
    assert.equal(await readWorkerTerminal(jobDir), undefined);
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");
    assert.equal(notifications.some(({ message }) => message.includes("termination is indeterminate")), true);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation refuses process metadata without a surface or authenticated runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cancel-no-surface-"));
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(jobDir, { recursive: true });
    const launchNonce = "no-surface-nonce";
    const identity = await captureProcessIdentity(process.pid, launchNonce);
    assert.ok(identity);
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: no surface",
      title: "no surface",
      mode: "research",
      originalCwd: root,
      workerCwd: root,
      launchNonce,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "running");
    await writeFile(join(jobDir, "status.json"), JSON.stringify({
      state: "running",
      pid: identity.pid,
      processIdentity: identity,
      launchNonce,
    }));
    const { commands } = registerExtension();
    await commands.get("delegate-cancel").handler(jobId, {
      hasUI: true,
      waitForIdle: async () => {},
      ui: { confirm: async () => true, notify() {}, setStatus() {} },
    });

    assert.equal(await readWorkerTerminal(jobDir), undefined);
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");
    assert.equal(await inspectProcessIdentity(identity), "alive");
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery never terminalizes an unknown process identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-unknown-"));
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: unknown process",
      title: "unknown process",
      mode: "research",
      originalCwd: root,
      workerCwd: root,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "running");
    await writeFile(join(jobDir, "status.json"), JSON.stringify({
      state: "running",
      processIdentity: {
        pid: 1,
        startSignature: "unavailable",
        processGroup: 2,
        command: "unknown",
        launchNonce: "unknown",
      },
      launchNonce: "unknown",
    }));
    const { commands } = registerExtension();
    const notifications = [];
    await commands.get("delegate-recover").handler(jobId, {
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        confirm: async () => true,
        notify: (message, level) => notifications.push({ message, level }),
        setStatus() {},
      },
    });

    assert.equal(await readWorkerTerminal(jobDir), undefined);
    const lifecycle = await readJobLifecycle(jobDir);
    assert.equal(lifecycle.phase, "recovery_required");
    assert.match(lifecycle.reason, /identity is unknown/);
    assert.equal(notifications.some(({ message }) => message.includes("recovery was refused")), true);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery terminates a recorded reviewer process before removing its evaluator", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reviewer-recovery-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const reviewerDir = join(agentDir, "subagents", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", "22222222-3333-4444-8555-666666666666");
  const reviewDir = join(jobDir, "iterations", "001", "reviews", "01-test");
  const checkout = join(reviewDir, "checkout");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  let reviewerProcess;
  try {
    await checked("git", ["init", repository]);
    await checked("git", ["-C", repository, "config", "user.name", "Test User"]);
    await checked("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await writeFile(join(repository, "tracked.txt"), "base\n");
    await checked("git", ["-C", repository, "add", "."]);
    await checked("git", ["-C", repository, "commit", "-m", "base"]);
    await mkdir(reviewDir, { recursive: true });
    await checked("git", ["-C", repository, "worktree", "add", "--detach", checkout, "HEAD"]);
    await mkdir(reviewerDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: reviewer recovery",
      title: "reviewer recovery",
      mode: "coding",
      originalCwd: repository,
      workerCwd: repository,
      worktreePath: repository,
      launchNonce: "canonical-nonce",
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "completed");
    const missingIdentity = {
      pid: 999_999_999,
      startSignature: "missing",
      processGroup: 999_999_999,
      command: "missing",
      launchNonce: "canonical-nonce",
    };
    await writeRunnerProcess(jobDir, {
      schemaVersion: 2,
      jobId,
      launchNonce: "canonical-nonce",
      wrapper: missingIdentity,
      startedAt: new Date().toISOString(),
    });
    await writeRunnerExit(jobDir, {
      schemaVersion: 2,
      jobId,
      launchNonce: "canonical-nonce",
      wrapperPid: missingIdentity.pid,
      exitCode: 1,
      exitedAt: new Date().toISOString(),
    });
    await claimWorkerTerminal(jobDir, jobId, "recovery", {
      state: "failed",
      stopReason: "recovered",
      launchNonce: "canonical-nonce",
    }, "recovered");

    reviewerProcess = spawn("/bin/zsh", ["-lc", "sleep 30"], { detached: true, stdio: "ignore" });
    const reviewerIdentity = await captureProcessIdentity(
      reviewerProcess.pid,
      "reviewer-nonce",
      reviewerProcess.pid,
    );
    assert.ok(reviewerIdentity);
    await writeRunnerProcess(reviewerDir, {
      schemaVersion: 2,
      jobId: "22222222-3333-4444-8555-666666666666",
      launchNonce: "reviewer-nonce",
      wrapper: reviewerIdentity,
      startedAt: new Date().toISOString(),
    });
    await writeFile(join(reviewDir, "checkout-lifecycle.json"), `${JSON.stringify({
      schemaVersion: 1,
      phase: "evaluating",
      checkoutPath: checkout,
      processJobId: "22222222-3333-4444-8555-666666666666",
      processJobDir: reviewerDir,
      processLaunchNonce: "reviewer-nonce",
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await updateJobLifecycle(jobDir, "completed", undefined, {
      activeReviewerJobs: [{
        jobId: "22222222-3333-4444-8555-666666666666",
        jobDir: reviewerDir,
        launchNonce: "reviewer-nonce",
        checkoutPath: checkout,
      }],
    });
    await claimJobDecision(jobDir, jobId, "cancel");

    const { commands } = registerExtension();
    await commands.get("delegate-recover").handler(jobId, {
      hasUI: true,
      waitForIdle: async () => {},
      ui: { confirm: async () => true, notify() {}, setStatus() {} },
    });

    await assert.rejects(lstat(checkout), { code: "ENOENT" });
    assert.equal(
      JSON.parse(await readFile(join(reviewDir, "checkout-lifecycle.json"), "utf8")).phase,
      "removed",
    );
    assert.throws(() => process.kill(reviewerProcess.pid, 0), { code: "ESRCH" });
  } finally {
    if (reviewerProcess?.pid) {
      try { process.kill(-reviewerProcess.pid, "SIGKILL"); } catch {}
    }
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery preserves partial launch resources while a worker process is live", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-partial-launch-recovery-"));
  const repository = join(root, "repository");
  const retainedWorktree = join(root, "retained-worktree");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  let child;
  try {
    await checked("git", ["init", repository]);
    await mkdir(retainedWorktree);
    await writeFile(join(retainedWorktree, "marker"), "retain\n");
    await mkdir(jobDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    child = spawn("/bin/zsh", ["-lc", "sleep 30"], { detached: true, stdio: "ignore" });
    const launchNonce = "partial-launch-nonce";
    const identity = await captureProcessIdentity(child.pid, launchNonce, child.pid);
    assert.ok(identity);
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: partial launch",
      title: "partial launch",
      mode: "coding",
      originalCwd: repository,
      workerCwd: retainedWorktree,
      worktreePath: retainedWorktree,
      launchNonce,
      tabId: "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb",
      workspacePlan: {
        repoRoot: repository,
        relativeCwd: "",
        branch: "pi-agent/partial",
        folderName: "retained-worktree",
        baseSha: "unverified",
      },
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "provisioning_worktree");
    await writeFile(join(jobDir, "status.json"), JSON.stringify({
      state: "running",
      pid: identity.pid,
      processIdentity: identity,
      launchNonce,
    }));
    await writeRunnerProcess(jobDir, {
      schemaVersion: 2,
      jobId,
      launchNonce,
      wrapper: identity,
      startedAt: new Date().toISOString(),
    });
    const supacodeCalls = [];
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      supacodeCalls.push(args);
      return { stdout: "", stderr: "unexpected Supacode mutation", code: 1, killed: false };
    });
    await commands.get("delegate-recover").handler(jobId, {
      hasUI: true,
      waitForIdle: async () => {},
      ui: { confirm: async () => true, notify() {}, setStatus() {} },
    });

    assert.deepEqual(supacodeCalls, []);
    assert.equal((await lstat(join(retainedWorktree, "marker"))).isFile(), true);
    assert.equal(await inspectProcessIdentity(identity), "alive");
    assert.equal(await readWorkerTerminal(jobDir), undefined);
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("recover removes an untouched worktree left by interrupted provisioning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-provisioning-recovery-"));
  const repository = join(root, "repository");
  const worktree = join(root, "worker");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const branch = "pi-agent/aaaaaa/111111";
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await checked("git", ["init", repository]);
    await checked("git", ["-C", repository, "config", "user.name", "Test User"]);
    await checked("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await writeFile(join(repository, "tracked.txt"), "base\n");
    await checked("git", ["-C", repository, "add", "."]);
    await checked("git", ["-C", repository, "commit", "-m", "base"]);
    const baseSha = await checked("git", ["-C", repository, "rev-parse", "HEAD"]);
    await checked("git", ["-C", repository, "worktree", "add", "-b", branch, worktree, baseSha]);
    const canonicalWorktree = await realpath(worktree);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(jobDir, { recursive: true });
    const workspacePlan = {
      repoRoot: await realpath(repository),
      relativeCwd: "",
      branch,
      folderName: "worker",
      baseSha,
    };
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: recover",
      title: "recover provisioning",
      mode: "coding",
      originalCwd: repository,
      workerCwd: repository,
      workspacePlan,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "provisioning_worktree", { workspacePlan });
    let deleted = false;
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "worktree" && args[1] === "list") {
        return { stdout: `${encodeURIComponent(canonicalWorktree)}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "worktree" && args[1] === "delete") {
        deleted = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: "unexpected command", code: 1, killed: false };
    });
    const notifications = [];
    await commands.get("delegate-recover").handler(jobId, {
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        confirm: async () => true,
        notify: (message, level) => notifications.push({ message, level }),
        setStatus() {},
      },
    });
    assert.equal(deleted, true);
    await assert.rejects(realpath(worktree));
    assert.equal((await readJobLifecycle(jobDir)).phase, "failed");
    assert.equal(notifications.some((notification) => notification.message.includes("Removed untouched worktree")), true);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("delegate_loop passes its signal to confirmation and rejects dirty or gitlink parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-loop-parent-"));
  try {
    await checked("git", ["init", root]);
    await checked("git", ["-C", root, "config", "user.name", "Test User"]);
    await checked("git", ["-C", root, "config", "user.email", "test@example.com"]);
    const nestedCwd = join(root, "packages", "api");
    await mkdir(nestedCwd, { recursive: true });
    await writeFile(join(root, "tracked.txt"), "base\n");
    await writeFile(join(nestedCwd, "package.txt"), "package\n");
    await checked("git", ["-C", root, "add", "."]);
    await checked("git", ["-C", root, "commit", "-m", "base"]);

    const { tools } = registerExtension();
    const signal = new AbortController().signal;
    let confirmationOptions;
    const context = baseContext(nestedCwd, async (_title, _message, options) => {
      confirmationOptions = options;
      return false;
    });
    const params = {
      task: "test loop",
      checks: [{ command: "true" }],
      reviewers: [{ focus: "review correctness" }],
    };
    const cancelled = await tools.get("delegate_loop").execute(
      "call",
      params,
      signal,
      undefined,
      context,
    );
    assert.equal(cancelled.details.cancelled, true);
    assert.equal(confirmationOptions.signal, signal);

    const abortController = new AbortController();
    let confirmationStarted;
    const enteredConfirmation = new Promise((resolve) => {
      confirmationStarted = resolve;
    });
    const abortContext = baseContext(nestedCwd, async (_title, _message, options) => {
      confirmationStarted();
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve(false), { once: true });
      });
    });
    const aborted = tools.get("delegate_loop").execute(
      "call",
      params,
      abortController.signal,
      undefined,
      abortContext,
    );
    await enteredConfirmation;
    abortController.abort();
    await assert.rejects(aborted, /aborted/i);

    await writeFile(join(root, "untracked.txt"), "dirty\n");
    let confirmed = false;
    const dirtyContext = baseContext(nestedCwd, async () => {
      confirmed = true;
      return false;
    });
    await assert.rejects(
      tools.get("delegate_loop").execute(
        "call",
        params,
        signal,
        undefined,
        dirtyContext,
      ),
      /requires a clean parent checkout/,
    );
    assert.equal(confirmed, false);

    await rm(join(root, "untracked.txt"));
    const embedded = join(root, "embedded");
    await checked("git", ["init", embedded]);
    await checked("git", ["-C", embedded, "config", "user.name", "Test User"]);
    await checked("git", ["-C", embedded, "config", "user.email", "test@example.com"]);
    await writeFile(join(embedded, "nested.txt"), "nested\n");
    await checked("git", ["-C", embedded, "add", "nested.txt"]);
    await checked("git", ["-C", embedded, "commit", "-m", "nested"]);
    await checked("git", ["-C", root, "add", "embedded"]);
    await checked("git", ["-C", root, "commit", "-m", "add gitlink"]);
    await assert.rejects(
      tools.get("delegate_loop").execute(
        "call",
        params,
        signal,
        undefined,
        dirtyContext,
      ),
      /unsupported submodules or gitlinks/,
    );
    assert.equal(confirmed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
