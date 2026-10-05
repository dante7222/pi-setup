import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionRequest } from "./policy.ts";

interface NormalizedToolPath {
  absolute: string;
  resource: string;
  external: boolean;
}

type PathKind = "file" | "directory";

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

// Match Pi 1.0.2 resolveToCwd/normalizePath without importing private runtime
// modules. This is lexical classification, not symlink-safe containment.
function expandToolPath(rawPath: string, toolInput = true): string {
  let path = toolInput
    ? rawPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    : rawPath;
  if (toolInput && path.startsWith("@")) path = path.slice(1);
  if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
    const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) path = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(homedir(), path.slice(2));
  }
  // Decode only lowercase file:// URLs, just like the tools. Malformed URLs
  // must throw; ordinary filenames containing percent escapes remain literal.
  return path.startsWith("file://") ? fileURLToPath(path) : path;
}

function toSlashPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeToolPath(cwd: string, rawPath: string): NormalizedToolPath {
  const absoluteCwd = resolve(expandToolPath(cwd, false));
  const absolute = resolve(absoluteCwd, expandToolPath(rawPath));
  return classifyAbsolutePath(absoluteCwd, absolute);
}

function classifyAbsolutePath(absoluteCwd: string, absolute: string): NormalizedToolPath {
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
  path: NormalizedToolPath,
  kind: PathKind,
): void {
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

// Native read selects an existing spelling, not just a lexical path. Mirror
// resolveReadPathAsync's ordered fallbacks without a private runtime import.
// Existence checks do not make this a sandbox: symlinks and TOCTOU still apply.
export async function permissionRequestsForToolAsync(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
): Promise<PermissionRequest[]> {
  signal?.throwIfAborted();
  if (adapterName(toolName) !== "read") return permissionRequestsForTool(toolName, input, cwd);

  const absoluteCwd = resolve(expandToolPath(cwd, false));
  const resolved = resolve(absoluteCwd, expandToolPath(requiredString(input, "path", "read")));
  const nfd = resolved.normalize("NFD");
  const variants = [
    resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    resolved.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ];
  let selected = resolved;
  for (const candidate of [resolved, ...variants.filter((variant) => variant !== resolved)]) {
    signal?.throwIfAborted();
    let exists = false;
    try {
      await access(candidate, constants.F_OK);
      exists = true;
    } catch {
      // Native read treats all access failures as a missing candidate.
    }
    signal?.throwIfAborted();
    if (exists) {
      selected = candidate;
      break;
    }
  }

  const requests: PermissionRequest[] = [];
  // Never pass the selected path back through tool-input normalization: that
  // would erase narrow spaces, including those decoded from a file URL.
  addPathRequests(requests, "read", classifyAbsolutePath(absoluteCwd, selected), "file");
  return requests;
}

// Lexical adapter for non-read tools and lexical path parity tests. Production
// permission checks must use the async adapter above for native read targets.
export function permissionRequestsForTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): PermissionRequest[] {
  const requests: PermissionRequest[] = [];
  const name = adapterName(toolName);

  if (name === "read") {
    addPathRequests(requests, "read", normalizeToolPath(cwd, requiredString(input, "path", name)), "file");
    return deduplicate(requests);
  }

  if (name === "edit" || name === "write") {
    addPathRequests(requests, "edit", normalizeToolPath(cwd, requiredString(input, "path", name)), "file");
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
    addPathRequests(requests, "list", normalizeToolPath(cwd, rawPath || "."), "directory");
    return deduplicate(requests);
  }

  if (name === "bash") {
    return bashPermissionResources(requiredString(input, "command", name)).map(
      (resource) => ({ permission: "bash", resource }),
    );
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
