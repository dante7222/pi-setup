import { homedir } from "node:os";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

export interface PermissionRequest {
  permission: string;
  resource: string;
}

export interface CompiledPermissionConfig {
  rules: readonly PermissionRule[];
}

export interface PermissionResolution {
  denied: readonly PermissionRequest[];
  asked: readonly PermissionRequest[];
}

const ACTIONS = new Set<PermissionAction>(["allow", "ask", "deny"]);
const MAX_RULES = 10_000;
const MAX_PERMISSION_LENGTH = 256;
const MAX_PATTERN_LENGTH = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionAction(value: unknown): value is PermissionAction {
  return typeof value === "string" && ACTIONS.has(value as PermissionAction);
}

function expandHome(pattern: string, home: string): string {
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "~") return home;
  if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

function assertRuleLimit(rules: PermissionRule[]): void {
  if (rules.length > MAX_RULES) {
    throw new Error(`permission contains more than ${MAX_RULES} rules`);
  }
}

function validatePermissionName(permission: string): void {
  if (permission.length === 0) throw new Error("permission names must not be empty");
  if (permission.length > MAX_PERMISSION_LENGTH) {
    throw new Error(`permission name exceeds ${MAX_PERMISSION_LENGTH} characters`);
  }
}

function validatePattern(pattern: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`permission pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  }
}

export function parsePermissionConfig(
  value: unknown,
  home = homedir(),
): CompiledPermissionConfig {
  if (!isRecord(value)) throw new Error("pi.json must contain a JSON object");

  for (const key of Object.keys(value)) {
    if (key !== "$schema" && key !== "permission") {
      throw new Error(`unsupported top-level property ${JSON.stringify(key)}`);
    }
  }
  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new Error("$schema must be a string");
  }
  if (!("permission" in value)) throw new Error("pi.json must define permission");

  const permissionConfig = value.permission;
  const normalized = isPermissionAction(permissionConfig)
    ? { "*": permissionConfig }
    : permissionConfig;
  if (!isRecord(normalized)) {
    throw new Error('permission must be "allow", "ask", "deny", or an object');
  }

  const rules: PermissionRule[] = [];
  for (const [permission, ruleConfig] of Object.entries(normalized)) {
    validatePermissionName(permission);

    if (isPermissionAction(ruleConfig)) {
      rules.push({ permission, pattern: "*", action: ruleConfig });
      assertRuleLimit(rules);
      continue;
    }
    if (!isRecord(ruleConfig)) {
      throw new Error(
        `permission.${permission} must be an action or a pattern-to-action object`,
      );
    }

    for (const [rawPattern, action] of Object.entries(ruleConfig)) {
      validatePattern(rawPattern);
      if (!isPermissionAction(action)) {
        throw new Error(
          `permission.${permission}[${JSON.stringify(rawPattern)}] must be "allow", "ask", or "deny"`,
        );
      }
      rules.push({
        permission,
        pattern: expandHome(rawPattern, home),
        action,
      });
      assertRuleLimit(rules);
    }
  }

  return {
    rules: Object.freeze(rules.map((rule) => Object.freeze({ ...rule }))),
  };
}

/** OpenCode-compatible anchored wildcard matching. */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  // OpenCode treats a trailing " *" as an optional argument suffix, so
  // "git status *" matches both "git status" and "git status --short".
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;

  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(
    normalized,
  );
}

export function evaluatePermission(
  rules: readonly PermissionRule[],
  permission: string,
  resource: string,
): PermissionAction {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (
      wildcardMatch(permission, rule.permission) &&
      wildcardMatch(resource, rule.pattern)
    ) {
      return rule.action;
    }
  }
  return "ask";
}

export function resolvePermissions(
  rules: readonly PermissionRule[],
  requests: readonly PermissionRequest[],
): PermissionResolution {
  const denied: PermissionRequest[] = [];
  const asked: PermissionRequest[] = [];

  for (const request of requests) {
    const action = evaluatePermission(rules, request.permission, request.resource);
    if (action === "deny") denied.push(request);
    if (action === "ask") asked.push(request);
  }

  return { denied, asked };
}
