import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
const { default: supacodeSubagents } = await import("../extensions/supacode-subagents/index.ts");

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

function registerExtension() {
  const tools = new Map();
  const commands = new Map();
  const pi = {
    exec: execResult,
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
    process.env[WORKER_JOB_ENV] = jobDir;
    supacodeSubagents({
      on: (event, handler) => handlers.set(event, handler),
    });
    await handlers.get("agent_start")();
    await handlers.get("agent_settled")({}, {
      sessionManager: { getEntries: () => entries },
    });
    return {
      status: JSON.parse(await readFile(join(jobDir, "status.json"), "utf8")),
      result: await readFile(join(jobDir, "result.md"), "utf8"),
    };
  } finally {
    if (prior === undefined) delete process.env[WORKER_JOB_ENV];
    else process.env[WORKER_JOB_ENV] = prior;
    await rm(jobDir, { recursive: true, force: true });
  }
}

test("all delegation tools execute sequentially", () => {
  const { tools } = registerExtension();
  assert.deepEqual([...tools.keys()].sort(), [
    "delegate",
    "delegate_apply",
    "delegate_loop",
    "delegate_parallel",
  ]);
  for (const tool of tools.values()) assert.equal(tool.executionMode, "sequential");
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
