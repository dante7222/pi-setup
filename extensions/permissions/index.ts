import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  parsePermissionConfig,
  resolvePermissions,
  type CompiledPermissionConfig,
  type PermissionRequest,
} from "./policy.ts";
import { permissionRequestsForTool } from "./resources.ts";

const CONFIG_ENV = "PI_PERMISSION_CONFIG";
const CONFIG_PATH = fileURLToPath(new URL("../../pi.json", import.meta.url));
const MAX_CONFIG_BYTES = 1024 * 1024;
const ENTRY_TYPE = "ventris-permissions";
const ENTRY_VERSION = 1;
const STATUS_KEY = "permissions";
const YOLO_ENV = "VENTRIS_PI_PERMISSION_YOLO";
const RPC_PROMPT_TIMEOUT_MS = 30_000;

const CHOICE_DENY = "Deny";
const CHOICE_ONCE = "Allow once";
const CHOICE_SESSION = "Allow for this session";

type PermissionStateEntry =
  | {
      version: 1;
      sessionId: string;
      operation: "grant";
      keys: string[];
    }
  | {
      version: 1;
      sessionId: string;
      operation: "clear";
    }
  | {
      version: 1;
      sessionId: string;
      operation: "yolo";
      enabled: boolean;
    };

interface RuntimeState {
  configPath: string;
  cliYolo: boolean;
  yolo: boolean;
  policy?: CompiledPermissionConfig;
  error?: string;
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return homedir() + value.slice(1);
  }
  return value;
}

function selectedConfigPath(cwd: string): string {
  const override = process.env[CONFIG_ENV]?.trim();
  if (!override) return CONFIG_PATH;
  const expanded = expandHomePath(override);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

async function loadPolicy(configPath: string): Promise<CompiledPermissionConfig> {
  const info = await stat(configPath);
  if (!info.isFile()) throw new Error("configuration path is not a file");
  if (info.size > MAX_CONFIG_BYTES) {
    throw new Error(`configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  const text = await readFile(configPath, "utf8");
  const parsed: unknown = JSON.parse(text);
  return parsePermissionConfig(parsed);
}

function parseStateEntry(value: unknown): PermissionStateEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.version !== ENTRY_VERSION || typeof data.sessionId !== "string") {
    return undefined;
  }
  if (data.operation === "grant") {
    if (!Array.isArray(data.keys) || data.keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    return {
      version: ENTRY_VERSION,
      sessionId: data.sessionId,
      operation: "grant",
      keys: data.keys as string[],
    };
  }
  if (data.operation === "clear") {
    return {
      version: ENTRY_VERSION,
      sessionId: data.sessionId,
      operation: "clear",
    };
  }
  if (data.operation === "yolo" && typeof data.enabled === "boolean") {
    return {
      version: ENTRY_VERSION,
      sessionId: data.sessionId,
      operation: "yolo",
      enabled: data.enabled,
    };
  }
  return undefined;
}

function grantKey(request: PermissionRequest): string {
  return createHash("sha256")
    .update(request.permission)
    .update("\0")
    .update(request.resource)
    .digest("hex");
}

function restoreSessionState(ctx: ExtensionContext, sessionGrants: Set<string>): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  let yolo = false;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = parseStateEntry(entry.data);
    if (!data || data.sessionId !== sessionId) continue;
    if (data.operation === "clear") {
      sessionGrants.clear();
      continue;
    }
    if (data.operation === "yolo") {
      yolo = data.enabled;
      continue;
    }
    for (const key of data.keys) sessionGrants.add(key);
  }
  return yolo;
}

function sanitizePreview(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function truncatePreview(value: string, maxLength = 280): string {
  const clean = sanitizePreview(value);
  if (clean.length <= maxLength) return clean;
  const tailLength = Math.floor(maxLength / 3);
  return `${clean.slice(0, maxLength - tailLength - 3)}...${clean.slice(-tailLength)}`;
}

function describeRequest(request: PermissionRequest): string {
  return `${request.permission}: ${truncatePreview(request.resource) || "(empty)"}`;
}

function describeRequests(requests: readonly PermissionRequest[]): string {
  const visible = requests.slice(0, 8).map((request) => `  ${describeRequest(request)}`);
  if (requests.length > visible.length) {
    visible.push(`  ...and ${requests.length - visible.length} more`);
  }
  return visible.join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateStatus(ctx: ExtensionContext, state: RuntimeState): void {
  if (ctx.mode !== "tui") return;
  const status = state.yolo
    ? ctx.ui.theme.bold(ctx.ui.theme.fg("error", "YOLO mode"))
    : undefined;
  ctx.ui.setStatus(STATUS_KEY, status);
}

export default function permissions(pi: ExtensionAPI): void {
  pi.registerFlag("yolo", {
    description: "Bypass all agent tool permission checks, including configured denies",
    type: "boolean",
    default: false,
  });

  let state: RuntimeState = {
    configPath: CONFIG_PATH,
    cliYolo: false,
    yolo: false,
    error: "not initialized",
  };
  const sessionGrants = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    sessionGrants.clear();
    const cliYolo = pi.getFlag("yolo") === true;
    const sessionYolo = restoreSessionState(ctx, sessionGrants);
    const yolo = cliYolo || sessionYolo;
    state = {
      configPath: selectedConfigPath(ctx.cwd),
      cliYolo,
      yolo,
      error: yolo ? undefined : "configuration is loading",
    };
    if (yolo) process.env[YOLO_ENV] = "1";
    else delete process.env[YOLO_ENV];

    if (yolo) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "YOLO mode active: all agent tool permission checks are bypassed.",
          "warning",
        );
      }
      updateStatus(ctx, state);
      return;
    }

    try {
      const policy = await loadPolicy(state.configPath);
      state = { ...state, policy, error: undefined };
    } catch (error) {
      state = { ...state, policy: undefined, error: errorMessage(error) };
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Permissions blocked all agent tools: ${state.configPath}: ${state.error}`,
          "error",
        );
      }
    }

    updateStatus(ctx, state);
  });

  pi.on("session_shutdown", () => {
    delete process.env[YOLO_ENV];
  });

  pi.on("tool_call", async (event, ctx) => {
    if (state.yolo) return undefined;
    if (!state.policy) {
      return {
        block: true,
        reason: `Permissions unavailable: ${state.configPath}: ${state.error ?? "unknown configuration error"}`,
      };
    }

    let requests: PermissionRequest[];
    try {
      requests = permissionRequestsForTool(event.toolName, event.input, ctx.cwd);
    } catch (error) {
      return {
        block: true,
        reason: `Permissions rejected malformed ${event.toolName} input: ${errorMessage(error)}`,
      };
    }

    const resolution = resolvePermissions(state.policy.rules, requests);
    if (resolution.denied.length > 0) {
      return {
        block: true,
        reason: `Denied by ${state.configPath}: ${describeRequest(resolution.denied[0])}`,
      };
    }

    const unresolved = resolution.asked.filter(
      (request) => !sessionGrants.has(grantKey(request)),
    );
    if (unresolved.length === 0) return undefined;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Approval required but ${ctx.mode} mode has no permission UI: ${describeRequest(unresolved[0])}`,
      };
    }

    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(
        `Permission required\n\n${describeRequests(unresolved)}`,
        [CHOICE_DENY, CHOICE_ONCE, CHOICE_SESSION],
        {
          signal: ctx.signal,
          timeout: ctx.mode === "rpc" ? RPC_PROMPT_TIMEOUT_MS : undefined,
        },
      );
    } catch (error) {
      return {
        block: true,
        reason: `Permission prompt failed: ${errorMessage(error)}`,
      };
    }

    if (choice === CHOICE_ONCE) return undefined;
    if (choice === CHOICE_SESSION) {
      const keys = unresolved.map(grantKey);
      for (const key of keys) sessionGrants.add(key);
      pi.appendEntry(ENTRY_TYPE, {
        version: ENTRY_VERSION,
        sessionId: ctx.sessionManager.getSessionId(),
        operation: "grant",
        keys,
      } satisfies PermissionStateEntry);
      updateStatus(ctx, state);
      return undefined;
    }

    return {
      block: true,
      reason: `Permission denied by user: ${describeRequest(unresolved[0])}`,
    };
  });

  pi.registerCommand("yolo", {
    description: "Toggle YOLO permission bypass for this session",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /yolo", "warning");
        return;
      }

      if (state.cliYolo) {
        ctx.ui.notify(
          "YOLO mode was forced by --yolo. Restart Pi without --yolo to disable it.",
          "warning",
        );
        return;
      }

      if (!state.yolo) {
        state = { ...state, yolo: true };
        pi.appendEntry(ENTRY_TYPE, {
          version: ENTRY_VERSION,
          sessionId: ctx.sessionManager.getSessionId(),
          operation: "yolo",
          enabled: true,
        } satisfies PermissionStateEntry);
        process.env[YOLO_ENV] = "1";
        if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
        updateStatus(ctx, state);
        ctx.ui.notify(
          "YOLO mode enabled for this session: all permission checks are bypassed.",
          "warning",
        );
        return;
      }

      state = { ...state, yolo: false };
      if (!state.policy) {
        state = { ...state, error: "configuration is loading" };
        try {
          const policy = await loadPolicy(state.configPath);
          state = { ...state, policy, error: undefined };
        } catch (error) {
          state = { ...state, policy: undefined, error: errorMessage(error) };
        }
      }
      pi.appendEntry(ENTRY_TYPE, {
        version: ENTRY_VERSION,
        sessionId: ctx.sessionManager.getSessionId(),
        operation: "yolo",
        enabled: false,
      } satisfies PermissionStateEntry);
      delete process.env[YOLO_ENV];
      updateStatus(ctx, state);
      if (state.policy) {
        ctx.ui.notify("YOLO mode disabled; pi.json permissions are active.", "info");
      } else {
        ctx.ui.notify(
          `YOLO mode disabled; tools are blocked because permissions could not load: ${state.error}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("permissions", {
    description: "Show permission policy status or clear session approvals",
    handler: async (args, ctx) => {
      const operation = args.trim();
      if (operation === "clear") {
        sessionGrants.clear();
        pi.appendEntry(ENTRY_TYPE, {
          version: ENTRY_VERSION,
          sessionId: ctx.sessionManager.getSessionId(),
          operation: "clear",
        } satisfies PermissionStateEntry);
        updateStatus(ctx, state);
        ctx.ui.notify("Cleared permission approvals for this session.", "info");
        return;
      }
      if (operation) {
        ctx.ui.notify("Usage: /permissions [clear]", "warning");
        return;
      }

      const lines = [
        `Config: ${state.configPath}`,
        `Status: ${state.yolo ? "YOLO (all permission checks bypassed)" : state.policy ? "active" : `blocked (${state.error ?? "unknown error"})`}`,
        `Rules: ${state.yolo ? "bypassed" : state.policy?.rules.length ?? 0}`,
        `Session grants: ${sessionGrants.size}`,
        `Override: ${CONFIG_ENV}=<path>`,
        "Scope: agent tool calls only; this is an approval gate, not a sandbox.",
      ];
      ctx.ui.notify(lines.join("\n"), state.yolo || state.policy ? "info" : "error");
    },
  });
}
