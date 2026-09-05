import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { atomic, json, type Completion, type Job, type WorkerClaim } from "./core.ts";
import { ProcessTree, type ProcessSnapshot } from "./process-tree.ts";

export function finalReport(last: AssistantMessage | undefined, exitCode: number | null, ended: boolean): { text: string; error?: string } {
  const text = last?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
  const error = exitCode !== 0 ? `Pi exited with code ${exitCode}. See stderr.log.`
    : !ended ? "Pi exited without agent_end; report may be incomplete."
    : !last ? "Pi produced no assistant message."
    : last.stopReason === "error" || last.stopReason === "aborted" ? last.errorMessage || `Pi ${last.stopReason}.`
    : last.stopReason !== "stop" || last.content.some((part) => part.type === "toolCall") ? "Pi stopped before completing the task."
    : !text.trim() ? "Pi produced no final text report."
    : undefined;
  return { text, error };
}

export async function runWorker(directory: string): Promise<void> {
  process.umask(0o077);
  const job = await json<Job>(join(directory, "job.json"));
  const launch = await json<{ pi: string; args: string[] }>(join(directory, "launch.json"));
  if (!job || !launch || !job.pane || job.closed || job.pane !== process.env.HERDR_PANE_ID) throw new Error("Worker does not own this pane.");
  // Only the startup-claim winner may execute Pi or publish completion. Parent
  // cancellation can win this same claim, fencing rejected/delayed pane launches.
  if (!await atomic(join(directory, "worker.json"), { pid: process.pid }, true)) {
    if ((await json<WorkerClaim>(join(directory, "worker.json")))?.cancelled) return;
    throw new Error("Worker already started; refusing duplicate invocation.");
  }
  process.env.PI_HERDR_WORKER = "1";
  const cancelledPath = join(directory, "cancel.json");
  let child: ChildProcessWithoutNullStreams | undefined;
  let tree: ProcessTree | undefined;
  let events: number | undefined;
  let errors: number | undefined;
  let last: AssistantMessage | undefined;
  let ended = false;
  let failure: string | undefined;
  let interrupted: string | undefined;
  let cleanupError: string | undefined;
  let exited = false;
  let displayBroken = false;
  let reaping: Promise<void> | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let polling: NodeJS.Timeout | undefined;
  let pollBusy = false;
  let code: number | null = null;
  let buffer = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const signalOwned = async (signal: NodeJS.Signals): Promise<number | undefined> => {
    if (!tree) return 0;
    try {
      // SIGTERM can trigger a late shutdown handoff. Merge it before EVERY pass,
      // including finalization after Pi exits, not just before requesting shutdown.
      const snapshot = await json<ProcessSnapshot>(join(directory, "processes.json"));
      if (snapshot) await tree.refresh(snapshot);
    } catch (error) { cleanupError = `Process snapshot failed: ${String(error)}`; }
    try { return await tree.signal(signal); }
    catch (error) {
      cleanupError = `Process cleanup failed: ${String(error)}`;
      // The ChildProcess handle is still authoritative while its direct child lives.
      if (signal === "SIGKILL" && child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return undefined;
    }
  };
  const reap = () => reaping ??= (async () => {
    // An error signaling one descendant must not skip escalation for the others.
    // No grace delay is needed when a clean exit left no live owned processes.
    if (await signalOwned("SIGTERM") !== 0) await delay(2000);
    await signalOwned("SIGKILL");
  })();
  const fail = (error: unknown) => {
    failure ??= String(error);
    void reap();
  };
  const stop = (reason: string) => {
    interrupted ??= reason;
    void reap();
  };
  const onOutputError = (error: Error) => { displayBroken = true; if (!exited) fail(error); };
  const show = (text: string) => {
    if (displayBroken) return;
    try {
      // Strip C1 too: an escape sequence may be split across separate deltas/chunks.
      process.stdout.write(stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
    } catch (error) { displayBroken = true; fail(error); }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (exited) process.exit(0);
    stop(`Cancelled by ${signal}.`);
  };
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  for (const signal of signals) process.on(signal, onSignal);
  process.stdout.on("error", onOutputError);
  const line = (text: string) => {
    if (!text.trim()) return;
    const event = JSON.parse(text) as Record<string, unknown> | null;
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") throw new Error("Invalid JSON event in Pi output; inspect events.jsonl.");
    if (event.type === "agent_start") { ended = false; last = undefined; }
    if (event.type === "agent_end") ended = true;
    if (event.type === "message_end") {
      const message = event.message as AssistantMessage | undefined;
      if (message?.role === "assistant") {
        if (!Array.isArray(message.content) || typeof message.stopReason !== "string" || message.content.some((part) => !part || typeof part.type !== "string" || (part.type === "text" && typeof part.text !== "string"))) throw new Error("Invalid assistant message in Pi output.");
        last = message;
      }
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
      if (update?.type === "text_delta" && typeof update.delta === "string") show(update.delta);
    }
    if (event.type === "tool_execution_start") {
      // Pi emits this BEFORE argument validation; custom tools may also legitimately
      // have object-valued path/command fields. A preview must never crash execution.
      const args = event.args as { path?: unknown; command?: unknown } | undefined;
      const detail = typeof args?.path === "string" ? args.path : typeof args?.command === "string" ? args.command : "";
      show(`\n[${typeof event.toolName === "string" ? event.toolName : "tool"}] ${detail.slice(0, 180)}\n`);
    }
  };
  try {
    if (existsSync(cancelledPath)) interrupted = "Cancelled before worker startup.";
    else {
      // Ordinary named terminal, never a registered Herdr agent. Detached JSON Pi
      // is invisible to foreground detection; the installed integration skips JSON.
      process.stdout.write(`\x1b]0;${job.task.role}: ${job.task.name}\x07`);
      show(`${job.task.role}: ${job.task.name}\n${job.task.model || "default model"}\n\n`);
      if (failure) throw new Error(failure);
      events = openSync(join(directory, "events.jsonl"), "w", 0o600);
      errors = openSync(join(directory, "stderr.log"), "w", 0o600);
      const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1", PI_HERDR_JOB_DIR: directory };
      for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
      child = spawn(launch.pi, launch.args, { cwd: job.task.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      if (child.pid) tree = new ProcessTree(child.pid);
      const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      const exit = new Promise<number | null>((resolve) => {
        child!.once("exit", (code) => { clearTimeout(timeout); resolve(code); });
        child!.once("error", (error) => { clearTimeout(timeout); failure ??= error.message; resolve(null); });
      });
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          if (failure) return;
          writeSync(events!, chunk);
          buffer += stdoutDecoder.write(chunk);
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            line(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        } catch (error) { fail(error); }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try { if (!failure) writeSync(errors!, chunk); show(stderrDecoder.write(chunk)); }
        catch (error) { fail(error); }
      });
      child.stdout.on("error", fail);
      child.stderr.on("error", fail);
      child.stdin.on("error", () => {});
      child.stdin.end(job.task.prompt);
      timeout = setTimeout(() => stop(`Timed out after ${job.task.timeout}s.`), job.task.timeout * 1000);
      await tree?.refresh();
      polling = setInterval(() => {
        if (existsSync(cancelledPath)) stop("Cancelled by parent.");
        if (pollBusy || reaping) return;
        pollBusy = true;
        void tree?.refresh().catch(fail).finally(() => { pollBusy = false; });
      }, 250);
      code = await exit;
      clearTimeout(timeout);
      // Observe process exit separately from pipe closure: detached descendants may
      // retain stdout/stderr forever. Reap first, then bound final pipe draining.
      await reap();
      await Promise.race([closed, delay(500)]);
      child.stdout.destroy();
      child.stderr.destroy();
      if (!failure) {
        buffer += stdoutDecoder.end();
        if (buffer) line(buffer);
      }
      show(stderrDecoder.end());
    }
  } catch (error) { failure ??= String(error); }
  finally {
    clearTimeout(timeout);
    clearInterval(polling);
    await reap();
    await signalOwned("SIGKILL");
    child?.stdout.destroy();
    child?.stderr.destroy();
    child?.stdin.destroy();
    for (const fd of [events, errors]) if (fd !== undefined) {
      try { closeSync(fd); } catch (error) { failure ??= String(error); }
    }
  }
  if (existsSync(cancelledPath)) interrupted ??= "Cancelled by parent.";
  const report = finalReport(last, code, ended);
  const error = [interrupted || failure || report.error, cleanupError].filter(Boolean).join("\n") || undefined;
  const done: Completion = { state: interrupted ? "cancelled" : error ? "failed" : "done", report: report.text, exitCode: code, ...(error ? { error } : {}), ...(cleanupError ? { cleanupError } : {}) };
  try { await writeFile(join(directory, "result.md"), report.text, { mode: 0o600 }); }
  catch (error) { done.state = "failed"; done.error = `${done.error || ""}\nSaving result.md failed: ${String(error)}`; }
  await atomic(join(directory, "done.json"), done, true);
  exited = true;
  show(`\n\n[${done.state}]${done.error ? ` ${done.error}` : ""}\nReport: ${join(directory, "result.md")}\n`);
  if (interrupted && !cleanupError) {
    for (const signal of signals) process.off(signal, onSignal);
    process.stdout.off("error", onOutputError);
    return;
  }
  // Retain final text, or a failed-cleanup warning, until the owned pane is closed.
  setInterval(() => {}, 60_000);
}
