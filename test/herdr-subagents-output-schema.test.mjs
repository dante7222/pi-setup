import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { atomic, cleanup, PAGE_BYTES, save, status } from "../extensions/herdr-subagents/core.ts";
import { sendTask, stopTask } from "../extensions/herdr-subagents/conversations.ts";
import { outputSchema } from "../extensions/herdr-subagents/output-schema.ts";
import { configurePresets } from "../extensions/herdr-subagents/policy.ts";
import { emptyUsage, trackProgress } from "../extensions/herdr-subagents/progress.ts";
import { recoverTask } from "../extensions/herdr-subagents/recovery.ts";
import { acknowledgeReport, readManyReports, readReport, waitForReports } from "../extensions/herdr-subagents/reports.ts";
import { configure, settings } from "../extensions/herdr-subagents/scheduler.ts";

const id = "000000000001";
const page = { id, name: "worker", state: "done", offset: 0, complete: true, text: "evidence", receipt: `${id}.${"a".repeat(64)}` };
const worker = { id, name: "worker", phase: "starting", elapsedSeconds: 0 };
const examples = {
  help: { declaration: "subagents(args: {action: string}): Promise<unknown>;" },
  prepare: { requestId: "prepared-id" },
  spawn: { jobs: [{ id, name: "worker" }] },
  request_status: { requestId: "historical", scope: "abc", found: true, admissionState: "done", jobs: [{ id, artifactMissing: false, closed: true, collected: true }] },
  status: { root: "/private/reports", jobs: [{ id, name: "worker", state: "running" }] },
  wait: { ready: [id], pending: 0 },
  read: page,
  read_many: { reports: [page], errors: [] },
  next: { reports: [page], errors: [], pending: 0, acknowledgementRequired: true, finished: false, closed: [] },
  ack: { id, collected: true, cursor: 8 },
  cancel: { closed: ["worker"] },
  close: { closed: [] },
  continue: { jobs: [{ id, name: "worker", conversationId: id }] },
  send: { state: "accepted" },
  stop: { stopped: id, settled: false },
  recover: { id, recovered: true },
  reattach: { id, pane: "pane-2", terminal: "terminal-2" },
  configure: { concurrency: 4, presets: {} },
};

function envelope(action, data) {
  // This is the ordinary tool's JSON boundary, not its in-memory undefined fields.
  return JSON.parse(JSON.stringify({ ok: true, action, data }));
}

function valid(action, data) {
  const value = envelope(action, data);
  assert.equal(Check(outputSchema, value), true, JSON.stringify(value));
  return value;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-output-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = join(root, "backend.mjs");
  await writeFile(backend, `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== '["pane","list"]') throw new Error('Unexpected fixture backend call');
console.log(JSON.stringify({result:{panes:[{pane_id:'worker-pane',terminal_id:'worker-terminal'}]}}));
`);
  await chmod(backend, 0o700);
  // Explicit fixture backend: never use the host's Herdr executable or socket.
  const scope = { root, pane: "parent", workspace: "workspace", env: { HERDR_BIN_PATH: backend } };
  let counter = 0;
  async function job(text, extra = {}, state = "done") {
    const value = {
      id: (++counter).toString(16).padStart(12, "0"),
      task: { name: `worker-${counter}`, prompt: "fixture only", role: "worker", cwd: root, timeout: 60, extensions: [] },
      cursor: 0, created: Date.now(), ...extra,
    };
    await mkdir(join(root, value.id), { mode: 0o700 });
    await save(scope, value);
    if (text !== undefined) await atomic(join(root, value.id, "done.json"), { state, report: text });
    return value;
  }
  return { scope, job };
}

for (const [action, data] of Object.entries(examples)) {
  test(`output schema discriminates ${action} success and failure`, () => {
    valid(action, data);
    assert.equal(Check(outputSchema, { ok: false, action, error: "failure" }), true);
    assert.equal(Check(outputSchema, { ok: true, action }), false);
    assert.equal(Check(outputSchema, { ok: true, action, data: {} }), false);
    assert.equal(Check(outputSchema, { ok: true, action, data, error: "failure" }), false);
    assert.equal(Check(outputSchema, { ok: false, action, data, error: "failure" }), false);
  });
}

test("output union has exactly the ordinary action branches and generic/diagnostic failure branches", () => {
  const branches = outputSchema.anyOf;
  assert.equal(branches.length, Object.keys(examples).length + 2);
  assert.deepEqual(branches.filter((branch) => branch.properties.ok.const === true).map((branch) => branch.properties.action.const).sort(), Object.keys(examples).sort());
  assert.equal(Check(outputSchema, { ok: false, action: "unknown", error: "invalid action" }), true);
  for (const value of [null, {}, { ok: false, action: "wait" }, { ok: false, error: "failure" }, { ok: "true", action: "wait", data: examples.wait }, { ok: true, action: "unknown", data: {} }]) {
    assert.equal(Check(outputSchema, value), false);
  }
  // No unconstrained data leaf may silently turn codemode's return type into unknown.
  function inspect(schema) {
    assert.ok(schema.type || schema.anyOf || Object.hasOwn(schema, "const"), JSON.stringify(schema));
    if (schema.anyOf) schema.anyOf.forEach(inspect);
    if (schema.type === "object") {
      Object.values(schema.properties ?? {}).forEach(inspect);
      Object.values(schema.patternProperties ?? {}).forEach(inspect);
    }
    if (schema.type === "array") inspect(schema.items);
  }
  inspect(outputSchema);
});

test("request diagnostic failures require an inspection action and concrete metadata", () => {
  for (const code of ["REQUEST_ID_CONFLICT", "REQUEST_NOT_REPLAYABLE", "REQUEST_ARTIFACT_MISSING"]) {
    const value = { ok: false, action: "spawn", error: "inspect", code, diagnostic: examples.request_status,
      inspection: { action: "request_status", requestId: "historical" } };
    assert.equal(Check(outputSchema, value), true);
    for (const key of ["code", "diagnostic", "inspection"]) {
      const broken = { ...value }; delete broken[key];
      assert.equal(Check(outputSchema, broken), false);
    }
  }
});

test("nested report, progress, usage and preset mistakes are rejected", () => {
  const progress = { phase: "tool", updatedAt: 1, turns: 0, usage: emptyUsage() };
  const statusWith = (value) => ({ ...examples.status, jobs: [{ ...examples.status.jobs[0], progress: value }] });
  const malformed = [
    ["spawn", { jobs: [{ id }] }],
    ["status", { ...examples.status, jobs: [{ id, name: "worker", state: "stalled" }] }],
    ["status", statusWith({ ...progress, phase: "running" })],
    ["status", statusWith({ ...progress, usage: {} })],
    ["status", statusWith({ ...progress, usage: { ...emptyUsage(), reasoning: "10" } })],
    ["status", statusWith({ ...progress, usage: { ...emptyUsage(), cost: { total: 0 } } })],
    ["status", statusWith({ ...progress, turns: "1" })],
    ["status", { ...examples.status, jobs: [{ ...examples.status.jobs[0], closed: false }] }],
    ["wait", { ready: [id], pending: -1 }],
    ["wait", { ready: [], pending: 1, pendingWorkers: [{ ...worker, elapsedSeconds: "1" }] }],
    ["wait", { ready: [], pending: 1, pendingWorkers: [{ ...worker, phase: "stalled" }] }],
    ["wait", { ready: [], pending: 1, pendingWorkers: [{ ...worker, lastEventAgeSeconds: null }] }],
    ["read", { ...page, offset: -1 }],
    ["read", { ...page, next: "8" }],
    ["read", { ...page, complete: "true" }],
    ["read", { ...page, receipt: undefined }],
    ["read", { ...page, state: "running" }],
    ["read_many", { reports: [page], errors: [{ id, error: 12 }] }],
    ["next", { ...examples.next, reports: [{ ...page, receipt: undefined }] }],
    ["next", { ...examples.next, acknowledgementRequired: undefined }],
    ["next", { ...examples.next, finished: "true" }],
    ["next", { ...examples.next, closedOmitted: -1 }],
    ["next", { ...examples.next, pendingWorkersOmitted: "1" }],
    ["ack", { ...examples.ack, cursor: 0.5 }],
    ["cancel", { closed: [12] }],
    ["close", { closed: [], unexpected: true }],
    ["continue", { jobs: [{ id, name: "worker" }] }],
    ["send", { state: "done" }],
    ["send", { state: "accepted", disposition: false }],
    ["stop", { stopped: id, settled: "false" }],
    ["recover", { id, recovered: false }],
    ["reattach", { id, pane: "worker" }],
    ["configure", { concurrency: 17, presets: {} }],
    ["configure", { concurrency: 4, presets: { review: {} } }],
    ["configure", { concurrency: 4, presets: { review: { model: "provider/model", thinking: 4 } } }],
    ["configure", { concurrency: 4, presets: { review: { model: "provider/model", maxCost: "1" } } }],
    ["configure", { concurrency: 4, presets: { review: { model: "provider/model", secret: "not a preset field" } } }],
  ];
  for (const [action, data] of malformed) assert.equal(Check(outputSchema, envelope(action, data)), false, `${action}: ${JSON.stringify(data)}`);
});

test("genuine report pages, partial acknowledgements and batch errors match the schema", async (t) => {
  const { scope, job } = await fixture(t);
  const large = await job("evidence ".repeat(PAGE_BYTES));
  const failed = await job("failure evidence", {}, "failed");
  const cancelled = await job("cancelled evidence", {}, "cancelled");
  const pending = await job(undefined);
  const first = await readReport(scope, large.id);
  valid("read", first);
  assert.equal(first.complete, false);
  assert.equal(typeof first.next, "number");
  valid("ack", await acknowledgeReport(scope, first.receipt));
  const second = await readReport(scope, large.id);
  valid("read", second);
  assert.equal(second.offset, first.next);
  const batch = await readManyReports(scope, [large.id, failed.id, cancelled.id, pending.id, "ffffffffffff"]);
  valid("read_many", batch);
  assert.deepEqual(batch.reports.map((entry) => entry.state), ["done", "failed", "cancelled"]);
  assert.equal(batch.errors.length, 2);
  const final = batch.reports.find((entry) => entry.id === failed.id);
  assert.equal(final.next, undefined);
  assert.equal(valid("ack", await acknowledgeReport(scope, final.receipt)).data.collected, true);
  // Planned next shares the actual report-page contract, not a text-only escape.
  valid("next", { ...batch, acknowledgementRequired: true, finished: false, pending: 1, closed: [], pendingWorkers: [{ ...worker, id: pending.id }] });
});

test("genuine waits include optional bounded pending details and empty completion", async (t) => {
  const { scope, job } = await fixture(t);
  valid("wait", await waitForReports(scope, 0));
  const ready = await job("complete");
  const active = await job(undefined);
  const queued = await job(undefined);
  const ending = await job(undefined, { endedAt: Date.now() });
  await atomic(join(scope.root, active.id, "progress.json"), { phase: "tool", tool: "bash", updatedAt: Date.now(), turns: 0, usage: emptyUsage() });
  await atomic(join(scope.root, queued.id, "waiting.json"), {});
  const plain = valid("wait", await waitForReports(scope, 0)).data;
  assert.deepEqual(plain.ready, [ready.id]);
  assert.equal(plain.pendingWorkers, undefined);
  const detailed = valid("wait", await waitForReports(scope, 0, undefined, true)).data;
  assert.equal(detailed.pending, 3);
  assert.deepEqual(new Set(detailed.pendingWorkers.map((entry) => entry.phase)), new Set(["tool", "queued", "ending"]));
  assert.equal(detailed.pendingWorkers.find((entry) => entry.id === active.id).tool, "bash");
  assert.equal(detailed.pendingWorkers.find((entry) => entry.id === ending.id).lastEventAgeSeconds, undefined);
  for (let index = 0; index < 16; index++) await job(undefined);
  const bounded = valid("wait", await waitForReports(scope, 0, undefined, true)).data;
  assert.equal(bounded.pendingWorkers.length, 16);
  assert.equal(bounded.pendingWorkersOmitted, 3);
  valid("next", { reports: [], errors: [], acknowledgementRequired: false, finished: false, pending: bounded.pending, closed: ["old-worker"], closedOmitted: 2, warning: "offline", pendingWorkers: bounded.pendingWorkers, pendingWorkersOmitted: bounded.pendingWorkersOmitted });
  valid("next", { reports: [], errors: [], acknowledgementRequired: false, finished: true, pending: 0, closed: [] });
});

test("genuine status exposes typed progress, Pi usage breakdowns and optional metadata", async (t) => {
  const { scope, job } = await fixture(t);
  valid("status", { root: scope.root, ...await status(scope) });
  const complete = await job("saved", { conversationId: id, previousId: "000000000000", collected: true });
  const active = await job(undefined, { pane: "worker-pane", terminal: "worker-terminal" });
  const progress = { phase: "starting", updatedAt: Date.now(), turns: 0, usage: emptyUsage() };
  trackProgress(progress, { type: "message_end", message: { role: "assistant", provider: "fixture", model: "model", usage: { ...emptyUsage(), input: 12, output: 3, totalTokens: 15 } } });
  trackProgress(progress, { type: "tool_execution_start", toolName: "read" });
  // Optional Pi provider fields are valid even though trackProgress omits them.
  progress.usage.cacheWrite1h = 2;
  progress.usage.reasoning = 1;
  await atomic(join(scope.root, active.id, "progress.json"), progress);
  const result = valid("status", { root: scope.root, ...await status(scope) }).data;
  assert.equal(result.jobs.find((entry) => entry.id === complete.id).collected, true);
  const running = result.jobs.find((entry) => entry.id === active.id);
  assert.equal(running.state, "running");
  assert.equal(running.progress.model, "fixture/model");
  assert.equal(running.progress.usage.totalTokens, 15);
  assert.equal(running.progress.usage.reasoning, 1);
  for (const phase of ["starting", "working", "tool", "retry", "compacting", "settled"]) {
    valid("status", { root: scope.root, jobs: [{ ...running, progress: { ...progress, phase } }] });
  }
  for (let index = 0; index < 16; index++) await job("saved");
  const paged = valid("status", { root: scope.root, ...await status(scope) }).data;
  assert.equal(paged.next, 16);
  valid("status", { root: scope.root, ...await status(scope, paged.next) });
});

test("genuine configuration, stop, recovery and close results preserve existing fields", async (t) => {
  const { scope, job } = await fixture(t);
  valid("configure", { ...await settings(scope), presets: {} });
  const presets = await configurePresets(scope, {
    brief: { model: "fixture/brief" },
    review: { model: "fixture/review", thinking: "high", maxTokens: 1024, maxCost: 0.25 },
  });
  const configured = valid("configure", { ...await configure(scope, 2), presets }).data;
  assert.deepEqual(configured.presets.brief, { model: "fixture/brief" });
  assert.equal(configured.presets.review.maxTokens, 1024);
  const complete = await job("saved");
  valid("stop", await stopTask(scope, complete.id));
  const pending = await job(undefined);
  assert.equal(valid("stop", await stopTask(scope, pending.id)).data.settled, false);
  // The already-verified path performs no process recovery or Herdr operations.
  await atomic(join(scope.root, complete.id, "shutdown.json"), { verified: true });
  valid("recover", await recoverTask(scope, complete.id));
  const report = await readReport(scope, complete.id);
  await acknowledgeReport(scope, report.receipt);
  assert.deepEqual(valid("close", { closed: await cleanup(scope) }).data.closed, [complete.task.name]);
  assert.deepEqual(valid("cancel", { closed: await cleanup(scope, true) }).data.closed, [pending.task.name]);
});

test("genuine rejected mailbox replies and optional control dispositions are typed", async (t) => {
  const { scope, job } = await fixture(t);
  const persistent = await job("saved");
  persistent.task.persistent = true;
  await save(scope, persistent);
  await mkdir(join(scope.root, persistent.id, "control"));
  await atomic(join(scope.root, persistent.id, "control", "closed.json"), { error: "fixture mailbox closed" });
  const reply = valid("send", await sendTask(scope, persistent.id, "fixture message", "steer", "request-1")).data;
  assert.deepEqual(reply, { state: "rejected", error: "fixture mailbox closed" });
  valid("send", { state: "accepted", disposition: "queued" });
  valid("send", { state: "uncertain", error: "No acknowledgement yet" });
});
