#!/usr/bin/env node
// Development runner: execute subagent tasks with the new manager outside a Pi
// session (for example before /reload). Reads a JSON task array on stdin, prints
// each report as it arrives, exits when all are done.
// Usage: node --experimental-strip-types test/live/run-tasks.mjs < tasks.json
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { formatReport } from "../../extensions/subagents/index.ts";
import { SubagentManager } from "../../extensions/subagents/manager.ts";
import { validateTasks } from "../../extensions/subagents/tasks.ts";

const inputs = JSON.parse(await text(process.stdin));
const dir = await mkdtemp(join(tmpdir(), "subagents-run-"));
const manager = new SubagentManager({
  dir,
  env: process.env,
  promptExtension: fileURLToPath(new URL("../../extensions/subagents/worker-prompt.ts", import.meta.url)),
  invocation: { command: "pi", prefix: [] },
  hooks: { changed() {}, report() {} },
});
const defaults = { cwd: process.cwd(), model: undefined, thinking: undefined, resolveModel: (pattern) => pattern };
manager.spawn(validateTasks(inputs, defaults, new Set()));
let remaining = inputs.length;
while (remaining > 0) {
  const { reports, pending } = await manager.wait([], 1800);
  for (const report of reports) { console.log(`${formatReport(report)}\n(full: ${report.path})\n`); remaining--; }
  if (!reports.length && !pending.length) break;
}
await manager.dispose();
