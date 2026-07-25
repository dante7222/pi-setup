import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const wrapper = resolve("extensions/supacode-subagents/bounded-exec.mjs");

function run(args) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [wrapper, ...args], { encoding: "utf8", timeout: 10_000 },
      (error, stdout, stderr) => resolveResult({
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      }));
  });
}

test("bounded exec drains output, caps artifacts, escapes controls, and preserves exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bounded-exec-"));
  try {
    const stdoutPath = join(root, "stdout.log");
    const stderrPath = join(root, "stderr.log");
    const configuration = JSON.stringify({
      stdout: { mode: "capture", path: stdoutPath, maxBytes: 100, append: false, mirror: false },
      stderr: { mode: "capture", path: stderrPath, maxBytes: 80, append: false, mirror: "stderr" },
    });
    const result = await run([
      configuration,
      "--",
      process.execPath,
      "-e",
      "process.stdout.write('x'.repeat(10000)); process.stderr.write('bad\\x1b[31m\\u202e' + 'y'.repeat(10000)); process.exit(7)",
    ]);
    assert.equal(result.code, 7);
    assert.equal((await stat(stdoutPath)).size <= 100, true);
    assert.equal((await stat(stderrPath)).size <= 80, true);
    const stdoutArtifact = await readFile(stdoutPath, "utf8");
    const stderr = await readFile(stderrPath, "utf8");
    assert.equal(stderr.includes("\x1b"), false);
    assert.equal(stderr.includes("\u202e"), false);
    assert.match(stderr, /\\u001b/);
    assert.match(stdoutArtifact, /\[artifact truncated at configured limit\]/);
    assert.match(stderr, /\[artifact truncated at configured limit\]/);
    assert.equal(Buffer.byteLength(result.stderr) <= 80, true);
    assert.equal(result.stderr.includes("\x1b"), false);
    assert.equal(result.stderr.includes("\u202e"), false);
    assert.match(result.stderr, /\[terminal output truncated at configured limit\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded exec treats artifact writer failure as command failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bounded-exec-failure-"));
  try {
    const configuration = JSON.stringify({
      stdout: {
        mode: "capture",
        path: join(root, "missing", "stdout.log"),
        maxBytes: 100,
        append: false,
        mirror: false,
      },
      stderr: { mode: "inherit" },
    });
    const result = await run([configuration, "--", process.execPath, "-e", "process.stdout.write('output')"]);
    assert.equal(result.code, 74);
    assert.match(result.stderr, /bounded-exec:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
