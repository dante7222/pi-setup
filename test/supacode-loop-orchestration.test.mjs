import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  publishWorkerReport,
  writeRunnerProcess,
} from "../extensions/supacode-subagents/lifecycle.ts";

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
const {
  buildRunner,
  default: supacodeSubagents,
} = createRequire(import.meta.url)("../extensions/supacode-subagents/index.ts");

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
        env: options.env,
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

function argument(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name} in ${args.join(" ")}`);
  return args[index + 1];
}

async function writeSettledWorker(jobDir, job, output) {
  const missingIdentity = {
    pid: 999_999_999,
    startSignature: "missing process",
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
  await publishWorkerReport(jobDir, job.id, job.launchNonce, {
    state: "completed",
    launchNonce: job.launchNonce,
    completedAt: new Date().toISOString(),
    stopReason: "stop",
  }, output);
  await writeFile(join(jobDir, "runner-exit.json"), `${JSON.stringify({
    schemaVersion: 2,
    jobId: job.id,
    launchNonce: job.launchNonce,
    wrapperPid: missingIdentity.pid,
    exitCode: 0,
    exitedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

test("delegate_loop repairs and accepts one Git tree attested by every check and reviewer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi loop-'orchestration-"));
  const repository = join(root, "repository");
  const agentDir = join(root, "agent");
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorWorktreeId = process.env.SUPACODE_WORKTREE_ID;
  const tabs = new Map();
  const supacodeWorktrees = [];
  let anchorClosures = 0;
  try {
    await git(root, "init", "repository");
    await git(repository, "config", "user.name", "Test User");
    await git(repository, "config", "user.email", "test@example.com");
    const packageDirectory = join(repository, "packages", "api");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "implementation.txt"), "base\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "base");
    const canonicalRepository = await realpath(repository);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.SUPACODE_WORKTREE_ID = encodeURIComponent(canonicalRepository);

    const supacodeExec = async (args) => {
      if (args[0] === "repo" && args[1] === "list") {
        return { stdout: `${encodeURIComponent(canonicalRepository)}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "repo" && args[1] === "worktree-new") {
        const branch = argument(args, "--branch");
        const base = argument(args, "--base");
        const name = argument(args, "--name");
        const worktree = join(root, "worktrees", name);
        await mkdir(dirname(worktree), { recursive: true });
        await git(repository, "worktree", "add", "-b", branch, worktree, base);
        const worktreeId = encodeURIComponent(await realpath(worktree));
        supacodeWorktrees.push(worktreeId);
        return { stdout: `${worktreeId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { stdout: `${supacodeWorktrees.join("\n")}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "new") {
        const tabId = argument(args, "-n");
        await mkdir(join(agentDir, "subagents"), { recursive: true });
        const batches = await readdir(join(agentDir, "subagents"));
        const intents = [];
        for (const batch of batches) {
          try {
            const metadata = JSON.parse(await readFile(join(agentDir, "subagents", batch, "batch.json"), "utf8"));
            if (metadata.tabId === tabId) intents.push(metadata);
          } catch {}
        }
        assert.equal(intents.length, 1);
        assert.equal(intents[0].phase, "launching");
        assert.equal(intents[0].anchorSurfaceId, tabId);
        tabs.set(tabId, new Set([tabId]));
        return { stdout: `${tabId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "close") {
        tabs.delete(argument(args, "-t"));
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      if (args[0] === "tab" && args[1] === "list") {
        return { stdout: `${[...tabs.keys()].join("\n")}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "split") {
        const tabId = argument(args, "-t");
        const surfaceId = argument(args, "-n");
        tabs.get(tabId)?.add(surfaceId);
        const input = argument(args, "-i");
        const runnerPath = await checked(
          "/bin/zsh",
          ["-c", `set -- ${input}; print -r -- "$2"`],
        );
        const jobDir = dirname(runnerPath);
        const runner = await readFile(runnerPath, "utf8");
        const job = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
        assert.match(runner, /'--no-session' '--name'/);
        assert.doesNotMatch(runner, /'--print'|'--mode' 'json'|worker-output\.mjs/);
        assert.match(runner, job.disableProjectFiles || !job.projectTrusted ? /'--no-approve'/ : /'--approve'/);
        const lifecycle = JSON.parse(await readFile(join(jobDir, "lifecycle.json"), "utf8"));
        assert.equal(job.tabId, tabId);
        assert.equal(job.surfaceId, surfaceId);
        assert.equal(lifecycle.phase, "launching");
        assert.equal(lifecycle.details.surfaceId, surfaceId);
        if (job.mode === "coding") {
          const attempt = Number(job.attempt);
          await writeFile(
            join(job.workerCwd, "implementation.txt"),
            attempt === 1 ? "attempt-one\n" : "accepted\n",
          );
          await git(job.worktreePath, "add", "packages/api/implementation.txt");
          await git(job.worktreePath, "commit", "-m", `attempt ${attempt}`);
          await writeSettledWorker(jobDir, job, `implementation attempt ${attempt} complete`);
        } else {
          const evaluatorLifecycle = JSON.parse(await readFile(
            join(resolve(job.workerCwd, "..", "..", ".."), "checkout-lifecycle.json"),
            "utf8",
          ));
          assert.equal(evaluatorLifecycle.phase, "evaluating");
          assert.equal(evaluatorLifecycle.processJobId, job.id);
          assert.equal(evaluatorLifecycle.processJobDir, jobDir);
          assert.equal(evaluatorLifecycle.processLaunchNonce, job.launchNonce);
          assert.equal(await readFile(join(job.workerCwd, "implementation.txt"), "utf8"), "accepted\n");
          await writeSettledWorker(jobDir, job, "No blocking findings.\nVERDICT: PASS");
        }
        return { stdout: `${surfaceId}\n`, stderr: "", code: 0, killed: false };
      }
      if (args[0] === "surface" && args[1] === "list") {
        const tabId = argument(args, "-t");
        return {
          stdout: `${[...(tabs.get(tabId) ?? [])].join("\n")}\n`,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      if (args[0] === "surface" && args[1] === "close") {
        const tabId = argument(args, "-t");
        const surfaceId = argument(args, "-s");
        if (surfaceId === tabId) anchorClosures++;
        tabs.get(tabId)?.delete(surfaceId);
        return { stdout: "", stderr: "", code: 0, killed: false };
      }
      return { stdout: "", stderr: `unexpected Supacode command: ${args.join(" ")}`, code: 1, killed: false };
    };
    const tools = new Map();
    supacodeSubagents({
      exec: (command, args, options) => command === "supacode"
        ? supacodeExec(args)
        : execResult(command, args, options),
      __supacodeLaunchForTests: (args) => supacodeExec(args),
      getSessionName: () => "loop test",
      getThinkingLevel: () => "medium",
      registerCommand() {},
      registerTool: (tool) => tools.set(tool.name, tool),
    });
    const result = await tools.get("delegate_loop").execute(
      "call",
      {
        task: "Change implementation.txt to accepted.",
        checks: [{
          command: "if test \"$(cat implementation.txt)\" = attempt-one; then printf 'gate-mutation\\n' > implementation.txt; exit 0; else test \"$(cat implementation.txt)\" = accepted; fi",
        }],
        reviewers: [
          { focus: "Verify implementation.txt contains accepted and report concrete defects." },
          { focus: "Independently verify the accepted candidate tree and its test evidence." },
        ],
        maxAttempts: 2,
        keepOpen: false,
      },
      undefined,
      undefined,
      {
        cwd: packageDirectory,
        model: undefined,
        hasUI: true,
        isProjectTrusted: () => true,
        abort() {},
        ui: { confirm: async () => true },
      },
    );

    assert.equal(
      result.details.state,
      "awaiting_apply",
      `${result.details.reason}\n${JSON.stringify(result.details.attempts.at(-1)?.reviews, null, 2)}`,
    );
    assert.equal(result.details.attempts.length, 2);
    assert.equal(result.details.attempts[0].checks[0].exitCode, 0);
    assert.equal(result.details.attempts[0].checks[0].after.unchanged, false);
    assert.equal(result.details.attempts[0].checks[0].passed, false);
    assert.equal(result.details.attempts[0].transition.state, "repairing");
    const accepted = result.details.attempts[1];
    assert.equal(accepted.transition.state, "awaiting_apply");
    assert.equal(accepted.checks[0].candidateTree, accepted.evidence.tree);
    assert.equal(accepted.checks[0].before.unchanged, true);
    assert.equal(accepted.checks[0].after.unchanged, true);
    assert.equal(accepted.reviews.length, 2);
    assert.equal(accepted.reviews[0].before.candidateTree, accepted.evidence.tree);
    assert.equal(accepted.reviews[1].before.candidateTree, accepted.evidence.tree);
    assert.notEqual(accepted.reviews[0].before.checkoutPath, accepted.reviews[1].before.checkoutPath);
    assert.equal(accepted.reviews.every((review) => review.after.unchanged), true);
    const canonicalJob = JSON.parse(await readFile(join(result.details.jobDir, "job.json"), "utf8"));
    const decision = JSON.parse(await readFile(join(result.details.jobDir, "decision.json"), "utf8"));
    assert.equal(decision.owner, "accept");
    assert.equal(canonicalJob.acceptedTree, accepted.evidence.tree);
    assert.equal(canonicalJob.acceptedCommit, accepted.evidence.commit);
    assert.equal(canonicalJob.acceptedRef, accepted.evidence.ref);
    assert.equal(await git(repository, "rev-parse", `${canonicalJob.acceptedRef}^{tree}`), canonicalJob.acceptedTree);
    const checkDir = join(result.details.jobDir, "iterations", "002", "checks", "01");
    const checkoutLifecycle = JSON.parse(await readFile(join(checkDir, "checkout-lifecycle.json"), "utf8"));
    const validationProcess = JSON.parse(await readFile(join(checkDir, "runner-process.json"), "utf8"));
    const validationExit = JSON.parse(await readFile(join(checkDir, "runner-exit.json"), "utf8"));
    assert.equal(checkoutLifecycle.phase, "removed");
    assert.equal(validationProcess.launchNonce, validationExit.launchNonce);
    assert.equal(validationProcess.wrapper.pid, validationExit.wrapperPid);
    assert.equal(validationExit.exitCode, 0);
    assert.equal(anchorClosures, 3);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorWorktreeId === undefined) delete process.env.SUPACODE_WORKTREE_ID;
    else process.env.SUPACODE_WORKTREE_ID = priorWorktreeId;
    await rm(root, { recursive: true, force: true });
  }
});

test("generated worker runner launches interactive Pi with quoted paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi runner-'quoted-"));
  try {
    const workerCwd = join(root, "worker's directory");
    const jobDir = join(root, "job's artifacts");
    const binDir = join(root, "fake bin");
    await Promise.all([
      mkdir(workerCwd, { recursive: true }),
      mkdir(jobDir, { recursive: true }),
      mkdir(binDir, { recursive: true }),
    ]);
    const argsPath = join(root, "pi args.bin");
    const environmentPath = join(root, "pi environment.txt");
    const metadataPath = join(root, "metadata.txt");
    const fakePiPath = join(binDir, "pi");
    await writeFile(fakePiPath, `#!/bin/zsh
printf '%s\\0' "$@" > "$ARGS_PATH"
printf '%s\\n' "$PI_PERMISSION_CONFIG" > "$ENVIRONMENT_PATH"
printf '%s\\n' 'fake interactive worker response'
exit "\${FAKE_PI_EXIT:-0}"
`);
    await chmod(fakePiPath, 0o700);
    const runnerMetadataPath = join(jobDir, "runner metadata.mjs");
    await writeFile(runnerMetadataPath, `
import * as fs from "node:fs";
fs.appendFileSync(process.env.META_PATH, process.argv.slice(2).join(":") + "\\n");
`);
    const promptPath = join(jobDir, "prompt's task.md");
    const permissionConfigPath = join(root, "permission's config.json");
    const skillPath = join(root, "skill's path.md");
    await Promise.all([
      writeFile(promptPath, "review\n"),
      writeFile(permissionConfigPath, "{}\n"),
      writeFile(skillPath, "skill\n"),
    ]);
    const runnerPath = join(jobDir, "run worker.zsh");
    const runner = buildRunner({
      id: "11111111-2222-4333-8444-555555555555",
      batchId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      batchTitle: "quoted runner",
      title: "quoted worker's title",
      mode: "research",
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      yolo: true,
      projectTrusted: true,
      originalCwd: workerCwd,
      workerCwd,
      jobDir,
      promptPath,
      resultPath: join(jobDir, "result.md"),
      stderrPath: join(jobDir, "stderr's log.txt"),
      statusPath: join(jobDir, "status.json"),
      runnerPath,
      runnerMetadataPath,
      runnerExitPath: join(jobDir, "runner-exit.json"),
      launchNonce: "launch-nonce",
      tabWorktreeId: encodeURIComponent(workerCwd),
      permissionConfigPath,
      disableContextFiles: true,
      disableProjectFiles: false,
      disableSkillDiscovery: true,
      skillPaths: [skillPath],
    });
    await writeFile(runnerPath, runner);
    await chmod(runnerPath, 0o700);

    const executed = await execResult("/bin/zsh", [runnerPath], {
      cwd: workerCwd,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ARGS_PATH: argsPath,
        ENVIRONMENT_PATH: environmentPath,
        META_PATH: metadataPath,
      },
      timeout: 10_000,
    });
    assert.equal(executed.code, 0, executed.stderr);
    const args = (await readFile(argsPath)).toString("utf8").split("\0").filter(Boolean);
    assert.deepEqual(args.slice(0, 3), ["--no-session", "--name", "quoted worker's title"]);
    assert.equal(args.includes("--print"), false);
    assert.equal(args.includes("--mode"), false);
    assert.match(executed.stdout, /fake interactive worker response/);
    assert.equal(args.includes("--no-context-files"), true);
    assert.equal(args.includes("--approve"), true);
    assert.equal(args.includes("--no-approve"), false);
    assert.equal(args.includes("--no-skills"), true);
    assert.equal(args.includes("--yolo"), true);
    assert.equal(args.includes(`@${promptPath}`), true);
    assert.equal(args.includes(skillPath), true);
    assert.equal(await readFile(environmentPath, "utf8"), `${permissionConfigPath}\n`);
    assert.equal(await readFile(metadataPath, "utf8"), "start\nexit:0\n");

    await writeFile(metadataPath, "");
    const failed = await execResult("/bin/zsh", [runnerPath], {
      cwd: workerCwd,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ARGS_PATH: argsPath,
        ENVIRONMENT_PATH: environmentPath,
        META_PATH: metadataPath,
        FAKE_PI_EXIT: "37",
      },
      timeout: 10_000,
    });
    assert.equal(failed.code, 37);
    assert.equal(await readFile(metadataPath, "utf8"), "start\nexit:37\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
