import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  editSessionGroupContextInZed,
  SessionGroupEditorError,
} from "../extensions/session-groups/editor.ts";

test("publishes the launcher PID before exec preserves it as Zed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-editor-"));
  const binDirectory = join(directory, "bin");
  const contextPath = join(directory, "context.md");
  const markerPath = join(directory, "zed-started");
  const previousPath = process.env.PATH;
  try {
    await mkdir(binDirectory);
    await writeFile(contextPath, "# Context\n", "utf8");
    const zedPath = join(binDirectory, "zed");
    await writeFile(
      zedPath,
      `#!/bin/sh\nprintf '%s' "$$" > "${markerPath}"\nsleep 0.05\nexit 0\n`,
      "utf8",
    );
    await chmod(zedPath, 0o700);
    process.env.PATH = `${binDirectory}:${previousPath ?? ""}`;

    const pids = [];
    await editSessionGroupContextInZed({}, contextPath, async (pid) => {
      pids.push(pid);
      if (pid !== null) {
        assert.equal(existsSync(markerPath), false);
        process.kill(pid, 0);
      }
    });

    assert.equal(typeof pids[0], "number");
    assert.equal(pids.at(-1), null);
    assert.equal(Number(await readFile(markerPath, "utf8")), pids[0]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports a missing Zed executable without fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-group-editor-missing-"));
  const contextPath = join(directory, "context.md");
  const previousPath = process.env.PATH;
  try {
    await writeFile(contextPath, "# Context\n", "utf8");
    process.env.PATH = directory;
    await assert.rejects(
      editSessionGroupContextInZed({}, contextPath),
      SessionGroupEditorError,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
