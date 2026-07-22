import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { resolvePermissionConfigPath } from "../extensions/supacode-subagents/permission-config.ts";

test("worker permission config paths resolve from the parent cwd", () => {
  const cwd = resolve("/workspace", "project");
  const home = resolve("/home", "tester");

  assert.equal(resolvePermissionConfigPath(undefined, cwd, home), undefined);
  assert.equal(resolvePermissionConfigPath("  ", cwd, home), undefined);
  assert.equal(
    resolvePermissionConfigPath("config/permissions.json", cwd, home),
    resolve(cwd, "config/permissions.json"),
  );
  assert.equal(
    resolvePermissionConfigPath("~/permissions.json", cwd, home),
    resolve(home, "permissions.json"),
  );
  assert.equal(
    resolvePermissionConfigPath(resolve(home, "absolute.json"), cwd, home),
    resolve(home, "absolute.json"),
  );
});
