import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { validateTasks } from "../extensions/herdr-subagents/core.ts";

const directory = fileURLToPath(new URL("../skills/herdr-subagents/", import.meta.url));
const skill = readFileSync(new URL("../skills/herdr-subagents/SKILL.md", import.meta.url), "utf8");

test("Herdr exposes one discoverable skill, not its optional reference", () => {
  const loaded = loadSkillsFromDir({ dir: directory, source: "test" });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.skills.map((entry) => entry.name), ["herdr-subagents"]);
  assert.equal(loaded.skills[0].disableModelInvocation, false);
  assert.ok(loaded.skills[0].description.length <= 120);
  const passive = formatSkillsForPrompt(loaded.skills);
  assert.ok(passive.includes(loaded.skills[0].description));
  assert.ok(!passive.includes("pending: 0"));
  assert.ok(!passive.includes("reference.md"));
});

test("Herdr operational instructions stay compact without losing safety or collection rules", () => {
  // Character budgets are portable and deterministic; token counts vary by model.
  assert.ok(skill.length <= 1800, `Operational skill grew to ${skill.length} characters`);
  for (const required of [
    "**bash**", "self-contained", "no parent history", "No overlapping writes",
    "Normal Pi tools/extensions; roles are not permissions", "16 open jobs", "collect 60", "Bash timeout 75s",
    "pending: 0", "complete: false", "failed/cancelled is not success", "never pipe/truncate",
    "before your final response", "never force-close", "unacknowledged cancellation",
  ]) assert.ok(skill.includes(required), `Missing operational rule: ${required}`);
  assert.match(skill, /Read \[reference\.md\]\(reference\.md\) only for/);
  const reference = readFileSync(new URL("../skills/herdr-subagents/reference.md", import.meta.url), "utf8");
  for (const field of ["timeout", "extensions", "thinking", "stderr.log", "Reload"])
    assert.ok(reference.includes(field), `Missing deferred detail: ${field}`);
});

test("Herdr compact spawn example matches the actual CLI task format", () => {
  const example = skill.match(/spawn <<'JSON'\n([\s\S]*?)\nJSON/);
  assert.ok(example);
  const tasks = validateTasks(JSON.parse(example[1]), {});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].role, "reviewer");
  assert.equal(tasks[0].name, "review-auth");
});
