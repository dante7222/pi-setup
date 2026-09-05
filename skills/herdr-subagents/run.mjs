#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { cleanup, closeJobs, collect, jobs, locked, scopeFor, spawnTasks, status, validateTasks } from "../../extensions/herdr-subagents/core.ts";
import { runWorker } from "../../extensions/herdr-subagents/worker.ts";

const [command, ...args] = process.argv.slice(2);
const emit = (value) => new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
});

try {
  if (command === "worker") {
    if (args.length !== 1) throw new Error("Worker directory required.");
    await runWorker(args[0]);
  } else {
    const scope = scopeFor();
    switch (command) {
      case "spawn": {
        if (args.length > 1) throw new Error("spawn accepts a JSON file path, or stdin.");
        const tasks = validateTasks(JSON.parse(await readFile(args[0] || "/dev/stdin", "utf8")));
        const created = await spawnTasks(scope, tasks);
        await emit({ jobs: created.map((job) => ({ id: job.id, name: job.task.name })) });
        break;
      }
      case "status": {
        const offset = args.length ? Number(args[0]) : 0;
        if (args.length > 1 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("status accepts a nonnegative offset.");
        await emit({ root: scope.root, ...await status(scope, offset) });
        break;
      }
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
      default: throw new Error("Usage: run.mjs spawn [tasks.json] | status [offset] | collect [0..60] | close | cancel <id...|all>");
    }
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
