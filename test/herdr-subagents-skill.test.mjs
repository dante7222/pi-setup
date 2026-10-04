import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { validateTasks } from "../extensions/herdr-subagents/core.ts";

const directory = fileURLToPath(new URL("../skills/herdr-subagents/", import.meta.url));
const skill = readFileSync(new URL("../skills/herdr-subagents/SKILL.md", import.meta.url), "utf8");

test("Herdr exposes one bounded discovery entry, not its deferred documentation", () => {
  const loaded = loadSkillsFromDir({ dir: directory, source: "test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.skills.map((entry) => entry.name), ["herdr-subagents"]);
  assert.equal(loaded.skills[0].disableModelInvocation, false);
  assert.ok(loaded.skills[0].description.length <= 120);
  const passive = formatSkillsForPrompt(loaded.skills);
  assert.ok(passive.includes(loaded.skills[0].description));
  assert.ok(!passive.includes("pending: 0"));
  assert.ok(!passive.includes("reference.md"));
  assert.ok(!passive.includes("troubleshooting.md"));
  // Normalize only the checkout path: XML and the shared skills preamble count too.
  const portable = formatSkillsForPrompt([{ ...loaded.skills[0], filePath: "/package/herdr-subagents/SKILL.md" }]);
  assert.ok(Buffer.byteLength(portable) <= 640, `Discovery prompt grew to ${Buffer.byteLength(portable)} bytes`);
});

test("Herdr operational instructions stay compact without losing safety or collection rules", () => {
  // Character budgets are portable and deterministic; token counts vary by model.
  assert.ok(skill.length <= 1800, `Operational skill grew to ${skill.length} characters`);
  for (const required of [
    "**bash**", "self-contained", "no parent history", "No overlapping writes",
    "Normal Pi tools/extensions; roles are not permissions", "16 open jobs", "collect 60", "Bash timeout 75s",
    "pending: 0", "complete: false", "failed/cancelled is not success", "never pipe/truncate",
    "before your final response", "never force-close", "unacknowledged cancellation", "omit when matching the parent",
  ]) assert.ok(skill.includes(required), `Missing operational rule: ${required}`);
  assert.match(skill, /Read \[reference\.md\]\(reference\.md\) only for/);
  assert.match(skill, /\[troubleshooting\.md\]\(troubleshooting\.md\) for lifecycle\/errors/);
});

test("parent orchestration is codemode-first without forcing worker tool routing", () => {
  const orchestration = readFileSync(new URL("../skills/herdr-subagents/orchestration.md", import.meta.url), "utf8");
  assert.ok(skill.includes("use **codemode with native `tools.subagents(...)`**, not the Bash runner"));
  assert.ok(skill.includes("Without codemode, call native `subagents` directly"));
  assert.ok(skill.includes("Only without native tools, use the CLI"));
  assert.ok(skill.includes("Emit pages before acknowledging them in a later call"));
  assert.ok(orchestration.includes("Do not wrap the Bash runner in codemode"));
  assert.ok(orchestration.includes("A failed or denied call is not unavailability"));
  assert.ok(orchestration.includes("Ordinary workers retain direct tools"));
  const setup = readFileSync(new URL("../skills/herdr-subagents/setup.md", import.meta.url), "utf8");
  assert.ok(setup.includes("already-running workers do not reload automatically"));
  for (const required of [
    'action:"next"', 'store("herdr.receipts"', "only after consuming every page", "in a later model call",
    "Newly returned pages are never acknowledged in that call", "Do not loop", "One cycle per model call",
    "emit the entire result, without unrelated output", "Check `ok` even when calls resolve",
    "inspect `errors` even when `ok:true`", "Failed/cancelled reports are not success",
    "Finish only on `finished:true`", "acknowledgementRequired:true, finished:false", "even with pending zero",
    "12 KB aggregate budget", "Never ack unseen/truncated output", "No consuming `collect` from codemode",
    "separate successful call", "Let this call succeed before spawning", "commits stores only on successful scripts",
    "rerun **only spawn** with the stored ID", "Never regenerate an ID to bypass uncertainty",
    "automatic replacement workers", "not blind replay", 'store("herdr.operation",undefined)',
    "not a heartbeat or proof of a stall", "troubleshooting.md#native-delivery-recovery",
    'action:"prepare"', "codemode retains only the ID", "not preparation",
  ]) assert.ok(orchestration.includes(required), `Missing first-use safety rule: ${required}`);
  assert.ok(!orchestration.includes('"defaultTools"'), "Setup details should not inflate the mandatory workflow guide");
  assert.ok(orchestration.length <= 4200, `Native workflow grew to ${orchestration.length} characters`);
  assert.ok(orchestration.indexOf("```js") < 650, "Start with the executable happy path, not reference material");
  const settings = JSON.parse(setup.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(settings, { defaultTools: ["+codemode", "+tool_search"], codemode: { mode: "on" } });
});

test("native progress is an opt-in cycle variation, not another executable recipe", () => {
  const guide = readFileSync(new URL("../skills/herdr-subagents/orchestration.md", import.meta.url), "utf8");
  const scripts = [...guide.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.equal(scripts.length, 4);
  assert.ok(scripts.every((script) => !script.includes("details:")), "Progress must not inflate default responses");
  assert.ok(guide.includes('`{action:"next", acknowledge:load("herdr.receipts") ?? [], seconds:30, details:true}`'));
  assert.ok(guide.includes("Progress is opt-in"));
  assert.ok(guide.includes("Keep the same emit/read/later-ack steps"));
  assert.ok(guide.includes("not a heartbeat or proof of a stall"));
});

test("options stay small; lifecycle details and diagnostics remain available separately", () => {
  const reference = readFileSync(new URL("../skills/herdr-subagents/reference.md", import.meta.url), "utf8");
  const troubleshooting = readFileSync(new URL("../skills/herdr-subagents/troubleshooting.md", import.meta.url), "utf8");
  assert.ok(reference.length <= 1100, `Options reference grew to ${reference.length} characters`);
  for (const field of ["model", "thinking", "cwd", "timeout", "extensions", "off|minimal|low|medium|high|xhigh|max"])
    assert.ok(reference.includes(field), `Missing option: ${field}`);
  for (const detail of ["stderr.log", "Reload", "acknowledgement", "terminal identity", "APPEND_SYSTEM.md", "not a sandbox", "job.json", "omitted `offset`", "Omitted `collected`/`closed`"])
    assert.ok(troubleshooting.includes(detail), `Missing deferred detail: ${detail}`);
  for (const detail of [
    'text(await describeTool("subagents"))', 'await describeNamespace("subagents")', "1–3 action names",
    "printing a promise gives `{}`", "Neither activates the schema", "not security tokens",
    "262,144 JSON characters/value", "compact ID", "Defaults stay fixed from first admission",
    "host-generated UUID", "prepared-origin", "no spawn was attempted", "never prepare a replacement",
    "Changed tasks collide", "immutable snapshot", "Admission `done` is not worker completion", "incomplete artifacts",
    "one stored operation at a time", "{ok,action,data?,error?}", "UTF-16 offset", "per-job read failures",
    "unfinished/unlisted jobs", "**not** pages still requiring acknowledgement", "closedOmitted",
    "reports and errors are empty and pending is zero", "clear only the local `herdr.receipts` store",
    "without acknowledgements to reread from host cursors", "Do not guess receipts or acknowledge by job ID",
    "contiguous and idempotent", "those effects are not rolled back", "Retrying the same old receipts is safe",
    "newly issued pages remain unacknowledged", "Fatal acknowledgement/cleanup errors stop before new delivery",
    "`seconds:0..60` bounds waiting", "Cancelling a wait alone does not cancel workers",
    "at most 16 pending-worker phases", "including queue time", "last-event age/tool and an omitted count",
    "selective acknowledgement", "presets and concurrency", "durable prototype",
  ]) assert.ok(troubleshooting.includes(detail), `Missing relocated native guidance: ${detail}`);
  assert.ok(!reference.includes("stderr.log") && !reference.includes("Process cleanup"));
  const orchestration = readFileSync(new URL("../skills/herdr-subagents/orchestration.md", import.meta.url), "utf8");
  const setup = readFileSync(new URL("../skills/herdr-subagents/setup.md", import.meta.url), "utf8");
  for (const document of [skill, reference, troubleshooting, orchestration, setup, readFileSync(new URL("../skills/herdr-subagents/manual.md", import.meta.url), "utf8")]) {
    for (const [, path] of document.matchAll(/\]\(([^)]+\.md)\)/g)) {
      assert.ok(readFileSync(new URL(`../skills/herdr-subagents/${path}`, import.meta.url), "utf8"));
    }
  }
});

test("Herdr compact spawn example matches the actual CLI task format", () => {
  const example = skill.match(/spawn <<'JSON'\n([\s\S]*?)\nJSON/);
  assert.ok(example);
  const input = JSON.parse(example[1]);
  for (const field of ["cwd", "model", "thinking"]) assert.ok(!Object.hasOwn(input[0], field));
  const tasks = validateTasks(input, { PI_PROVIDER: "provider", PI_MODEL: "model", PI_REASONING_LEVEL: "xhigh" }, directory);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].role, "reviewer");
  assert.equal(tasks[0].name, "review-auth");
  assert.equal(tasks[0].model, "provider/model");
  assert.equal(tasks[0].thinking, "xhigh");
  assert.equal(tasks[0].cwd, directory.replace(/\/$/, ""));
});
