import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSessionGroupContext,
  appendUnavailableSessionGroupContext,
} from "../extensions/session-groups/context.ts";

const snapshot = {
  id: "019cda47-9baf-7000-8000-000000000001",
  name: "partitioning",
  path: "/private/context.md",
  content: "## Decision\n\nUse monthly partitions.\n",
  bytes: 39,
  revision: 3,
  sha256: "a".repeat(64),
};

test("appends complete scoped context and explicit-update policy", () => {
  const prompt = appendSessionGroupContext("base prompt", snapshot);
  assert.match(prompt, /^base prompt/);
  assert.match(prompt, /global session group 'partitioning'/);
  assert.match(prompt, /contextual scoping, not an operating-system security boundary/);
  assert.match(prompt, /only through edit_group_context/);
  assert.match(prompt, /Use monthly partitions/);
  assert.match(prompt, new RegExp(snapshot.sha256));
  assert.doesNotMatch(prompt, /\/private\/context\.md/);
});

test("appends only a short warning when shared context is unavailable", () => {
  const prompt = appendUnavailableSessionGroupContext(
    "base prompt",
    "partitioning",
    "context exceeds 65536 bytes",
    true,
  );
  assert.match(prompt, /Shared session-group context unavailable/);
  assert.match(prompt, /\/group edit/);
  assert.doesNotMatch(prompt, /Use monthly partitions/);

  const metadataPrompt = appendUnavailableSessionGroupContext(
    "base prompt",
    "partitioning",
    "metadata is corrupt",
    false,
  );
  assert.doesNotMatch(metadataPrompt, /\/group edit/);
  assert.match(metadataPrompt, /metadata must be repaired/);
});
