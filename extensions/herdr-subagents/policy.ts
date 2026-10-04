import { join } from "node:path";
import { atomic, json, locked, validateTasks, type Scope, type Task } from "./core.ts";

export interface Preset { model: string; thinking?: string; maxTokens?: number; maxCost?: number }
export type Presets = Record<string, Preset>;

export async function presets(scope: Scope): Promise<Presets> {
  return await json<Presets>(join(scope.root, "presets.json")) ?? {};
}

/** Explicit per-session presets: no cloud/provider names or prices are hardcoded. */
export async function configurePresets(scope: Scope, input: unknown): Promise<Presets> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 32) throw new Error("Expected at most 32 named model presets.");
  const validated: Presets = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model preset.");
    const entry = value as Record<string, unknown>;
    if (typeof entry.model !== "string" || Object.keys(entry).some((key) => !["model", "thinking", "maxTokens", "maxCost"].includes(key))) throw new Error("Presets require a model and optional thinking/maxTokens/maxCost.");
    const [task] = validateTasks([{ name, prompt: "validate preset", ...entry }], {});
    validated[name] = { model: task.model!, thinking: task.thinking, maxTokens: task.maxTokens, maxCost: task.maxCost };
  }
  await locked(scope, async () => { await atomic(join(scope.root, "presets.json"), validated); });
  return validated;
}

export async function resolveTasks(scope: Scope, input: unknown, env: NodeJS.ProcessEnv, cwd: string): Promise<Task[]> {
  if (!Array.isArray(input)) return validateTasks(input, env, cwd);
  const configured = await presets(scope);
  return validateTasks(input.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("preset" in item)) return item;
    const { preset, ...task } = item;
    if (typeof preset !== "string" || !Object.hasOwn(configured, preset)) throw new Error(`Unknown model preset: ${String(preset)}`);
    // An explicit model must not accidentally inherit another model's reasoning.
    const defaults = { ...configured[preset] };
    if ("model" in task && !("thinking" in task)) delete defaults.thinking;
    return { ...defaults, ...task };
  }), env, cwd);
}
