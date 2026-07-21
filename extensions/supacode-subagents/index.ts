import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WORKER_JOB_ENV = "PI_SUPACODE_SUBAGENT_JOB_DIR";
const MAX_PARALLEL = 3;
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
const POLL_INTERVAL_MS = 250;
const RESULT_BUDGET_BYTES = DEFAULT_MAX_BYTES - 2048;
const RESEARCH_TOOLS = "read,grep,find,ls";
const CODING_TOOLS = "read,bash,edit,write,grep,find,ls";

type WorkerMode = "research" | "coding";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type WorkerState = "running" | "completed" | "failed";

interface WorkerSpec {
  task: string;
  title?: string;
  mode: WorkerMode;
  model?: string;
  thinking?: ThinkingLevel;
}

interface WorkerStatus {
  state: WorkerState;
  pid?: number;
  startedAt?: string;
  completedAt?: string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  usage?: unknown;
  exitCode?: number;
}

interface WorkerJob {
  id: string;
  title: string;
  mode: WorkerMode;
  model?: string;
  thinking: ThinkingLevel;
  originalCwd: string;
  workerCwd: string;
  jobDir: string;
  promptPath: string;
  resultPath: string;
  stderrPath: string;
  statusPath: string;
  runnerPath: string;
  worktreeId: string;
  worktreePath?: string;
  branch?: string;
  baseSha?: string;
  tabId: string;
}

interface GitSummary {
  head?: string;
  commit?: string;
  status?: string;
}

interface WorkerResult {
  id: string;
  title: string;
  mode: WorkerMode;
  state: "completed" | "failed";
  output: string;
  error?: string;
  jobDir?: string;
  resultPath?: string;
  stderrPath?: string;
  tabId?: string;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  git?: GitSummary;
  status?: WorkerStatus;
}

interface ParentSurface {
  worktreeId: string;
  tabId?: string;
  surfaceId?: string;
}

function isoNow(): string {
  return new Date().toISOString();
}

function sanitizeTitle(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "delegated task").slice(0, 60);
}

function taskTitle(task: string, requested?: string): string {
  return `agent: ${sanitizeTitle(requested || task)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function lastNonEmptyLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

function decodeResourceId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isFinalState(status: WorkerStatus | undefined): status is WorkerStatus & { state: "completed" | "failed" } {
  return status?.state === "completed" || status?.state === "failed";
}

async function atomicWrite(filePath: string, content: string, mode = 0o600): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, content, { encoding: "utf8", mode });
  await fs.promises.rename(temporary, filePath);
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function finalAssistantMessage(entries: any[]): any | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") return entry.message;
  }
  return undefined;
}

function assistantText(message: any): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("")
    .trim();
}

/** Worker processes load this same global extension. In worker mode it only reports the first settled result. */
function registerWorkerCapture(pi: ExtensionAPI, jobDir: string): void {
  const resultPath = path.join(jobDir, "result.md");
  const statusPath = path.join(jobDir, "status.json");
  let finalized = false;

  pi.on("agent_start", async () => {
    if (finalized) return;
    await atomicWrite(
      statusPath,
      JSON.stringify({ state: "running", pid: process.pid, startedAt: isoNow() } satisfies WorkerStatus),
    );
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (finalized) return;
    finalized = true;

    const message = finalAssistantMessage(ctx.sessionManager.getEntries());
    const text = assistantText(message);
    const stopReason = typeof message?.stopReason === "string" ? message.stopReason : undefined;
    const errorMessage = typeof message?.errorMessage === "string" ? message.errorMessage : undefined;
    const failed = !text || stopReason === "error" || stopReason === "aborted";
    const output = text || errorMessage || "Worker settled without an assistant response.";

    try {
      await atomicWrite(resultPath, `${output.trim()}\n`);
      await atomicWrite(
        statusPath,
        JSON.stringify({
          state: failed ? "failed" : "completed",
          pid: process.pid,
          completedAt: isoNow(),
          stopReason,
          errorMessage: failed ? errorMessage || (!text ? output : undefined) : undefined,
          model: typeof message?.model === "string" ? message.model : undefined,
          usage: message?.usage,
        } satisfies WorkerStatus),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await atomicWrite(
          statusPath,
          JSON.stringify({ state: "failed", pid: process.pid, completedAt: isoNow(), errorMessage: message } satisfies WorkerStatus),
        );
      } catch {
        // The wrapper reports a fallback failure if even the status file cannot be written.
      }
    }
  });
}

function buildPrompt(spec: WorkerSpec, originalCwd: string, workerCwd: string, branch?: string): string {
  const common = [
    "# Delegated task",
    "",
    spec.task.trim(),
    "",
    "# Context",
    "",
    `- Parent working directory: \`${originalCwd}\``,
    `- Your working directory: \`${workerCwd}\``,
    "- You are an independent Pi worker. You do not have the parent conversation.",
    "- Follow every AGENTS.md/context file loaded for your working directory.",
  ];

  if (spec.mode === "research") {
    common.push(
      "",
      "# Operating mode: research",
      "",
      "- Investigate and report; do not modify files.",
      "- Cite exact file paths and line numbers when useful.",
      "- Return concise findings that the parent agent can act on without repeating your investigation.",
    );
  } else {
    common.push(
      "",
      "# Operating mode: coding",
      "",
      `- Work only in this isolated worktree${branch ? ` on branch \`${branch}\`` : ""}.`,
      "- Implement the requested change, run relevant validation, and review the diff.",
      "- Commit intended changes with an informative commit message. Do not push or merge.",
      "- If you cannot complete or commit the work, preserve the worktree and explain exactly why.",
      "- Finish with a summary, files changed, tests run, and commit SHA when available.",
    );
  }

  return `${common.join("\n")}\n`;
}

function buildRunner(job: Omit<WorkerJob, "tabId">): string {
  const args = [
    "pi",
    "--no-session",
    "--name",
    job.title,
    "--thinking",
    job.thinking,
    "--tools",
    job.mode === "research" ? RESEARCH_TOOLS : CODING_TOOLS,
  ];
  if (job.model) args.push("--model", job.model);
  args.push(`@${job.promptPath}`, "Complete the delegated task described in the attached prompt.");

  const command = args.map(shellQuote).join(" ");
  return `#!/bin/zsh
set -u
JOB_DIR=${shellQuote(job.jobDir)}
STATUS_PATH=${shellQuote(job.statusPath)}
STDERR_PATH=${shellQuote(job.stderrPath)}
cd -- ${shellQuote(job.workerCwd)} || exit 72
export ${WORKER_JOB_ENV}="$JOB_DIR"
touch "$STDERR_PATH"
printf '\\n[supacode-subagent] %s\\n\\n' ${shellQuote(job.title)}
set +e
${command} 2> >(tee -a "$STDERR_PATH" >&2)
EXIT_CODE=$?
if ! grep -Eq '"state":"(completed|failed)"' "$STATUS_PATH" 2>/dev/null; then
  printf '{"state":"failed","completedAt":"%s","errorMessage":"Worker exited before reporting a result.","exitCode":%d}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$EXIT_CODE" > "$STATUS_PATH.tmp"
  mv "$STATUS_PATH.tmp" "$STATUS_PATH"
fi
exit "$EXIT_CODE"
`;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Subagent operation aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Subagent operation aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function execChecked(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<string> {
  const result = await pi.exec(command, args, options);
  if (result.code !== 0) {
    const diagnostic = (result.stderr || result.stdout || `exit ${result.code}`).trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${diagnostic}`);
  }
  return result.stdout;
}

async function gitOutput(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return (await execChecked(pi, "git", ["-C", cwd, ...args], { signal, timeout: 30_000 })).trim();
}

async function ensureRepositoryKnown(
  pi: ExtensionAPI,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const listed = await execChecked(pi, "supacode", ["repo", "list"], { signal, timeout: 30_000 });
  const knownId = listed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((id) => id && path.resolve(decodeResourceId(id)) === path.resolve(repoRoot));
  if (knownId) return knownId;

  await execChecked(pi, "supacode", ["repo", "open", repoRoot], { signal, timeout: 60_000 });
  return encodeURIComponent(repoRoot);
}

async function createCodingWorktree(
  pi: ExtensionAPI,
  originalCwd: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<{ id: string; worktreePath: string; branch: string; baseSha: string }> {
  const repoRoot = await gitOutput(pi, originalCwd, ["rev-parse", "--show-toplevel"], signal);
  const baseSha = await gitOutput(pi, originalCwd, ["rev-parse", "HEAD"], signal);
  const repoId = await ensureRepositoryKnown(pi, repoRoot, signal);
  const shortId = jobId.slice(0, 8);
  const branch = `pi-agent/${shortId}`;
  const folderName = `pi-agent-${shortId}`;
  const stdout = await execChecked(
    pi,
    "supacode",
    [
      "repo",
      "worktree-new",
      "-r",
      repoId,
      "--branch",
      branch,
      "--base",
      baseSha,
      "--name",
      folderName,
    ],
    { signal, timeout: 180_000 },
  );
  const id = lastNonEmptyLine(stdout);
  if (!id) throw new Error("Supacode created a worktree but returned no worktree ID.");
  const worktreePath = decodeResourceId(id);
  if (!path.isAbsolute(worktreePath)) throw new Error(`Unexpected Supacode worktree ID: ${id}`);
  return { id, worktreePath, branch, baseSha };
}

async function refocusParent(pi: ExtensionAPI, parent: ParentSurface): Promise<void> {
  if (!parent.tabId || !parent.surfaceId) return;
  try {
    await execChecked(
      pi,
      "supacode",
      [
        "surface",
        "focus",
        "-w",
        parent.worktreeId,
        "-t",
        parent.tabId,
        "-s",
        parent.surfaceId,
      ],
      { timeout: 30_000 },
    );
  } catch {
    // The worker still runs if restoring focus fails.
  }
}

async function launchWorker(
  pi: ExtensionAPI,
  spec: WorkerSpec,
  ctxCwd: string,
  parent: ParentSurface,
  signal: AbortSignal | undefined,
): Promise<WorkerJob> {
  const id = randomUUID();
  const title = taskTitle(spec.task, spec.title);
  const jobDir = path.join(getAgentDir(), "subagents", id);
  await fs.promises.mkdir(jobDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(jobDir, 0o700);

  let worktreeId = parent.worktreeId;
  let workerCwd = ctxCwd;
  let worktreePath: string | undefined;
  let branch: string | undefined;
  let baseSha: string | undefined;

  if (spec.mode === "coding") {
    const worktree = await createCodingWorktree(pi, ctxCwd, id, signal);
    worktreeId = worktree.id;
    workerCwd = worktree.worktreePath;
    worktreePath = worktree.worktreePath;
    branch = worktree.branch;
    baseSha = worktree.baseSha;
  }

  const promptPath = path.join(jobDir, "prompt.md");
  const resultPath = path.join(jobDir, "result.md");
  const stderrPath = path.join(jobDir, "stderr.log");
  const statusPath = path.join(jobDir, "status.json");
  const runnerPath = path.join(jobDir, "run.zsh");
  const thinking = spec.thinking ?? "medium";
  const partialJob = {
    id,
    title,
    mode: spec.mode,
    model: spec.model,
    thinking,
    originalCwd: ctxCwd,
    workerCwd,
    jobDir,
    promptPath,
    resultPath,
    stderrPath,
    statusPath,
    runnerPath,
    worktreeId,
    worktreePath,
    branch,
    baseSha,
  } satisfies Omit<WorkerJob, "tabId">;

  await atomicWrite(promptPath, buildPrompt(spec, ctxCwd, workerCwd, branch));
  await atomicWrite(stderrPath, "");
  await atomicWrite(runnerPath, buildRunner(partialJob), 0o700);
  await fs.promises.chmod(runnerPath, 0o700);

  const stdout = await execChecked(
    pi,
    "supacode",
    ["tab", "new", "-w", worktreeId, "--title", title, "-i", `zsh ${shellQuote(runnerPath)}`],
    { signal, timeout: 60_000 },
  );
  const tabId = lastNonEmptyLine(stdout);
  if (!/^[0-9a-f-]{36}$/i.test(tabId)) throw new Error(`Unexpected Supacode tab ID: ${tabId || "(empty)"}`);

  const job: WorkerJob = { ...partialJob, tabId };
  try {
    await atomicWrite(
      path.join(jobDir, "job.json"),
      JSON.stringify(
        {
          id,
          title,
          mode: spec.mode,
          model: spec.model,
          thinking,
          originalCwd: ctxCwd,
          workerCwd,
          worktreeId,
          worktreePath,
          branch,
          baseSha,
          tabId,
          createdAt: isoNow(),
        },
        null,
        2,
      ),
    );
  } catch {
    // Metadata is useful for inspection but must not invalidate a running worker.
  }
  await refocusParent(pi, parent);
  return job;
}

async function closeWorkerTab(pi: ExtensionAPI, job: WorkerJob): Promise<void> {
  try {
    await execChecked(
      pi,
      "supacode",
      ["tab", "close", "-w", job.worktreeId, "-t", job.tabId],
      { timeout: 30_000 },
    );
  } catch {
    // Cleanup is best effort; IDs and logs remain in the job directory.
  }
}

async function collectGitSummary(pi: ExtensionAPI, job: WorkerJob): Promise<GitSummary | undefined> {
  if (job.mode !== "coding" || !job.worktreePath) return undefined;
  try {
    const head = await gitOutput(pi, job.worktreePath, ["rev-parse", "HEAD"]);
    const status = await gitOutput(pi, job.worktreePath, ["status", "--short"]);
    return { head, commit: job.baseSha && head !== job.baseSha ? head : undefined, status };
  } catch {
    return undefined;
  }
}

async function waitForWorker(
  pi: ExtensionAPI,
  job: WorkerJob,
  timeoutSeconds: number,
  keepOpen: boolean,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Subagent operation aborted");
      const status = await readJson<WorkerStatus>(job.statusPath);
      if (isFinalState(status)) {
        const output = (await readText(job.resultPath)).trim();
        const stderr = (await readText(job.stderrPath)).trim();
        const git = await collectGitSummary(pi, job);
        if (!keepOpen) await closeWorkerTab(pi, job);
        return {
          id: job.id,
          title: job.title,
          mode: job.mode,
          state: status.state,
          output: output || status.errorMessage || stderr || "Worker produced no output.",
          error: status.state === "failed" ? status.errorMessage || stderr || "Worker failed." : undefined,
          jobDir: job.jobDir,
          resultPath: job.resultPath,
          stderrPath: job.stderrPath,
          tabId: job.tabId,
          worktreeId: job.worktreeId,
          worktreePath: job.worktreePath,
          branch: job.branch,
          git,
          status,
        };
      }
      await delay(POLL_INTERVAL_MS, signal);
    }

    await closeWorkerTab(pi, job);
    return {
      id: job.id,
      title: job.title,
      mode: job.mode,
      state: "failed",
      output: `Timed out after ${timeoutSeconds} seconds.`,
      error: `Timed out after ${timeoutSeconds} seconds.`,
      jobDir: job.jobDir,
      resultPath: job.resultPath,
      stderrPath: job.stderrPath,
      tabId: job.tabId,
      worktreeId: job.worktreeId,
      worktreePath: job.worktreePath,
      branch: job.branch,
    };
  } catch (error) {
    await closeWorkerTab(pi, job);
    throw error;
  }
}

function formatResults(results: WorkerResult[]): string {
  const perResultBytes = Math.max(8 * 1024, Math.floor(RESULT_BUDGET_BYTES / Math.max(1, results.length)));
  const successful = results.filter((result) => result.state === "completed").length;
  const sections = results.map((result) => {
    const truncation = truncateHead(result.output, {
      maxBytes: perResultBytes,
      maxLines: Math.min(DEFAULT_MAX_LINES, 800),
    });
    const metadata = [
      `Mode: ${result.mode}`,
      result.tabId ? `Supacode tab: ${result.tabId}` : undefined,
      result.worktreePath ? `Worktree: ${result.worktreePath}` : undefined,
      result.branch ? `Branch: ${result.branch}` : undefined,
      result.git?.commit ? `Commit: ${result.git.commit}` : undefined,
      result.git?.status ? `Uncommitted changes:\n\`\`\`text\n${result.git.status}\n\`\`\`` : undefined,
      result.resultPath ? `Full result: ${result.resultPath}` : undefined,
      result.stderrPath ? `Errors/log: ${result.stderrPath}` : undefined,
    ].filter(Boolean);
    const omitted = truncation.truncated
      ? `\n\n[Result truncated for parent context. Full output: ${result.resultPath}]`
      : "";
    return `## ${result.title} — ${result.state}\n\n${metadata.join("\n")}\n\n${truncation.content}${omitted}`;
  });
  return `${successful}/${results.length} delegated task${results.length === 1 ? "" : "s"} completed successfully.\n\n${sections.join("\n\n---\n\n")}`;
}

function resultDetails(results: WorkerResult[]) {
  return {
    results: results.map((result) => ({
      id: result.id,
      title: result.title,
      mode: result.mode,
      state: result.state,
      error: result.error,
      jobDir: result.jobDir,
      resultPath: result.resultPath,
      stderrPath: result.stderrPath,
      tabId: result.tabId,
      worktreeId: result.worktreeId,
      worktreePath: result.worktreePath,
      branch: result.branch,
      git: result.git,
      status: result.status,
      resultPreview: result.output.slice(0, 4096),
    })),
  };
}

async function runWorkers(
  pi: ExtensionAPI,
  specs: WorkerSpec[],
  ctxCwd: string,
  parent: ParentSurface,
  timeoutSeconds: number,
  keepOpen: boolean,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: any) => void) | undefined,
): Promise<WorkerResult[]> {
  const ordered: Array<WorkerResult | undefined> = new Array(specs.length);
  const launched: Array<{ index: number; job: WorkerJob }> = [];

  try {
    for (let index = 0; index < specs.length; index++) {
      onUpdate?.({
        content: [{ type: "text", text: `Launching worker ${index + 1}/${specs.length}...` }],
        details: { launched: launched.length, total: specs.length },
      });
      try {
        const job = await launchWorker(pi, specs[index], ctxCwd, parent, signal);
        launched.push({ index, job });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ordered[index] = {
          id: randomUUID(),
          title: taskTitle(specs[index].task, specs[index].title),
          mode: specs[index].mode,
          state: "failed",
          output: message,
          error: message,
        };
      }
    }

    let completed = ordered.filter(Boolean).length;
    await Promise.all(
      launched.map(async ({ index, job }) => {
        const result = await waitForWorker(pi, job, timeoutSeconds, keepOpen, signal);
        ordered[index] = result;
        completed++;
        onUpdate?.({
          content: [{ type: "text", text: `Delegated workers: ${completed}/${specs.length} finished.` }],
          details: resultDetails(ordered.filter((item): item is WorkerResult => Boolean(item))),
        });
      }),
    );
  } catch (error) {
    await Promise.all(launched.map(({ job }) => closeWorkerTab(pi, job)));
    throw error;
  } finally {
    await refocusParent(pi, parent);
  }

  return ordered.filter((item): item is WorkerResult => Boolean(item));
}

const ModeSchema = StringEnum(["research", "coding"] as const, {
  description: "research is read-only in the current project; coding creates an isolated Git worktree.",
  default: "research",
});

const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
  description: "Worker thinking level. Defaults to the parent Pi thinking level.",
});

const SingleParams = Type.Object({
  task: Type.String({ description: "Self-contained task for the worker. It does not inherit the parent conversation." }),
  title: Type.Optional(Type.String({ description: "Short Supacode tab title." })),
  mode: Type.Optional(ModeSchema),
  model: Type.Optional(Type.String({ description: "Optional Pi model pattern. Defaults to the parent model." })),
  thinking: Type.Optional(ThinkingSchema),
  timeoutSeconds: Type.Optional(
    Type.Integer({ minimum: 30, maximum: 3600, default: DEFAULT_TIMEOUT_SECONDS, description: "Worker timeout." }),
  ),
  keepOpen: Type.Optional(
    Type.Boolean({ default: true, description: "Keep the Supacode tab open after its result is captured." }),
  ),
});

const ParallelTask = Type.Object({
  task: Type.String({ description: "Self-contained task for this worker." }),
  title: Type.Optional(Type.String({ description: "Short Supacode tab title." })),
  mode: Type.Optional(ModeSchema),
  model: Type.Optional(Type.String({ description: "Optional Pi model pattern. Defaults to the parent model." })),
  thinking: Type.Optional(ThinkingSchema),
});

const ParallelParams = Type.Object({
  tasks: Type.Array(ParallelTask, {
    minItems: 1,
    maxItems: MAX_PARALLEL,
    description: `Independent tasks to run concurrently. Maximum ${MAX_PARALLEL}.`,
  }),
  timeoutSeconds: Type.Optional(
    Type.Integer({ minimum: 30, maximum: 3600, default: DEFAULT_TIMEOUT_SECONDS, description: "Timeout per worker." }),
  ),
  keepOpen: Type.Optional(
    Type.Boolean({ default: true, description: "Keep Supacode tabs open after results are captured." }),
  ),
});

export default function supacodeSubagents(pi: ExtensionAPI) {
  const workerJobDir = process.env[WORKER_JOB_ENV];
  if (workerJobDir) {
    registerWorkerCapture(pi, path.resolve(workerJobDir));
    return;
  }

  function parentSurface(): ParentSurface {
    const worktreeId = process.env.SUPACODE_WORKTREE_ID;
    if (!worktreeId) {
      throw new Error("Supacode subagents require the parent Pi session to run inside a Supacode terminal.");
    }
    return {
      worktreeId,
      tabId: process.env.SUPACODE_TAB_ID,
      surfaceId: process.env.SUPACODE_SURFACE_ID,
    };
  }

  function defaultModel(ctx: any): string | undefined {
    return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  }

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Run one independent Pi worker in a visible Supacode tab and return its final answer. Research mode is read-only. Coding mode creates and preserves an isolated Git worktree; it never merges or pushes. Worker output is capped for model context and the full result path is returned.",
    promptSnippet: "Delegate one independent research or coding task to a visible Pi worker in Supacode",
    promptGuidelines: [
      "Use delegate when one independent task can be completed in an isolated context; include all necessary requirements because workers do not inherit the parent conversation.",
    ],
    parameters: SingleParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const spec: WorkerSpec = {
        task: params.task,
        title: params.title,
        mode: params.mode ?? "research",
        model: params.model ?? defaultModel(ctx),
        thinking: params.thinking ?? pi.getThinkingLevel(),
      };
      const results = await runWorkers(
        pi,
        [spec],
        ctx.cwd,
        parentSurface(),
        params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        params.keepOpen ?? true,
        signal,
        onUpdate,
      );
      return { content: [{ type: "text", text: formatResults(results) }], details: resultDetails(results) };
    },
  });

  pi.registerTool({
    name: "delegate_parallel",
    label: "Delegate Parallel",
    description:
      `Run up to ${MAX_PARALLEL} independent Pi workers concurrently in visible Supacode tabs and return all final answers. Research workers are read-only; each coding worker gets a separate preserved Git worktree. Output is capped for model context and full result paths are returned.`,
    promptSnippet: "Delegate up to three independent tasks to parallel visible Pi workers in Supacode",
    promptGuidelines: [
      "Use delegate_parallel only for independent tasks that benefit from concurrent investigation or isolated implementations, and make every task self-contained.",
    ],
    parameters: ParallelParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const parentModel = defaultModel(ctx);
      const parentThinking = pi.getThinkingLevel();
      const specs: WorkerSpec[] = params.tasks.map((task) => ({
        task: task.task,
        title: task.title,
        mode: task.mode ?? "research",
        model: task.model ?? parentModel,
        thinking: task.thinking ?? parentThinking,
      }));
      const results = await runWorkers(
        pi,
        specs,
        ctx.cwd,
        parentSurface(),
        params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        params.keepOpen ?? true,
        signal,
        onUpdate,
      );
      return { content: [{ type: "text", text: formatResults(results) }], details: resultDetails(results) };
    },
  });
}
