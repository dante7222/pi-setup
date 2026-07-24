import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  claimJobDecision,
  claimWorkerTerminal,
  initializeJobLifecycle,
  publishWorkerReport,
  readJobDecision,
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

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const piRoot = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const runtimePackages = new Map([
  ["@earendil-works/pi-ai", join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js")],
  ["@earendil-works/pi-coding-agent", join(piRoot, "dist", "index.js")],
  ["@earendil-works/pi-tui", join(piRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")],
  ["typebox", join(piRoot, "node_modules", "typebox", "build", "index.mjs")],
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const filePath = runtimePackages.get(specifier);
    if (filePath) return { url: pathToFileURL(filePath).href, shortCircuit: true };
    return nextResolve(specifier, context);
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
    __supacodePiExecutableForTests: process.execPath,
    __supacodeLaunchForTests: (args, options) => execute("supacode", args, options),
    getSessionName: () => "test",
    getThinkingLevel: () => "medium",
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
  };
  supacodeSubagents(pi);
  return { pi, tools, commands };
}

function baseContext(cwd, confirm, projectTrusted = true) {
  return {
    cwd,
    model: undefined,
    hasUI: true,
    isProjectTrusted: () => projectTrusted,
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
    let shutdownRequested = false;
    const context = {
      sessionManager: { getEntries: () => entries },
      shutdown: () => { shutdownRequested = true; },
    };
    await handlers.get("session_start")({}, context);
    await handlers.get("agent_start")();
    await handlers.get("agent_settled")({}, context);
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
      shutdownRequested,
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
  assert.equal(completed.shutdownRequested, true);
  assert.equal(completed.status.state, "completed");
  assert.equal(completed.status.stopReason, "stop");
  assert.equal(completed.status.usage.input, 60);
  assert.equal(completed.status.usage.output, 30);
  assert.equal(completed.status.usage.reasoning, 6);
  assert.equal(completed.result, "done\n");

  const incomplete = await captureWorker([
    assistantEntry("partial answer", "length", 1),
  ]);
  assert.equal(incomplete.shutdownRequested, true);
  assert.equal(incomplete.status.state, "failed");
  assert.match(incomplete.status.errorMessage, /stopped with length/);
  assert.equal(incomplete.result, "partial answer\n");
});

test("worker capture reports and exits when an interactive prompt never starts", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-startup-timeout-"));
  const prior = process.env[WORKER_JOB_ENV];
  const originalSetTimeout = globalThis.setTimeout;
  const handlers = new Map();
  const jobId = "11111111-2222-4333-8444-555555555555";
  const launchNonce = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let timeoutCallback;
  try {
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      launchNonce,
    }));
    process.env[WORKER_JOB_ENV] = jobDir;
    globalThis.setTimeout = (callback, delay, ...args) => {
      assert.equal(delay, 60_000);
      timeoutCallback = () => callback(...args);
      return 1;
    };
    supacodeSubagents({
      on: (event, handler) => handlers.set(event, handler),
    });
    let shutdownRequested = false;
    await handlers.get("session_start")({}, {
      shutdown: () => { shutdownRequested = true; },
    });
    globalThis.setTimeout = originalSetTimeout;
    assert.equal(typeof timeoutCallback, "function");
    await timeoutCallback();

    const report = await readWorkerReport(jobDir, jobId, launchNonce);
    assert.ok(report);
    assert.equal(report.status.state, "failed");
    assert.equal(report.status.stopReason, "startup_timeout");
    assert.match(await readWorkerReportOutput(report), /did not start an agent run within 60 seconds/);
    assert.equal(shutdownRequested, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (prior === undefined) delete process.env[WORKER_JOB_ENV];
    else process.env[WORKER_JOB_ENV] = prior;
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("worker startup watchdog is invalidated by session shutdown", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-startup-shutdown-"));
  const prior = process.env[WORKER_JOB_ENV];
  const originalSetTimeout = globalThis.setTimeout;
  const handlers = new Map();
  const jobId = "11111111-2222-4333-8444-555555555555";
  const launchNonce = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let timeoutCallback;
  try {
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      launchNonce,
    }));
    process.env[WORKER_JOB_ENV] = jobDir;
    globalThis.setTimeout = (callback, delay, ...args) => {
      assert.equal(delay, 60_000);
      timeoutCallback = () => callback(...args);
      return 1;
    };
    supacodeSubagents({
      on: (event, handler) => handlers.set(event, handler),
    });
    let shutdownRequested = false;
    await handlers.get("session_start")({}, {
      shutdown: () => { shutdownRequested = true; },
    });
    globalThis.setTimeout = originalSetTimeout;
    const timeoutWork = timeoutCallback();
    await handlers.get("session_shutdown")();
    await timeoutWork;

    assert.equal(await readWorkerReport(jobDir, jobId, launchNonce), undefined);
    assert.equal(shutdownRequested, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (prior === undefined) delete process.env[WORKER_JOB_ENV];
    else process.env[WORKER_JOB_ENV] = prior;
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("worker settled capture is invalidated by session shutdown", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-settled-shutdown-"));
  const prior = process.env[WORKER_JOB_ENV];
  const handlers = new Map();
  const jobId = "11111111-2222-4333-8444-555555555555";
  const launchNonce = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      launchNonce,
    }));
    process.env[WORKER_JOB_ENV] = jobDir;
    supacodeSubagents({
      on: (event, handler) => handlers.set(event, handler),
    });
    let shutdownRequested = false;
    const context = {
      sessionManager: { getEntries: () => [assistantEntry("stale", "stop", 1)] },
      shutdown: () => { shutdownRequested = true; },
    };
    await handlers.get("session_start")({}, context);
    await handlers.get("agent_start")();
    const settlement = handlers.get("agent_settled")({}, context);
    await handlers.get("session_shutdown")();
    await settlement;

    assert.equal(await readWorkerReport(jobDir, jobId, launchNonce), undefined);
    assert.equal(shutdownRequested, false);
  } finally {
    if (prior === undefined) delete process.env[WORKER_JOB_ENV];
    else process.env[WORKER_JOB_ENV] = prior;
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("session shutdown waits for an already-started worker report publication", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-report-shutdown-"));
  const prior = process.env[WORKER_JOB_ENV];
  const handlers = new Map();
  const jobId = "11111111-2222-4333-8444-555555555555";
  const launchNonce = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let releasePublication;
  let markPublicationStarted;
  const publicationStarted = new Promise((resolve) => { markPublicationStarted = resolve; });
  try {
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      launchNonce,
    }));
    process.env[WORKER_JOB_ENV] = jobDir;
    supacodeSubagents({
      on: (event, handler) => handlers.set(event, handler),
      __supacodePublishWorkerReportForTests: async (...args) => {
        markPublicationStarted();
        await new Promise((resolve) => { releasePublication = resolve; });
        return publishWorkerReport(...args);
      },
    });
    let shutdownRequested = false;
    const context = {
      sessionManager: { getEntries: () => [assistantEntry("committed", "stop", 1)] },
      shutdown: () => { shutdownRequested = true; },
    };
    await handlers.get("session_start")({}, context);
    await handlers.get("agent_start")();
    const settlement = handlers.get("agent_settled")({}, context);
    await publicationStarted;
    let sessionShutdownCompleted = false;
    const sessionShutdown = handlers.get("session_shutdown")().then(() => {
      sessionShutdownCompleted = true;
    });
    await Promise.resolve();
    assert.equal(sessionShutdownCompleted, false);
    releasePublication();
    await Promise.all([settlement, sessionShutdown]);

    const report = await readWorkerReport(jobDir, jobId, launchNonce);
    assert.ok(report);
    assert.equal(await readWorkerReportOutput(report), "committed\n");
    assert.equal(shutdownRequested, false);
  } finally {
    if (prior === undefined) delete process.env[WORKER_JOB_ENV];
    else process.env[WORKER_JOB_ENV] = prior;
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("worker capture requests interactive shutdown when cancellation already won", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-worker-cancel-shutdown-"));
  const prior = process.env[WORKER_JOB_ENV];
  const handlers = new Map();
  const jobId = "11111111-2222-4333-8444-555555555555";
  const launchNonce = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    await writeFile(join(jobDir, "job.json"), JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      launchNonce,
    }));
    await claimJobDecision(jobDir, jobId, "cancel");
    process.env[WORKER_JOB_ENV] = jobDir;
    supacodeSubagents({
      on: (event, handler) => handlers.set(event, handler),
    });
    await handlers.get("agent_start")();
    let shutdownRequested = false;
    await handlers.get("agent_settled")({}, {
      sessionManager: { getEntries: () => [assistantEntry("ignored", "stop", 1)] },
      shutdown: () => { shutdownRequested = true; },
    });
    assert.equal(shutdownRequested, true);
    assert.equal(await readWorkerReport(jobDir, jobId, launchNonce), undefined);
  } finally {
    if (prior === undefined) delete process.env[WORKER_JOB_ENV];
    else process.env[WORKER_JOB_ENV] = prior;
    await rm(jobDir, { recursive: true, force: true });
  }
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
        assert.equal(latest.job.projectTrusted, false);
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
    assert.match(delegated.details.results[0].id, /^[a-f0-9-]{36}$/);
    assert.equal(typeof delegated.details.results[0].jobDir, "string");
    assert.equal(
      JSON.parse(await readFile(join(delegated.details.results[0].jobDir, "job.json"), "utf8")).id,
      delegated.details.results[0].id,
    );
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

test("pre-surface cancellation records durable non-launch settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pre-surface-cancel-"));
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
    let tabClosed = false;
    const { tools } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "repo" && args[1] === "list") {
        return { stdout: `${encodeURIComponent(canonicalRepository)}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "new") {
        const batches = await readdir(join(agentDir, "subagents"));
        const batchDir = join(agentDir, "subagents", batches[0]);
        const workerEntry = (await readdir(batchDir, { withFileTypes: true }))
          .find((entry) => entry.isDirectory() && entry.name !== "tab-launches");
        const jobDir = join(batchDir, workerEntry.name);
        const job = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
        await claimJobDecision(jobDir, job.id, "cancel");
        await writeJobControl(jobDir, job.id, "cancel before surface creation");
        return { stdout: `${args[args.indexOf("-n") + 1]}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "split") {
        surfaceLaunched = true;
        return { stdout: "", stderr: "", code: 1, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        return { stdout: "", stderr: "", code: 0, killed: false };
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

    const delegated = await tools.get("delegate").execute(
      "call",
      { task: "pre-surface cancellation", keepOpen: false },
      undefined,
      undefined,
      baseContext(repository, async () => true),
    );
    assert.equal(delegated.details.results[0].state, "failed");
    assert.equal(surfaceLaunched, false);
    const batches = await readdir(join(agentDir, "subagents"));
    const batchDir = join(agentDir, "subagents", batches[0]);
    const workerEntry = (await readdir(batchDir, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== "tab-launches");
    const jobDir = join(batchDir, workerEntry.name);
    const completion = JSON.parse(await readFile(join(jobDir, "surface-launch", "creation-complete.json"), "utf8"));
    assert.equal(completion.commandStarted, false);
    assert.notEqual((await readJobLifecycle(jobDir)).phase, "recovery_required");
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorWorktreeId === undefined) delete process.env.SUPACODE_WORKTREE_ID;
    else process.env.SUPACODE_WORKTREE_ID = priorWorktreeId;
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancellation racing surface creation wins the launch claim and removes the surface", async () => {
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
        const workerEntry = (await readdir(batchDir, { withFileTypes: true }))
          .find((entry) => entry.isDirectory() && entry.name !== "tab-launches");
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

    const delegated = await tools.get("delegate").execute(
      "call",
      { task: "prelaunch cancellation", keepOpen: false },
      undefined,
      undefined,
      baseContext(repository, async () => true),
    );
    assert.equal(delegated.details.results[0].state, "failed");
    assert.equal(surfaceLaunched, true);
    assert.equal(surfaceClosed, true);
    assert.equal(tabClosed, true);
    const jobs = await readdir(join(agentDir, "subagents"));
    const batchDir = join(agentDir, "subagents", jobs[0]);
    const workerEntry = (await readdir(batchDir, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== "tab-launches");
    const workerJobDir = join(batchDir, workerEntry.name);
    assert.notEqual((await readJobLifecycle(workerJobDir)).phase, "recovery_required");
    const launchClaim = JSON.parse(await readFile(join(workerJobDir, "worker-launch-claim.json"), "utf8"));
    assert.equal(launchClaim.owner, "recovery");
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorWorktreeId === undefined) delete process.env.SUPACODE_WORKTREE_ID;
    else process.env.SUPACODE_WORKTREE_ID = priorWorktreeId;
    await rm(root, { recursive: true, force: true });
  }
});

test("failed tab creation propagates recovery when tab cleanup cannot be verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tab-launch-recovery-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorWorktreeId = process.env.SUPACODE_WORKTREE_ID;
  try {
    await checked("git", ["init", repository]);
    const worktreeId = encodeURIComponent(await realpath(repository));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.SUPACODE_WORKTREE_ID = worktreeId;
    let retainedTabId;
    const { tools } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "repo" && args[1] === "list") {
        return { stdout: `${worktreeId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "new") {
        retainedTabId = args[args.indexOf("-n") + 1];
        return { stdout: "", stderr: "simulated tab creation timeout", code: 1, killed: false };
      }
      if (args[0] === "tab" && args[1] === "close") {
        return { stdout: "", stderr: "simulated tab close failure", code: 1, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: `${retainedTabId}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `unexpected command: ${args.join(" ")}`, code: 1, killed: false };
    });

    await assert.rejects(
      tools.get("delegate").execute(
        "call",
        { task: "tab launch recovery", keepOpen: true },
        undefined,
        undefined,
        baseContext(repository, async () => true),
      ),
      /Cleanup requires recovery/,
    );

    const batches = await readdir(join(agentDir, "subagents"));
    const batchDir = join(agentDir, "subagents", batches[0]);
    assert.equal(JSON.parse(await readFile(join(batchDir, "batch.json"), "utf8")).phase, "recovery_required");
    const workerEntry = (await readdir(batchDir, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== "tab-launches");
    assert.ok(workerEntry);
    assert.equal((await readJobLifecycle(join(batchDir, workerEntry.name))).phase, "recovery_required");
    assert.equal(await readWorkerTerminal(join(batchDir, workerEntry.name)), undefined);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorWorktreeId === undefined) delete process.env.SUPACODE_WORKTREE_ID;
    else process.env.SUPACODE_WORKTREE_ID = priorWorktreeId;
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel launch abort verifies earlier worker termination before closing the batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-parallel-launch-abort-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorWorktreeId = process.env.SUPACODE_WORKTREE_ID;
  const controller = new AbortController();
  try {
    await checked("git", ["init", repository]);
    const canonicalRepository = await realpath(repository);
    const worktreeId = encodeURIComponent(canonicalRepository);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.SUPACODE_WORKTREE_ID = worktreeId;
    const tabs = new Map();
    const closedSurfaces = [];
    let splitCount = 0;
    const { tools } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "repo" && args[1] === "list") {
        return { stdout: `${worktreeId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "new") {
        const tabId = args[args.indexOf("-n") + 1];
        tabs.set(tabId, new Set([tabId]));
        return { stdout: `${tabId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "split") {
        splitCount++;
        const tabId = args[args.indexOf("-t") + 1];
        const surfaceId = args[args.indexOf("-n") + 1];
        const runnerInput = args[args.indexOf("-i") + 1];
        const runnerPath = await checked("/bin/zsh", ["-c", `set -- ${runnerInput}; print -r -- "$2"`]);
        const jobDir = join(runnerPath, "..");
        const job = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
        assert.equal(job.projectTrusted, false);
        assert.match(await readFile(runnerPath, "utf8"), /'--no-approve'/);
        const missingIdentity = {
          pid: 999_999_999,
          startSignature: "missing",
          processGroup: 999_999_999,
          command: "missing",
          launchNonce: job.launchNonce,
        };
        await writeRunnerProcess(jobDir, {
          schemaVersion: 2,
          jobId: job.id,
          launchNonce: job.launchNonce,
          wrapper: missingIdentity,
          startedAt: new Date().toISOString(),
        });
        await writeFile(join(jobDir, "status.json"), JSON.stringify({
          state: "running",
          pid: missingIdentity.pid,
          processIdentity: missingIdentity,
          launchNonce: job.launchNonce,
        }));
        if (splitCount === 2) {
          controller.abort();
          return { stdout: "", stderr: "simulated second launch abort", code: 1, killed: false };
        }
        tabs.get(tabId)?.add(surfaceId);
        return { stdout: `${surfaceId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "close") {
        const tabId = args[args.indexOf("-t") + 1];
        const surfaceId = args[args.indexOf("-s") + 1];
        closedSurfaces.push(surfaceId);
        tabs.get(tabId)?.delete(surfaceId);
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        const tabId = args[args.indexOf("-t") + 1];
        return { stdout: `${[...(tabs.get(tabId) ?? [])].join("\n")}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "close") {
        tabs.delete(args[args.indexOf("-t") + 1]);
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: `${[...tabs.keys()].join("\n")}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `unexpected command: ${args.join(" ")}`, code: 1, killed: false };
    });

    await assert.rejects(
      tools.get("delegate_parallel").execute(
        "call",
        {
          tasks: [
            { task: "first worker", title: "first worker" },
            { task: "second worker", title: "second worker" },
            { task: "third worker", title: "third worker" },
          ],
          timeoutSeconds: 30,
          keepOpen: true,
        },
        controller.signal,
        undefined,
        baseContext(repository, async () => true, false),
      ),
      /aborted|simulated second launch abort/,
    );

    assert.equal(tabs.size, 0);
    const batches = await readdir(join(agentDir, "subagents"));
    const batchDir = join(agentDir, "subagents", batches[0]);
    const jobEntries = (await readdir(batchDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "tab-launches");
    let firstEntry;
    let thirdEntry;
    for (const entry of jobEntries) {
      const job = JSON.parse(await readFile(join(batchDir, entry.name, "job.json"), "utf8"));
      if (job.title === "first worker") firstEntry = entry;
      if (job.title === "third worker") thirdEntry = entry;
    }
    assert.ok(firstEntry);
    assert.ok(thirdEntry);
    const firstJobDir = join(batchDir, firstEntry.name);
    const firstJob = JSON.parse(await readFile(join(firstJobDir, "job.json"), "utf8"));
    assert.equal(closedSurfaces.includes(firstJob.surfaceId), true);
    assert.equal((await readWorkerTerminal(firstJobDir)).owner, "abort");
    assert.equal((await readJobLifecycle(firstJobDir)).phase, "cancelled");
    assert.equal(JSON.parse(await readFile(join(firstJobDir, "termination.json"), "utf8")).verified, true);
    assert.equal((await readJobLifecycle(join(batchDir, thirdEntry.name))).phase, "recovery_required");
    assert.equal(await readWorkerTerminal(join(batchDir, thirdEntry.name)), undefined);
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

    assert.equal(surfaceClosed, false);
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

test("accepted delegate-loop recovery reconstructs canonical metadata from durable intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-loop-acceptance-recovery-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const attemptDir = join(jobDir, "attempts", "001");
  const iterationDir = join(jobDir, "iterations", "001");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await checked("git", ["init", repository]);
    await checked("git", ["-C", repository, "config", "user.name", "Test User"]);
    await checked("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await writeFile(join(repository, "tracked.txt"), "accepted\n");
    await checked("git", ["-C", repository, "add", "."]);
    await checked("git", ["-C", repository, "commit", "-m", "accepted"]);
    const head = await checked("git", ["-C", repository, "rev-parse", "HEAD"]);
    const tree = await checked("git", ["-C", repository, "rev-parse", "HEAD^{tree}"]);
    const branch = await checked("git", ["-C", repository, "symbolic-ref", "--short", "HEAD"]);
    const candidateRef = `refs/pi-agent-candidates/${jobId}/001`;
    await checked("git", ["-C", repository, "update-ref", candidateRef, head]);
    await mkdir(attemptDir, { recursive: true });
    await mkdir(iterationDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const launchNonce = "accepted-attempt-nonce";
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: accepted recovery",
      title: "accepted recovery",
      mode: "research",
      originalCwd: repository,
      workerCwd: repository,
      worktreePath: repository,
      branch,
      baseSha: head,
      delegateLoop: true,
      activeWorkerJobDir: attemptDir,
      launchNonce,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "recovery_required");
    const missingIdentity = {
      pid: 999_999_999,
      startSignature: "missing",
      processGroup: 999_999_999,
      command: "missing",
      launchNonce,
    };
    await writeRunnerProcess(attemptDir, {
      schemaVersion: 2,
      jobId,
      launchNonce,
      wrapper: missingIdentity,
      startedAt: new Date().toISOString(),
    });
    await writeRunnerExit(attemptDir, {
      schemaVersion: 2,
      jobId,
      launchNonce,
      wrapperPid: missingIdentity.pid,
      exitCode: 0,
      exitedAt: new Date().toISOString(),
    });
    await claimWorkerTerminal(attemptDir, jobId, "worker", {
      state: "completed",
      stopReason: "stop",
      launchNonce,
      processIdentity: missingIdentity,
    }, "implementation completed");
    const patchPath = join(iterationDir, "candidate.patch");
    await writeFile(patchPath, "");
    await writeFile(join(jobDir, "acceptance.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId,
      createdAt: new Date().toISOString(),
      candidate: {
        attempt: 1,
        tree,
        commit: head,
        ref: candidateRef,
        head,
        branch,
        patchPath,
        patchSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        patchBytes: 0,
        patchPreview: "",
        patchPreviewTruncated: false,
        changedPaths: ["tracked.txt"],
        gitlinkPaths: [],
      },
    }, null, 2)}\n`);
    const { commands } = registerExtension();
    await commands.get("delegate-recover").handler(jobId, {
      hasUI: true,
      waitForIdle: async () => {},
      ui: { confirm: async () => true, notify() {}, setStatus() {} },
    });

    assert.equal((await readJobLifecycle(jobDir)).phase, "completed");
    const recoveredJob = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
    assert.equal(recoveredJob.loopState, "awaiting_apply");
    assert.equal(recoveredJob.acceptedTree, tree);
    assert.equal(recoveredJob.acceptedCommit, head);
    assert.equal(recoveredJob.acceptedRef, candidateRef);
    assert.equal((await readJobDecision(jobDir)).owner, "accept");
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("delegate-loop recovery never promotes an implementation terminal over retained evaluators", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-loop-evaluator-recovery-"));
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const attemptDir = join(jobDir, "attempts", "001");
  const evaluatorDir = join(jobDir, "iterations", "001", "checks", "01");
  const checkoutPath = join(evaluatorDir, "checkout");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(attemptDir, { recursive: true });
    await mkdir(evaluatorDir, { recursive: true });
    const launchNonce = "loop-attempt-nonce";
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: loop recovery",
      title: "loop recovery",
      mode: "research",
      originalCwd: root,
      workerCwd: root,
      worktreePath: root,
      delegateLoop: true,
      loopState: "failed",
      activeWorkerJobDir: attemptDir,
      launchNonce,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "recovery_required");
    await writeFile(join(jobDir, "status.json"), JSON.stringify({
      state: "failed",
      stopReason: "recovery_required",
      errorMessage: "evaluator retained",
    }));
    const missingIdentity = {
      pid: 999_999_999,
      startSignature: "missing",
      processGroup: 999_999_999,
      command: "missing",
      launchNonce,
    };
    await writeRunnerProcess(attemptDir, {
      schemaVersion: 2,
      jobId,
      launchNonce,
      wrapper: missingIdentity,
      startedAt: new Date().toISOString(),
    });
    await writeRunnerExit(attemptDir, {
      schemaVersion: 2,
      jobId,
      launchNonce,
      wrapperPid: missingIdentity.pid,
      exitCode: 0,
      exitedAt: new Date().toISOString(),
    });
    await claimWorkerTerminal(attemptDir, jobId, "worker", {
      state: "completed",
      stopReason: "stop",
      launchNonce,
      processIdentity: missingIdentity,
    }, "implementation completed");
    await writeFile(join(evaluatorDir, "checkout-lifecycle.json"), `${JSON.stringify({
      schemaVersion: 1,
      phase: "evaluating",
      checkoutPath,
    }, null, 2)}\n`);
    const { commands } = registerExtension();
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

    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");

    const validationJobId = `${jobId}-check-1-1`;
    const validationNonce = "validation-gate-nonce";
    await writeFile(join(evaluatorDir, "validation-gate.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: validationJobId,
      launchNonce: validationNonce,
      launcher: {
        pid: 999_999_999,
        startSignature: "missing",
        processGroup: 999_999_999,
        command: "missing",
        launchNonce: validationNonce,
      },
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await writeFile(join(evaluatorDir, "checkout-lifecycle.json"), `${JSON.stringify({
      schemaVersion: 1,
      phase: "evaluating",
      checkoutPath,
      processJobId: validationJobId,
      processJobDir: evaluatorDir,
      processLaunchNonce: validationNonce,
    }, null, 2)}\n`);
    await commands.get("delegate-recover").handler(jobId, context);
    const finalLifecycle = await readJobLifecycle(jobDir);
    assert.equal(finalLifecycle.phase, "failed", JSON.stringify({ finalLifecycle, notifications }));
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation authenticates reviewer bindings before publishing the parent decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-reviewer-binding-cancel-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "abcdefab-cdef-4abc-8abc-defabcdefabc";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(repository, { recursive: true });
    await mkdir(jobDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      title: "binding parent",
      mode: "research",
      createdAt: new Date().toISOString(),
    })}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "running", {
      activeReviewerJobs: [{
        jobId: jobId.toUpperCase(),
        jobDir,
        launchNonce: "self-binding",
        checkoutPath: repository,
      }],
    });
    const { commands } = registerExtension();
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

    assert.equal(await readJobDecision(jobDir), undefined);
    await assert.rejects(readFile(join(jobDir, "control.json")));
    assert.equal(
      notifications.some((notification) => notification.message.includes("refers to its parent job")),
      true,
    );
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation recovery clears pre-tab reviewer bindings with and without child lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-pretab-reviewer-recovery-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const reviewerBindings = [
    {
      batchId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      jobId: "22222222-3333-4444-8555-666666666666",
      nonce: "reviewer-one-nonce",
      lifecycle: true,
      batchPhase: "planned",
    },
    {
      batchId: "cccccccc-dddd-4eee-8fff-000000000000",
      jobId: "33333333-4444-4555-8666-777777777777",
      nonce: "reviewer-two-nonce",
      lifecycle: false,
      batchPhase: "running",
      tabId: "55555555-6666-4777-8888-999999999999",
    },
    {
      batchId: "dddddddd-eeee-4fff-8aaa-111111111111",
      jobId: "44444444-5555-4666-8777-888888888888",
      nonce: "reviewer-three-nonce",
      lifecycle: true,
      batchPhase: "running",
      tabId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      surfaceId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
    },
  ];
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await checked("git", ["init", repository]);
    await checked("git", ["-C", repository, "config", "user.name", "Test User"]);
    await checked("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await writeFile(join(repository, "tracked.txt"), "base\n");
    await checked("git", ["-C", repository, "add", "."]);
    await checked("git", ["-C", repository, "commit", "-m", "base"]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: pretab recovery",
      title: "pretab recovery",
      mode: "research",
      originalCwd: repository,
      workerCwd: repository,
      worktreePath: repository,
      delegateLoop: true,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "completed");
    const activeReviewerJobs = [];
    const evaluatorCheckouts = [];
    for (const [index, reviewer] of reviewerBindings.entries()) {
      const reviewerDir = join(agentDir, "subagents", reviewer.batchId, reviewer.jobId);
      await mkdir(reviewerDir, { recursive: true });
      const tabLaunchDir = join(reviewerDir, "..", "tab-launches", reviewer.tabId ?? "planned");
      const tabLaunchJobId = `${reviewer.batchId}-tab-launch`;
      const tabLaunchNonce = `${reviewer.nonce}-tab`;
      if (reviewer.tabId) {
        await mkdir(tabLaunchDir, { recursive: true });
        await writeFile(join(tabLaunchDir, "validation-gate.json"), `${JSON.stringify({
          schemaVersion: 2,
          jobId: tabLaunchJobId,
          launchNonce: tabLaunchNonce,
          launcher: {
            pid: 999_999_999,
            startSignature: "missing",
            processGroup: 999_999_999,
            command: "missing",
            launchNonce: tabLaunchNonce,
          },
          createdAt: new Date().toISOString(),
        }, null, 2)}\n`);
      }
      await writeFile(join(reviewerDir, "..", "batch.json"), `${JSON.stringify({
        schemaVersion: 2,
        id: reviewer.batchId,
        title: "planned reviewers",
        worktreeId: encodeURIComponent(repository),
        phase: reviewer.batchPhase,
        ...(reviewer.tabId ? {
          tabId: reviewer.tabId,
          anchorSurfaceId: reviewer.tabId,
          tabLaunchDir,
          tabLaunchJobId,
          tabLaunchNonce,
        } : {}),
      }, null, 2)}\n`);
      const surfaceLaunchDir = join(reviewerDir, "surface-launch");
      const surfaceLaunchJobId = `${reviewer.jobId}-surface-launch`;
      const surfaceLaunchNonce = `${reviewer.nonce}-surface`;
      if (reviewer.surfaceId) {
        await mkdir(surfaceLaunchDir, { recursive: true });
        await writeFile(join(surfaceLaunchDir, "validation-gate.json"), `${JSON.stringify({
          schemaVersion: 2,
          jobId: surfaceLaunchJobId,
          launchNonce: surfaceLaunchNonce,
          launcher: {
            pid: 999_999_999,
            startSignature: "missing",
            processGroup: 999_999_999,
            command: "missing",
            launchNonce: surfaceLaunchNonce,
          },
          createdAt: new Date().toISOString(),
        }, null, 2)}\n`);
      }
      await writeFile(join(reviewerDir, "job.json"), `${JSON.stringify({
        schemaVersion: 2,
        id: reviewer.jobId,
        batchId: reviewer.batchId,
        batchTitle: "planned reviewers",
        title: "planned reviewer",
        mode: "research",
        originalCwd: repository,
        workerCwd: repository,
        launchNonce: reviewer.nonce,
        tabWorktreeId: encodeURIComponent(repository),
        ...(reviewer.tabId && reviewer.surfaceId ? {
          tabId: reviewer.tabId,
          surfaceId: reviewer.surfaceId,
          surfaceLaunchState: "requested",
          surfaceLaunchDir,
          surfaceLaunchJobId,
          surfaceLaunchNonce,
          launcherProcessIdentity: {
            pid: 999_999_999,
            startSignature: "missing",
            processGroup: 999_999_999,
            command: "missing",
            launchNonce: reviewer.nonce,
          },
        } : {}),
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`);
      if (reviewer.lifecycle) {
        await initializeJobLifecycle(reviewerDir, reviewer.jobId, reviewer.batchId, "planned");
      }
      const evaluatorDir = join(jobDir, "iterations", String(index + 1).padStart(3, "0"), "reviews", "01");
      const checkoutPath = join(evaluatorDir, "checkout");
      await mkdir(evaluatorDir, { recursive: true });
      await checked("git", ["-C", repository, "worktree", "add", "--detach", checkoutPath, "HEAD"]);
      await writeFile(join(evaluatorDir, "checkout-lifecycle.json"), `${JSON.stringify({
        schemaVersion: 1,
        phase: "evaluating",
        checkoutPath,
        processJobId: reviewer.jobId,
        processJobDir: reviewerDir,
        processLaunchNonce: reviewer.nonce,
      }, null, 2)}\n`);
      evaluatorCheckouts.push(checkoutPath);
      activeReviewerJobs.push({
        jobId: reviewer.jobId,
        jobDir: reviewerDir,
        launchNonce: reviewer.nonce,
        checkoutPath,
      });
    }
    await updateJobLifecycle(jobDir, "completed", undefined, { activeReviewerJobs });
    await claimJobDecision(jobDir, jobId, "cancel");
    const closedTabs = new Set();
    const launchedTabs = new Set(reviewerBindings.flatMap((reviewer) => reviewer.tabId ? [reviewer.tabId] : []));
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "surface" && args[1] === "list") {
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "close") {
        closedTabs.add(args[args.indexOf("-t") + 1]);
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return {
          stdout: `${[...launchedTabs].filter((tabId) => !closedTabs.has(tabId)).join("\n")}\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "", stderr: `unexpected Supacode command: ${args.join(" ")}`, code: 1, killed: false };
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

    const lifecycle = await readJobLifecycle(jobDir);
    assert.equal(lifecycle.phase, "cancelled", JSON.stringify({ lifecycle, notifications }));
    assert.equal(lifecycle.details.activeReviewerJobs, undefined);
    assert.deepEqual(closedTabs, launchedTabs);
    const resolvedReviewerDir = activeReviewerJobs[0].jobDir;
    assert.equal((await readJobLifecycle(resolvedReviewerDir)).phase, "cancelled");
    for (const checkoutPath of evaluatorCheckouts) {
      await assert.rejects(lstat(checkoutPath), { code: "ENOENT" });
    }
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
  const reviewerBatchId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const reviewerJobId = "22222222-3333-4444-8555-666666666666";
  const reviewerTabId = "33333333-4444-4555-8666-777777777777";
  const reviewerSurfaceId = "44444444-5555-4666-8777-888888888888";
  const reviewerDir = join(agentDir, "subagents", reviewerBatchId, reviewerJobId);
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
      codeWorktreeId: encodeURIComponent(repository),
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
    await writeFile(join(reviewerDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: reviewerJobId,
      batchId: reviewerBatchId,
      batchTitle: "agents: retained reviewers",
      title: "retained reviewer",
      mode: "research",
      originalCwd: repository,
      workerCwd: repository,
      launchNonce: "reviewer-nonce",
      tabWorktreeId: encodeURIComponent(repository),
      tabId: reviewerTabId,
      surfaceId: reviewerSurfaceId,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await writeFile(join(reviewerDir, "..", "batch.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: reviewerBatchId,
      title: "agents: retained reviewers",
      worktreeId: encodeURIComponent(repository),
      tabId: reviewerTabId,
      phase: "recovery_required",
    }, null, 2)}\n`);
    await writeRunnerProcess(reviewerDir, {
      schemaVersion: 2,
      jobId: reviewerJobId,
      launchNonce: "reviewer-nonce",
      wrapper: reviewerIdentity,
      startedAt: new Date().toISOString(),
    });
    await writeFile(join(reviewDir, "checkout-lifecycle.json"), `${JSON.stringify({
      schemaVersion: 1,
      phase: "evaluating",
      checkoutPath: checkout,
      processJobId: reviewerJobId,
      processJobDir: reviewerDir,
      processLaunchNonce: "reviewer-nonce",
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await updateJobLifecycle(jobDir, "completed", undefined, {
      activeReviewerJobs: [{
        jobId: reviewerJobId,
        jobDir: reviewerDir,
        launchNonce: "reviewer-nonce",
        checkoutPath: checkout,
      }],
    });
    await claimJobDecision(jobDir, jobId, "cancel");

    let surfaceClosed = false;
    let tabClosed = false;
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "surface" && args[1] === "close") {
        surfaceClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        return { stdout: surfaceClosed ? "" : `${reviewerSurfaceId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "close") {
        tabClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: tabClosed ? "" : `${reviewerTabId}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `unexpected command: ${args.join(" ")}`, code: 1, killed: false };
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

    const postRecoveryLifecycle = await readJobLifecycle(jobDir);
    await assert.rejects(
      lstat(checkout),
      { code: "ENOENT" },
      JSON.stringify({ lifecycle: postRecoveryLifecycle, notifications }),
    );
    assert.equal(
      JSON.parse(await readFile(join(reviewDir, "checkout-lifecycle.json"), "utf8")).phase,
      "removed",
    );
    assert.throws(() => process.kill(reviewerProcess.pid, 0), { code: "ESRCH" });
    assert.equal(surfaceClosed, true);
    assert.equal(tabClosed, true);
    const recoveredLifecycle = await readJobLifecycle(jobDir);
    assert.equal(recoveredLifecycle.phase, "cancelled");
    assert.equal(recoveredLifecycle.details.activeReviewerJobs, undefined);
  } finally {
    if (reviewerProcess?.pid) {
      try { process.kill(-reviewerProcess.pid, "SIGKILL"); } catch {}
    }
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery claims and removes an ordinary surface whose runner never published metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-prelaunch-surface-recovery-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-2222-4333-8444-555555555555";
  const tabId = "22222222-3333-4444-8555-666666666666";
  const surfaceId = "33333333-4444-4555-8666-777777777777";
  const jobDir = join(agentDir, "subagents", batchId, jobId);
  const tabLaunchDir = join(agentDir, "subagents", batchId, "tab-launches", tabId);
  const surfaceLaunchDir = join(jobDir, "surface-launch");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await checked("git", ["init", repository]);
    await mkdir(tabLaunchDir, { recursive: true });
    await mkdir(surfaceLaunchDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const worktreeId = encodeURIComponent(await realpath(repository));
    const tabLaunchJobId = `${batchId}-tab-launch`;
    const tabLaunchNonce = "tab-launch-nonce";
    const surfaceLaunchJobId = `${jobId}-surface-launch`;
    const surfaceLaunchNonce = "surface-launch-nonce";
    await writeFile(join(tabLaunchDir, "creation-complete.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: tabLaunchJobId,
      launchNonce: tabLaunchNonce,
      commandStarted: true,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    })}\n`);
    await writeFile(join(surfaceLaunchDir, "creation-complete.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: surfaceLaunchJobId,
      launchNonce: surfaceLaunchNonce,
      commandStarted: true,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    })}\n`);
    await writeFile(join(jobDir, "..", "batch.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: batchId,
      title: "agents: prelaunch recovery",
      worktreeId,
      tabId,
      phase: "running",
      anchorSurfaceId: tabId,
      tabLaunchDir,
      tabLaunchJobId,
      tabLaunchNonce,
    })}\n`);
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: prelaunch recovery",
      title: "prelaunch recovery",
      mode: "research",
      originalCwd: repository,
      workerCwd: repository,
      launchNonce: "worker-launch-nonce",
      workerLaunchClaimVersion: 1,
      surfaceCreationProtocolVersion: 1,
      tabWorktreeId: worktreeId,
      tabId,
      surfaceId,
      surfaceLaunchDir,
      surfaceLaunchJobId,
      surfaceLaunchNonce,
      createdAt: new Date().toISOString(),
    })}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "launching", {
      tabWorktreeId: worktreeId,
      tabId,
      surfaceId,
      launchNonce: "worker-launch-nonce",
    });

    let surfaceClosed = false;
    let tabClosed = false;
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "surface" && args[1] === "close") {
        surfaceClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        return { stdout: surfaceClosed ? "" : `${surfaceId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "close") {
        tabClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: tabClosed ? "" : `${tabId}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `unexpected command: ${args.join(" ")}`, code: 1, killed: false };
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

    assert.equal(surfaceClosed, true, JSON.stringify(notifications));
    assert.equal(tabClosed, true);
    assert.equal(JSON.parse(await readFile(join(jobDir, "worker-launch-claim.json"), "utf8")).owner, "recovery");
    assert.equal((await readJobLifecycle(jobDir)).phase, "failed");
    assert.equal((await readWorkerTerminal(jobDir)).owner, "recovery");
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("recovering one terminal worker never closes a shared tab with a live sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shared-tab-recovery-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const selectedId = "11111111-2222-4333-8444-555555555555";
  const siblingId = "22222222-3333-4444-8555-666666666666";
  const tabId = "33333333-4444-4555-8666-777777777777";
  const selectedSurface = "44444444-5555-4666-8777-888888888888";
  const siblingSurface = "55555555-6666-4777-8888-999999999999";
  const selectedDir = join(agentDir, "subagents", batchId, selectedId);
  const siblingDir = join(agentDir, "subagents", batchId, siblingId);
  const tabLaunchDir = join(agentDir, "subagents", batchId, "tab-launches", tabId);
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await checked("git", ["init", repository]);
    await mkdir(tabLaunchDir, { recursive: true });
    await mkdir(selectedDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const worktreeId = encodeURIComponent(await realpath(repository));
    const tabLaunchJobId = `${batchId}-tab-launch`;
    const tabLaunchNonce = "tab-launch-nonce";
    await writeFile(join(tabLaunchDir, "creation-complete.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: tabLaunchJobId,
      launchNonce: tabLaunchNonce,
      commandStarted: true,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    })}\n`);
    await writeFile(join(selectedDir, "..", "batch.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: batchId,
      title: "agents: shared recovery",
      worktreeId,
      tabId,
      phase: "running",
      tabLaunchDir,
      tabLaunchJobId,
      tabLaunchNonce,
    })}\n`);
    for (const [id, jobDir, surfaceId, phase] of [
      [selectedId, selectedDir, selectedSurface, "completed"],
      [siblingId, siblingDir, siblingSurface, "running"],
    ]) {
      const surfaceLaunchDir = join(jobDir, "surface-launch");
      const surfaceLaunchJobId = `${id}-surface-launch`;
      const surfaceLaunchNonce = `${id}-surface-nonce`;
      await mkdir(surfaceLaunchDir, { recursive: true });
      await writeFile(join(surfaceLaunchDir, "creation-complete.json"), `${JSON.stringify({
        schemaVersion: 2,
        jobId: surfaceLaunchJobId,
        launchNonce: surfaceLaunchNonce,
        commandStarted: true,
        exitCode: 0,
        completedAt: new Date().toISOString(),
      })}\n`);
      await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
        schemaVersion: 2,
        id,
        batchId,
        batchTitle: "agents: shared recovery",
        title: id === selectedId ? "selected" : "sibling",
        mode: "research",
        originalCwd: repository,
        workerCwd: repository,
        launchNonce: `${id}-worker-nonce`,
        workerLaunchClaimVersion: 1,
        surfaceCreationProtocolVersion: 1,
        tabWorktreeId: worktreeId,
        tabId,
        surfaceId,
        surfaceLaunchDir,
        surfaceLaunchJobId,
        surfaceLaunchNonce,
        createdAt: new Date().toISOString(),
      })}\n`);
      await initializeJobLifecycle(jobDir, id, batchId, phase, { tabId, surfaceId });
    }
    await claimWorkerTerminal(selectedDir, selectedId, "recovery", {
      state: "failed",
      launchNonce: `${selectedId}-worker-nonce`,
      stopReason: "recovered",
    }, "recovered");

    const closedSurfaces = new Set();
    let tabClosed = false;
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "surface" && args[1] === "close") {
        closedSurfaces.add(args[args.indexOf("-s") + 1].toLowerCase());
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        const visible = [selectedSurface, siblingSurface]
          .filter((surface) => !closedSurfaces.has(surface.toLowerCase()));
        return { stdout: visible.length ? `${visible.join("\n")}\n` : "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "close") {
        tabClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: tabClosed ? "" : `${tabId}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `unexpected command: ${args.join(" ")}`, code: 1, killed: false };
    });
    const notifications = [];
    await commands.get("delegate-recover").handler(selectedId, {
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        confirm: async () => true,
        notify: (message, level) => notifications.push({ message, level }),
        setStatus() {},
      },
    });

    assert.equal(closedSurfaces.has(selectedSurface.toLowerCase()), true, JSON.stringify(notifications));
    assert.equal(closedSurfaces.has(siblingSurface.toLowerCase()), false);
    assert.equal(tabClosed, false);
    assert.equal((await readJobLifecycle(siblingDir)).phase, "running");
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("shared research workers recover a crash before the first surface without mutual blocking", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shared-pre-surface-recovery-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const batchId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const firstId = "11111111-2222-4333-8444-555555555555";
  const secondId = "22222222-3333-4444-8555-666666666666";
  const tabId = "33333333-4444-4555-8666-777777777777";
  const batchDir = join(agentDir, "subagents", batchId);
  const tabLaunchDir = join(batchDir, "tab-launches", tabId);
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await checked("git", ["init", repository]);
    await mkdir(tabLaunchDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const worktreeId = encodeURIComponent(await realpath(repository));
    const tabLaunchJobId = `${batchId}-tab-launch`;
    const tabLaunchNonce = "tab-launch-nonce";
    await writeFile(join(tabLaunchDir, "creation-complete.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: tabLaunchJobId,
      launchNonce: tabLaunchNonce,
      commandStarted: true,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    })}\n`);
    await writeFile(join(batchDir, "batch.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: batchId,
      title: "agents: shared pre-surface",
      worktreeId,
      tabId,
      phase: "running",
      anchorSurfaceId: tabId,
      tabLaunchDir,
      tabLaunchJobId,
      tabLaunchNonce,
    })}\n`);
    for (const id of [firstId, secondId]) {
      const jobDir = join(batchDir, id);
      await mkdir(jobDir, { recursive: true });
      await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
        schemaVersion: 2,
        id,
        batchId,
        batchTitle: "agents: shared pre-surface",
        title: id === firstId ? "first" : "second",
        mode: "research",
        originalCwd: repository,
        workerCwd: repository,
        launchNonce: `${id}-nonce`,
        createdAt: new Date().toISOString(),
      })}\n`);
      await initializeJobLifecycle(jobDir, id, batchId, "workspace_ready");
    }

    let tabClosed = false;
    const { commands } = registerExtension(async (command, args, options) => {
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "tab" && args[1] === "close") {
        tabClosed = true;
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: tabClosed ? "" : `${tabId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        return { stdout: `${tabId}\n`, stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `unexpected command: ${args.join(" ")}`, code: 1, killed: false };
    });
    const context = {
      hasUI: true,
      waitForIdle: async () => {},
      ui: { confirm: async () => true, notify() {}, setStatus() {} },
    };
    await commands.get("delegate-recover").handler(firstId, context);
    assert.equal(tabClosed, true);
    assert.equal((await readJobLifecycle(join(batchDir, firstId))).phase, "failed");
    assert.equal((await readJobLifecycle(join(batchDir, secondId))).phase, "workspace_ready");

    await commands.get("delegate-recover").handler(secondId, context);
    assert.equal((await readJobLifecycle(join(batchDir, secondId))).phase, "failed");
    assert.equal((await readWorkerTerminal(join(batchDir, secondId))).owner, "recovery");
  } finally {
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
  const worktreeLaunchDir = join(jobDir, "worktree-launch");
  const worktreeLaunchJobId = `${jobId}-worktree-launch`;
  const worktreeLaunchNonce = "worktree-launch-nonce";
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  let creator;
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
    creator = spawn("/bin/zsh", ["-lc", "sleep 30"], { detached: true, stdio: "ignore" });
    const creatorIdentity = await captureProcessIdentity(
      creator.pid,
      worktreeLaunchNonce,
      creator.pid,
    );
    assert.ok(creatorIdentity);
    await writeRunnerProcess(worktreeLaunchDir, {
      schemaVersion: 2,
      jobId: worktreeLaunchJobId,
      launchNonce: worktreeLaunchNonce,
      wrapper: creatorIdentity,
      startedAt: new Date().toISOString(),
    });
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify({
      schemaVersion: 2,
      id: jobId,
      batchId,
      batchTitle: "agents: recover",
      title: "recover provisioning",
      mode: "coding",
      originalCwd: repository,
      workerCwd: repository,
      observedCodeWorktreeId: encodeURIComponent(await realpath(repository)),
      observedWorktreePath: canonicalWorktree,
      workspacePlan,
      worktreeCreationProtocolVersion: 1,
      worktreeLaunchDir,
      worktreeLaunchJobId,
      worktreeLaunchNonce,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await initializeJobLifecycle(jobDir, jobId, batchId, "provisioning_worktree", {
      workspacePlan,
      worktreeCreationProtocolVersion: 1,
      worktreeLaunchDir,
      worktreeLaunchJobId,
      worktreeLaunchNonce,
    });
    let deleted = false;
    let deleteAttempts = 0;
    let worktreeListed = false;
    let interruptGitRemoval = true;
    const { commands } = registerExtension(async (command, args, options) => {
      if (
        command === "git" && interruptGitRemoval &&
        args.includes("worktree") && args.includes("remove")
      ) {
        interruptGitRemoval = false;
        await rm(canonicalWorktree, { recursive: true, force: true });
        return { stdout: "", stderr: "simulated crash after directory removal", code: 1, killed: false };
      }
      if (command !== "supacode") return execResult(command, args, options);
      if (args[0] === "worktree" && args[1] === "list") {
        return { stdout: worktreeListed ? `${encodeURIComponent(canonicalWorktree)}\n` : "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "worktree" && args[1] === "delete") {
        deleteAttempts++;
        if (deleteAttempts === 1) {
          return { stdout: "", stderr: "simulated Supacode deletion failure", code: 1, killed: false };
        }
        deleted = true;
        worktreeListed = false;
        return { stdout: "", stderr: "", code: 0, killed: false };
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
    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal(deleted, false);
    assert.equal(await inspectProcessIdentity(creatorIdentity), "alive");
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");

    await writeFile(join(worktreeLaunchDir, "creation-complete.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: worktreeLaunchJobId,
      launchNonce: worktreeLaunchNonce,
      commandStarted: true,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    })}\n`);
    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal(deleted, false);
    assert.throws(() => process.kill(creator.pid, 0), { code: "ESRCH" });
    assert.equal(await realpath(worktree), canonicalWorktree);
    await assert.rejects(readFile(join(jobDir, "worktree-cleanup.json")));
    assert.equal(
      notifications.some((notification) => notification.message.includes("ID does not match authenticated path")),
      true,
    );

    const repairedJob = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
    repairedJob.observedCodeWorktreeId = encodeURIComponent(canonicalWorktree);
    await writeFile(join(jobDir, "job.json"), `${JSON.stringify(repairedJob, null, 2)}\n`);
    worktreeListed = true;
    await commands.get("delegate-recover").handler(jobId, context);
    await assert.rejects(realpath(worktree), undefined, JSON.stringify(notifications));
    assert.equal(JSON.parse(await readFile(join(jobDir, "worktree-cleanup.json"), "utf8")).phase, "planned");
    assert.equal((await readJobLifecycle(jobDir)).phase, "recovery_required");

    const cleanupPath = join(jobDir, "worktree-cleanup.json");
    const plannedCleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal(deleted, false);
    const gitRemovedCleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
    assert.equal(gitRemovedCleanup.phase, "git_removed");
    assert.equal(
      (await checked("git", ["-C", repository, "worktree", "list", "--porcelain"])).includes(canonicalWorktree),
      false,
    );

    await writeFile(cleanupPath, `${JSON.stringify(plannedCleanup, null, 2)}\n`);
    await checked("git", ["-C", repository, "worktree", "add", canonicalWorktree, branch]);
    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal(deleted, false);
    assert.equal(
      notifications.some((notification) => notification.message.includes("identity was replaced")),
      true,
    );
    assert.equal(JSON.parse(await readFile(cleanupPath, "utf8")).phase, "planned");
    await checked("git", ["-C", repository, "worktree", "remove", canonicalWorktree]);
    await writeFile(cleanupPath, `${JSON.stringify(gitRemovedCleanup, null, 2)}\n`);

    await writeFile(cleanupPath, `${JSON.stringify({
      ...gitRemovedCleanup,
      worktreeId: encodeURIComponent(await realpath(repository)),
    }, null, 2)}\n`);
    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal(deleted, false);
    assert.equal(
      notifications.some((notification) => notification.message.includes("Supacode identity do not match")),
      true,
    );
    await writeFile(cleanupPath, `${JSON.stringify(gitRemovedCleanup, null, 2)}\n`);

    await mkdir(worktree);
    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal(deleted, false);
    assert.equal(
      notifications.some((notification) => notification.message.includes("path was recreated")),
      true,
    );
    await rm(worktree, { recursive: true, force: true });

    await commands.get("delegate-recover").handler(jobId, context);
    assert.equal(deleted, true);
    assert.equal(JSON.parse(await readFile(join(jobDir, "worktree-cleanup.json"), "utf8")).phase, "completed");
    assert.equal((await readJobLifecycle(jobDir)).phase, "failed");
    assert.equal(notifications.some((notification) => notification.message.includes("Removed untouched worktree")), true);
  } finally {
    if (creator?.pid) {
      try { process.kill(-creator.pid, "SIGKILL"); } catch {}
    }
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
