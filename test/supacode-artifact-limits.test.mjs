import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_WORKER_RESULT_BYTES,
  boundedArtifactText,
} from "../extensions/supacode-subagents/artifact-limits.ts";
import { publishWorkerReport, readWorkerReport } from "../extensions/supacode-subagents/lifecycle.ts";

test("worker result artifacts have a strict byte limit and explicit truncation marker", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "pi-bounded-worker-result-"));
  try {
    const output = "x".repeat(MAX_WORKER_RESULT_BYTES * 2);
    const report = await publishWorkerReport(jobDir, "job", "nonce", { state: "completed" }, output);
    assert.equal((await stat(report.resultFile)).size <= MAX_WORKER_RESULT_BYTES, true);
    assert.match(await readFile(report.resultFile, "utf8"), /Artifact truncated/);
    assert.equal(boundedArtifactText("short"), "short\n");
    const exactLimit = boundedArtifactText("x".repeat(MAX_WORKER_RESULT_BYTES));
    assert.equal(Buffer.byteLength(exactLimit), MAX_WORKER_RESULT_BYTES);
    assert.equal(Buffer.byteLength(boundedArtifactText("oversized", 1, 1)) <= 1, true);
    assert.equal((await readWorkerReport(jobDir, "job", "nonce")).resultSha256, report.resultSha256);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
