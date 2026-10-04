import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import type { RequestStatus } from "./core.ts";
import type { ControlReply } from "./conversations.ts";
import type { Preset } from "./policy.ts";
import type { WorkerProgress } from "./progress.ts";
import type { PendingWorker, ReportPage, ReportsReady } from "./reports.ts";
import type { NextReports } from "./workflow.ts";

const exact = { additionalProperties: false };
const count = Type.Integer({ minimum: 0 });
const completionState = Type.Union([Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled")]);
const phase = Type.Union([
  Type.Literal("starting"), Type.Literal("working"), Type.Literal("tool"),
  Type.Literal("retry"), Type.Literal("compacting"), Type.Literal("settled"),
]);
// Keep the optional provider breakdowns from Pi's Usage contract. Progress does
// not currently accumulate them, but persisted valid Usage may include them.
const usage = Type.Object({
  input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()), reasoning: Type.Optional(Type.Number()), totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number(), total: Type.Number(),
  }, exact),
}, exact);
const progress = Type.Object({
  phase, updatedAt: Type.Number(), turns: count,
  tool: Type.Optional(Type.String()), model: Type.Optional(Type.String()), usage,
}, exact);
const reportPage = Type.Object({
  id: Type.String(), name: Type.String(), state: completionState,
  offset: count, next: Type.Optional(count), complete: Type.Boolean(), text: Type.String(), receipt: Type.String(),
}, exact);
const pendingWorker = Type.Object({
  id: Type.String(), name: Type.String(),
  phase: Type.Union([phase, Type.Literal("queued"), Type.Literal("ending")]),
  elapsedSeconds: count, lastEventAgeSeconds: Type.Optional(count), tool: Type.Optional(Type.String()),
}, exact);
const pendingDetails = {
  warning: Type.Optional(Type.String()),
  pendingWorkers: Type.Optional(Type.Array(pendingWorker)),
  pendingWorkersOmitted: Type.Optional(count),
};
const ready = Type.Object({ ready: Type.Array(Type.String()), pending: count, ...pendingDetails }, exact);
const batch = {
  reports: Type.Array(reportPage),
  errors: Type.Array(Type.Object({ id: Type.String(), error: Type.String() }, exact)),
};
const preset = Type.Object({
  model: Type.String(), thinking: Type.Optional(Type.String()),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })), maxCost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
}, exact);
const controlReply = Type.Object({
  state: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("uncertain")]),
  error: Type.Optional(Type.String()), disposition: Type.Optional(Type.String()),
}, exact);
const closed = Type.Object({ closed: Type.Array(Type.String()) }, exact);
const requestStatus = Type.Object({
  requestId: Type.String(), scope: Type.String(), found: Type.Boolean(),
  admissionState: Type.Optional(Type.Union([Type.Literal("prepared"), Type.Literal("starting"), Type.Literal("done"), Type.Literal("failed")])),
  jobs: Type.Array(Type.Object({
    id: Type.String(), name: Type.Optional(Type.String()),
    closed: Type.Optional(Type.Boolean()), collected: Type.Optional(Type.Boolean()), artifactMissing: Type.Boolean(),
  }, exact), { maxItems: 16 }),
  jobsOmitted: Type.Optional(count), artifactsIncomplete: Type.Optional(Type.Boolean()),
}, exact);

function success<Action extends string, Data extends TSchema>(action: Action, data: Data) {
  return Type.Object({ ok: Type.Literal(true), action: Type.Literal(action), data }, exact);
}

/** Ordinary subagents only; codemode derives its return declaration from this schema. */
export const outputSchema = Type.Union([
  success("help", Type.Object({ declaration: Type.String() }, exact)),
  success("prepare", Type.Object({ requestId: Type.String() }, exact)),
  success("spawn", Type.Object({
    jobs: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, exact)),
  }, exact)),
  success("request_status", requestStatus),
  success("status", Type.Object({
    root: Type.String(),
    jobs: Type.Array(Type.Object({
      id: Type.String(), name: Type.String(),
      state: Type.Union([completionState, Type.Literal("unattached"), Type.Literal("ending"), Type.Literal("queued"), Type.Literal("running")]),
      progress: Type.Optional(progress), conversationId: Type.Optional(Type.String()), previousId: Type.Optional(Type.String()),
      collected: Type.Optional(Type.Literal(true)), closed: Type.Optional(Type.Literal(true)),
    }, exact)),
    next: Type.Optional(count),
  }, exact)),
  success("wait", ready),
  success("read", reportPage),
  success("read_many", Type.Object(batch, exact)),
  success("next", Type.Object({
    ...batch,
    acknowledgementRequired: Type.Boolean({ description: "Returned pages require acknowledgement in a later call after consumption." }),
    finished: Type.Boolean({ description: "No reports, no errors and no pending work; cleanup finished for this cycle." }),
    // Excludes pages in this delivery. Even final pages need acknowledgement
    // in a later call: completion is reports=[], errors=[], pending=0 together.
    pending: Type.Integer({ minimum: 0, description: "Pending work excluding reports in this delivery; finish only when reports and errors are also empty. Acknowledge final pages in a later call." }),
    closed: Type.Array(Type.String()), closedOmitted: Type.Optional(count), ...pendingDetails,
  }, exact)),
  success("ack", Type.Object({ id: Type.String(), collected: Type.Boolean(), cursor: count }, exact)),
  success("cancel", closed),
  success("close", closed),
  success("continue", Type.Object({
    jobs: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), conversationId: Type.String() }, exact)),
  }, exact)),
  success("send", controlReply),
  success("stop", Type.Object({ stopped: Type.String(), settled: Type.Boolean() }, exact)),
  success("recover", Type.Object({ id: Type.String(), recovered: Type.Literal(true) }, exact)),
  success("reattach", Type.Object({ id: Type.String(), pane: Type.String(), terminal: Type.String() }, exact)),
  success("configure", Type.Object({
    // The renderer uses additionalProperties, not Record's patternProperties.
    // Both describe the same preset values; retain Record's static TS type.
    concurrency: Type.Integer({ minimum: 1, maximum: 16 }), presets: Type.Record(Type.String(), preset, { additionalProperties: preset }),
  }, exact)),
  Type.Object({ ok: Type.Literal(false), action: Type.String(), error: Type.String() }, exact),
  Type.Object({
    ok: Type.Literal(false), action: Type.String(), error: Type.String(),
    code: Type.Union([Type.Literal("REQUEST_ID_CONFLICT"), Type.Literal("REQUEST_NOT_REPLAYABLE"), Type.Literal("REQUEST_ARTIFACT_MISSING")]),
    diagnostic: requestStatus,
    inspection: Type.Object({ action: Type.Literal("request_status"), requestId: Type.String() }, exact),
  }, exact),
]);

export type SubagentOutput = Static<typeof outputSchema>;

// Compile-time drift checks against runtime contracts, including Pi's Usage.
// Both directions matter: an accidentally required optional field is a mismatch.
type Assert<Condition extends true> = Condition;
type SchemaTypes = [Static<typeof usage>, Static<typeof progress>, Static<typeof reportPage>, Static<typeof pendingWorker>, Static<typeof ready>, Static<typeof preset>, Static<typeof controlReply>, Static<typeof requestStatus>];
type RuntimeTypes = [Usage, WorkerProgress, ReportPage, PendingWorker, ReportsReady, Preset, ControlReply, RequestStatus];
type SchemaContracts = Assert<SchemaTypes extends RuntimeTypes ? RuntimeTypes extends SchemaTypes ? true : false : false>;
type NextData = Extract<SubagentOutput, { ok: true; action: "next" }>["data"];
type NextContract = Assert<NextData extends NextReports ? NextReports extends NextData ? true : false : false>;
