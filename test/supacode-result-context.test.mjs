import assert from "node:assert/strict";
import test from "node:test";
import {
  allocatePerResultContext,
  formatWorkerResults,
  truncateContextHead,
} from "../extensions/supacode-subagents/result-context.ts";

function worker(index, overrides = {}) {
  return {
    id: `worker-${index}`,
    batchId: "batch-id",
    batchTitle: "agents: test",
    title: `worker ${index}`,
    mode: "research",
    state: "completed",
    output: "done",
    resultPath: `/tmp/result-${index}.md`,
    stderrPath: `/tmp/stderr-${index}.log`,
    ...overrides,
  };
}

test("parallel workers share one bounded output budget", () => {
  const budget = allocatePerResultContext(8, 48 * 1024, 800);
  assert.equal(budget.maxBytes * 8, 48 * 1024);
  assert.equal(budget.maxLines * 8, 800);

  const results = Array.from({ length: 8 }, (_, index) => worker(index + 1, {
    mode: "coding",
    output: `${`finding ${index}\n`.repeat(5000)}${"x".repeat(100000)}`,
    worktreePath: `/tmp/worktree-${index}`,
    branch: `pi-agent/${index}`,
    git: {
      changedFiles: ["a.ts", "b.ts"],
      status: "M a.ts\n".repeat(100000),
    },
  }));
  const formatted = formatWorkerResults(results, 48 * 1024, 800);

  assert.ok(Buffer.byteLength(formatted) <= 48 * 1024);
  assert.ok(formatted.split("\n").length <= 800);
  for (const result of results) {
    assert.match(formatted, new RegExp(`## ${result.title} — completed`));
    assert.match(formatted, new RegExp(`/delegate-apply ${result.id}`));
    assert.match(formatted, new RegExp(`Full result: ${result.resultPath}`));
  }
  assert.equal(formatted.includes("M a.ts\nM a.ts"), false);
  assert.equal(formatted.includes("Errors/log:"), false);
  assert.equal(formatted.includes("undefined"), false);
});

test("truncation preserves useful single-line and UTF-8 prefixes", () => {
  const longLine = `start-${"x".repeat(100000)}`;
  const oneLine = truncateContextHead(longLine, 128, 20);
  assert.equal(oneLine.truncated, true);
  assert.ok(oneLine.content.startsWith("start-"));
  assert.ok(Buffer.byteLength(oneLine.content) <= 128);

  const unicode = truncateContextHead("😀".repeat(1000), 101, 20);
  assert.equal(unicode.truncated, true);
  assert.equal(unicode.content.includes("�"), false);
  assert.ok(Buffer.byteLength(unicode.content) <= 101);
});

test("failed results retain diagnostics while successful results omit log paths", () => {
  const formatted = formatWorkerResults([
    worker(1),
    worker(2, {
      mode: "coding",
      state: "failed",
      output: "failed",
      worktreePath: "/tmp/failed-worktree",
    }),
  ], 4096, 100);

  assert.equal((formatted.match(/Errors\/log:/g) ?? []).length, 1);
  assert.equal(formatted.includes("/delegate-apply worker-2"), false);
  assert.match(formatted, /Result truncated|failed/);
});

test("the complete formatted result stays within the requested byte limit", () => {
  const longPath = `/${"a".repeat(980)}`;
  const results = Array.from({ length: 8 }, (_, index) => worker(index + 1, {
    mode: "coding",
    output: "x".repeat(100000),
    resultPath: longPath,
    stderrPath: longPath,
    worktreePath: longPath,
    branch: `pi-agent/${index}`,
  }));
  const formatted = formatWorkerResults(results, 50 * 1024, 800);

  assert.ok(Buffer.byteLength(formatted) <= 50 * 1024);
  assert.ok(formatted.split("\n").length <= 800);
  assert.match(formatted, /Result truncated/);
});
