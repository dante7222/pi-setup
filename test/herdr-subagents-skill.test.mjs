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

test("options stay small; lifecycle details and diagnostics remain available separately", () => {
  const reference = readFileSync(new URL("../skills/herdr-subagents/reference.md", import.meta.url), "utf8");
  const troubleshooting = readFileSync(new URL("../skills/herdr-subagents/troubleshooting.md", import.meta.url), "utf8");
  assert.ok(reference.length <= 1100, `Options reference grew to ${reference.length} characters`);
  for (const field of ["model", "thinking", "cwd", "timeout", "extensions", "off|minimal|low|medium|high|xhigh|max"])
    assert.ok(reference.includes(field), `Missing option: ${field}`);
  for (const detail of ["stderr.log", "Reload", "acknowledgement", "terminal identity", "APPEND_SYSTEM.md", "not a sandbox", "job.json", "omitted `offset`", "Omitted `collected`/`closed`"])
    assert.ok(troubleshooting.includes(detail), `Missing deferred detail: ${detail}`);
  assert.ok(!reference.includes("stderr.log") && !reference.includes("Process cleanup"));
  for (const document of [skill, reference, troubleshooting]) {
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
