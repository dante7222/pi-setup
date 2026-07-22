import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSupacodeResourceId,
  findSupacodePathId,
  sameSupacodeUuid,
} from "../extensions/supacode-subagents/resource-id.ts";

const uuid = "3b6db66f-7c97-4ae5-87c4-2534c2939c5d";

test("Supacode path lookup returns the canonical listed ID", () => {
  const canonical = "%2FUsers%2Fventris%2Fpi-setup%2F";
  const listed = `%2FUsers%2Fventris%2F\n${canonical}\n`;

  assert.equal(findSupacodePathId(listed, "/Users/ventris/pi-setup"), canonical);
  assert.equal(findSupacodePathId(listed, "/Users/ventris/missing"), undefined);
});

test("Supacode resource ID decoding handles encoded paths and invalid escapes", () => {
  assert.equal(decodeSupacodeResourceId(" %2FUsers%2Fventris%2Fpi-setup%2F\n"), "/Users/ventris/pi-setup/");
  assert.equal(decodeSupacodeResourceId("%invalid"), "%invalid");
});

test("Supacode UUID comparison ignores CLI output casing and whitespace", () => {
  assert.equal(sameSupacodeUuid(` ${uuid.toUpperCase()}\n`, uuid), true);
});

test("Supacode UUID comparison rejects a different UUID", () => {
  assert.equal(
    sameSupacodeUuid(uuid, "3b6db66f-7c97-4ae5-87c4-2534c2939c5e"),
    false,
  );
});
