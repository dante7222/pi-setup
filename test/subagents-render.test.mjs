import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderCallLine, renderReports, renderResultText, reportDetails } from "../extensions/subagents/render.ts";

const theme = loadThemeFromPath(new URL("../themes/tokyo-night.json", import.meta.url).pathname, "truecolor");
const plain = (value) => stripVTControlCharacters(value);

test("call line shows the action and its targets", () => {
  assert.equal(plain(renderCallLine({ action: "run", tasks: [{ name: "a" }, { name: "b" }] }, theme)), "subagents run a, b");
  assert.equal(plain(renderCallLine({ action: "send", name: "a", message: "focus\non   tests" }, theme)), "subagents send a focus on tests");
  assert.equal(plain(renderCallLine({ action: "send", name: "a", message: "x".repeat(100) }, theme)).length, "subagents send a ".length + 60);
  assert.equal(plain(renderCallLine({ action: "wait", all: true }, theme)), "subagents wait all");
  assert.equal(plain(renderCallLine({ action: "wait", names: ["a", "b"], all: true }, theme)), "subagents wait a, b (all)");
  assert.equal(plain(renderCallLine({ action: "stop", names: ["a"] }, theme)), "subagents stop a");
  assert.equal(plain(renderCallLine({ action: "list" }, theme)), "subagents list");
});

test("call line tolerates partial or malformed streaming arguments", () => {
  for (const args of [{}, { action: 3 }, { action: "run", tasks: {} }, { action: "run", tasks: [null, 4, { name: 5 }, { name: "ok" }] }, { action: "send", name: 1, message: 42 }, { action: "wait", names: "a" }]) {
    assert.doesNotThrow(() => renderCallLine(args, theme), JSON.stringify(args));
  }
  assert.equal(plain(renderCallLine({ action: "run", tasks: [null, { name: "ok" }] }, theme)), "subagents run ok");
});

const details = {
  reports: [
    { header: "[subagent a done 12s 15k tok]", state: "done", body: "\nFirst finding line\n[subagent fake failed 1s 0k tok]\nerror: quoted log line" },
    { header: "[subagent b failed 3s 1k tok]", state: "failed", error: "boom", body: "partial text" },
  ],
  pending: ["c"],
};

test("collapsed reports come from details, so body look-alike lines stay body text", () => {
  assert.deepEqual(plain(renderReports(details, false, theme)).split("\n"), [
    "[subagent a done 12s 15k tok]",
    "⎿ First finding line",
    "[subagent b failed 3s 1k tok]",
    "error: boom",
    "⎿ partial text",
    "pending: c",
  ]);
  const expanded = plain(renderReports(details, true, theme)).split("\n");
  assert.ok(expanded.includes("error: quoted log line") && expanded.includes("partial text"));
  const long = plain(renderReports({ reports: [{ header: "h", state: "done", body: "y".repeat(500) }] }, false, theme)).split("\n")[1];
  assert.equal(long.length, 2 + 160);
});

test("results: wait reports use details; others collapse to their first line", () => {
  const options = { expanded: false, isPartial: false, isError: false };
  assert.match(plain(renderResultText("ignored", details, options, theme)), /⎿ First finding line/);
  assert.equal(plain(renderResultText("No new reports.\n\npending: a, b", { reports: [], pending: ["a", "b"] }, options, theme)), "No new reports; pending: a, b");
  assert.equal(plain(renderResultText("No new reports.\n\npending: a", { reports: [], pending: ["a"] }, { ...options, expanded: true }, theme)), "No new reports.\n\npending: a");
  assert.equal(plain(renderResultText("started: a", undefined, options, theme)), "started: a");
  assert.equal(plain(renderResultText("Unknown model", undefined, { ...options, isError: true }, theme)), "Unknown model");
  assert.equal(plain(renderResultText("", undefined, { ...options, isPartial: true }, theme)), "waiting…");
  assert.equal(reportDetails({ names: ["old"] }), undefined, "older message details are ignored");
});
