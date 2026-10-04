#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { cleanup, closeJobs, collect, jobs, locked, scopeFor, spawnTasks, status } from "../../extensions/herdr-subagents/core.ts";
import { claimScope } from "../../extensions/herdr-subagents/ownership.ts";
import { continueTask, sendTask, stopTask } from "../../extensions/herdr-subagents/conversations.ts";
import { reattachJob, replayViewer } from "../../extensions/herdr-subagents/presentation.ts";
import { configure, settings } from "../../extensions/herdr-subagents/scheduler.ts";
import { recoverTask } from "../../extensions/herdr-subagents/recovery.ts";
import { configurePresets, presets, resolveTasks } from "../../extensions/herdr-subagents/policy.ts";
import { runWorker } from "../../extensions/herdr-subagents/worker.ts";
import { acknowledgeReport, readReport, waitForReports } from "../../extensions/herdr-subagents/reports.ts";

const [command, ...args] = process.argv.slice(2);
const emit = (value) => new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
});

try {
  if (command === "worker") {
    if (args.length !== 1) throw new Error("Worker directory required.");
    await runWorker(args[0]);
  } else if (command === "resume-job") {
    if (args.length !== 1) throw new Error("Viewer directory required.");
    await replayViewer(args[0]);
  } else {
    const scope = scopeFor();
    await claimScope(scope);
    switch (command) {
      case "spawn": {
        if (args.length > 2) throw new Error("spawn accepts [tasks.json|-] [requestId]; omit the file or use - for stdin.");
        const intent = JSON.parse(await readFile(!args[0] || args[0] === "-" ? "/dev/stdin" : args[0], "utf8"));
        const created = await spawnTasks(scope, {
          intent,
          resolve: (input) => resolveTasks(scope, input, process.env, process.cwd()),
        }, args[1]);
        await emit({ jobs: created.map((job) => ({ id: job.id, name: job.task.name })) });
        break;
      }
      case "continue": {
        if (args.length < 2 || args.length > 3) throw new Error("continue <id> <requestId> [prompt-file|-]");
        const prompt = await readFile(!args[2] || args[2] === "-" ? "/dev/stdin" : args[2], "utf8");
        const created = await continueTask(scope, args[0], prompt, args[1]);
        await emit({ jobs: created.map((job) => ({ id: job.id, name: job.task.name, conversationId: job.conversationId })) });
        break;
      }
      case "send": {
        if (args.length < 3 || args.length > 4 || !["steer", "follow_up"].includes(args[1])) throw new Error("send <id> <steer|follow_up> <requestId> [message-file|-]");
        await emit(await sendTask(scope, args[0], await readFile(!args[3] || args[3] === "-" ? "/dev/stdin" : args[3], "utf8"), args[1], args[2]));
        break;
      }
      case "stop":
      case "recover":
        if (args.length !== 1) throw new Error(`${command} requires one job ID.`);
        await emit(await (command === "stop" ? stopTask(scope, args[0]) : recoverTask(scope, args[0])));
        break;
      case "reattach": {
        if (args.length < 1 || args.length > 2) throw new Error("reattach <id> [pane]");
        const job = await reattachJob(scope, args[0], args[1]);
        await emit({ id: job.id, pane: job.pane, terminal: job.terminal });
        break;
      }
      case "configure": {
        if (args.length > 1) throw new Error("configure [settings.json|-]");
        const input = args.length ? JSON.parse(await readFile(args[0] === "-" ? "/dev/stdin" : args[0], "utf8")) : {};
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["concurrency", "presets"].includes(key))) throw new Error("Expected concurrency and/or presets settings.");
        const models = input.presets === undefined ? await presets(scope) : await configurePresets(scope, input.presets);
        await emit({ ...await (input.concurrency === undefined ? settings(scope) : configure(scope, input.concurrency)), presets: models });
        break;
      }
      case "status": {
        const offset = args.length ? Number(args[0]) : 0;
        if (args.length > 1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("status accepts a nonnegative offset.");
        await emit({ root: scope.root, ...await status(scope, offset) });
        break;
      }
      case "read":
        if (args.length < 1 || args.length > 2) throw new Error("read requires job ID and optional offset.");
        await emit(await readReport(scope, args[0], args[1] === undefined ? undefined : Number(args[1])));
        break;
      case "ack":
        if (args.length !== 1) throw new Error("ack requires one report receipt.");
        await emit(await acknowledgeReport(scope, args[0]));
        break;
      case "wait":
        if (args.length > 1) throw new Error("wait accepts seconds (0..60).");
        await emit(await waitForReports(scope, args.length ? Number(args[0]) : 0));
        break;
      case "collect": {
        const wait = args.length ? Number(args[0]) : 0;
        if (args.length > 1 || !Number.isInteger(wait) || wait < 0 || wait > 60) throw new Error("collect accepts wait seconds (0..60).");
        await collect(scope, wait, emit);
        break;
      }
      case "close":
        if (args.length) throw new Error("close takes no arguments; it closes collected panes only.");
        await emit({ closed: await cleanup(scope) });
        break;
      case "cancel":
        if (!args.length) throw new Error("cancel requires job IDs, or 'all'.");
        await locked(scope, async () => {
          const all = await jobs(scope);
          if (!(args.length === 1 && args[0] === "all") && args.some((id) => !all.some((job) => job.id === id))) throw new Error("Unknown job ID.");
          const selected = all.filter((job) => args[0] === "all" || args.includes(job.id));
          await closeJobs(scope, selected, true);
        });
        await emit({ cancelled: args });
        break;
      default: throw new Error("Usage: run.mjs spawn [tasks.json|-] [requestId] | status [offset] | wait [0..60] | read <id> [offset] | ack <receipt> | collect [0..60] | close | cancel <id...|all> | continue <id> <requestId> [prompt-file|-] | send <id> <steer|follow_up> <requestId> [message-file|-] | stop <id> | recover <id> | reattach <id> [pane] | configure [settings.json|-]");
    }
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
