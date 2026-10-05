import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Marked } from "@earendil-works/pi-tui";
import compactionTranscript from "../extensions/compaction-transcript/index.ts";
import { renderTranscript, serializeActiveBranch } from "../extensions/compaction-transcript/render.ts";

const header = { type: "session", version: 3, id: "unicode-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/fixture" };
const user = { type: "message", id: "user1", parentId: null, timestamp: header.timestamp,
  message: { role: "user", content: "Original question", timestamp: 1 } };
function response(stopReason, content = [{ type: "text", text: `Exact ${stopReason} text  ` }]) {
  return { type: "message", id: `assistant-${stopReason}`, parentId: user.id, timestamp: header.timestamp,
    message: { role: "assistant", provider: "fixture", api: "fixture", model: "fixture", content, stopReason,
      errorMessage: "Private provider diagnostic must stay in raw history", timestamp: 2 } };
}

function render(entries) {
  return renderTranscript({ entries, title: "Fixture", generatedAt: header.timestamp,
    rawFileName: "fixture.active-branch.jsonl", sessionId: header.id });
}

test("long Unicode titles publish byte-safe snapshots and short atomic temporary names", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-transcript-unicode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let command;
  compactionTranscript({ on() {}, registerCommand(name, definition) {
    if (name === "transcript") command = definition.handler;
  } });
  const entries = [user, response("stop")];
  const notifications = [];
  let title;
  const ctx = { hasUI: true, ui: { notify: (message, type) => notifications.push({ message, type }) },
    sessionManager: { getSessionFile: () => join(directory, "session.jsonl"), getBranch: () => entries,
      getHeader: () => header, getSessionId: () => header.id, getSessionName: () => title } };
  const raw = serializeActiveBranch(header, entries);
  const hash = createHash("sha256").update(raw).digest("hex");
  const sessionKey = createHash("sha256").update(header.id).digest("hex").slice(0, 12);
  for (title of ["a".repeat(60), "界".repeat(60), "𐐀".repeat(60), "é".repeat(60)]) {
    await command("", ctx);
    assert.equal(notifications.at(-1).type, "info", notifications.at(-1).message);
    const names = await readdir(join(directory, "transcripts"));
    assert.ok(names.every((name) => Buffer.byteLength(name, "utf8") <= 255));
    assert.ok(names.every((name) => !name.endsWith(".tmp")), "No atomic-write debris");
    const markdowns = names.filter((name) => name.endsWith(".md"));
    assert.equal(markdowns.length, 1, "Renaming retains only the current reading view");
    const markdownPath = join(directory, "transcripts", markdowns[0]);
    const markdown = await readFile(markdownPath, "utf8");
    assert.ok(markdown.startsWith(`# ${title}\n`), "Reader title is never shortened");
    const sidecar = /lossless-sidecar: (.+)/.exec(markdown)[1];
    assert.ok(sidecar.endsWith(`--${sessionKey}.${hash}.active-branch.jsonl`));
    assert.equal(await readFile(join(directory, "transcripts", sidecar), "utf8"), raw);
    if (process.platform !== "win32") {
      assert.equal((await stat(markdownPath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, "transcripts", sidecar))).mode & 0o777, 0o600);
    }
  }
  assert.equal((await readdir(join(directory, "transcripts"))).filter((name) => name.endsWith(".jsonl")).length, 4);
});

test("annotates each incomplete attempt without changing text or labeling a successful retry", () => {
  const interrupted = [response("aborted"), response("error"), response("length")];
  const success = response("stop");
  const markdown = render([user, ...interrupted, success]);
  for (const entry of [...interrupted, success]) assert.ok(markdown.includes(entry.message.content[0].text));
  assert.equal((markdown.match(/> \[!warning\] Incomplete response/g) ?? []).length, 3);
  assert.match(markdown, /response was aborted/);
  assert.match(markdown, /response ended with an error/);
  assert.match(markdown, /response reached the output limit/);
  assert.ok(markdown.indexOf("response reached the output limit") < markdown.indexOf("Exact stop text"));
  assert.doesNotMatch(markdown, /Private provider diagnostic/);
  assert.doesNotMatch(render([user, response("stop"), response("toolUse")]), /Incomplete response/);
});

test("partial Markdown cannot hide its status or consume a later successful attempt", () => {
  const parser = new Marked();
  for (const body of ["```js\npartial", "~~~~text\npartial", "<!-- unfinished", "<pre>unfinished",
    "> ```text\n> partial", "- ```text\n  partial", "```text\n<!-- this is code\n```", "<?unfinished", "<![CDATA[unfinished",
    ...["pre", "PRE", "script", "style", "textarea"].flatMap((tag) => [
      `<${tag} class="language-js">partial`, `<${tag}\n class="language-js">partial`,
    ])]) {
    const partial = response("length", [{ type: "text", text: body }]);
    const retry = response("stop", [{ type: "text", text: "RETRY_SUCCESS" }]);
    const markdown = render([user, partial, retry]);
    assert.ok(markdown.includes(body), "The original text stays intact");
    assert.ok(markdown.indexOf("Incomplete response") < markdown.indexOf(body));
    const html = parser.parse(markdown);
    assert.match(html, /<p>RETRY_SUCCESS<\/p>/, body);
    assert.match(html, /<blockquote>\s*<p>\[!warning\] Incomplete response/, body);
    const htmlAfterComments = html.replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(htmlAfterComments.includes("Incomplete response"), body);
    assert.ok(htmlAfterComments.includes("RETRY_SUCCESS"), body);
    assert.deepEqual(serializeActiveBranch(header, [user, partial, retry]).trimEnd().split("\n").map(JSON.parse),
      [header, user, partial, retry]);
  }
});

test("partial user Markdown and thinking blocks cannot consume response status", () => {
  for (const body of ["```text\npartial", "<!-- unfinished"]) {
    const question = { ...user, message: { ...user.message, content: body } };
    const partial = response("aborted", [{ type: "thinking", thinking: body }, { type: "text", text: "RESPONSE_TEXT" }]);
    const markdown = render([question, partial]);
    const html = new Marked().parse(markdown).replace(/<!--[\s\S]*?-->/g, "");
    assert.match(html, /<p>RESPONSE_TEXT<\/p>/);
    assert.match(html, /<blockquote>\s*<p>\[!warning\] Incomplete response/);
  }
});

test("empty failed responses still have a readable status and raw sidecars retain all fields", () => {
  const failed = response("error", []);
  const entries = [user, failed,
    { type: "message", id: "system", parentId: failed.id, timestamp: header.timestamp,
      message: { role: "system", content: "private checkpoint", toolsAdded: [{ name: "read", parameters: {} }], timestamp: 3 } },
    { type: "context_edit", id: "omit", parentId: "system", timestamp: header.timestamp, targetId: failed.id, replacement: null },
    { type: "message", id: "nested", parentId: "omit", timestamp: header.timestamp,
      message: { role: "toolResult", toolName: "codemode", toolCallId: "call", content: [], timestamp: 4,
        nestedCalls: { complete: true, calls: [{ name: "read", arguments: { path: "private.txt" }, status: "done" }] } } },
  ];
  const markdown = render(entries);
  assert.match(markdown, /### Response\n\n> \[!warning\] Incomplete response/);
  assert.doesNotMatch(markdown, /private checkpoint|private\.txt/);
  assert.deepEqual(serializeActiveBranch(header, entries).trimEnd().split("\n").map(JSON.parse), [header, ...entries]);
});
