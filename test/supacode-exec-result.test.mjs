import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execRejectKilled } from "../extensions/supacode-subagents/exec-result.ts";
import { observeSupacodeWorktree } from "../extensions/supacode-subagents/resource-state.ts";

const extensionDir = fileURLToPath(new URL("../extensions/supacode-subagents/", import.meta.url));

test("code-zero pi.exec termination is rejected", async () => {
  const pi = {
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: true }),
  };
  await assert.rejects(
    execRejectKilled(pi, "supacode", ["worktree", "list"]),
    /terminated before settlement/,
  );
  await assert.rejects(
    observeSupacodeWorktree(pi, encodeURIComponent("/tmp/worktree")),
    /terminated before settlement/,
  );
});

test("all extension pi.exec calls pass through the killed-result guard", async () => {
  const files = (await readdir(extensionDir)).filter((name) => name.endsWith(".ts"));
  const directCalls = [];
  for (const file of files) {
    const content = await readFile(new URL(`../extensions/supacode-subagents/${file}`, import.meta.url), "utf8");
    const count = content.match(/\bpi\.exec\s*\(/g)?.length ?? 0;
    if (count > 0) directCalls.push({ file, count });
  }
  assert.deepEqual(directCalls, [{ file: "exec-result.ts", count: 1 }]);
});
