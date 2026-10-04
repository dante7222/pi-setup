import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateSessionTitle } from "../extensions/tokyo-night-footer/index.ts";

test("preserves session titles that fit the available width", () => {
  assert.equal(truncateSessionTitle("Partition huge table", 60), "Partition huge table");
});

test("renders missing titles and non-positive widths as empty text", () => {
  assert.equal(truncateSessionTitle(undefined, 60), "");
  assert.equal(truncateSessionTitle("Session title", 0), "");
  assert.equal(truncateSessionTitle("Session title", -1), "");
});

test("truncates long session titles to the available terminal width", () => {
  for (const title of ["s".repeat(80), "界".repeat(40)]) {
    for (const width of [1, 2, 12, 60]) {
      const truncated = truncateSessionTitle(title, width);
      assert.ok(visibleWidth(truncated) <= width);
      assert.ok(stripVTControlCharacters(truncated).endsWith("…"));
    }
  }
});
