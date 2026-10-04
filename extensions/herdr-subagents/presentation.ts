import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import { atomic, herdr, json, launcher, locked, save, type Job, type Scope, type WorkerClaim } from "./core.ts";
import { identityAlive, processIdentity, type ProcessIdentity } from "./identity.ts";

const exec = promisify(execFile);
const AGENT = "pi-subagent"; // Deliberately NOT native "pi": restore must never execute Pi.
interface Pane { pane_id: string; terminal_id: string }
interface ProcessInfo { pane_id: string; shell_pid?: number; foreground_processes?: Array<{ pid: number }> }
interface ViewerAttachment {
  kind: "viewer";
  identity: ProcessIdentity;
  pane: string;
  terminal: string;
  active: boolean;
}

function environmentScope(directory: string): Scope {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PANE_ID) {
    throw new Error("Presentation requires a Herdr pane.");
  }
  // Unlike scopeFor, this is also used by the isolated supervisor/viewer.
  return { root: dirname(resolve(directory)), pane: process.env.HERDR_PANE_ID, workspace: process.env.HERDR_WORKSPACE_ID || "", env: process.env };
}

function sameIdentity(a: ProcessIdentity | undefined, b: ProcessIdentity): boolean {
  return a?.pid === b.pid && a.start === b.start && a.boot === b.boot;
}

async function provenPane(scope: Scope, pane: string, identity: ProcessIdentity, terminal?: string): Promise<Pane> {
  if (!await identityAlive(identity)) throw new Error("Attachment process identity is no longer alive.");
  const { process_info: info } = await herdr<{ process_info: ProcessInfo }>(scope, ["pane", "process-info", "--pane", pane]);
  if (!info || (info.shell_pid !== identity.pid && !info.foreground_processes?.some((entry) => entry.pid === identity.pid))) {
    throw new Error("Pane process evidence does not match the claimed supervisor/viewer.");
  }
  const { panes } = await herdr<{ panes: Pane[] }>(scope, ["pane", "list"]);
  const current = panes.find((entry) => entry.pane_id === info.pane_id);
  if (!current?.terminal_id || (terminal !== undefined && current.terminal_id !== terminal)) {
    throw new Error("Pane terminal identity changed during attachment verification.");
  }
  if (!await identityAlive(identity)) throw new Error("Attachment process identity changed during verification.");
  return current;
}

/** Mirror Herdr 0.9.3's resume argv limits, before taking presentation authority. */
export function resumeArgv(directory: string): string[] {
  const argv = ["node", resolve(launcher), "resume-job", resolve(directory)];
  if (argv.length > 64 || argv.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 8192
    || argv.some((arg) => /['\x00-\x1f\x7f-\x9f]/u.test(arg)) || !/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(argv[0])) {
    throw new Error("Invalid Herdr resume argv: at most 64 arguments / 8192 bytes; no apostrophes or control characters; plain command required.");
  }
  return argv;
}

async function report(scope: Scope, directory: string, args: string[], resume?: string[]): Promise<void> {
  const path = join(directory, "presentation.json");
  const previous = await json<{ seq: number }>(path);
  if (previous && (!Number.isSafeInteger(previous.seq) || previous.seq < 0)) throw new Error("Invalid presentation sequence.");
  const seq = (previous?.seq ?? 0) + 1;
  if (!Number.isSafeInteger(seq)) throw new Error("Presentation sequence exhausted.");
  // Persist BEFORE sending: failed or interrupted sends must never reuse a seq.
  await atomic(path, { seq });
  // Herdr's report/release commands intentionally return no JSON on success.
  await exec(scope.env.HERDR_BIN_PATH || "herdr", [...args, "--seq", String(seq), ...(resume ? ["--", ...resume] : [])], { env: scope.env, timeout: 3000, maxBuffer: 64 * 1024 });
}

export async function publishPresentation(directory: string, job: Job, state: "working" | "idle" | "blocked"): Promise<void> {
  if (job.task.presentation !== "agent") return; // Quiet means no reads, writes, locks or Herdr calls.
  const argv = resumeArgv(directory);
  const scope = environmentScope(directory);
  if (basename(resolve(directory)) !== job.id) throw new Error("Presentation directory does not own this job.");
  const identity = await processIdentity();
  if (!identity) throw new Error("Cannot establish presentation process identity.");
  await locked({ ...scope, root: resolve(directory) }, async () => {
    const pane = await provenPane(scope, scope.pane, identity);
    const source = `pi-subagents:${job.id}`;
    const common = [pane.pane_id, "--source", source, "--agent", AGENT];
    // State carries the command atomically; no native-resume window on partial failure.
    for (const command of ["report-agent", "report-agent-session"]) {
      await report(scope, directory, ["pane", command, ...common,
        ...(command === "report-agent" ? ["--state", state] : []),
        "--agent-session-id", job.id,
      ], argv);
    }
    const title = Array.from(stripVTControlCharacters(`${job.task.role}: ${job.task.name}`).replace(/[\x00-\x1f\x7f-\x9f]/gu, "").trim()).slice(0, 80).join("");
    await report(scope, directory, ["pane", "report-metadata", ...common, "--applies-to-source", source,
      "--title", title, "--display-agent", "Pi subagent", "--state-label", "working=Working",
      "--state-label", "idle=Report ready", "--state-label", "blocked=Needs inspection"]);
  });
}

/** Explicitly rebind only with live boot/start identity AND current PTY evidence. */
export async function reattachJob(scope: Scope, id: string, pane?: string): Promise<Job> {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error("Invalid job ID.");
  return locked(scope, async () => {
    const directory = join(scope.root, id);
    const job = await json<Job>(join(directory, "job.json"));
    if (!job || job.id !== id || job.closed) throw new Error("No open owned job with this ID.");
    const claim = await json<WorkerClaim>(join(directory, "worker.json"));
    if (!claim?.identity || claim.cancelled || (claim.pid !== undefined && claim.pid !== claim.identity.pid)) {
      throw new Error("No valid owned worker claim; refusing reattachment.");
    }
    const viewer = await json<ViewerAttachment>(join(directory, "viewer.json"));
    // A viewer is a separate attachment, NEVER a replacement worker claim. Prefer
    // a live worker; a restored viewer cannot mask still-running execution.
    const workerAlive = await identityAlive(claim.identity);
    const identity = workerAlive ? claim.identity : viewer?.kind === "viewer" && viewer.active ? viewer.identity : undefined;
    if (!identity || !await identityAlive(identity)) throw new Error("No live claimed supervisor/viewer identity; refusing reattachment.");
    const { panes } = await herdr<{ panes: Pane[] }>(scope, ["pane", "list"]);
    const candidates = panes.filter((entry) => (pane === undefined || entry.pane_id === pane) && entry.pane_id !== scope.pane);
    const matches: Pane[] = [];
    for (const candidate of candidates) {
      try { matches.push(await provenPane(scope, candidate.pane_id, identity, candidate.terminal_id)); }
      catch { /* Titles, stale pane IDs and PIDs without the current start/boot are not evidence. */ }
    }
    if (matches.length !== 1) throw new Error("Expected exactly one pane with matching process evidence; refusing reattachment.");
    const candidate = matches[0];
    // Re-sample immediately before save, including terminal and boot/start. A
    // handoff may change terminals, but changes during this check fail closed.
    await provenPane(scope, candidate.pane_id, identity, candidate.terminal_id);
    const freshClaim = await json<WorkerClaim>(join(directory, "worker.json"));
    const freshViewer = await json<ViewerAttachment>(join(directory, "viewer.json"));
    if (!freshClaim || freshClaim.cancelled || !sameIdentity(freshClaim.identity, claim.identity)
      || (freshClaim.pid !== undefined && freshClaim.pid !== claim.identity.pid)
      || (!workerAlive && (!freshViewer?.active || freshViewer.kind !== "viewer" || !sameIdentity(freshViewer.identity, identity)))) {
      throw new Error("Attachment claim changed; refusing reattachment.");
    }
    job.pane = candidate.pane_id;
    job.terminal = candidate.terminal_id;
    delete job.endedAt;
    await save(scope, job);
    return job;
  });
}

/** Cold restore is a read-only report viewer, not a task/session resume. */
export async function replayViewer(directory: string): Promise<void> {
  directory = resolve(directory);
  const job = await json<Job>(join(directory, "job.json"));
  if (!job || !/^[a-f0-9]{12}$/.test(job.id) || basename(directory) !== job.id) throw new Error("Invalid viewer job directory.");
  const scope = environmentScope(directory);
  const identity = await processIdentity();
  if (!identity) throw new Error("Cannot establish viewer process identity.");
  const pane = await provenPane(scope, scope.pane, identity);
  const attachment: ViewerAttachment = { kind: "viewer", identity, pane: pane.pane_id, terminal: pane.terminal_id, active: true };
  const localScope = { ...scope, root: directory };
  await locked(localScope, async () => {
    const previous = await json<ViewerAttachment>(join(directory, "viewer.json"));
    if (previous?.active && await identityAlive(previous.identity)) throw new Error("A live viewer already owns this job attachment.");
    await atomic(join(directory, "viewer.json"), attachment);
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  process.stdout.on("error", stop);
  let previous = "";
  try {
    // Optional display failures cannot change report/worker/shutdown evidence.
    try { await publishPresentation(directory, job, "idle"); } catch { /* Best effort. */ }
    while (!controller.signal.aborted) {
      let text = "No saved report yet. The task is NOT restarted.";
      try {
        const file = await open(join(directory, "result.md"), "r");
        try {
          const buffer = Buffer.alloc(12_001);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          text = buffer.subarray(0, Math.min(bytesRead, 12_000)).toString("utf8");
          if (bytesRead > 12_000) text += "\n[report truncated; collect the saved report for full text]";
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") text = "Saved report temporarily unavailable.";
      }
      text = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
      const lines = text.split("\n");
      if (lines.length > 80) text = `${lines.slice(0, 80).join("\n")}\n[report truncated]`;
      const display = `Read-only subagent report: ${job.id}\nNo Pi process or task will be resumed.\n\n${text}\n`;
      if (display !== previous) { process.stdout.write(display); previous = display; }
      try { await delay(1000, undefined, { signal: controller.signal }); } catch { break; }
    }
  } finally {
    try {
      await locked(localScope, async () => {
        const current = await json<ViewerAttachment>(join(directory, "viewer.json"));
        if (!sameIdentity(current?.identity, identity)) return;
        // Even a partially successful optional publish may have taken authority.
        if (job.task.presentation === "agent") {
          try {
            const currentPane = await provenPane(scope, scope.pane, identity, pane.terminal_id);
            await report(scope, directory, ["pane", "release-agent", currentPane.pane_id, "--source", `pi-subagents:${job.id}`, "--agent", AGENT]);
          } catch { /* Pane/server may already be gone. */ }
        }
        await atomic(join(directory, "viewer.json"), { ...current, active: false });
      });
    } finally {
      for (const signal of signals) process.off(signal, stop);
      process.stdout.off("error", stop);
    }
  }
}
