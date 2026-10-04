import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { appendFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { atomic, json, type Completion, type Job, type WorkerClaim } from "./core.ts";
import { ProcessTree, snapshotProcesses, type ProcessSnapshot } from "./process-tree.ts";
import { processIdentity } from "./identity.ts";
import { emptyUsage, trackProgress, type WorkerProgress } from "./progress.ts";
import { RpcControl } from "./rpc-control.ts";
import { acquireSlot, releaseSlot } from "./scheduler.ts";
import { publishPresentation } from "./presentation.ts";

export function finalReport(last: AssistantMessage | undefined, exitCode: number | null, settled: boolean): { text: string; error?: string } {
  const text = last?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
  const error = exitCode !== 0 ? `Pi exited with code ${exitCode}. See stderr.log.`
    : !settled ? "Pi exited without agent_settled; report may be incomplete."
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
  const identity = await processIdentity();
  if (!identity) throw new Error("Cannot establish worker process identity.");
  if (!await atomic(join(directory, "worker.json"), { pid: process.pid, identity }, true)) {
    if ((await json<WorkerClaim>(join(directory, "worker.json")))?.cancelled) return;
    throw new Error("Worker already started; refusing duplicate invocation.");
  }
  process.env.PI_HERDR_WORKER = "1";
  const cancelledPath = join(directory, "cancel.json");
  const cancelled = () => existsSync(cancelledPath) || existsSync(join(directory, "stop.json"));
  const queueAbort = new AbortController();
  let slot = false;
  let queuePolling: NodeJS.Timeout | undefined;
  let rpc: RpcControl | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let tree: ProcessTree | undefined;
  let events: number | undefined;
  let errors: number | undefined;
  let last: AssistantMessage | undefined;
  let settled = false;
  let checkpointText = "";
  let checkpointed = Promise.resolve();
  let progressSaved = Promise.resolve();
  let executionSaved = Promise.resolve();
  const checkpointExecution = () => executionSaved = executionSaved.then(async () => {
    if (tree) await atomic(join(directory, "execution.json"), { boot: identity.boot, tree: await tree.evidence() });
  });
  const progress: WorkerProgress = { phase: "starting", updatedAt: Date.now(), turns: 0, usage: emptyUsage() };
  let failure: string | undefined;
  let interrupted: string | undefined;
  let cleanupError: string | undefined;
  let cleanupVerified = false;
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
      await tree.refresh();
      await checkpointExecution();
    } catch (error) { cleanupError ??= `Process snapshot failed: ${String(error)}`; }
    try { return await tree.signal(signal); }
    catch (error) {
      cleanupError ??= `Process cleanup failed: ${String(error)}`;
      // The ChildProcess handle is still authoritative while its direct child lives.
      if (signal === "SIGKILL" && child && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch (error) { cleanupError += `\nDirect child cleanup failed: ${String(error)}`; }
      }
      return undefined;
    }
  };
  const reap = () => reaping ??= (async () => {
    if (rpc && (interrupted || failure) && child?.exitCode === null && child.signalCode === null) {
      await rpc.abort().catch((error: unknown) => { failure ??= String(error); });
      // Give stdin EOF/runtime disposal a bounded chance before OS escalation.
      const deadline = Date.now() + 500;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
    }
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
    queueAbort.abort(new Error(reason));
    void reap();
  };
  const checkpoint = () => {
    // Capture authoritative message_end text, never display deltas. Serialize
    // replacements so a slow earlier write cannot overwrite a newer settlement.
    const value = { report: checkpointText, settled };
    checkpointed = checkpointed.then(async () => { await atomic(join(directory, "checkpoint.json"), value); })
      .catch((error: unknown) => { fail(`Saving checkpoint.json failed: ${String(error)}`); });
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
    rpc?.event(event);
    if (trackProgress(progress, event)) {
      if (job.task.maxTokens !== undefined && progress.usage.totalTokens >= job.task.maxTokens) stop(`Soft token budget reached (${progress.usage.totalTokens}/${job.task.maxTokens}).`);
      if (job.task.maxCost !== undefined && progress.usage.cost.total >= job.task.maxCost) stop(`Soft cost budget reached (${progress.usage.cost.total}/${job.task.maxCost}).`);
      const snapshot = structuredClone(progress);
      progressSaved = progressSaved.then(async () => { await atomic(join(directory, "progress.json"), snapshot); })
        .catch((error: unknown) => { fail(`Saving progress.json failed: ${String(error)}`); });
    }
    if (event.type === "agent_start") {
      settled = false;
      last = undefined;
      // Keep the previous attempt's text available if a retry dies before replying.
      checkpoint();
    }
    // agent_end only ends a low-level attempt; retries/follow-ups can still run.
    if (event.type === "agent_settled") { settled = true; checkpoint(); }
    if (event.type === "message_end") {
      const message = event.message as AssistantMessage | undefined;
      if (message?.role === "assistant") {
        if (!Array.isArray(message.content) || typeof message.stopReason !== "string" || message.content.some((part) => !part || typeof part.type !== "string" || (part.type === "text" && typeof part.text !== "string"))) throw new Error("Invalid assistant message in Pi output.");
        last = message;
        settled = false;
        checkpointText = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        checkpoint();
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
  const present = async (state: "running" | Completion["state"]) => {
    if (job.task.presentation !== "agent") return;
    try { await publishPresentation(directory, job, state === "running" ? "working" : state === "done" ? "idle" : "blocked"); }
    catch (error) { await appendFile(join(directory, "presentation-error.log"), `${String(error)}\n`, { mode: 0o600 }).catch(() => {}); }
  };
  try {
    if (cancelled()) interrupted = "Cancelled before worker startup.";
    else {
      // Scheduling lives in the worker, outside the parent's scope lock. Parent
      // cancellation remains observable while this worker waits for global capacity.
      queuePolling = setInterval(() => { if (cancelled()) stop("Cancelled while queued."); }, 100);
      await acquireSlot(directory, queueAbort.signal);
      slot = true;
      clearInterval(queuePolling);
      if (cancelled()) stop("Cancelled while queued.");
      queueAbort.signal.throwIfAborted();
      await present("running");
      if (cancelled()) stop("Cancelled before Pi startup.");
      queueAbort.signal.throwIfAborted();
      // Default remains an ordinary named terminal. Herdr agent presentation is
      // explicit and independent of process ownership and execution protocol.
      process.stdout.write(`\x1b]0;${job.task.role}: ${job.task.name}\x07`);
      show(`${job.task.role}: ${job.task.name}\n${job.task.model || "default model"}\n\n`);
      if (failure) throw new Error(failure);
      events = openSync(join(directory, "events.jsonl"), "w", 0o600);
      errors = openSync(join(directory, "stderr.log"), "w", 0o600);
      const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1", PI_HERDR_JOB_DIR: directory, PI_HERDR_GROUP: job.task.group || "none" };
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
          // RPC shutdown responses must still drain after an earlier failure.
          if (failure && !rpc) return;
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
      if (job.task.persistent) {
        rpc = new RpcControl(directory, child.stdin, fail, () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => fail("Pi did not exit after RPC stdin closed."), 2000);
        });
      }
      timeout = setTimeout(() => stop(`Timed out after ${job.task.timeout}s.`), job.task.timeout * 1000);
      if (tree) {
        try {
          const snapshot = await snapshotProcesses();
          // ProcessTree intentionally never attaches if its first sample missed
          // the root. That is safe for signaling, but cannot prove cleanup.
          if (!snapshot.some((entry) => entry.pid === child!.pid)) throw new Error("Initial process snapshot missed Pi; ownership is unverified.");
          await tree.refresh(snapshot);
          await checkpointExecution();
        } catch (error) { cleanupError ??= `Process snapshot failed: ${String(error)}`; throw error; }
      }
      // Establish durable ownership before releasing the task into stdin. This
      // also avoids a fast print worker exiting before its first process sample.
      if (failure || interrupted) throw new Error(failure || interrupted);
      if (rpc) void rpc.start(job.task.prompt).catch(fail);
      else child.stdin.end(job.task.prompt);
      polling = setInterval(() => {
        if (cancelled()) stop("Cancelled by parent.");
        if (rpc) void rpc.poll().catch(fail);
        if (pollBusy || reaping) return;
        pollBusy = true;
        void tree?.refresh().then(checkpointExecution).catch((error: unknown) => {
          cleanupError ??= `Process snapshot failed: ${String(error)}`;
          fail(error);
        }).finally(() => { pollBusy = false; });
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
    clearInterval(queuePolling);
    clearInterval(polling);
    await reap();
    // signal() reports targets BEFORE delivery. Recheck after escalation instead
    // of treating a successful kill request as proof that descendants are gone.
    const deadline = Date.now() + 2000;
    while (true) {
      const remaining = await signalOwned("SIGKILL");
      if (remaining === 0) { cleanupVerified = true; break; }
      if (remaining === undefined || Date.now() >= deadline) break;
      await delay(50);
    }
    if (!cleanupVerified) cleanupError ??= "Process cleanup could not verify that all owned descendants exited.";
    child?.stdout.destroy();
    child?.stderr.destroy();
    child?.stdin.destroy();
    if (rpc) await rpc.finish(interrupted || failure).catch((error: unknown) => { failure ??= String(error); });
    for (const fd of [events, errors]) if (fd !== undefined) {
      try { closeSync(fd); } catch (error) { failure ??= String(error); }
    }
  }
  await Promise.all([checkpointed, progressSaved]);
  if (cancelled()) interrupted ??= "Cancelled by parent.";
  const report = finalReport(last, code, settled);
  if (!last) report.text = checkpointText;
  let resultError: string | undefined;
  const resultTemporary = join(directory, `result.${randomUUID()}.tmp`);
  try {
    await writeFile(resultTemporary, report.text, { mode: 0o600, flag: "wx" });
    await rename(resultTemporary, join(directory, "result.md"));
  } catch (error) { resultError = `Saving result.md failed: ${String(error)}`; }
  finally { await rm(resultTemporary, { force: true }).catch(() => {}); }
  // done.json is report evidence only. The parent may synthesize it after losing
  // this supervisor, so only this separate, verified acknowledgement permits close.
  if (cleanupVerified && !cleanupError) {
    try {
      await atomic(join(directory, "shutdown.json"), { verified: true });
      if (slot) await releaseSlot(directory);
    }
    catch (error) { cleanupError = `Saving shutdown.json failed: ${String(error)}`; }
  }
  const error = [interrupted || failure || report.error, resultError, cleanupError].filter(Boolean).join("\n") || undefined;
  const done: Completion = { state: resultError ? "failed" : interrupted ? "cancelled" : error ? "failed" : "done", report: report.text, exitCode: code, ...(error ? { error } : {}), ...(cleanupError ? { cleanupError } : {}) };
  await atomic(join(directory, "done.json"), done, true);
  await present(done.state);
  exited = true;
  show(`\n\n[${done.state}]${done.error ? ` ${done.error}` : ""}\nReport: ${join(directory, "result.md")}\n`);
  if (interrupted && !cleanupError) {
    for (const signal of signals) process.off(signal, onSignal);
    process.stdout.off("error", onOutputError);
    return;
  }
  // Reject controls racing final publication while retaining the pane/report.
  // closed.json also gives the parent an explicit mailbox admission boundary.
  setInterval(() => { if (rpc) void rpc.poll().catch(() => {}); }, rpc ? 250 : 60_000);
}
