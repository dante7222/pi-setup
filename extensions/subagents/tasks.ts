import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ROLES = {
  worker: "Complete the assigned task. Report changes, validation and remaining risks.",
  reviewer: "Review only; do not edit files. Report actionable defects with severity, file:line, evidence and a fix suggestion. Say when no defects were found.",
  explorer: "Explore only; do not edit files. Report relevant file paths, symbols, relationships and concrete answers.",
  tester: "Run relevant tests. Report exact commands, outcomes and failures. Do not modify source or tests unless explicitly assigned.",
} as const;

export type Role = keyof typeof ROLES;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

/**
 * Roles that must not mutate files run with a read-only tool allowlist and without
 * skills or MCP, which also keeps their bootstrap prompt small. `bash` stays for git
 * and search, so read-only is still partly enforced by the prompt.
 */
const READ_ONLY_ROLES: ReadonlySet<Role> = new Set(["reviewer", "explorer"]);
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];

export interface TaskInput {
  name: string;
  task: string;
  role?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
}

export interface Task {
  name: string;
  task: string;
  role: Role;
  /** `provider/id`, resolved against the parent's model registry. */
  model?: string;
  thinking?: Thinking;
  cwd: string;
  /** The parent's trust decision for `cwd`, when the worker runs in the parent's project. */
  trusted?: boolean;
}

export interface Defaults {
  cwd: string;
  /** Whether the parent trusts the project at `cwd`. */
  trusted?: boolean;
  /** Parent model as `provider/id`. */
  model?: string;
  thinking?: Thinking;
  /** Resolve a model pattern to `provider/id`; throws for unknown or ambiguous models. */
  resolveModel(pattern: string): string;
}

export const NAME = "[a-z][a-z0-9-]{0,31}";
const NAME_PATTERN = new RegExp(`^${NAME}$`);

/** `~` and `~/x` as the home directory, like Pi's tools. */
export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function validateTasks(inputs: readonly TaskInput[], defaults: Defaults, taken: ReadonlySet<string>): Task[] {
  const names = new Set<string>();
  return inputs.map((input) => {
    if (!NAME_PATTERN.test(input.name)) throw new Error(`Invalid name "${input.name}": use lowercase a-z, 0-9, - (max 32, starts with a letter).`);
    if (names.has(input.name) || taken.has(input.name)) throw new Error(`Name "${input.name}" is already in use.`);
    names.add(input.name);
    if (!input.task.trim()) throw new Error(`Task for "${input.name}" is empty.`);
    const role = (input.role ?? "worker") as Role;
    if (!Object.hasOwn(ROLES, role)) throw new Error(`Unknown role "${input.role}". Use ${Object.keys(ROLES).join("|")}.`);
    if (input.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(input.thinking)) {
      throw new Error(`Unknown thinking level "${input.thinking}".`);
    }
    // Accept Pi's `model:thinking` shorthand.
    const [, pattern, suffix] = /^(.*?)(?::([a-z]+))?$/.exec(input.model?.trim() ?? "") ?? [];
    const suffixThinking = suffix && (THINKING_LEVELS as readonly string[]).includes(suffix) ? suffix as Thinking : undefined;
    const modelPattern = suffix && !suffixThinking ? input.model!.trim() : pattern;
    // An explicit model drops inherited thinking: levels are not portable across models.
    const model = modelPattern ? defaults.resolveModel(modelPattern) : defaults.model;
    const thinking = (input.thinking as Thinking | undefined) ?? suffixThinking ?? (modelPattern ? undefined : defaults.thinking);
    const cwd = resolve(defaults.cwd, expandHome(input.cwd?.trim() || "."));
    // A missing cwd would surface as a spawn ENOENT that names the node binary.
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`cwd for "${input.name}" is not a directory: ${cwd}`);
    // A headless worker cannot ask, so an undecided project would load without its .pi resources
    // even when the parent trusts it for this session. Elsewhere Pi decides on its own.
    return { name: input.name, task: input.task, role, model, thinking, cwd, ...(cwd === resolve(defaults.cwd) && defaults.trusted !== undefined ? { trusted: defaults.trusted } : {}) };
  });
}

/** Depends on the role only, so sibling workers of one role send an identical, cacheable prefix. */
export function systemPrompt(role: Role): string {
  return [
    `You are ${role === "explorer" ? "an" : "a"} ${role} subagent. ${ROLES[role]}`,
    "You have no access to the parent conversation; the task message is self-contained.",
    "Do not commit. You cannot ask questions: state assumptions or report blockers.",
    "You may receive follow-up messages later; answer each one with a fresh concise report.",
    "Only your final message is delivered: end with a concise, complete report (aim under 1500 characters, include critical evidence such as file:line). No preamble.",
  ].join("\n");
}

/** Arguments for `pi --mode rpc`; the task itself is sent as an RPC prompt. */
// `--session-id` opens the existing session file when present, so the same
// arguments both start a worker and revive it after an idle shutdown.
export function rpcArgs(task: Task, session: { id: string; dir: string }, promptExtension: string): string[] {
  const args = ["--mode", "rpc", "--session-dir", session.dir, "--session-id", session.id, "--name", task.name];
  if (task.model) args.push("--model", task.model);
  if (task.thinking) args.push("--thinking", task.thinking);
  if (task.trusted !== undefined) args.push(task.trusted ? "--approve" : "--no-approve");
  // Workers never orchestrate. Extensions still load in read-only roles (e.g. bash
  // timeouts); the allowlist only drops their tools.
  if (READ_ONLY_ROLES.has(task.role)) args.push("--no-skills", "--no-mcp", "--tools", READ_ONLY_TOOLS.join(","));
  else args.push("--exclude-tools", "subagents");
  // An extension rather than --append-system-prompt keeps APPEND_SYSTEM.md discovery.
  args.push("-e", promptExtension);
  return args;
}
