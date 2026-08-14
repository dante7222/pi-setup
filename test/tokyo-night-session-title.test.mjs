import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  formatSessionTitle,
  truncateSessionTitle,
} from "../extensions/tokyo-night-footer/index.ts";

test("package loads the footer before session groups can publish startup state", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const extensions = packageJson.pi.extensions;
  assert.equal(
    extensions.indexOf("./extensions/tokyo-night-footer/index.ts") <
      extensions.indexOf("./extensions/session-groups/index.ts"),
    true,
  );
});

test("appends the session group in brackets after the agent title", () => {
  assert.equal(
    formatSessionTitle("Partition huge table", "partitioning"),
    "Partition huge table [partitioning]",
  );
});

test("formats agent-only, group-only, and empty titles", () => {
  assert.equal(formatSessionTitle("Partition huge table", undefined), "Partition huge table");
  assert.equal(formatSessionTitle(undefined, "partitioning"), "[partitioning]");
  assert.equal(formatSessionTitle(undefined, undefined), undefined);
});

test("truncation preserves a visible bracketed group suffix", () => {
  const groupName = "g".repeat(30);
  const title = truncateSessionTitle("s".repeat(40), groupName, 60);
  assert.equal(title.endsWith(`[${groupName}]`), true);
  assert.equal(title.includes("…"), true);

  const longGroupOnly = truncateSessionTitle(undefined, "partitioning-work", 12);
  assert.equal(longGroupOnly.startsWith("["), true);
  assert.equal(longGroupOnly.endsWith("]"), true);
  assert.equal(longGroupOnly.includes("…"), true);
});
