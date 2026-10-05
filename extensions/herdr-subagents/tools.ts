import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { cleanup, closeJobs, jobs, locked, PAGE_BYTES, prepareTasks, reportPage, requestStatus, RequestDiagnosticError, scopeFor, spawnTasks, status } from "./core.ts";
import { acknowledgeReport, readManyReports, readReport, waitForReports } from "./reports.ts";
import { claimScope } from "./ownership.ts";
import { continueTask, sendTask, stopTask } from "./conversations.ts";
import { reattachJob } from "./presentation.ts";
import { configure, settings } from "./scheduler.ts";
import { recoverTask } from "./recovery.ts";
import { configurePresets, presets, resolveTasks } from "./policy.ts";
import { nextReports } from "./workflow.ts";
import { outputSchema } from "./output-schema.ts";

import { parameters, publicParameters } from "./input-schema.ts";
import { actionHelp } from "./discovery.ts";

function result(action: string, data: unknown, failure?: unknown): AgentToolResult {
  let error = failure === undefined ? undefined : failure instanceof Error ? failure.message : String(failure);
  const diagnostic = failure instanceof RequestDiagnosticError
    ? { code: failure.code, diagnostic: failure.diagnostic, inspection: failure.inspection } : {};
  if (error !== undefined) {
    // Keep actionable metadata intact and reserve its escaped JSON bytes before
    // shortening the human-readable error. Diagnostic job lists are bounded.
    const overhead = Buffer.byteLength(JSON.stringify({ ok: false, action, error: "", ...diagnostic }));
    const bounded = reportPage(error, 0, Math.max(0, PAGE_BYTES - overhead - 3));
    error = bounded.length < error.length ? `${bounded}...` : bounded;
  }
  // Round-trip removes optional undefined fields and keeps metadata JSON-only.
  const envelope = JSON.parse(JSON.stringify(error === undefined
    ? { ok: true, action, data }
    : { ok: false, action, error, ...diagnostic })) as JsonValue;
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    details: envelope,
    structuredContent: envelope,
    ...(error === undefined ? {} : { isError: true }),
    // Worker usage is report metadata, never repeated as parent tool usage.
  };
}

export function registerSubagentTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description: "Run Herdr subagents. Prefer next: acknowledge consumed prior receipts, close eligible jobs, wait and return one bounded batch. Check ok; consume new pages before the next call.",
    exposure: "deferred",
    namespace: {
      name: "subagents",
      description: "Session-scoped Herdr subagents and replay-safe reports.",
      instructions: "Check result.ok before using data; errors also return an envelope. Call prepare with tasks to persist an immutable payload without launching; retain its requestId in a successful separate codemode call, then spawn with only that ID. Retry the same ID after uncertainty, never prepare a replacement. Explicit-task spawn remains available. Request errors include diagnostic and inspection metadata; request_status includes historical closed jobs. Defaults are resolved once at first admission. Prefer next (default wait 30s, max 60s; optional details): explicitly acknowledge prior consumed receipts, close eligible jobs, wait and return one batch. New pages are never acknowledged in that call. Emit the entire result and store its report receipts; call next again only AFTER consuming that output in a later model call, never in a script loop. The whole result shares 12 KB. Inspect per-job errors; finish only on finished:true. acknowledgementRequired means new pages need a later acknowledgement cycle. Granular wait/read/read_many/ack/close remain available. For narrow discovery use help with 1..3 action names; await describeTool for the complete interface. Close only closes fully acknowledged jobs; cancel ids or 'all' explicitly stops workers. Aborting a tool wait leaves workers running. Usage is metadata, not additional parent usage.",
    },
    parameters: publicParameters,
    outputSchema,
    // Core/report operations lock their own mutations; a wait must not block cancel.
    executionMode: "parallel",
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      try {
        signal?.throwIfAborted();
        if (!Check(parameters, input)) throw new Error("Invalid subagents action or arguments.");
        const params = input as Static<typeof parameters>;
        // Schema-only help is independent of session ownership and Herdr I/O.
        if (params.action === "help") return result("help", actionHelp(params.actions));
        const session = ctx.sessionManager.getSessionId();
        if (!session) throw new Error("A current Pi session ID is required.");
        const scope = scopeFor(session);
        await claimScope(scope, signal);
        let data: unknown;
        switch (params.action) {
          case "prepare": data = await prepareTasks(scope, params.tasks, signal); break;
          case "spawn": {
            const started = await spawnTasks(scope, {
              intent: params.tasks,
              // Resolve only after retry lookup, inside the admission lock. Never
              // inherit stale PI_MODEL / PI_REASONING_LEVEL from the process.
              resolve: (intent) => resolveTasks(scope, intent, {
                PI_PROVIDER: ctx.model?.provider,
                PI_MODEL: ctx.model?.id,
                PI_REASONING_LEVEL: ctx.thinkingLevel,
              }, ctx.cwd),
            }, params.requestId, signal);
            data = { jobs: started.map((job) => ({ id: job.id, name: job.task.name })) };
            break;
          }
          case "request_status": data = await requestStatus(scope, params.requestId, signal); break;
          case "status": data = { root: scope.root, ...await status(scope, params.offset) }; break;
          case "continue": data = { jobs: (await continueTask(scope, params.id, params.message, params.requestId, signal)).map((job) => ({ id: job.id, name: job.task.name, conversationId: job.conversationId })) }; break;
          case "send": data = await sendTask(scope, params.id, params.message, params.kind, params.requestId, signal); break;
          case "stop": data = await stopTask(scope, params.id, signal); break;
          case "recover": data = await recoverTask(scope, params.id, signal); break;
          case "reattach": {
            const job = await reattachJob(scope, params.id, params.pane, signal);
            data = { id: job.id, pane: job.pane, terminal: job.terminal };
            break;
          }
          case "configure": {
            // Preset validation happens first; independent files make retries safe.
            const models = params.presets === undefined ? await presets(scope) : await configurePresets(scope, params.presets, signal);
            data = { ...await (params.concurrency === undefined ? settings(scope) : configure(scope, params.concurrency, signal)), presets: models };
            break;
          }
          case "wait": data = await waitForReports(scope, params.seconds ?? 30, signal, params.details); break;
          case "next": data = await nextReports(scope, params.acknowledge ?? [], params.seconds ?? 30, signal, params.details); break;
          case "read": data = await readReport(scope, params.id, params.offset); break;
          case "read_many": data = await readManyReports(scope, params.ids, signal); break;
          case "ack": data = await acknowledgeReport(scope, params.receipt, signal); break;
          case "cancel": {
            const ids = params.ids;
            if (ids === "all") data = { closed: await cleanup(scope, true, signal) };
            else data = await locked(scope, async () => {
              const all = await jobs(scope);
              for (const id of ids) if (!all.some((job) => job.id === id)) throw new Error(`Unknown subagent: ${id}`);
              return { closed: await closeJobs(scope, all.filter((job) => ids.includes(job.id)), true) };
            }, signal);
            break;
          }
          case "close": data = { closed: await cleanup(scope, false, signal) }; break;
        }
        return result(params.action, data);
      } catch (error) {
        const action = typeof input?.action === "string" ? reportPage(input.action, 0, 128) : "unknown";
        return result(action, undefined, error);
      }
    },
  });
}
