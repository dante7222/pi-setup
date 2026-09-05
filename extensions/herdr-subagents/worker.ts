import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { atomic, json, type Completion, type Job } from "./core.ts";

export function finalReport(last: AssistantMessage | undefined, exitCode: number | null, ended: boolean): { text: string; error?: string } {
  const text = last?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
  const error = exitCode !== 0 ? `Pi exited with code ${exitCode}. See stderr.log.`
    : !ended ? "Pi exited without agent_end; report may be incomplete."
    : !last ? "Pi produced no assistant message."
    : last.stopReason === "error" || last.stopReason === "aborted" ? last.errorMessage || `Pi ${last.stopReason}.`
    : last.stopReason === "length" || last.content.some((part) => part.type === "toolCall") ? "Pi stopped before completing the task."
    : !text.trim() ? "Pi produced no final text report."
    : undefined;
  return { text, error };
}

export async function runWorker(directory: string): Promise<void> {
  process.umask(0o077);
  process.env.PI_HERDR_WORKER = "1";
  const job = await json<Job>(join(directory, "job.json"));
  const launch = await json<{ pi: string; args: string[] }>(join(directory, "launch.json"));
  if (!job || !launch || !job.pane || job.pane !== process.env.HERDR_PANE_ID) throw new Error("Worker does not own this pane.");
  // Keep this supervisor an ordinary terminal process, not a registered Herdr agent:
  // workers must not enter its Agents/priority list or attention notifications.
  // Pi runs detached below; its Herdr integration skips JSON mode. Our files own status.
  process.stdout.write(`\x1b]0;${job.task.role}: ${job.task.name}\x07${job.task.role}: ${job.task.name}\n${job.task.model || "default model"}\n\n`);
  const events = openSync(join(directory, "events.jsonl"), "w", 0o600);
  const errors = openSync(join(directory, "stderr.log"), "w", 0o600);
  let last: AssistantMessage | undefined;
  let ended = false;
  let malformed = false;
  let interrupted: string | undefined;
  let exited = false;
  let stopping = false;
  let killFinished: Promise<void> | undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1" };
  // Parent shell metadata is not the worker's identity.
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
  const child = spawn(launch.pi, launch.args, {
    cwd: job.task.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const killGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    interrupted = reason;
    killGroup("SIGTERM");
    // Always kill the group after the grace period, even if its leader exited first.
    killFinished = new Promise((resolve) => setTimeout(() => { killGroup("SIGKILL"); resolve(); }, 2000));
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (exited) process.exit(0);
    stop(`Cancelled by ${signal}.`);
  };
  const signals = ["SIGHUP", "SIGTERM", "SIGINT"] as const;
  for (const signal of signals) process.on(signal, onSignal);
  const timeout = setTimeout(() => stop(`Timed out after ${job.task.timeout}s.`), job.task.timeout * 1000);
  const cancellation = setInterval(() => {
    if (existsSync(join(directory, "cancel.json"))) stop("Cancelled by parent.");
  }, 250);
  const show = (text: string) => process.stdout.write(stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
  let buffer = "";
  const line = (text: string) => {
    if (!text.trim()) return;
    let event: { type?: string; message?: AssistantMessage; toolName?: string; args?: { path?: string; command?: string }; assistantMessageEvent?: { type?: string; delta?: string } };
    try { event = JSON.parse(text) as typeof event; }
    catch { malformed = true; return; }
    if (event.type === "agent_start") ended = false;
    if (event.type === "agent_end") ended = true;
    if (event.type === "message_end" && event.message?.role === "assistant") last = event.message;
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") show(event.assistantMessageEvent.delta || "");
    if (event.type === "tool_execution_start") {
      const detail = event.args?.path || event.args?.command || "";
      show(`\n[${event.toolName || "tool"}] ${detail.slice(0, 180)}\n`);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    writeSync(events, chunk);
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      line(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { writeSync(errors, chunk); show(chunk.toString("utf8")); });
  // A startup error may close stdin before the prompt is written.
  child.stdin.on("error", () => {});
  child.stdin.end(job.task.prompt);
  let spawnError: string | undefined;
  child.on("error", (error) => { spawnError = error.message; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  if (buffer) line(buffer);
  closeSync(events);
  closeSync(errors);
  clearTimeout(timeout);
  clearInterval(cancellation);
  // Finish group cancellation before advertising completion or exiting the supervisor.
  await killFinished;
  const report = finalReport(last, code, ended);
  const error = interrupted || spawnError || (malformed ? "Invalid JSON in Pi output; inspect events.jsonl." : report.error);
  const done: Completion = { state: interrupted ? "cancelled" : error ? "failed" : "done", report: report.text, exitCode: code, ...(error ? { error } : {}) };
  await writeFile(join(directory, "result.md"), report.text, { mode: 0o600 });
  await atomic(join(directory, "done.json"), done, true);
  exited = true;
  show(`\n\n[${done.state}]${error ? ` ${error}` : ""}\nReport: ${join(directory, "result.md")}\n`);
  if (interrupted) return;
  // Keep the completed report visible. Closing this owned pane ends the supervisor.
  // No shell prompt is exposed for somebody to accidentally reuse before cleanup.
  setInterval(() => {}, 60_000);
}
