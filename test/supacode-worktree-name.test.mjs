import assert from "node:assert/strict";
import test from "node:test";
import { codingWorktreeName } from "../extensions/supacode-subagents/worktree-name.ts";

const workerId = "4e9a04ef-c879-4986-aa59-d9aa300123d7";

test("coding worktree names combine a readable task slug with a UUID suffix", () => {
  assert.equal(
    codingWorktreeName("Tree-sitter Bash permissions", workerId),
    "tree-sitter-bash-permissions-4e9a04efc879",
  );
  assert.equal(codingWorktreeName("Crème brûlée API", workerId), "creme-brulee-api-4e9a04efc879");
});

test("coding worktree names remove path syntax and bound the readable prefix", () => {
  const name = codingWorktreeName("../../Very long task name ".repeat(5), workerId);

  assert.match(name, /^[a-z0-9-]+-4e9a04efc879$/);
  assert.ok(name.length <= 53);
  assert.equal(name.includes(".."), false);
  assert.equal(name.includes("/"), false);
});

test("coding worktree names fall back for titles without ASCII words", () => {
  assert.equal(codingWorktreeName("修正する", workerId), "task-4e9a04efc879");
});
