import assert from "node:assert/strict";
import fs, { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { atomic, jobs, PAGE_BYTES, save } from "../extensions/herdr-subagents/core.ts";
import { acknowledgeReport, readManyReports, readReport, waitForReports } from "../extensions/herdr-subagents/reports.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-report-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backend = join(root, "backend.mjs");
  await writeFile(backend, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.REPORT_CALLS, JSON.stringify(process.argv.slice(2))+'\\n');
await new Promise(r=>setTimeout(r, Number(process.env.REPORT_DELAY || 0)));
if(process.env.REPORT_OFFLINE) { console.error('offline'); process.exit(1); }
console.log(JSON.stringify({result:{panes:[{pane_id:'worker',terminal_id:'worker-terminal'}]}}));
`);
  await chmod(backend, 0o700);
  const scope = { root, pane: "parent", workspace: "workspace", env: { ...process.env, HERDR_BIN_PATH: backend, REPORT_CALLS: join(root, "calls") } };
  let count = 0;
  async function job(text, extra = {}, done = {}) {
    const value = {
      id: (++count).toString(16).padStart(12, "0"),
      task: { name: `report-${count}`, prompt: "fixture only", role: "worker", cwd: root, timeout: 60, extensions: [] },
      cursor: 0, created: count, pane: "worker", terminal: "worker-terminal", ...extra,
    };
    await mkdir(join(root, value.id), { mode: 0o700 });
    await save(scope, value);
    if (text !== undefined) await atomic(join(root, value.id, "done.json"), { state: "done", report: text, ...done }, true);
    return value;
  }
  return { scope, job };
}

async function saved(scope, id) {
  return JSON.parse(await readFile(join(scope.root, id, "job.json"), "utf8"));
}

test("replayable reads issue private durable receipts without consuming reports", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("Evidence 😀");
  const before = await readFile(join(scope.root, worker.id, "job.json"), "utf8");
  const first = await readReport(scope, worker.id);
  assert.deepEqual(await readReport({ ...scope }, worker.id), first);
  assert.deepEqual(first, { id: worker.id, name: worker.task.name, state: "done", offset: 0, complete: true, text: "Evidence 😀", receipt: first.receipt });
  assert.equal(await readFile(join(scope.root, worker.id, "job.json"), "utf8"), before);
  const directory = join(scope.root, worker.id, "receipts");
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(directory), [`${first.receipt}.json`]);
  assert.equal((await stat(join(directory, `${first.receipt}.json`))).mode & 0o777, 0o600);
  const acknowledged = { id: worker.id, collected: true, cursor: first.text.length };
  assert.deepEqual(await acknowledgeReport({ ...scope }, first.receipt), acknowledged);
  assert.deepEqual(await acknowledgeReport(scope, first.receipt), acknowledged);
  assert.deepEqual(await readReport(scope, worker.id, 0), first, "Collected reports remain replayable");
  const eof = await readReport(scope, worker.id);
  assert.equal(eof.offset, first.text.length);
  assert.equal(eof.text, "");
  assert.equal(eof.complete, true);
});

test("serialized pages stay strictly bounded and losslessly preserve escaped Unicode", async (t) => {
  const { scope, job } = await fixture(t);
  const text = ('😀中文\n\u0000"\\\r\t\ud800X\udfff' + "a".repeat(11)).repeat(2500) + "END";
  const worker = await job(text);
  const chunks = [];
  let previousReceipt;
  let offset = 0;
  while (true) {
    const page = await readReport(scope, worker.id);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < PAGE_BYTES);
    assert.equal(JSON.stringify(page).split("\n").length, 1);
    assert.equal(page.offset, offset);
    chunks.push(page.text);
    offset += page.text.length;
    assert.equal((await saved(scope, worker.id)).cursor, page.offset);
    if (!page.complete) assert.equal(page.next, offset);
    else assert.ok(!Object.hasOwn(page, "next"));
    const result = await acknowledgeReport(scope, page.receipt);
    assert.deepEqual(result, { id: worker.id, collected: page.complete, cursor: offset });
    if (previousReceipt) assert.deepEqual(await acknowledgeReport(scope, previousReceipt), result);
    previousReceipt = page.receipt;
    if (page.complete) break;
    assert.ok(chunks.length < 100);
  }
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
});

test("acknowledgements require contiguous exact delivered ranges", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("x".repeat(PAGE_BYTES * 2));
  const first = await readReport(scope, worker.id);
  const second = await readReport(scope, worker.id, first.next);
  const overlap = await readReport(scope, worker.id, 1);
  const eof = await readReport(scope, worker.id, PAGE_BYTES * 2);
  for (const page of [second, overlap, eof]) {
    await assert.rejects(acknowledgeReport(scope, page.receipt), /contiguous/);
  }
  assert.equal((await saved(scope, worker.id)).cursor, 0);
  await acknowledgeReport(scope, first.receipt);
  await assert.rejects(acknowledgeReport(scope, overlap.receipt), /contiguous/);
  await acknowledgeReport(scope, second.receipt);
  assert.equal((await readReport(scope, worker.id)).offset, second.next);
});

test("concurrent duplicate acknowledgements are atomically idempotent", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("one final");
  const page = await readReport(scope, worker.id);
  const results = await Promise.all(Array.from({ length: 4 }, () => acknowledgeReport(scope, page.receipt)));
  for (const result of results) assert.deepEqual(result, results[0]);
  const stored = await saved(scope, worker.id);
  assert.equal(stored.cursor, page.text.length);
  assert.deepEqual(stored.reportAcknowledgements, [page.receipt]);
});

test("unknown, tampered, cross-job, cross-scope and stale receipts are rejected", async (t) => {
  const { scope, job } = await fixture(t);
  const a = await job("original");
  const b = await job("original");
  const page = await readReport(scope, a.id);
  for (const receipt of ["../job.json", `${a.id}.${"0".repeat(64)}`, `${b.id}${page.receipt.slice(12)}`, `${page.receipt.slice(0, -1)}${page.receipt.endsWith("0") ? "1" : "0"}`]) {
    await assert.rejects(acknowledgeReport(scope, receipt), /receipt/);
  }
  const path = join(scope.root, a.id, "receipts", `${page.receipt}.json`);
  const issued = JSON.parse(await readFile(path, "utf8"));
  await atomic(path, { ...issued, end: 1 });
  await assert.rejects(acknowledgeReport(scope, page.receipt), /tampered/);
  await atomic(path, issued);
  const other = await fixture(t);
  const otherJob = await other.job("original");
  await mkdir(join(other.scope.root, otherJob.id, "receipts"));
  await atomic(join(other.scope.root, otherJob.id, "receipts", `${page.receipt}.json`), issued);
  await assert.rejects(acknowledgeReport(other.scope, page.receipt), /tampered/);
  await atomic(join(scope.root, a.id, "done.json"), { state: "failed", report: "original" });
  await assert.rejects(acknowledgeReport(scope, page.receipt), /Stale/);
  assert.equal((await saved(scope, a.id)).cursor, 0);
});

test("even acknowledged receipts become stale if a job incarnation changes", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("same");
  const page = await readReport(scope, worker.id);
  await acknowledgeReport(scope, page.receipt);
  await save(scope, { ...await saved(scope, worker.id), created: worker.created + 1 });
  await assert.rejects(acknowledgeReport(scope, page.receipt), /Stale/);
});

test("invalid IDs, offsets and split surrogate offsets fail without progress changes", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("😀text");
  for (const offset of [-1, 0.5, NaN, Infinity, 100, 1, "0", null]) {
    await assert.rejects(readReport(scope, worker.id, offset), /offset/);
  }
  for (const id of ["../escape", "ffffffffffff"]) await assert.rejects(readReport(scope, id), /job/);
  assert.equal((await readReport(scope, worker.id, 2)).text, "text");
  const pending = await job(undefined);
  await assert.rejects(readReport(scope, pending.id), /not complete/);
  assert.equal((await saved(scope, worker.id)).cursor, 0);
});

test("empty, failed and cancelled report rendering matches the existing completion contract", async (t) => {
  const { scope, job } = await fixture(t);
  for (const state of ["done", "failed", "cancelled"]) {
    const worker = await job("", {}, { state, error: "reason" });
    const page = await readReport(scope, worker.id);
    assert.equal(page.state, state);
    assert.equal(page.text, "reason\n\n(no final report)");
    assert.equal(page.complete, true);
    assert.equal((await acknowledgeReport(scope, page.receipt)).collected, true);
  }
});

test("fallback reports use the immutable completion, not mutable result/checkpoint files", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job(undefined, { endedAt: Date.now() - 6000, closed: true });
  const directory = join(scope.root, worker.id);
  await atomic(join(directory, "checkpoint.json"), { report: "Checkpoint evidence" });
  const page = await readReport(scope, worker.id);
  assert.equal(page.state, "cancelled");
  assert.match(page.text, /Checkpoint evidence/);
  await atomic(join(directory, "checkpoint.json"), { report: "Late replacement" });
  await writeFile(join(directory, "result.md"), "Late replacement");
  assert.deepEqual(await readReport(scope, worker.id), page);
  assert.equal((await saved(scope, worker.id)).collected, undefined);
});

test("wait preserves offline-readable closed reports and counts unfinished jobs", async (t) => {
  const { scope, job } = await fixture(t);
  const ready = await job("saved", { closed: true });
  await job(undefined);
  const offline = { ...scope, env: { ...scope.env, REPORT_OFFLINE: "1" } };
  assert.deepEqual(await waitForReports(offline, 60), { ready: [ready.id], pending: 1 });
  assert.equal(await stat(join(scope.root, "calls")).catch(() => undefined), undefined);
  const page = await readReport(offline, ready.id);
  await acknowledgeReport(offline, page.receipt);
  const result = await waitForReports(offline, 0);
  assert.equal(result.pending, 1);
  assert.deepEqual(result.ready, []);
  assert.match(result.warning, /offline/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < PAGE_BYTES);
});

test("zero-second wait reconciles missing panes without acknowledging reports", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job(undefined, { terminal: "missing" });
  assert.deepEqual(await waitForReports(scope, 0), { ready: [], pending: 1 });
  const stored = await saved(scope, worker.id);
  assert.equal(typeof stored.endedAt, "number");
  assert.equal(stored.cursor, 0);
  assert.equal(stored.collected, undefined);
  assert.match(await readFile(join(scope.root, "calls"), "utf8"), /pane.*list/);
});

test("wait observes later completion and does not consume it", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job(undefined);
  const publish = delay(100).then(() => atomic(join(scope.root, worker.id, "done.json"), { state: "done", report: "later" }, true));
  const result = await waitForReports(scope, 2);
  await publish;
  assert.deepEqual(result, { ready: [worker.id], pending: 0 });
  assert.equal((await saved(scope, worker.id)).cursor, 0);
  assert.equal((await saved(scope, worker.id)).collected, undefined);
});

test("wait validates bounds and cancellation does not cancel or close workers", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job(undefined);
  for (const seconds of [-1, 61, Infinity, NaN, "1"]) await assert.rejects(waitForReports(scope, seconds), /0\.\.60/);
  const already = AbortSignal.abort(new Error("already aborted"));
  await assert.rejects(waitForReports(scope, 60, already), /already aborted/);
  const controller = new AbortController();
  const waiting = waitForReports(scope, 60, controller.signal);
  const abort = delay(50).then(() => controller.abort(new Error("stop waiting")));
  await assert.rejects(waiting, /stop waiting/);
  await abort;
  await delay(150); // Allow already-started reconciliation to release its lock.
  const stored = await saved(scope, worker.id);
  assert.equal(stored.closed, undefined);
  assert.equal(stored.collected, undefined);
  assert.equal(await stat(join(scope.root, worker.id, "cancel.json")).catch(() => undefined), undefined);
  assert.deepEqual((await jobs(scope)).map((entry) => entry.id), [worker.id]);
});

test("deadline and abort interrupt slow reconciliation without terminating workers", async (t) => {
  const { scope, job } = await fixture(t);
  await job(undefined);
  const slow = { ...scope, env: { ...scope.env, REPORT_DELAY: "400" } };
  const start = Date.now();
  assert.deepEqual(await waitForReports(slow, 0.08), { ready: [], pending: 1 });
  assert.ok(Date.now() - start < 350);
  await delay(450);
  const controller = new AbortController();
  const waiting = waitForReports(slow, 60, controller.signal);
  const abort = delay(50).then(() => controller.abort(new Error("interrupt I/O")));
  await assert.rejects(waiting, /interrupt I\/O/);
  await abort;
  await delay(450);
  const calls = (await readFile(join(scope.root, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.every((args) => args[0] === "pane" && args[1] === "list"));
});

test("positive wait deadlines cover the initial readiness scan", async (t) => {
  const { scope, job } = await fixture(t);
  await job(undefined);
  const original = fs.readFile;
  t.mock.method(fs, "readFile", async (path, ...args) => {
    if (String(path).endsWith("/job.json")) await delay(400);
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const start = Date.now();
  const result = await waitForReports(scope, 0.08);
  assert.ok(Date.now() - start < 350);
  assert.equal(result.pending, 1);
  assert.match(result.warning, /Initial readiness scan/);
  await delay(450);
});

test("historical ready backlogs are bounded and unlisted reports remain pending", async (t) => {
  const { scope, job } = await fixture(t);
  for (let i = 0; i < 40; i++) await job("saved", { closed: true });
  const result = await waitForReports(scope, 0);
  assert.equal(result.ready.length, 16);
  assert.equal(result.pending, 24);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < PAGE_BYTES);
});

test("batch reads fairly share one aggregate budget, replay and acknowledge losslessly", async (t) => {
  const { scope, job } = await fixture(t);
  const content = ('😀中文\n\u0000"\\\r\t' + 'x'.repeat(100)).repeat(25);
  const workers = [];
  for (let i = 0; i < 16; i++) workers.push(await job(`${i}:${content}`));
  const received = new Map(workers.map((worker) => [worker.id, ""]));
  let ids = workers.map((worker) => worker.id);
  let batches = 0;
  while (ids.length) {
    const result = await readManyReports(scope, ids);
    assert.deepEqual(await readManyReports(scope, ids), result, "unacknowledged batches replay exactly");
    assert.equal(result.reports.length, ids.length);
    assert.deepEqual(result.errors, []);
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, action: "read_many", data: result })) < PAGE_BYTES);
    const next = [];
    for (const page of result.reports) {
      assert.ok(page.text.length > 0, "a large first report must not starve other workers");
      assert.equal((await saved(scope, page.id)).cursor, page.offset);
      received.set(page.id, received.get(page.id) + page.text);
      const ack = await acknowledgeReport(scope, page.receipt);
      assert.equal(ack.collected, page.complete);
      if (!page.complete) next.push(page.id);
    }
    ids = next;
    assert.ok(++batches < 30);
  }
  assert.ok(batches > 1);
  for (const [index, worker] of workers.entries()) assert.equal(received.get(worker.id), `${index}:${content}`);
});

test("batch reads preserve successful pages alongside per-job failures without consuming either", async (t) => {
  const { scope, job } = await fixture(t);
  const success = await job("good");
  const pending = await job(undefined);
  const failed = await job("failure evidence", {}, { state: "failed", error: "failed task" });
  const result = await readManyReports(scope, [success.id, pending.id, "ffffffffffff", failed.id]);
  assert.deepEqual(result.reports.map((page) => page.state), ["done", "failed"]);
  assert.deepEqual(result.errors.map((entry) => entry.id), [pending.id, "ffffffffffff"]);
  assert.match(result.errors[0].error, /not complete/);
  assert.match(result.errors[1].error, /Unknown/);
  for (const worker of [success, pending, failed]) assert.equal((await saved(scope, worker.id)).cursor, 0);
  const single = await readReport(scope, success.id);
  assert.equal(single.receipt, result.reports[0].receipt, "same delivered range uses the same protocol receipt");
});

test("batch input and abort admission are strict; oversized errors stay bounded", async (t) => {
  const { scope, job } = await fixture(t);
  const worker = await job("saved");
  for (const ids of [[], [worker.id, worker.id], ["../escape"], "all", null, Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(12, "0"))]) {
    await assert.rejects(readManyReports(scope, ids), /unique report job IDs/);
  }
  await assert.rejects(readManyReports(scope, [worker.id], AbortSignal.abort(new Error("aborted"))), /aborted/);
  assert.equal(await stat(join(scope.root, worker.id, "receipts")).catch(() => undefined), undefined);
  const original = fs.readFile;
  t.mock.method(fs, "readFile", async (path, ...args) => {
    if (String(path).endsWith("/job.json")) throw new Error("\u0000😀".repeat(10000));
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await readManyReports(scope, Array.from({ length: 16 }, (_, i) => i.toString(16).padStart(12, "0")));
  assert.equal(result.errors.length, 16);
  assert.ok(result.errors.every((entry) => entry.error.endsWith("...")));
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, action: "read_many", data: result })) < PAGE_BYTES);
});

test("optional wait details expose bounded pending event age, not a stall diagnosis or usage", async (t) => {
  const { scope, job } = await fixture(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const ready = await job("complete");
  const active = await job(undefined, { created: now - 65_000 });
  const queued = await job(undefined, { created: now - 2000 });
  const starting = await job(undefined, { created: now + 1000 });
  await atomic(join(scope.root, active.id, "progress.json"), { phase: "tool", tool: "bash", updatedAt: now - 9000, usage: { private: "not included" } });
  await atomic(join(scope.root, queued.id, "waiting.json"), {});
  const plain = await waitForReports(scope, 60);
  assert.deepEqual(plain, { ready: [ready.id], pending: 3 });
  const detailed = await waitForReports(scope, 60, undefined, true);
  assert.deepEqual(detailed.pendingWorkers, [
    { id: active.id, name: active.task.name, phase: "tool", tool: "bash", elapsedSeconds: 65, lastEventAgeSeconds: 9 },
    { id: queued.id, name: queued.task.name, phase: "queued", elapsedSeconds: 2 },
    { id: starting.id, name: starting.task.name, phase: "starting", elapsedSeconds: 0 },
  ]);
  assert.ok(!JSON.stringify(detailed).includes("usage"));
  assert.ok(!JSON.stringify(detailed).includes("stalled"));
  assert.equal(await stat(join(scope.root, "calls")).catch(() => undefined), undefined);
  await assert.rejects(waitForReports(scope, 0, undefined, "yes"), /boolean/);
});

test("wait detail backlogs and escaped metadata obey output limits", async (t) => {
  const { scope, job } = await fixture(t);
  await job("complete");
  for (let i = 0; i < 40; i++) {
    const worker = await job(undefined);
    await atomic(join(scope.root, worker.id, "progress.json"), { phase: "tool", tool: "\u0000😀".repeat(100), updatedAt: Date.now() });
  }
  const result = await waitForReports(scope, 0, undefined, true);
  assert.equal(result.pending, 40);
  assert.equal(result.pendingWorkers.length, 16);
  assert.equal(result.pendingWorkersOmitted, 24);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < PAGE_BYTES);
});

test("wait detail reads remain subject to the initial deadline", async (t) => {
  const { scope, job } = await fixture(t);
  await job(undefined);
  const original = fs.readFile;
  t.mock.method(fs, "readFile", async (path, ...args) => {
    if (String(path).endsWith("/progress.json")) await delay(400);
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const start = Date.now();
  const result = await waitForReports(scope, 0.08, undefined, true);
  assert.ok(Date.now() - start < 350);
  assert.match(result.warning, /Initial readiness scan/);
  assert.equal(result.pendingWorkers, undefined);
  await delay(450);
});

test("no jobs returns immediately and never contacts the backend", async (t) => {
  const { scope } = await fixture(t);
  assert.deepEqual(await waitForReports(scope, 60), { ready: [], pending: 0 });
  assert.equal(await stat(join(scope.root, "calls")).catch(() => undefined), undefined);
});
