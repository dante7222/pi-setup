import assert from "node:assert/strict";
import fs, { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { atomic, jobs, locked, save } from "../extensions/herdr-subagents/core.ts";
import { readReport } from "../extensions/herdr-subagents/reports.ts";
import { nextReports } from "../extensions/herdr-subagents/workflow.ts";
import { processIdentity } from "../extensions/herdr-subagents/identity.ts";

// No Herdr or model calls: all pane ownership and failures are private fixtures.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-next-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = join(root, "backend.mjs");
  await writeFile(join(root, "panes.json"), "[]");
  await writeFile(join(root, "backend-config.json"), "{}");
  await writeFile(backend, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.NEXT_TEST_ROOT, args = process.argv.slice(2);
appendFileSync(join(root, 'calls'), JSON.stringify(args) + '\\n');
const config = JSON.parse(readFileSync(join(root, 'backend-config.json'), 'utf8'));
const panes = JSON.parse(readFileSync(join(root, 'panes.json'), 'utf8'));
if (args[0] !== 'pane' || !['list', 'close'].includes(args[1])) throw new Error('unexpected backend command');
if (args[1] === 'list' && config.publish) {
  for (const [id, report] of Object.entries(config.publish)) writeFileSync(join(root, id, 'done.json'), JSON.stringify({state:'done', report}));
}
if (config.offline || (args[1] === 'close' && args[2] === config.failClose)) {
  console.error(config.offline || 'injected close failure'); process.exit(1);
}
if (args[1] === 'close') writeFileSync(join(root, 'panes.json'), JSON.stringify(panes.filter(p => p.pane_id !== args[2])));
console.log(JSON.stringify({result: args[1] === 'list' ? {panes} : {}}));
`);
  await chmod(backend, 0o700);
  const scope = { root, pane: "parent", workspace: "workspace", env: { ...process.env, HERDR_BIN_PATH: backend, NEXT_TEST_ROOT: root } };
  let count = 0;
  async function job(text, extra = {}, done = {}) {
    const id = (++count).toString(16).padStart(12, "0");
    const value = {
      id, task: { name: `worker-${count}`, prompt: "fixture only", role: "worker", cwd: root, timeout: 60, extensions: [] },
      cursor: 0, created: count, pane: `pane-${count}`, terminal: `terminal-${count}`, ...extra,
    };
    await mkdir(join(root, id), { mode: 0o700 });
    await save(scope, value);
    if (text !== undefined) await atomic(join(root, id, "done.json"), { state: "done", report: text, ...done }, true);
    if (value.pane && !value.closed) {
      const panes = JSON.parse(await readFile(join(root, "panes.json"), "utf8"));
      panes.push({ pane_id: value.pane, terminal_id: value.terminal });
      await atomic(join(root, "panes.json"), panes);
    }
    return value;
  }
  return { scope, job, configure: (config) => atomic(join(root, "backend-config.json"), config) };
}

async function saved(scope, id) {
  return JSON.parse(await readFile(join(scope.root, id, "job.json"), "utf8"));
}

async function calls(scope) {
  const text = await readFile(join(scope.root, "calls"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.trim() ? text.trim().split("\n").map(JSON.parse) : [];
}

function bounded(data) {
  const bytes = Buffer.byteLength(JSON.stringify({ ok: true, action: "next", data }), "utf8");
  assert.ok(bytes <= 12_000, `entire native next envelope is ${bytes} UTF-8 bytes`);
  assert.equal(data.acknowledgementRequired, data.reports.length > 0);
  assert.equal(data.finished, data.reports.length === 0 && data.errors.length === 0 && data.pending === 0);
  assert.ok(data.closed.length <= 16);
  assert.ok(data.reports.length <= 16);
  assert.ok(Number.isSafeInteger(data.pending) && data.pending >= 0);
}

function complete(data) {
  assert.equal(data.acknowledgementRequired, data.reports.length > 0);
  assert.equal(data.finished, data.reports.length === 0 && data.errors.length === 0 && data.pending === 0);
  return data.finished;
}

async function noReceipt(scope, id) {
  assert.equal(await stat(join(scope.root, id, "receipts")).catch(() => undefined), undefined, "fatal failure must not issue any fresh receipts");
}

async function noCancellation(scope) {
  for (const worker of await jobs(scope)) {
    assert.equal(await stat(join(scope.root, worker.id, "cancel.json")).catch(() => undefined), undefined);
  }
}

async function eventually(predicate, message) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function snapshot(directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    result[entry.name] = entry.isDirectory() ? await snapshot(join(directory, entry.name)) : await readFile(join(directory, entry.name), "utf8");
  }
  return result;
}

test("next replays lost responses and only a later invocation acknowledges final pages", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job(('😀中文\n\u0000"\\\r\t\ud800X\udfff' + "a".repeat(11)).repeat(900) + "END");
  const source = JSON.parse(await readFile(join(scope.root, worker.id, "done.json"), "utf8")).report;
  let acknowledge = [];
  let text = "";
  let batches = 0;
  while (true) {
    const result = await nextReports(scope, acknowledge, 0);
    bounded(result);
    assert.equal(result.pending, 0, "included ready IDs are excluded even when their pages are partial");
    assert.deepEqual(result.errors, []);
    assert.equal(result.reports.length, 1);
    const page = result.reports[0];
    assert.equal(page.offset, text.length);
    assert.ok(page.text.length > 0);
    const before = await saved(scope, worker.id);
    assert.equal(before.cursor, page.offset);
    assert.notEqual(before.collected, true);
    assert.notEqual(before.closed, true);
    // Simulate a lost transport response / failed caller script. Only OLD
    // receipts are retried; newly issued text must remain the current prefix.
    const replay = await nextReports(scope, acknowledge, 0);
    assert.deepEqual(replay.reports, result.reports);
    assert.deepEqual(await saved(scope, worker.id), before);
    text += page.text;
    acknowledge = [page.receipt];
    assert.equal(complete(result), false);
    assert.ok(++batches < 50);
    if (page.complete) break;
    assert.equal(page.next, text.length);
    assert.ok(!(/[\uD800-\uDBFF]/.test(source[text.length - 1]) && /[\uDC00-\uDFFF]/.test(source[text.length] ?? "")));
  }
  assert.ok(batches > 1);
  assert.equal(text, source);
  const final = await nextReports(scope, acknowledge, 0);
  bounded(final);
  assert.equal(complete(final), true);
  assert.ok(final.closed.includes(worker.task.name));
  const stored = await saved(scope, worker.id);
  assert.equal(stored.collected, true);
  assert.equal(stored.closed, true);
  assert.equal(stored.cursor, source.length);
  assert.equal(complete(await nextReports(scope, acknowledge, 0)), true, "final receipt retry is idempotent after closure");
  assert.equal((await calls(scope)).filter((args) => args[1] === "close").length, 1);
  await noCancellation(scope);
});

test("next validates all arguments before any acknowledgement, cleanup, or read", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("prior page");
  const prior = await readReport(scope, worker.id);
  await job("already acknowledged", { collected: true, cursor: 20 });
  await job("fresh unread");
  const before = await snapshot(scope.root);
  const invalid = [
    [null, 0, undefined, false], ["all", 0, undefined, false], [[7], 0, undefined, false],
    [[prior.receipt, "../forged"], 0, undefined, false],
    ...[-1, 61, Infinity, NaN, "1", null].map((seconds) => [[prior.receipt], seconds, undefined, false]),
    [[prior.receipt], 0, undefined, "yes"], [[prior.receipt], 0, undefined, null],
    [[prior.receipt], 0, AbortSignal.abort(new Error("preaborted next")), false],
  ];
  for (const args of invalid) {
    await assert.rejects(nextReports(scope, ...args));
    assert.deepEqual(await snapshot(scope.root), before);
  }
});

test("next rejects forged, cross-job, cross-scope, stale and out-of-order receipts before fresh reads", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("x".repeat(30_000));
  const other = await job("other");
  const fresh = await job("must not be fetched");
  const first = await readReport(scope, worker.id);
  const later = await readReport(scope, worker.id, first.next);
  const overlap = await readReport(scope, worker.id, 1);
  for (const receipt of [
    `${worker.id}.${"0".repeat(64)}`,
    `${other.id}${first.receipt.slice(12)}`,
    `${first.receipt.slice(0, -1)}${first.receipt.endsWith("0") ? "1" : "0"}`,
    later.receipt, overlap.receipt,
  ]) {
    await assert.rejects(nextReports(scope, [receipt], 0), /receipt|contiguous/i);
    assert.equal((await saved(scope, worker.id)).cursor, 0);
    await noReceipt(scope, fresh.id);
  }
  const receiptPath = join(scope.root, worker.id, "receipts", `${first.receipt}.json`);
  const issued = JSON.parse(await readFile(receiptPath, "utf8"));
  await atomic(receiptPath, { ...issued, end: 1 });
  await assert.rejects(nextReports(scope, [first.receipt], 0), /tampered/i);
  await atomic(receiptPath, issued);
  const foreign = await fixture(t);
  const foreignJob = await foreign.job("x".repeat(30_000));
  await mkdir(join(foreign.scope.root, foreignJob.id, "receipts"));
  await atomic(join(foreign.scope.root, foreignJob.id, "receipts", `${first.receipt}.json`), issued);
  await assert.rejects(nextReports(foreign.scope, [first.receipt], 0), /receipt|scope|tampered/i);
  assert.equal((await saved(foreign.scope, foreignJob.id)).cursor, 0);
  await atomic(join(scope.root, worker.id, "done.json"), { state: "failed", report: "x".repeat(30_000) });
  await assert.rejects(nextReports(scope, [first.receipt], 0), /stale/i);
  await noReceipt(scope, fresh.id);
  assert.deepEqual(await calls(scope), []);
});

test("next commits supplied receipts sequentially; partial failure and old-receipt retries are safe", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("x".repeat(40_000));
  const untouched = await job("fresh page");
  const first = await readReport(scope, worker.id);
  const second = await readReport(scope, worker.id, first.next);
  const forged = `${worker.id}.${"0".repeat(64)}`;
  await assert.rejects(nextReports(scope, [first.receipt, forged, second.receipt], 0), /receipt/i);
  let stored = await saved(scope, worker.id);
  assert.equal(stored.cursor, first.next);
  assert.deepEqual(stored.reportAcknowledgements, [first.receipt], "failure stops before later supplied receipts");
  await noReceipt(scope, untouched.id);
  const retry = await nextReports(scope, [first.receipt], 0);
  const page = retry.reports.find((entry) => entry.id === worker.id);
  assert.equal(page.offset, first.next);
  stored = await saved(scope, worker.id);
  assert.equal(stored.cursor, first.next);
  assert.deepEqual(stored.reportAcknowledgements, [first.receipt]);
  assert.deepEqual((await nextReports(scope, [first.receipt], 0)).reports, retry.reports);
  await noCancellation(scope);
});

test("next can acknowledge contiguous pages in caller order but never acknowledges newly fetched pages", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("x".repeat(40_000));
  const first = await readReport(scope, worker.id);
  const second = await readReport(scope, worker.id, first.next);
  const result = await nextReports(scope, [first.receipt, second.receipt], 0);
  assert.equal(result.reports[0].offset, second.next);
  assert.equal((await saved(scope, worker.id)).cursor, second.next);
  assert.deepEqual((await saved(scope, worker.id)).reportAcknowledgements, [first.receipt, second.receipt]);
});

test("next refuses unverified process cleanup without cancelling or reading new reports", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("final", { launched: true });
  const fresh = await job("unread");
  const page = await readReport(scope, worker.id);
  await assert.rejects(nextReports(scope, [page.receipt], 0), /cleanup.*verified|pane retained/i);
  assert.equal((await saved(scope, worker.id)).collected, true, "acknowledgement may commit before cleanup fails");
  assert.notEqual((await saved(scope, worker.id)).closed, true);
  await noReceipt(scope, fresh.id);
  assert.ok((await calls(scope)).every((args) => args[1] === "list"));
  await noCancellation(scope);
  await atomic(join(scope.root, worker.id, "shutdown.json"), { verified: true });
  const retry = await nextReports(scope, [page.receipt], 0);
  assert.equal((await saved(scope, worker.id)).closed, true);
  assert.deepEqual(retry.reports.map((entry) => entry.id), [fresh.id]);
  assert.notEqual((await saved(scope, fresh.id)).collected, true);
  await save(scope, { ...await saved(scope, worker.id), created: worker.created + 1 });
  await assert.rejects(nextReports(scope, [page.receipt], 0), /stale/i, "even acknowledged receipts are bound to their job incarnation");
});

test("next cleanupError refuses closure even with shutdown proof until recovery is verified", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("evidence", { launched: true }, { cleanupError: "cannot reap detached execution" });
  const fresh = await job("unread");
  await atomic(join(scope.root, worker.id, "shutdown.json"), { verified: true });
  const page = await readReport(scope, worker.id);
  await assert.rejects(nextReports(scope, [page.receipt], 0), /cannot reap.*pane retained/i);
  assert.equal((await saved(scope, worker.id)).collected, true);
  assert.notEqual((await saved(scope, worker.id)).closed, true);
  await noReceipt(scope, fresh.id);
  await noCancellation(scope);
  await atomic(join(scope.root, worker.id, "recovery.json"), { verified: true });
  const retry = await nextReports(scope, [page.receipt], 0);
  assert.equal((await saved(scope, worker.id)).closed, true);
  assert.deepEqual(retry.reports.map((entry) => entry.id), [fresh.id]);
});

test("next close failures retain earlier closures, stop before reads, and retry without duplicate close", async (t) => {
  const { scope, job, configure } = await fixture(t);
  const a = await job("a");
  const b = await job("b");
  const fresh = await job("fresh");
  const receipts = [(await readReport(scope, a.id)).receipt, (await readReport(scope, b.id)).receipt];
  await configure({ failClose: b.pane });
  await assert.rejects(nextReports(scope, receipts, 0), /injected close failure/);
  assert.equal((await saved(scope, a.id)).closed, true);
  assert.equal((await saved(scope, b.id)).collected, true);
  assert.notEqual((await saved(scope, b.id)).closed, true);
  await noReceipt(scope, fresh.id);
  await configure({});
  const retry = await nextReports(scope, receipts, 0);
  assert.equal((await saved(scope, b.id)).closed, true);
  assert.deepEqual(retry.reports.map((entry) => entry.id), [fresh.id]);
  assert.equal((await calls(scope)).filter((args) => args[1] === "close" && args[2] === a.pane).length, 1);
  await noCancellation(scope);
});

test("next shares the full native envelope fairly across 16 Unicode reports plus all metadata", async (t) => {
  const { scope, job, configure } = await fixture(t);
  // A historical acknowledged backlog can exceed today's 16-pane limit.
  for (let i = 0; i < 21; i++) await job("old", { collected: true, cursor: 3, pane: undefined, terminal: undefined });
  const content = ('😀中文\n\u0000"\\\r\t\ud800X\udfff' + "x".repeat(30)).repeat(35);
  const workers = [];
  const publish = {};
  for (let i = 0; i < 16; i++) {
    const worker = await job(undefined);
    workers.push(worker);
    publish[worker.id] = `${i}:${content}`;
  }
  for (let i = 0; i < 19; i++) {
    const worker = await job(undefined);
    await atomic(join(scope.root, worker.id, "progress.json"), { phase: "tool", tool: '\u0000😀"\\'.repeat(100), updatedAt: Date.now(), usage: { secret: "not exposed" } });
  }
  // Initial scan sees no completions; failed reconciliation publishes them,
  // forcing reports, warning, progress and closed metadata into ONE response.
  await configure({ publish, offline: '\u0000😀"\\'.repeat(500) });
  const first = await nextReports(scope, [], 0, undefined, true);
  bounded(first);
  assert.equal(first.reports.length, 16);
  assert.deepEqual(first.errors, []);
  assert.equal(first.pending, 19);
  assert.equal(first.closed.length, 16);
  assert.equal(first.closedOmitted, 5);
  assert.ok(first.warning);
  assert.equal(first.pendingWorkers.length, 16);
  assert.equal(first.pendingWorkersOmitted, 3);
  assert.ok(!JSON.stringify(first).includes('"usage"'));
  const received = new Map(workers.map((worker) => [worker.id, ""]));
  let result = first;
  let batches = 0;
  const finished = new Set();
  await configure({});
  while (result.reports.length) {
    bounded(result);
    for (const page of result.reports) {
      assert.ok(page.text.length > 0, "every ready worker gets a nonempty fair share");
      assert.equal(page.offset, received.get(page.id).length);
      received.set(page.id, received.get(page.id) + page.text);
      assert.equal((await saved(scope, page.id)).cursor, page.offset);
      assert.notEqual((await saved(scope, page.id)).collected, true);
      if (page.complete) finished.add(page.id);
    }
    result = await nextReports(scope, result.reports.map((page) => page.receipt), 0, undefined, true);
    assert.equal(result.pending, 19);
    assert.equal(result.reports.length, 16 - finished.size, "large early reports must not starve later workers");
    assert.deepEqual(result.errors, []);
    assert.ok(++batches < 40);
  }
  bounded(result);
  assert.ok(batches > 1);
  for (const worker of workers) assert.equal(received.get(worker.id), publish[worker.id]);
  assert.equal(complete(result), false, "unfinished workers still prevent termination");
  await noCancellation(scope);
});

test("next pending excludes included ready IDs but includes historical ready overflow", async (t) => {
  const { scope, job } = await fixture(t);
  for (let i = 0; i < 40; i++) await job(`saved-${i}`, { closed: true });
  const first = await nextReports(scope, [], 0);
  bounded(first);
  assert.equal(first.reports.length, 16);
  assert.equal(first.pending, 24);
  assert.equal(complete(first), false);
  const second = await nextReports(scope, first.reports.map((page) => page.receipt), 0);
  assert.equal(second.reports.length, 16);
  assert.equal(second.pending, 8);
  const third = await nextReports(scope, second.reports.map((page) => page.receipt), 0);
  assert.equal(third.reports.length, 8);
  assert.equal(third.pending, 0);
  assert.equal(complete(third), false);
  const final = await nextReports(scope, third.reports.map((page) => page.receipt), 0);
  assert.equal(complete(final), true);
  assert.deepEqual(await calls(scope), []);
});

test("next preserves bounded per-report errors and cannot terminate on errors with pending zero", async (t) => {
  const { scope, job } = await fixture(t);
  const good = await job("good");
  const bad = await job("bad");
  const original = fs.mkdir;
  // Fail receipt publication only, after readiness has selected both workers.
  t.mock.method(fs, "mkdir", async (path, ...args) => {
    if (String(path) === join(scope.root, bad.id, "receipts")) throw new Error('\u0000😀"\\'.repeat(10_000));
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await nextReports(scope, [], 0);
  bounded(result);
  assert.deepEqual(result.reports.map((page) => page.id), [good.id]);
  assert.deepEqual(result.errors.map((entry) => entry.id), [bad.id]);
  assert.ok(result.errors[0].error.length > 0);
  assert.equal(result.pending, 0);
  assert.equal(complete(result), false);
  const errorsOnly = await nextReports(scope, [result.reports[0].receipt], 0);
  bounded(errorsOnly);
  assert.deepEqual(errorsOnly.reports, []);
  assert.deepEqual(errorsOnly.errors.map((entry) => entry.id), [bad.id]);
  assert.equal(errorsOnly.pending, 0);
  assert.equal(complete(errorsOnly), false);
  assert.equal((await saved(scope, bad.id)).cursor, 0);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  const retry = await nextReports(scope, [], 0);
  assert.deepEqual(retry.reports.map((page) => page.id), [bad.id]);
  assert.equal(complete(await nextReports(scope, [retry.reports[0].receipt], 0)), true);
});

test("next polling releases the scope lock and abort never cancels unfinished workers", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job(undefined);
  const controller = new AbortController();
  const waiting = nextReports(scope, [], 60, controller.signal);
  const rejected = assert.rejects(waiting, /stop polling|abort/i);
  try {
    await eventually(async () => (await calls(scope)).some((args) => args[1] === "list"), "wait did not start reconciliation");
    await locked(scope, async () => {
      assert.equal(controller.signal.aborted, false);
    }, AbortSignal.timeout(2000));
    controller.abort(new Error("stop polling"));
    await rejected;
    // Catch detached reconciliation/lock work that resumes after cancellation.
    await locked(scope, async () => {}, AbortSignal.timeout(2000));
    const stored = await saved(scope, worker.id);
    assert.equal(stored.cursor, 0);
    assert.notEqual(stored.collected, true);
    assert.notEqual(stored.closed, true);
    await noReceipt(scope, worker.id);
    await noCancellation(scope);
    assert.ok((await calls(scope)).every((args) => args[1] === "list"));
  } finally {
    controller.abort(new Error("stop polling"));
    await rejected;
  }
});

for (const phase of ["acknowledge", "close", "read"]) test(`next abort reaches held-lock admission before ${phase}`, async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("report", phase === "close" ? { collected: true, cursor: 6 } : {});
  const receipts = phase === "acknowledge" ? [(await readReport(scope, worker.id)).receipt] : [];
  const before = await saved(scope, worker.id);
  const controller = new AbortController();
  let settled = false;
  let outcome;
  await locked(scope, async () => {
    outcome = nextReports(scope, receipts, 60, controller.signal).then(
      () => { settled = true; return { success: true }; },
      (error) => { settled = true; return { error }; },
    );
    try {
      await eventually(async () => (await readdir(join(scope.root, "locks"))).length >= 2, "next never attempted lock admission");
      controller.abort(new Error("abort lock admission"));
      await eventually(() => settled, "abort must reject while the existing lock remains held");
      assert.match(String((await outcome).error), /abort/i);
      assert.deepEqual(await saved(scope, worker.id), before);
      assert.deepEqual(await calls(scope), []);
    } finally { controller.abort(new Error("abort lock admission")); }
  });
  assert.ok((await outcome).error);
  await locked(scope, async () => {}, AbortSignal.timeout(2000));
  assert.deepEqual(await saved(scope, worker.id), before, "cancelled lock contenders must not mutate after admission resumes");
  if (phase !== "acknowledge") await noReceipt(scope, worker.id);
  await noCancellation(scope);
});

for (const phase of ["acknowledge", "close", "read"]) test(`next fences cancellation during authority verification before ${phase}`, async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("report", phase === "close" ? { collected: true, cursor: 6 } : {});
  const receipts = phase === "acknowledge" ? [(await readReport(scope, worker.id)).receipt] : [];
  const identity = await processIdentity();
  assert.ok(identity);
  scope.authority = { token: "fixture-authority", identity };
  await atomic(join(scope.root, "owner.json"), scope.authority);
  const before = await saved(scope, worker.id);
  const controller = new AbortController();
  const original = fs.readFile;
  let verified = 0;
  t.mock.method(fs, "readFile", async (path, ...args) => {
    const result = await original(path, ...args);
    if (String(path) === join(scope.root, "owner.json") && ++verified === (phase === "read" ? 2 : 1)) {
      controller.abort(new Error("aborted during authority I/O"));
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(nextReports(scope, receipts, 0, controller.signal), /aborted during authority/);
  assert.equal(verified, phase === "read" ? 2 : 1, "read phase reaches actual read admission, not just cleanup");
  assert.deepEqual(await saved(scope, worker.id), before);
  assert.deepEqual(await calls(scope), []);
  if (phase !== "acknowledge") await noReceipt(scope, worker.id);
  await noCancellation(scope);
});

test("next observes later completion without consuming it and empty scope terminates immediately", async (t) => {
  const { scope, job } = await fixture(t);
  const empty = await nextReports(scope, [], 60);
  bounded(empty);
  assert.equal(complete(empty), true);
  assert.deepEqual(await calls(scope), []);
  const worker = await job(undefined);
  const publish = delay(100).then(() => atomic(join(scope.root, worker.id, "done.json"), { state: "failed", report: "later evidence", error: "task failed" }, true));
  const result = await nextReports(scope, [], 2);
  await publish;
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].state, "failed");
  assert.equal(result.reports[0].text, "task failed\n\nlater evidence");
  assert.deepEqual(result.errors, [], "a failed worker report is not a protocol read error");
  assert.equal(result.pending, 0);
  assert.equal(complete(result), false);
  assert.equal((await saved(scope, worker.id)).cursor, 0);
  assert.notEqual((await saved(scope, worker.id)).closed, true);
  await noCancellation(scope);
});
