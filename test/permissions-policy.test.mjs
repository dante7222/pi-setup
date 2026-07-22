import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

test("bash compound commands are evaluated as separate resources", () => {
  assert.deepEqual(
    permissionRequestsForTool(
      "bash",
      { command: "git status --short && npm test\nls | head -n 5" },
      "/repo",
    ),
    [
      { permission: "bash", resource: "git status --short" },
      { permission: "bash", resource: "npm test" },
      { permission: "bash", resource: "ls" },
      { permission: "bash", resource: "head -n 5" },
    ],
  );
  assert.deepEqual(
    permissionRequestsForTool(
      "bash",
      { command: "git log --format='subject && body' 2>&1" },
      "/repo",
    ),
    [{ permission: "bash", resource: "git log --format='subject && body' 2>&1" }],
  );
});

test("bash chains preserve asks and denies instead of inheriting the first allow", () => {
  const policy = parsePermissionConfig({
    permission: {
      bash: {
        "*": "ask",
        "rm *": "deny",
        "git status *": "allow",
        "ls *": "allow",
        "head *": "allow",
      },
    },
  });

  for (const command of [
    "git status && npm test",
    "git status; npm test",
    "git status || npm test",
    "git status & npm test",
    "git status\nnpm test",
  ]) {
    const asked = resolvePermissions(
      policy.rules,
      permissionRequestsForTool("bash", { command }, "/repo"),
    );
    assert.deepEqual(asked.denied, [], command);
    assert.deepEqual(
      asked.asked,
      [{ permission: "bash", resource: "npm test" }],
      command,
    );
  }

  const denied = resolvePermissions(
    policy.rules,
    permissionRequestsForTool("bash", { command: "git status && rm -rf /" }, "/repo"),
  );
  assert.deepEqual(denied.denied, [{ permission: "bash", resource: "rm -rf /" }]);

  const allowed = resolvePermissions(
    policy.rules,
    permissionRequestsForTool("bash", { command: "ls | head -n 5" }, "/repo"),
  );
  assert.deepEqual(allowed, { denied: [], asked: [] });

  for (const command of [
    "git status $(npm test)",
    "git status `npm test`",
    "git status <(npm test)",
    "git status >(npm test)",
    "(git status)",
  ]) {
    const dynamic = resolvePermissions(
      policy.rules,
      permissionRequestsForTool("bash", { command }, "/repo"),
    );
    assert.equal(
      dynamic.asked.some((request) => request.resource.startsWith("<dynamic shell syntax>")),
      true,
      command,
    );
  }
});

test("tracked pi.json matches the working OpenCode profile", () => {
  const config = JSON.parse(readFileSync(new URL("../pi.json", import.meta.url), "utf8"));
  const policy = parsePermissionConfig(config);

  assert.equal(evaluatePermission(policy.rules, "read", "README.md"), "allow");
  assert.equal(evaluatePermission(policy.rules, "read", ".env"), "ask");
  assert.equal(evaluatePermission(policy.rules, "read", ".env.example"), "allow");
  assert.equal(evaluatePermission(policy.rules, "edit", "README.md"), "deny");
  assert.equal(evaluatePermission(policy.rules, "todowrite", "*"), "allow");
  assert.equal(evaluatePermission(policy.rules, "skill", "supacode-cli"), "allow");
  for (const command of [
    "git diff --stat",
    "git log -5",
    "git show HEAD",
    "git status --short",
    "git branch --show-current",
    "grep TODO README.md",
    "find . -name '*.ts'",
    "ls -la",
    "cat README.md",
    "head -n 5 README.md",
    "wc -l README.md",
    "sort names.txt",
    "uniq names.txt",
    "file README.md",
    "which node",
    "sed -n '1,5p' README.md",
    "gradle test",
    "gradlew test",
    "./gradlew test",
  ]) {
    assert.equal(evaluatePermission(policy.rules, "bash", command), "allow", command);
  }
  assert.equal(evaluatePermission(policy.rules, "bash", "git status"), "allow");
  assert.equal(evaluatePermission(policy.rules, "bash", "npm test"), "ask");
  assert.equal(evaluatePermission(policy.rules, "task", "research"), "allow");
  assert.equal(evaluatePermission(policy.rules, "task", "coding"), "allow");
  assert.equal(evaluatePermission(policy.rules, "unrecognized_tool", "*"), "ask");
});

test("tracked external directories are allowed while other external paths ask", () => {
  const config = JSON.parse(readFileSync(new URL("../pi.json", import.meta.url), "utf8"));
  const policy = parsePermissionConfig(config);
  const cwd = join(homedir(), "workspace", "current");

  assert.deepEqual(
    permissionRequestsForTool("read", { path: join(cwd, "src", "a.ts") }, cwd),
    [{ permission: "read", resource: "src/a.ts" }],
  );

  for (const target of [
    join(homedir(), "projects", "example", "README.md"),
    join(homedir(), ".agents", "skills", "example", "SKILL.md"),
    join(homedir(), ".config", "opencode", "opencode.json"),
  ]) {
    const external = permissionRequestsForTool("read", { path: target }, cwd)
      .find((request) => request.permission === "external_directory");
    assert.ok(external);
    assert.equal(
      evaluatePermission(policy.rules, external.permission, external.resource),
      "allow",
    );
  }

  const other = permissionRequestsForTool("read", { path: "/tmp/outside.txt" }, cwd)
    .find((request) => request.permission === "external_directory");
  assert.ok(other);
  assert.equal(evaluatePermission(policy.rules, other.permission, other.resource), "ask");
});
