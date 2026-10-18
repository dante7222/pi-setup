import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SubagentManager, type Report, type Worker } from "./manager.ts";
import { ROLES, THINKING_LEVELS, validateTasks, type Defaults, type Thinking } from "./tasks.ts";
import { renderCallLine, renderReports, renderResultText, reportDetails, type ReportDetails, type ReportView } from "./render.ts";
import { renderWidget, shortModelName, widgetCounts, type WidgetRow } from "./widget.ts";

const REPORT_TYPE = "subagent-report";
const REPORT_CHARS = 3000;
const ERROR_CHARS = 500;
const DELIVERY_DEBOUNCE_MS = 1500;
const DELIVERY_RETRY_MS = 2000;
/** A manager stashed for /reload that no reloaded instance adopted by then is disposed. */
const ADOPT_DEADLINE_MS = 60_000;
/** Finished subagents stay in the widget this long. */
const LINGER_MS = 5000;
const promptExtension = fileURLToPath(new URL("./worker-prompt.ts", import.meta.url));

// Managers outlive an extension reload: /reload must not kill running subagents.
const MANAGERS_KEY = Symbol.for("ventris.pi-subagents.managers");
const SETTINGS_KEY = Symbol.for("ventris.pi-subagents.settings");
/** Per-session state that must survive /reload together with its manager. */
interface SessionState {
  manager: SubagentManager;
  /** Esc on the parent: reports are recorded without starting a turn until the next user prompt. */
  interrupted: boolean;
  /** Subagents the current parent run (prompt to settlement) started or messaged; Esc stops only these. */
  runOwned: Set<string>;
}
const globals = globalThis as typeof globalThis & { [MANAGERS_KEY]?: Map<string, SessionState>; [SETTINGS_KEY]?: { autoWake: boolean } };
const detached = globals[MANAGERS_KEY] ??= new Map();
// `/subagents auto` lasts for the Pi process, including across /reload.
const settings = globals[SETTINGS_KEY] ??= { autoWake: true };

const parameters = Type.Object({
  action: StringEnum(["run", "send", "wait", "stop", "list"] as const),
  tasks: Type.Optional(Type.Array(Type.Object({
    name: Type.String({ description: "Unique lowercase slug, e.g. review-auth" }),
    task: Type.String({ description: "Self-contained instructions; the subagent has no parent history" }),
    role: Type.Optional(StringEnum(Object.keys(ROLES) as (keyof typeof ROLES)[], { description: "reviewer/explorer: read-only" })),
    model: Type.Optional(Type.String({ description: "provider/id, unique id, optional :thinking; omit to inherit" })),
    thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
    cwd: Type.Optional(Type.String()),
  }), { minItems: 1, maxItems: 16 })),
  name: Type.Optional(Type.String({ description: "send: target subagent" })),
  message: Type.Optional(Type.String({ description: "send: message text" })),
  names: Type.Optional(Type.Array(Type.String(), { description: "wait/stop: targets; omit for all" })),
  all: Type.Optional(Type.Boolean({ description: "wait: until all targets finish" })),
  seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 1800, description: "wait: max seconds (default 120)" })),
});

/** The parts of a report as the model sees them; the TUI renders the same parts from `details`. */
function reportView(report: Report): ReportView {
  const header = `[subagent ${report.name} ${report.state} ${report.seconds}s ${Math.round(report.tokens / 1000)}k tok]`;
  // Cut at a line boundary when one is reasonably close, so the last line is not mangled.
  const cut = report.text.lastIndexOf("\n", REPORT_CHARS);
  const head = report.text.slice(0, cut > REPORT_CHARS * 0.8 ? cut : REPORT_CHARS);
  const body = report.text.length > REPORT_CHARS ? `${head}\n[truncated; full report: ${report.path}]` : report.text;
  const error = report.error && report.error.length > ERROR_CHARS ? `${report.error.slice(0, ERROR_CHARS)}...` : report.error;
  return { header, state: report.state, ...(error ? { error } : {}), body };
}

export function formatReport(report: Report): string {
  const view = reportView(report);
  return [view.header, view.error ? `error: ${view.error}` : "", view.body].filter(Boolean).join("\n");
}

function describe(worker: Worker): string {
  const model = worker.task.model ? ` ${worker.task.model}${worker.task.thinking ? `:${worker.task.thinking}` : ""}` : "";
  const tool = worker.tool ? ` (${worker.tool})` : "";
  return `${worker.task.name} ${worker.task.role}${model} ${worker.state}${tool} ${Math.round(worker.total.tokens / 1000)}k`;
}

/** Run result: names grouped by state, with the model each resolved to (the caller may have given a fuzzy pattern). */
export function formatStarted(workers: readonly Worker[]): string {
  const label = (worker: Worker) => {
    // Full provider/id: a fuzzy pattern may match the same id under several providers.
    const model = worker.task.model;
    return model ? `${worker.task.name} (${model}${worker.task.thinking ? `:${worker.task.thinking}` : ""})` : worker.task.name;
  };
  const group = (state: string) => workers.filter((worker) => worker.state === state).map(label).join(", ");
  return [["started", group("running")], ["queued", group("queued")]].filter(([, names]) => names).map(([state, names]) => `${state}: ${names}`).join("; ");
}

function text(value: string, isError = false, details?: ReportDetails) {
  return { content: [{ type: "text" as const, text: value }], details, ...(isError ? { isError: true } : {}) };
}

function modelResolver(ctx: ExtensionContext): (pattern: string) => string {
  return (pattern) => {
    const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
    const available = ctx.modelRegistry.getAvailable();
    const exact = available.find((model) => key(model) === pattern);
    if (exact) return key(exact);
    const lower = pattern.toLowerCase();
    for (const match of [(id: string) => id.toLowerCase() === lower, (id: string) => id.toLowerCase().includes(lower)]) {
      const found = available.filter((model) => match(model.id) || match(key(model)));
      if (found.length === 1) return key(found[0]);
      if (found.length > 1) throw new Error(`Model "${pattern}" is ambiguous: ${found.slice(0, 8).map(key).join(", ")}.`);
    }
    throw new Error(`Unknown or unauthenticated model "${pattern}".`);
  };
}

export default function subagents(pi: ExtensionAPI): void {
  // Workers load this package too; they must never orchestrate.
  if (process.env.PI_SUBAGENT === "1") return;
  let manager: SubagentManager | undefined;
  let ctx: ExtensionContext | undefined;
  // Captured at session_start: a ctx may be stale by session_shutdown.
  let sessionId: string | undefined;
  let interrupted = false;
  let runOwned = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;

  const later = (ms: number) => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = undefined; flush(); }, ms);
    flushTimer.unref();
  };

  /**
   * Deliver reports only while the parent is idle. A message queued into a running
   * parent is dropped when the user presses Esc (Pi clears its queues), so busy
   * parents keep reports in the outbox until agent_settled or a later retry.
   */
  const flush = () => {
    const wake = settings.autoWake && !interrupted;
    const current = manager;
    if (!current?.outbox.length || !ctx) return;
    let idle = false;
    try { idle = ctx.isIdle(); } catch { return; }
    if (!idle) { later(DELIVERY_RETRY_MS); return; }
    // Wake once per batch: a run's reports wait until all its subagents finished.
    const reports = current.take((report) => current.isReady(report));
    if (!reports.length) return;
    // One message per batch: simultaneous completions wake the parent once.
    pi.sendMessage(
      { customType: REPORT_TYPE, content: reports.map(formatReport).join("\n\n"), display: true, details: { reports: reports.map(reportView) } satisfies ReportDetails },
      { triggerTurn: wake },
    );
  };

  // Rendered from live manager state on each frame, so updates only need a re-render.
  let requestRender: (() => void) | undefined;
  let widgetShown = false;
  let lingerTimer: NodeJS.Timeout | undefined;
  // Pi re-renders on every setStatus; skip unchanged text (render runs on each worker event).
  let statusText: string | undefined;
  const recent = (worker: Worker, now: number) => worker.report !== undefined && worker.finishedAt !== undefined && now - worker.finishedAt < LINGER_MS;
  const rows = (now = Date.now()): WidgetRow[] => [...(manager?.workers.values() ?? [])]
    .filter((worker) => worker.state === "running" || worker.state === "queued" || recent(worker, now))
    .map((worker) => {
      const [provider, ...id] = (worker.task.model ?? "").split("/");
      const model = provider && id.length ? ctx?.modelRegistry.find(provider, id.join("/")) : undefined;
      return {
        name: worker.task.name,
        model: model ? shortModelName(model.name || model.id) : id.join("/") || undefined,
        thinking: worker.task.thinking,
        state: worker.state === "queued" ? "queued" : worker.state !== "running" ? worker.report!.state : worker.endReason ? "stopping" : "running",
        tool: worker.tool,
        contextTokens: worker.contextTokens,
        contextWindow: model?.contextWindow,
      };
    });
  const render = () => {
    // Every ctx access stays inside try: a stale ctx throws, and this runs from worker
    // stdout handlers, where an escaping exception would crash the parent.
    try {
      if (!ctx?.hasUI || ctx.mode !== "tui") return;
      const now = Date.now();
      const current = manager ? rows(now) : [];
      // The footer keeps the counts visible when the widget scrolls away.
      const status = widgetCounts(current) || undefined;
      if (status !== statusText) { ctx.ui.setStatus("subagents", status); statusText = status; }
      // Re-render once the oldest finished row expires.
      const finished = [...(manager?.workers.values() ?? [])].filter((worker) => recent(worker, now)).map((worker) => worker.finishedAt! + LINGER_MS - now);
      clearTimeout(lingerTimer);
      lingerTimer = finished.length ? setTimeout(render, Math.max(50, Math.min(...finished))) : undefined;
      lingerTimer?.unref();
      if (!current.length) {
        if (widgetShown) ctx.ui.setWidget("subagents", undefined);
        widgetShown = false;
        requestRender = undefined;
      } else if (!widgetShown) {
        widgetShown = true;
        ctx.ui.setWidget("subagents", (tui, theme) => {
          requestRender = () => tui.requestRender();
          return { render: (width: number) => renderWidget(rows(), theme, width), invalidate() {} };
        });
      } else requestRender?.();
    } catch { /* stale ctx */ }
  };

  // Readiness can also change without a report, e.g. when a queued subagent is stopped.
  const hooks = {
    changed: () => { render(); if (manager?.outbox.length) later(DELIVERY_DEBOUNCE_MS); },
    report: () => later(DELIVERY_DEBOUNCE_MS),
  };

  const ensure = (current: ExtensionContext): SubagentManager => {
    sessionId ??= current.sessionManager.getSessionId();
    manager ??= new SubagentManager({ dir: join(getAgentDir(), "subagents", sessionId), env: process.env, promptExtension, hooks });
    return manager;
  };

  pi.on("session_start", (event, current) => {
    ctx = current;
    sessionId = current.sessionManager.getSessionId();
    const adopted = detached.get(sessionId);
    detached.delete(sessionId);
    if (event.reason === "reload" && adopted) {
      ({ manager, interrupted, runOwned } = adopted);
      adopted.manager.setHooks(hooks);
      render();
      flush();
    } else void adopted?.manager.dispose();
  });

  pi.on("session_shutdown", async (event) => {
    clearTimeout(flushTimer);
    clearTimeout(lingerTimer);
    flushTimer = lingerTimer = undefined;
    const current = manager;
    manager = undefined;
    if (!current) return;
    if (event.reason === "reload" && sessionId) {
      // Pi invalidates this ctx before the reloaded extension adopts the manager;
      // detach so worker events in between touch nothing stale.
      current.setHooks({ changed() {}, report() {} });
      ctx = undefined;
      const state = { manager: current, interrupted, runOwned };
      detached.set(sessionId, state);
      // The reloaded extension may fail to load or be removed; its workers must not run on unseen.
      const id = sessionId;
      setTimeout(() => {
        if (detached.get(id) !== state) return;
        detached.delete(id);
        void current.dispose();
      }, ADOPT_DEADLINE_MS).unref();
      return;
    }
    try { if (ctx?.hasUI && ctx.mode === "tui") { ctx.ui.setWidget("subagents", undefined); ctx.ui.setStatus("subagents", undefined); statusText = undefined; } } catch { /* stale ctx */ }
    await current.dispose();
  });

  // Ownership spans a whole run: retries and continuations emit more agent_start
  // events without settling, so only run boundaries reset it.
  pi.on("before_agent_start", (event) => {
    if (event.messageType === "user") interrupted = false;
  });
  pi.on("agent_settled", (event) => {
    if (event.aborted) {
      interrupted = true;
      // Esc also stops subagents this run started or messaged; earlier background
      // work keeps running. Stopped sessions remain available to `send`.
      const names = [...runOwned].filter((name) => manager?.workers.has(name));
      const stopped = names.length ? manager?.stop(names, "Parent run was stopped.") ?? [] : [];
      if (stopped.length && ctx?.hasUI) ctx.ui.notify(`Stopped subagents: ${stopped.join(", ")}`, "info");
    }
    runOwned.clear();
    flush();
  });

  pi.registerMessageRenderer(REPORT_TYPE, (message, { expanded }, theme) => {
    const details = reportDetails(message.details);
    // Messages from before this renderer existed carry no report details.
    if (details) return new Text(renderReports(details, expanded, theme), 0, 0);
    const lines = (typeof message.content === "string" ? message.content : "").split("\n");
    return new Text((expanded ? lines : lines.filter((line) => line.startsWith("[subagent ") || line.startsWith("error: "))).join("\n"), 0, 0);
  });

  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description: "Background Pi subagents. send steers a running subagent or continues a finished one with its history; stop aborts.",
    promptSnippet: "Delegate independent tasks to background Pi subagents",
    promptGuidelines: [
      "Use the subagents tool for independent work; give each task paths and acceptance criteria. Avoid overlapping file edits.",
      "Reports from one subagents run arrive together as one message; meanwhile continue or end your turn. Use wait only when blocked.",
    ],
    parameters,
    executionMode: "parallel",
    // Renderers draw only in the TUI; nothing here reaches the model.
    renderCall: (args, theme) => new Text(renderCallLine(args as Record<string, unknown>, theme), 0, 0),
    renderResult: (result, options, theme, context) => {
      const first = result.content[0];
      return new Text(renderResultText(first?.type === "text" ? first.text : "", result.details, { ...options, isError: context.isError }, theme), 0, 0);
    },
    async execute(_id, params, signal, _onUpdate, current) {
      ctx = current;
      try {
        const workers = ensure(current);
        switch (params.action) {
          case "run": {
            if (!params.tasks?.length) throw new Error("run requires tasks.");
            const defaults: Defaults = {
              cwd: current.cwd,
              model: current.model ? `${current.model.provider}/${current.model.id}` : undefined,
              thinking: pi.getThinkingLevel() as Thinking,
              resolveModel: modelResolver(current),
            };
            const created = workers.spawn(validateTasks(params.tasks, defaults, workers.busyNames()));
            for (const worker of created) runOwned.add(worker.task.name);
            return text(formatStarted(created));
          }
          case "send": {
            if (!params.name || !params.message?.trim()) throw new Error("send requires name and message.");
            workers.get(params.name);
            // Owned before awaiting: Esc during a slow steer reply must still stop it.
            runOwned.add(params.name);
            const outcome = await workers.send(params.name, params.message, signal);
            return text(`${params.name}: ${outcome}`);
          }
          case "wait": {
            const { reports, pending } = await workers.wait(params.names ?? [], params.seconds ?? 120, signal, params.all === true);
            const content = [reports.map(formatReport).join("\n\n") || "No new reports.", pending.length ? `pending: ${pending.join(", ")}` : ""].filter(Boolean).join("\n\n");
            return text(content, false, { reports: reports.map(reportView), pending });
          }
          case "stop": {
            const stopped = workers.stop(params.names ?? [...workers.workers.keys()]);
            return text(stopped.length ? `stopping: ${stopped.join(", ")}` : "Nothing to stop.");
          }
          case "list":
            return text([...workers.workers.values()].map(describe).join("\n") || "No subagents.");
        }
      } catch (error) {
        return text(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "List subagents; stop [name|all]; auto on|off (wake on reports)",
    handler: async (args, current) => {
      ctx = current;
      const [command, value] = args.trim().split(/\s+/);
      if (command === "auto" && (value === "on" || value === "off")) {
        settings.autoWake = value === "on";
        current.ui.notify(`Subagent reports ${settings.autoWake ? "wake the agent" : "wait for your next prompt"}.`, "info");
        return;
      }
      if (command === "stop") {
        const names = !value || value === "all" ? [...(manager?.workers.keys() ?? [])] : [value];
        try { current.ui.notify(`Stopping: ${manager?.stop(names).join(", ") || "nothing"}`, "info"); }
        catch (error) { current.ui.notify(String(error), "error"); }
        return;
      }
      if (command) { current.ui.notify("Usage: /subagents [stop [name|all] | auto on|off]", "warning"); return; }
      const lines = [...(manager?.workers.values() ?? [])].map(describe);
      current.ui.notify(`${lines.join("\n") || "No subagents."}\nauto-wake: ${settings.autoWake ? "on" : "off"}`, "info");
    },
  });
}
