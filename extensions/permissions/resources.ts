import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { PermissionRequest } from "./policy.ts";

interface NormalizedToolPath {
  absolute: string;
  resource: string;
  external: boolean;
}

type PathKind = "file" | "directory";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`${toolName}.${key} must be a string`);
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  toolName: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${toolName}.${key} must be a string when provided`);
  }
  return value;
}

function expandToolPath(rawPath: string): string {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  if (withoutAt === "~") return homedir();
  if (withoutAt.startsWith("~/") || withoutAt.startsWith("~\\")) {
    return homedir() + withoutAt.slice(1);
  }
  return withoutAt;
}

function toSlashPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeToolPath(cwd: string, rawPath: string): NormalizedToolPath {
  const absoluteCwd = resolve(cwd);
  const absolute = resolve(absoluteCwd, expandToolPath(rawPath));
  const relativePath = relative(absoluteCwd, absolute);
  const external =
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);

  return {
    absolute,
    resource: external ? toSlashPath(absolute) : toSlashPath(relativePath || "."),
    external,
  };
}

function externalDirectoryRequest(
  path: NormalizedToolPath,
  kind: PathKind,
): PermissionRequest | undefined {
  if (!path.external) return undefined;
  const directory = kind === "file" ? dirname(path.absolute) : path.absolute;
  return {
    permission: "external_directory",
    resource: toSlashPath(resolve(directory, "*")),
  };
}

function addPathRequests(
  requests: PermissionRequest[],
  permission: string,
  cwd: string,
  rawPath: string,
  kind: PathKind,
): void {
  const path = normalizeToolPath(cwd, rawPath);
  requests.push({ permission, resource: path.resource });
  const external = externalDirectoryRequest(path, kind);
  if (external) requests.push(external);
}

function stringsFromArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function deduplicate(requests: PermissionRequest[]): PermissionRequest[] {
  const seen = new Set<string>();
  return requests.filter((request) => {
    const key = `${request.permission}\0${request.resource}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// OpenCode evaluates parsed shell commands individually. Split common shell chains so
// an allowed first command cannot approve an unlisted or denied suffix command.
function bashPermissionResources(command: string): string[] {
  const resources: string[] = [];
  let start = 0;
  let quote: "single" | "double" | undefined;
  let dynamic = false;

  const append = (end: number): void => {
    const resource = command.slice(start, end).trim();
    if (resource) resources.push(resource);
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];

    if (quote === "single") {
      if (character === "'") quote = undefined;
      continue;
    }

    if (quote === "double") {
      if (character === "\\") {
        index++;
        continue;
      }
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "`" || (character === "$" && command[index + 1] === "(")) {
        dynamic = true;
      }
      continue;
    }

    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (
      character === "`" ||
      character === "(" ||
      character === ")" ||
      ((character === "$" || character === "<" || character === ">") &&
        command[index + 1] === "(")
    ) {
      dynamic = true;
    }

    if (
      character !== ";" &&
      character !== "\n" &&
      character !== "\r" &&
      character !== "&" &&
      character !== "|"
    ) {
      continue;
    }
    if (
      (character === "&" &&
        (command[index - 1] === ">" || command[index - 1] === "<" || command[index + 1] === ">")) ||
      (character === "|" && command[index - 1] === ">")
    ) {
      continue;
    }

    append(index);
    while (command[index + 1] === "&" || command[index + 1] === "|") index++;
    start = index + 1;
  }

  append(command.length);
  if (dynamic) resources.push(`<dynamic shell syntax> ${command}`);
  return [...new Set(resources.length > 0 ? resources : [command])];
}

function adapterName(toolName: string): string {
  return toolName.split(".").at(-1) ?? toolName;
}

export function permissionRequestsForTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): PermissionRequest[] {
  const requests: PermissionRequest[] = [];
  const name = adapterName(toolName);

  if (name === "read") {
    addPathRequests(requests, "read", cwd, requiredString(input, "path", name), "file");
    return deduplicate(requests);
  }

  if (name === "edit" || name === "write") {
    addPathRequests(requests, "edit", cwd, requiredString(input, "path", name), "file");
    return deduplicate(requests);
  }

  if (name === "apply_patch" || name === "patch") {
    return [{ permission: "edit", resource: "*" }];
  }

  if (name === "grep" || name === "rg") {
    requests.push({
      permission: "grep",
      resource: requiredString(input, "pattern", name),
    });
    const searchPath = optionalString(input, "path", name);
    if (searchPath !== undefined) {
      const path = normalizeToolPath(cwd, searchPath || ".");
      const external = externalDirectoryRequest(path, "directory");
      if (external) requests.push(external);
    }
    return deduplicate(requests);
  }

  if (name === "find") {
    requests.push({
      permission: "glob",
      resource: requiredString(input, "pattern", name),
    });
    const searchPath = optionalString(input, "path", name);
    if (searchPath !== undefined) {
      const path = normalizeToolPath(cwd, searchPath || ".");
      const external = externalDirectoryRequest(path, "directory");
      if (external) requests.push(external);
    }
    return deduplicate(requests);
  }

  if (name === "ls") {
    const rawPath = optionalString(input, "path", name) ?? ".";
    addPathRequests(requests, "list", cwd, rawPath || ".", "directory");
    return deduplicate(requests);
  }

  if (name === "bash") {
    return bashPermissionResources(requiredString(input, "command", name)).map(
      (resource) => ({ permission: "bash", resource }),
    );
  }

  if (name === "delegate") {
    const mode = optionalString(input, "mode", name) ?? "research";
    return [{ permission: "task", resource: mode }];
  }

  if (name === "delegate_parallel") {
    const tasks = input.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error("delegate_parallel.tasks must be a non-empty array");
    }
    for (const task of tasks) {
      if (!isRecord(task)) throw new Error("delegate_parallel.tasks entries must be objects");
      requests.push({
        permission: "task",
        resource: optionalString(task, "mode", "delegate_parallel task") ?? "research",
      });
    }
    return deduplicate(requests);
  }

  if (name === "delegate_loop") {
    requests.push({ permission: "task", resource: "coding" });
    const checks = input.checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      throw new Error("delegate_loop.checks must be a non-empty array");
    }
    for (const check of checks) {
      if (!isRecord(check)) throw new Error("delegate_loop.checks entries must be objects");
      const command = requiredString(check, "command", "delegate_loop check");
      for (const resource of bashPermissionResources(command)) {
        requests.push({ permission: "bash", resource });
      }
    }
    return deduplicate(requests);
  }

  if (name === "delegate_apply") {
    return [{ permission: "task", resource: "apply" }];
  }

  if (name === "web_search") {
    const query = optionalString(input, "query", name);
    const queries = stringsFromArray(input.queries, `${name}.queries`);
    for (const resource of [...(query === undefined ? [] : [query]), ...queries]) {
      requests.push({ permission: "websearch", resource });
    }
    return deduplicate(requests.length > 0 ? requests : [{ permission: "websearch", resource: "*" }]);
  }

  if (name === "fetch_content") {
    const url = optionalString(input, "url", name);
    const urls = stringsFromArray(input.urls, `${name}.urls`);
    for (const resource of [...(url === undefined ? [] : [url]), ...urls]) {
      requests.push({ permission: "webfetch", resource });
    }
    return deduplicate(requests.length > 0 ? requests : [{ permission: "webfetch", resource: "*" }]);
  }

  if (name === "get_search_content") {
    return [{
      permission: "get_search_content",
      resource: optionalString(input, "responseId", name) ?? "*",
    }];
  }

  if (name === "skill") {
    const skillName = optionalString(input, "name", name) ?? optionalString(input, "skill", name);
    return [{ permission: "skill", resource: skillName ?? "*" }];
  }

  if (name === "question" || name === "ask_question") {
    return [{ permission: "question", resource: "*" }];
  }

  return [{ permission: toolName, resource: "*" }];
}
