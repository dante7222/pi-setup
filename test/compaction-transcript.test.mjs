import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import compactionTranscript from "../extensions/compaction-transcript/index.ts";
import {
  renderTranscript,
  resolveTranscriptTitle,
  serializeActiveBranch,
} from "../extensions/compaction-transcript/render.ts";

const header = {
  type: "session",
  version: 3,
  id: "session-123",
  timestamp: "2026-03-19T10:00:00.000Z",
  cwd: "/tmp/project",
};

const usage = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const userText = "  leading spaces stay\n\n# User-authored heading\ntrailing spaces stay  ";
const firstThinking = "Inspect the exact session entries.";
const secondThinking = "Now synthesize the final answer.";
const firstResponse = "I will inspect the relevant file.";
const finalResponse = "## Final answer\n\nThe readable response remains exact.";
const toolOutput = "# README\n\nDiagnostic tool output that should not enter the reading view.";

const entries = [
  {
    type: "message",
    id: "user0001",
    parentId: null,
    timestamp: "2026-03-19T10:00:01.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: userText, textSignature: "user-signature" },
        { type: "image", data: "AAEC", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
  },
  {
    type: "message",
    id: "asst0001",
    parentId: "user0001",
    timestamp: "2026-03-19T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: firstThinking, thinkingSignature: "opaque-signature" },
        { type: "text", text: firstResponse },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "README.md", exact: "  value  " },
          thoughtSignature: "tool-signature",
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      responseId: "response-1",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
  },
  {
    type: "message",
    id: "tool0001",
    parentId: "asst0001",
    timestamp: "2026-03-19T10:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: toolOutput }],
      details: { nested: { preserved: true }, absent: null },
      isError: false,
      timestamp: 3,
    },
  },
  {
    type: "message",
    id: "asst0002",
    parentId: "tool0001",
    timestamp: "2026-03-19T10:00:04.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: secondThinking },
        { type: "text", text: finalResponse },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage,
      stopReason: "stop",
      timestamp: 4,
    },
  },
  {
    type: "message",
    id: "bash0001",
    parentId: "asst0002",
    timestamp: "2026-03-19T10:00:05.000Z",
    message: {
      role: "bashExecution",
      command: "git status --short",
      output: " M README.md",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 5,
    },
  },
  {
    type: "custom_message",
    id: "custom01",
    parentId: "bash0001",
    timestamp: "2026-03-19T10:00:06.000Z",
    customType: "fixture",
    content: "hidden extension context",
    details: { source: "test" },
    display: false,
  },
  {
    type: "model_change",
    id: "model001",
    parentId: "custom01",
    timestamp: "2026-03-19T10:00:07.000Z",
    provider: "openai",
    modelId: "gpt-test",
  },
  {
    type: "compaction",
    id: "compact1",
    parentId: "model001",
    timestamp: "2026-03-19T10:00:08.000Z",
    summary: "Generated compaction summary that should not enter the reading view.",
    firstKeptEntryId: "tool0001",
    tokensBefore: 42_000,
    details: { readFiles: ["README.md"], modifiedFiles: [] },
  },
];

test("serializes the complete active branch without dropping stored fields", () => {
  const raw = serializeActiveBranch(header, entries);
  const parsed = raw.trimEnd().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(parsed, [header, ...entries]);
  assert.equal(raw.endsWith("\n"), true);
});

test("uses the Pi session name and falls back to the first question for its title", () => {
  assert.equal(resolveTranscriptTitle(entries, "  Readable   Session  "), "Readable Session");
  assert.match(resolveTranscriptTitle(entries, undefined), /^leading spaces stay # User-authored heading/);
});

test("renders only questions, model thinking, and model responses", () => {
  const rawFileName = `readable-session--123456789abc.${"a".repeat(64)}.active-branch.jsonl`;
  const markdown = renderTranscript({
    entries,
    generatedAt: "2026-03-19T10:01:00.000Z",
    rawFileName,
    sessionId: header.id,
    title: "Readable *Session*",
  });

  assert.ok(markdown.startsWith("# Readable \\*Session\\*\n"));
  assert.ok(markdown.includes(userText));
  assert.ok(markdown.includes(`> ${firstThinking}`));
  assert.ok(markdown.includes(`> ${secondThinking}`));
  assert.ok(markdown.includes(firstResponse));
  assert.ok(markdown.includes(finalResponse));
  assert.ok(markdown.includes("> [!abstract]- Model thinking"));
  assert.ok(markdown.includes("## Contents"));
  assert.ok(markdown.includes("- [[#Question 1|1. leading spaces stay # User-authored heading"));
  assert.ok(markdown.includes("## Question 1"));
  assert.ok(markdown.includes("### Response"));
  assert.ok(markdown.includes(`lossless-sidecar: ${rawFileName}`));

  assert.equal(markdown.includes(toolOutput), false);
  assert.equal(markdown.includes("README.md"), false);
  assert.equal(markdown.includes("git status --short"), false);
  assert.equal(markdown.includes("hidden extension context"), false);
  assert.equal(markdown.includes("Generated compaction summary"), false);
  assert.equal(markdown.includes("AAEC"), false);
  assert.equal(markdown.includes("Lossless active-branch data"), false);
  assert.equal(markdown.endsWith("\n"), true);
});

test("commits matching content-addressed snapshots after successful compaction", async (context) => {
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-transcript-test-"));
  context.after(async () => fs.promises.rm(temporaryDirectory, { recursive: true, force: true }));

  let compactHandler;
  const notifications = [];
  compactionTranscript({
    on(name, handler) {
      if (name === "session_compact") compactHandler = handler;
    },
    registerCommand() {},
  });

  assert.equal(typeof compactHandler, "function");
  const sessionFile = path.join(temporaryDirectory, "2026-session.jsonl");
  const transcriptDirectory = path.join(temporaryDirectory, "transcripts");
  const legacyMarkdownPath = path.join(transcriptDirectory, "2026-session.md");
  await fs.promises.mkdir(transcriptDirectory, { mode: 0o777 });
  await fs.promises.writeFile(legacyMarkdownPath, "legacy transcript", "utf8");
  if (process.platform !== "win32") await fs.promises.chmod(transcriptDirectory, 0o777);

  const ctx = {
    hasUI: true,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getBranch: () => entries,
      getHeader: () => header,
      getSessionFile: () => sessionFile,
      getSessionId: () => header.id,
      getSessionName: () => "Fixture Session",
    },
  };
  const event = {
    type: "session_compact",
    compactionEntry: entries.at(-1),
    fromExtension: false,
    reason: "threshold",
    willRetry: false,
  };

  await compactHandler(event, ctx);

  const sessionKey = createHash("sha256").update(header.id).digest("hex").slice(0, 12);
  const markdownPath = path.join(transcriptDirectory, `fixture-session--${sessionKey}.md`);
  const firstMarkdown = await fs.promises.readFile(markdownPath, "utf8");
  const firstSidecars = (await fs.promises.readdir(transcriptDirectory))
    .filter((name) => name.endsWith(".active-branch.jsonl"));
  assert.equal(firstSidecars.length, 1);
  assert.match(firstSidecars[0], new RegExp(`^fixture-session--${sessionKey}\\.[a-f0-9]{64}\\.active-branch\\.jsonl$`));
  const firstRawPath = path.join(transcriptDirectory, firstSidecars[0]);
  assert.equal(await fs.promises.readFile(firstRawPath, "utf8"), serializeActiveBranch(header, entries));
  assert.ok(firstMarkdown.startsWith("# Fixture Session\n"));
  assert.ok(firstMarkdown.includes(userText));
  assert.ok(firstMarkdown.includes("## Contents"));
  assert.ok(firstMarkdown.includes("[[#Question 1|"));
  assert.ok(firstMarkdown.includes(`lossless-sidecar: ${firstSidecars[0]}`));
  await assert.rejects(fs.promises.access(legacyMarkdownPath), { code: "ENOENT" });
  assert.equal(firstMarkdown.includes(toolOutput), false);
  assert.deepEqual(notifications.at(-1), {
    message: `Transcript updated: ${markdownPath}`,
    type: "info",
  });
  assert.equal((await fs.promises.stat(markdownPath)).mode & 0o777, 0o600);
  assert.equal((await fs.promises.stat(firstRawPath)).mode & 0o777, 0o600);
  if (process.platform !== "win32") {
    assert.equal((await fs.promises.stat(transcriptDirectory)).mode & 0o777, 0o700);
  }

  const repeatedCompaction = {
    ...entries.at(-1),
    id: "compact2",
    parentId: "compact1",
    timestamp: "2026-03-19T10:00:09.000Z",
  };
  const refreshedEntries = [...entries, repeatedCompaction];
  ctx.sessionManager.getBranch = () => refreshedEntries;
  ctx.sessionManager.getSessionName = () => "Renamed Session";
  await compactHandler(event, ctx);

  const renamedMarkdownPath = path.join(transcriptDirectory, `renamed-session--${sessionKey}.md`);
  const refreshedMarkdown = await fs.promises.readFile(renamedMarkdownPath, "utf8");
  const refreshedSidecars = (await fs.promises.readdir(transcriptDirectory))
    .filter((name) => name.endsWith(".active-branch.jsonl"));
  assert.equal(refreshedSidecars.length, 2);
  assert.ok(refreshedSidecars.some((name) => name.startsWith(`fixture-session--${sessionKey}.`)));
  assert.ok(refreshedSidecars.some((name) => name.startsWith(`renamed-session--${sessionKey}.`)));
  await assert.rejects(fs.promises.access(markdownPath), { code: "ENOENT" });
  assert.ok(refreshedMarkdown.startsWith("# Renamed Session\n"));
  const currentSidecar = refreshedSidecars.find((name) => refreshedMarkdown.includes(`lossless-sidecar: ${name}`));
  assert.notEqual(currentSidecar, undefined);
  assert.equal(
    await fs.promises.readFile(path.join(transcriptDirectory, currentSidecar), "utf8"),
    serializeActiveBranch(header, refreshedEntries),
  );
  assert.equal((refreshedMarkdown.match(/^## Question 1$/gm) ?? []).length, 1);
  assert.equal(refreshedMarkdown.includes("compact2"), false);
  assert.equal(refreshedMarkdown.includes(toolOutput), false);
});

test("reports that in-memory sessions intentionally cannot be exported", async () => {
  let commandHandler;
  const notifications = [];
  compactionTranscript({
    on() {},
    registerCommand(name, options) {
      if (name === "transcript") commandHandler = options.handler;
    },
  });

  assert.equal(typeof commandHandler, "function");
  await commandHandler("", {
    hasUI: true,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    sessionManager: {
      getSessionFile: () => undefined,
    },
  });

  assert.deepEqual(notifications, [{
    message: "Transcript export failed: Cannot persist a transcript for an in-memory --no-session conversation",
    type: "error",
  }]);
});
