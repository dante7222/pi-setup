import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, serializeConversation, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { applyPatch } from "diff";
import { SessionGroupStore } from "../extensions/session-groups/store.ts";
import { createSessionGroupContextDiff } from "../extensions/session-groups/diff.ts";
import { registerSessionGroupTool, registerSessionGroupChangelogTool } from "../extensions/session-groups/tool.ts";

const theme = { fg: (_color, text) => text, bold: (text) => text };
const request = "Update shared context and append the changelog.";

async function withTools(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-session-groups-tool-"));
  const store = new SessionGroupStore({ rootDirectory: root });
  try {
    const group = await store.createGroup("tool tests");
    let snapshot = await store.readContext(group.id);
    const tools = new Map();
    const pi = { registerTool: (tool) => tools.set(tool.name, tool), getSessionName: () => "Tool test session" };
    const controller = {
      getCurrentGroupId: () => group.id,
      getCurrentContextSnapshot: () => snapshot,
      getCurrentUserAuthorization: () => ({ text: request, source: "interactive" }),
    };
    registerSessionGroupTool(pi, store, controller);
    registerSessionGroupChangelogTool(pi, store, controller);
    const edit = tools.get("edit_group_context");
    const changelog = tools.get("group_changelog");
    const confirmations = [];
    const ctx = { hasUI: true, ui: { confirm: async (...args) => { confirmations.push(args); return true; } } };
    const params = { userRequestQuote: "Update shared context", edits: [{ oldText: snapshot.content, newText: `${snapshot.content}New decision.\n` }] };
    await run({ store, group, edit, changelog, ctx, params, confirmations, snapshot, refresh: async () => { snapshot = await store.reconcileContext(group.id); } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("pre-aborted tools do not prompt or write", async () => {
  await withTools(async ({ store, group, edit, changelog, ctx, params, confirmations, snapshot }) => {
    const signal = AbortSignal.abort();
    await assert.rejects(edit.execute("edit", params, signal, undefined, ctx), { name: "AbortError" });
    await assert.rejects(changelog.execute("append", { action: "append", entry: "No write" }, signal, undefined, ctx), { name: "AbortError" });
    assert.equal(confirmations.length, 0);
    assert.equal((await store.readContext(group.id)).sha256, snapshot.sha256);
    await assert.rejects(readFile(store.changelogPath(group.id)), { code: "ENOENT" });
  });
});

test("confirmation receives cancellation and late approval cannot commit", async () => {
  await withTools(async ({ store, group, edit, changelog, ctx, params, snapshot }) => {
    for (const [tool, args] of [[edit, params], [changelog, { action: "append", entry: "No write" }]]) {
      const abort = new AbortController();
      ctx.ui.confirm = async (_title, _message, options) => {
        assert.equal(options.signal, abort.signal);
        abort.abort();
        return true;
      };
      await assert.rejects(tool.execute("cancel", args, abort.signal, undefined, ctx), { name: "AbortError" });
    }
    assert.equal((await store.readContext(group.id)).sha256, snapshot.sha256);
    await assert.rejects(readFile(store.changelogPath(group.id)), { code: "ENOENT" });
  });
});

test("cancellation after approval but before the file queue opens prevents mutation", async () => {
  await withTools(async ({ store, group, edit, ctx, params, snapshot }) => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const holder = withFileMutationQueue(store.contextPath(group.id), async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const abort = new AbortController();
    const approved = Promise.withResolvers();
    ctx.ui.confirm = async () => { approved.resolve(); return true; };
    const editing = edit.execute("queued", params, abort.signal, undefined, ctx);
    const rejection = assert.rejects(editing, { name: "AbortError" });
    await approved.promise;
    abort.abort();
    release.resolve();
    await Promise.all([holder, rejection]);
    assert.equal((await store.readContext(group.id)).sha256, snapshot.sha256);
  });
});

test("oversized replacements fail before confirmation or diff work", async () => {
  await withTools(async ({ edit, ctx, params, confirmations }) => {
    params.edits[0].newText = "x".repeat(65_537);
    await assert.rejects(edit.execute("oversized", params, undefined, undefined, ctx), /limit is 65536/);
    assert.equal(confirmations.length, 0);
  });
});

test("bounded diffs produce exact patches for line endings, EOF and empty files", async () => {
  for (const [before, after] of [["", "new\n"], ["old\n", ""], ["old", "new"], ["a\r\nb\r\n", "a\r\nc\r\n"], ["é\nlast", "é\nnext\n"], ["\uFEFFa\n", "\uFEFFb\n"]]) {
    const result = await createSessionGroupContextDiff("/tmp/context.md", before, after);
    assert.equal(applyPatch(before, result.patch), after);
  }
});

test("adversarial short-line diffs yield without quadratic UI stalls", { timeout: 5_000 }, async () => {
  const before = "a\n".repeat(8192);
  const after = "b\n".repeat(8192);
  let yielded = false;
  const timer = setTimeout(() => { yielded = true; }, 0);
  const result = await createSessionGroupContextDiff("/tmp/context.md", before, after);
  clearTimeout(timer);
  assert.equal(yielded, true);
  assert.equal(result.coarse, true);
  assert.equal(applyPatch(before, result.patch), after);
});

test("diff calculation is cancellable", async () => {
  const abort = new AbortController();
  const pending = createSessionGroupContextDiff("/tmp/context.md", "a\n".repeat(8192), "b\n".repeat(8192), abort.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  abort.abort();
  await rejected;
});

test("tool renders incomplete arguments and keeps full diffs in details, not model output", async () => {
  initTheme("dark", false);
  await withTools(async ({ edit, ctx, params }) => {
    assert.doesNotThrow(() => edit.renderCall({}, theme).render(80));
    const result = await edit.execute("edit", params, undefined, undefined, ctx);
    assert.match(result.details.patch, /New decision/);
    assert.doesNotMatch(result.content[0].text, /New decision/);
    assert.doesNotMatch(edit.renderResult(result, { expanded: false, isPartial: false }, theme).render(80).join("\n"), /New decision/);
    assert.match(edit.renderResult(result, { expanded: true, isPartial: false }, theme).render(80).join("\n"), /New decision/);
  });
});

test("giant-line previews show both changed sides rather than only an omission notice", async () => {
  await withTools(async ({ store, group, edit, ctx, confirmations, refresh }) => {
    await writeFile(store.contextPath(group.id), "x".repeat(60_000));
    await refresh();
    const result = await edit.execute("giant", { userRequestQuote: "Update shared context", edits: [{ oldText: "x".repeat(60_000), newText: "y".repeat(60_000) }] }, undefined, undefined, ctx);
    const preview = confirmations.at(-1)[1];
    assert.match(preview, /-1 xxxxx/);
    assert.match(preview, /\+1 yyyyy/);
    assert.match(preview, /line clipped/);
    assert.ok(Buffer.byteLength(preview) < 4500);
    const rendered = edit.renderResult(result, { expanded: true }, theme).render(80).join("\n");
    assert.match(rendered, /xxxxx/);
    assert.match(rendered, /yyyyy/);
  });
});

test("approved patches are byte-exact for existing BOM context files", async () => {
  await withTools(async ({ store, group, edit, ctx, refresh }) => {
    const before = "\uFEFFold\n";
    await writeFile(store.contextPath(group.id), before);
    await refresh();
    const result = await edit.execute("bom", { userRequestQuote: "Update shared context", edits: [{ oldText: "old", newText: "new" }] }, undefined, undefined, ctx);
    const after = await readFile(store.contextPath(group.id), "utf8");
    assert.equal(after, "\uFEFFnew\n");
    assert.equal(applyPatch(before, result.details.patch), after);
  });
});

test("changelog terminal controls are escaped only in display, not stored/model content", async () => {
  await withTools(async ({ store, group, changelog, ctx }) => {
    const injection = "\x1b]52;c;UE9JU09O\x07\x9b2J";
    await writeFile(store.changelogPath(group.id), `Text ${injection}\n`);
    const result = await changelog.execute("read", { action: "read" }, undefined, undefined, ctx);
    assert.ok(result.content[0].text.includes(injection));
    const rendered = changelog.renderResult(result, { expanded: true }, theme).render(80).join("\n");
    assert.doesNotMatch(rendered, /[\x07\x1b\x9b]/u);
    assert.match(rendered, /u001b/);
    assert.ok((await readFile(store.changelogPath(group.id), "utf8")).includes(injection));
  });
});

test("changelog pages are bounded, navigable, visible when expanded, and newest survives summary serialization", async () => {
  await withTools(async ({ store, group, changelog, ctx }) => {
    const older = "## 2026-01-01 — old\n\n" + "older line\n".repeat(4000);
    const latest = "## 2026-09-05 — latest\n\nLATEST_SENTINEL\n";
    await writeFile(store.changelogPath(group.id), `${older}\n${latest}`);
    const result = await changelog.execute("read", { action: "read" }, undefined, undefined, ctx);
    const text = result.content[0].text;
    assert.ok(Buffer.byteLength(text) <= 4096);
    assert.ok(text.split("\n").length <= 2000);
    assert.ok(result.details.nextCursor);
    assert.match(text, /cursor=/);
    assert.ok(text.indexOf("LATEST_SENTINEL") < 2000);
    const serialized = serializeConversation([{ role: "toolResult", toolCallId: "read", toolName: "group_changelog", content: result.content, isError: false, timestamp: Date.now() }]);
    assert.match(serialized, /LATEST_SENTINEL/);
    assert.doesNotMatch(changelog.renderResult(result, { expanded: false }, theme).render(80).join("\n"), /LATEST_SENTINEL/);
    assert.match(changelog.renderResult(result, { expanded: true }, theme).render(80).join("\n"), /LATEST_SENTINEL/);
    const next = await changelog.execute("next", { action: "read", cursor: result.details.nextCursor }, undefined, undefined, ctx);
    assert.notEqual(next.content[0].text, text);
    const filtered = await changelog.execute("filter", { action: "read", query: "LATEST_SENTINEL" }, undefined, undefined, ctx);
    assert.match(filtered.content[0].text, /LATEST_SENTINEL/);
    assert.doesNotMatch(filtered.content[0].text, /older line/);
    await assert.rejects(changelog.execute("bad", { action: "append", entry: "x", cursor: "bad" }, undefined, undefined, ctx), /does not accept read options/);
  });
});
