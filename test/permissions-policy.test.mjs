import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluatePermission,
  parsePermissionConfig,
  resolvePermissions,
  wildcardMatch,
} from "../extensions/permissions/policy.ts";
import { permissionRequestsForTool } from "../extensions/permissions/resources.ts";

test("scalar permission applies to every tool", () => {
  const policy = parsePermissionConfig({ permission: "deny" });
  assert.equal(evaluatePermission(policy.rules, "read", "README.md"), "deny");
  assert.equal(evaluatePermission(policy.rules, "custom", "*"), "deny");
});

test("last matching rule wins without specificity weighting", () => {
  const policy = parsePermissionConfig({
    permission: {
      "*": "ask",
      read: {
        "*": "allow",
        "*.env": "ask",
        ".env": "deny",
      },
    },
  });

  assert.equal(evaluatePermission(policy.rules, "read", "README.md"), "allow");
  assert.equal(evaluatePermission(policy.rules, "read", "config.env"), "ask");
  assert.equal(evaluatePermission(policy.rules, "read", ".env"), "deny");
  assert.equal(evaluatePermission(policy.rules, "bash", "pwd"), "ask");
});

test("a later catch-all overrides an earlier exact rule", () => {
  const policy = parsePermissionConfig({
    permission: {
      read: "deny",
      "*": "allow",
    },
  });
  assert.equal(evaluatePermission(policy.rules, "read", "secret"), "allow");
});

test("granular patterns expand home prefixes", () => {
  const policy = parsePermissionConfig(
    {
      permission: {
        external_directory: {
          "~/src/*": "allow",
          "$HOME/private/*": "deny",
        },
      },
    },
    "/home/tester",
  );

  assert.deepEqual(
    policy.rules.map((rule) => rule.pattern),
    ["/home/tester/src/*", "/home/tester/private/*"],
  );
});

test("invalid config is rejected", () => {
  assert.throws(() => parsePermissionConfig(null), /JSON object/);
  assert.throws(() => parsePermissionConfig({}), /must define permission/);
  assert.throws(
    () => parsePermissionConfig({ permission: { bash: "sometimes" } }),
    /must be an action/,
  );
  assert.throws(
    () => parsePermissionConfig({ permission: "allow", extra: true }),
    /unsupported top-level property/,
  );
});

test("wildcards match like OpenCode", () => {
  assert.equal(wildcardMatch("git status", "git status *"), true);
  assert.equal(wildcardMatch("git status --short", "git status *"), true);
  assert.equal(wildcardMatch("git/status", "git\\status"), true);
  assert.equal(wildcardMatch("file[1].ts", "file[1].ts"), true);
  assert.equal(wildcardMatch("file11.ts", "file[1].ts"), false);
  assert.equal(wildcardMatch("src/a/b.ts", "src/*.ts"), true);
  assert.equal(wildcardMatch("ab", "a?"), true);
  assert.equal(wildcardMatch("abc", "a?"), false);
});

test("multi-resource resolution reports deny and ask", () => {
  const policy = parsePermissionConfig({
    permission: {
      "*": "ask",
      edit: "deny",
      read: "allow",
    },
  });
  const resolution = resolvePermissions(policy.rules, [
    { permission: "read", resource: "a" },
    { permission: "bash", resource: "pwd" },
    { permission: "edit", resource: "b" },
  ]);

  assert.deepEqual(resolution.denied, [{ permission: "edit", resource: "b" }]);
  assert.deepEqual(resolution.asked, [{ permission: "bash", resource: "pwd" }]);
});

test("built-in file tools map to OpenCode permission names", () => {
  assert.deepEqual(permissionRequestsForTool("read", { path: "src/a.ts" }, "/repo"), [
    { permission: "read", resource: "src/a.ts" },
  ]);
  assert.deepEqual(permissionRequestsForTool("write", { path: "src/a.ts" }, "/repo"), [
    { permission: "edit", resource: "src/a.ts" },
  ]);
  assert.deepEqual(permissionRequestsForTool("rg", { pattern: "TODO" }, "/repo"), [
    { permission: "grep", resource: "TODO" },
  ]);
  assert.deepEqual(permissionRequestsForTool("find", { pattern: "*.ts" }, "/repo"), [
    { permission: "glob", resource: "*.ts" },
  ]);
  assert.deepEqual(permissionRequestsForTool("ls", {}, "/repo"), [
    { permission: "list", resource: "." },
  ]);
});

test("external paths add an external_directory request", () => {
  assert.deepEqual(permissionRequestsForTool("read", { path: "/tmp/a.txt" }, "/repo"), [
    { permission: "read", resource: "/tmp/a.txt" },
    { permission: "external_directory", resource: "/tmp/*" },
  ]);
  assert.deepEqual(permissionRequestsForTool("ls", { path: "/tmp" }, "/repo"), [
    { permission: "list", resource: "/tmp" },
    { permission: "external_directory", resource: "/tmp/*" },
  ]);
});

test("subagents use task permission with one resource per mode", () => {
  assert.deepEqual(permissionRequestsForTool("delegate", {}, "/repo"), [
    { permission: "task", resource: "research" },
  ]);
  assert.deepEqual(
    permissionRequestsForTool(
      "delegate_parallel",
      { tasks: [{ task: "a" }, { task: "b", mode: "coding" }, { task: "c", mode: "coding" }] },
      "/repo",
    ),
    [
      { permission: "task", resource: "research" },
      { permission: "task", resource: "coding" },
    ],
  );
});

test("web and unknown tools receive stable resources", () => {
  assert.deepEqual(
    permissionRequestsForTool("functions.web_search", { queries: ["one", "two"] }, "/repo"),
    [
      { permission: "websearch", resource: "one" },
      { permission: "websearch", resource: "two" },
    ],
  );
  assert.deepEqual(permissionRequestsForTool("custom_tool", { secret: true }, "/repo"), [
    { permission: "custom_tool", resource: "*" },
  ]);
});

test("tracked pi.json is valid and keeps sensitive actions on ask", () => {
  const config = JSON.parse(readFileSync(new URL("../pi.json", import.meta.url), "utf8"));
  const policy = parsePermissionConfig(config);

  assert.equal(evaluatePermission(policy.rules, "read", "README.md"), "allow");
  assert.equal(evaluatePermission(policy.rules, "read", ".env"), "ask");
  assert.equal(evaluatePermission(policy.rules, "read", ".env.example"), "allow");
  assert.equal(evaluatePermission(policy.rules, "edit", "README.md"), "ask");
  assert.equal(evaluatePermission(policy.rules, "bash", "git status"), "ask");
  assert.equal(evaluatePermission(policy.rules, "task", "research"), "allow");
  assert.equal(evaluatePermission(policy.rules, "task", "coding"), "ask");
  assert.equal(evaluatePermission(policy.rules, "unrecognized_tool", "*"), "ask");
});
