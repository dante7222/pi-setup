import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_BYTES,
  SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_LINES,
  SESSION_GROUP_CHANGELOG_PAGE_MAX_BYTES,
  SESSION_GROUP_CHANGELOG_PAGE_MAX_LINES,
} from "../extensions/session-groups/contracts.ts";
import {
  SessionGroupChangelogCursorError,
  SessionGroupChangelogEncodingError,
  SessionGroupStore,
} from "../extensions/session-groups/store.ts";

async function withGroup(run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-changelog-page-"));
  const store = new SessionGroupStore({ rootDirectory: directory });
  try {
    const group = await store.createGroup("Changelog pages");
    await run(store, group);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function rawFragment(content) {
  return content.replace(/^\[Record (?:fragment|continued)\] /, "");
}

async function allPages(store, groupId, options = {}) {
  const pages = [];
  let cursor;
  do {
    const page = await store.readChangelogPage(groupId, { ...options, cursor });
    assert.equal(page.returnedBytes, Buffer.byteLength(page.content));
    assert.ok(page.returnedBytes <= (options.maxBytes ?? SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_BYTES));
    const physicalLines = (page.content.match(/\n/g)?.length ?? 0) + (page.content && !page.content.endsWith("\n") ? 1 : 0);
    assert.ok(physicalLines <= (options.maxLines ?? SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_LINES));
    assert.equal(page.truncated, page.nextCursor !== undefined);
    assert.equal(page.content.includes("\ufffd"), false);
    if (page.nextCursor) assert.notEqual(page.nextCursor, cursor, "cursor must make progress");
    pages.push(page);
    cursor = page.nextCursor;
    assert.ok(pages.length < 2000, "paging must terminate");
  } while (cursor);
  return pages;
}

test("absent and empty changelogs are side-effect-free, including filtering", async () => {
  await withGroup(async (store, group) => {
    const absent = await store.readChangelogPage(group.id, { query: "nothing" });
    assert.deepEqual(absent, {
      path: store.changelogPath(group.id), exists: false, content: "", totalBytes: 0,
      returnedBytes: 0, truncated: false, matchedRecords: 0,
    });
    await assert.rejects(readFile(absent.path), /ENOENT/);
    await writeFile(absent.path, "", { mode: 0o600 });
    assert.deepEqual(await store.readChangelogPage(group.id, { query: "nothing" }), { ...absent, exists: true });
  });
});

test("newest records come first while multiline Markdown and fenced headings retain order", async () => {
  await withGroup(async (store, group) => {
    const preamble = "# Changelog\n\n";
    const old = "## 2026-01-01T00:00:00.000Z — Older\n\nOld start\nOld end\n\n";
    const newest = "## 2026-01-02T00:00:00.000Z — Newer\n\nNew start\n## Body heading\n```md\n## 2026-01-03T00:00:00.000Z — Not a record\n```\nNew end\n";
    await writeFile(store.changelogPath(group.id), preamble + old + newest, { mode: 0o600 });
    const pages = await allPages(store, group.id, { maxBytes: Buffer.byteLength(newest) + 1 });
    assert.equal(pages[0].content, newest);
    assert.equal(pages.map((page) => rawFragment(page.content)).join(""), newest + old + preamble);
    assert.equal(pages[0].content.includes("Record fragment"), false, "fitting records stay intact");
    assert.equal((await store.readChangelogTail(group.id)).content, preamble + old + newest);
  });
});

test("oversized UTF-8 records page without loss, including BOM and one-line budgets", async () => {
  await withGroup(async (store, group) => {
    const record = "\ufeffplain Markdown without record headings\n" + "é中😀 e\u0301\n\n".repeat(40) + "unterminated ending";
    await writeFile(store.changelogPath(group.id), record, { mode: 0o600 });
    for (const options of [{ maxBytes: 73 }, { maxBytes: 83, maxLines: 1 }, { maxBytes: 24, maxLines: 2 }]) {
      const pages = await allPages(store, group.id, options);
      assert.ok(pages.length > 1);
      assert.match(pages[0].content, /^\[Record fragment\]/);
      assert.match(pages[1].content, /^\[Record continued\]/);
      assert.equal(pages.map((page) => rawFragment(page.content)).join(""), record);
      assert.equal(pages[0].totalBytes, Buffer.byteLength(record));
    }
  });
});

test("filtering is case-insensitive literal matching across whole records and all pages", async () => {
  await withGroup(async (store, group) => {
    const old = "## 2026-01-01T00:00:00.000Z — Older\n\nKeep [A.*] here\n";
    const excluded = "## 2026-01-02T00:00:00.000Z — Excluded\n\nAxyz is not literal\n";
    const newest = "## 2026-01-03T00:00:00.000Z — Newest\n\n" + "details\n".repeat(30) + "late [a.*] match\n";
    await writeFile(store.changelogPath(group.id), old + excluded + newest, { mode: 0o600 });
    const pages = await allPages(store, group.id, { maxBytes: 128, query: "[a.*]" });
    assert.equal(pages.map((page) => rawFragment(page.content)).join(""), newest + old);
    assert.ok(pages.every((page) => page.matchedRecords === 2));
    const noMatches = await store.readChangelogPage(group.id, { query: "unmatched" });
    assert.equal(noMatches.matchedRecords, 0);
    assert.equal(noMatches.content, "");
    assert.equal(noMatches.truncated, false);
  });
});

test("manual Markdown headings use newest-first fallback without dropping preambles", async () => {
  await withGroup(async (store, group) => {
    const preamble = "notes before headings\n\n";
    const first = "## First manual section\nA\n~~~\n## fenced text\n~~~\n";
    const second = "## Second manual section\nB without terminal newline";
    await writeFile(store.changelogPath(group.id), preamble + first + second, { mode: 0o600 });
    const pages = await allPages(store, group.id, { maxBytes: 128 });
    assert.equal(pages.map((page) => rawFragment(page.content)).join(""), second + first + preamble);
    assert.equal(pages[0].content, second);
  });
});

test("cursor binds content hash, group and query and rejects malformed or stale positions", async () => {
  await withGroup(async (store, group) => {
    const path = store.changelogPath(group.id);
    const content = "first query\n".repeat(100);
    await writeFile(path, content, { mode: 0o600 });
    const first = await store.readChangelogPage(group.id, { maxBytes: 128, query: "FIRST" });
    assert.ok(first.nextCursor);
    await store.readChangelogPage(group.id, { cursor: first.nextCursor, query: "first" });
    const other = await store.createGroup("Other changelog");
    await assert.rejects(store.readChangelogPage(other.id, { cursor: first.nextCursor, query: "first" }), /Restart without cursor/);
    await assert.rejects(store.readChangelogPage(group.id, { cursor: first.nextCursor, query: "query" }), SessionGroupChangelogCursorError);
    // Same byte length but changed content must invalidate the hash-bound cursor.
    await writeFile(path, content.replace("first", "other"));
    await assert.rejects(store.readChangelogPage(group.id, { cursor: first.nextCursor, query: "first" }), /Restart without cursor/);
    await rm(path);
    await assert.rejects(store.readChangelogPage(group.id, { cursor: first.nextCursor, query: "first" }), SessionGroupChangelogCursorError);
    for (const cursor of ["bad!", "", "a".repeat(2049), Buffer.from(JSON.stringify({ version: 99 })).toString("base64url")]) {
      await assert.rejects(store.readChangelogPage(group.id, { cursor }), SessionGroupChangelogCursorError);
    }
    await writeFile(path, "é".repeat(100));
    const valid = await store.readChangelogPage(group.id, { maxBytes: 64 });
    const decoded = JSON.parse(Buffer.from(valid.nextCursor, "base64url").toString());
    for (const change of [{ offset: 1 }, { offset: -1 }, { record: 999 }, { version: 2 }]) {
      const cursor = Buffer.from(JSON.stringify({ ...decoded, ...change })).toString("base64url");
      await assert.rejects(store.readChangelogPage(group.id, { cursor }), SessionGroupChangelogCursorError);
    }
  });
});

test("defaults/hard limits bound output, with option validation before filesystem work", async () => {
  await withGroup(async (store, group) => {
    await writeFile(store.changelogPath(group.id), "x".repeat(20_000), { mode: 0o600 });
    const defaults = await store.readChangelogPage(group.id);
    assert.equal(defaults.returnedBytes, SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_BYTES);
    const maximum = await store.readChangelogPage(group.id, { maxBytes: SESSION_GROUP_CHANGELOG_PAGE_MAX_BYTES, maxLines: SESSION_GROUP_CHANGELOG_PAGE_MAX_LINES });
    assert.equal(maximum.returnedBytes, SESSION_GROUP_CHANGELOG_PAGE_MAX_BYTES);
    await writeFile(store.changelogPath(group.id), "line\n".repeat(2200));
    const lines = await store.readChangelogPage(group.id, { maxBytes: SESSION_GROUP_CHANGELOG_PAGE_MAX_BYTES });
    assert.equal((lines.content.match(/\n/g) ?? []).length, SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_LINES);
    await writeFile(store.changelogPath(group.id), Buffer.from([0xc3, 0x28]));
    await assert.rejects(store.readChangelogPage(group.id), SessionGroupChangelogEncodingError);
    store.withGroupLock = async () => { throw new Error("Unexpected filesystem work"); };
    for (const options of [{ maxBytes: 16385 }, { maxBytes: 0 }, { maxBytes: 1.5 }, { maxLines: 2001 }, { maxLines: NaN }, { query: "a".repeat(257) }]) {
      await assert.rejects(store.readChangelogPage(group.id, options), /Changelog (?:maxBytes|maxLines|query)/);
    }
    await assert.rejects(store.readChangelogPage(group.id, { signal: AbortSignal.abort(new Error("cancelled read")) }), /cancelled read/);
  });
});

test("appending invalidates a cursor and the restarted page shows the newest append first", async () => {
  await withGroup(async (store, group) => {
    await store.appendChangelog(group.id, "old work\n".repeat(30), "Old session");
    const first = await store.readChangelogPage(group.id, { maxBytes: 100 });
    await store.appendChangelog(group.id, "Newest decision", "New session");
    await assert.rejects(store.readChangelogPage(group.id, { cursor: first.nextCursor }), /Restart without cursor/);
    const restarted = await store.readChangelogPage(group.id);
    assert.ok(restarted.content.indexOf("Newest decision") < restarted.content.indexOf("old work"));
  });
});
