#!/usr/bin/env node
// Manual live check against the installed `pi`: spawn, follow-up with history,
// steer a running worker, stop during startup and mid-run.
// Usage: node --experimental-strip-types test/live/subagents-smoke.mjs [provider/model]
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SubagentManager } from "../../extensions/subagents/manager.ts";
import { validateTasks } from "../../extensions/subagents/tasks.ts";

const model = process.argv[2] ?? "openai-codex/gpt-6-astra";
const dir = await mkdtemp(join(tmpdir(), "subagents-live-"));
const manager = new SubagentManager({
  dir,
  env: process.env,
  promptExtension: fileURLToPath(new URL("../../extensions/subagents/worker-prompt.ts", import.meta.url)),
  invocation: { command: "pi", prefix: [] },
  hooks: { changed() {}, report() {} },
});
const defaults = { cwd: process.cwd(), model: undefined, thinking: undefined, resolveModel: (pattern) => pattern };
const spawn = (name, task, role = "explorer") => manager.spawn(validateTasks([{ name, role, model: `${model}:low`, task }], defaults, new Set()));
const show = (label, { reports }) => console.log(label, reports.map((r) => `${r.state} ${JSON.stringify(r.text.slice(0, 120))} ${r.error ?? ""}`).join(" | ") || "none");
let failed = false;
const check = (label, ok) => { console.log(ok ? "PASS" : "FAIL", label); failed ||= !ok; };

const started = Date.now();
spawn("count", "Run `ls extensions` with bash, then reply with only the number of entries.");
const first = await manager.wait(["count"], 180);
show(`first (${Date.now() - started}ms):`, first);
check("first run done", first.reports[0]?.state === "done");
console.log("send:", await manager.send("count", "What number did you report before? Reply with just that number plus 1."));
const second = await manager.wait(["count"], 180);
show("second:", second);
check("follow-up keeps history", second.reports[0]?.state === "done" && /\d/.test(second.reports[0].text));

spawn("steer", "Run `sleep 6` with bash. Then reply with exactly the word ALPHA.");
await delay(4000);
console.log("steer:", await manager.send("steer", "Change of plan: when done, reply with exactly the word BRAVO instead."));
const steered = await manager.wait(["steer"], 180);
show("steered:", steered);
check("steer changes answer", /BRAVO/.test(steered.reports[0]?.text ?? ""));

spawn("early", "Run `sleep 30` with bash, then reply DONE.");
await delay(200);
manager.stop(["early"]);
const early = await manager.wait(["early"], 30);
show("stop during startup:", early);
check("startup stop cancels", early.reports[0]?.state === "cancelled");

spawn("mid", "Run `sleep 30` with bash, then reply DONE.");
await delay(6000);
const stopAt = Date.now();
manager.stop(["mid"]);
const mid = await manager.wait(["mid"], 30);
show(`stop mid-run (${Date.now() - stopAt}ms):`, mid);
check("mid-run stop cancels quickly", mid.reports[0]?.state === "cancelled" && Date.now() - stopAt < 12_000);

await manager.dispose();
console.log("dir:", dir);
process.exitCode = failed ? 1 : 0;
