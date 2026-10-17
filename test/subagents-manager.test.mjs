import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { classify, SubagentManager } from "../extensions/subagents/manager.ts";
import { rpcArgs, validateTasks } from "../extensions/subagents/tasks.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url));

async function setup(t, limits = {}) {
  const dir = await mkdtemp(join(tmpdir(), "subagents-"));
  const log = join(dir, "fake.log");
  const reports = [];
  const manager = new SubagentManager({
    dir,
    env: { ...process.env, FAKE_PI_LOG: log, PI_SESSION_ID: "parent" },
    promptExtension: "/prompt.ts",
    invocation: { command: process.execPath, prefix: [fake] },
    hooks: { changed() {}, report(report) { reports.push(report); } },
    limits,
  });
  t.after(async () => { await manager.dispose(); await rm(dir, { recursive: true, force: true }); });
  const lines = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { manager, reports, dir, lines };
}

/** Collect reports until `count` arrived (each wait may return fewer). */
async function collect(manager, count, seconds = 15) {
  const all = [];
  const deadline = Date.now() + seconds * 1000;
  while (all.length < count && Date.now() < deadline) all.push(...(await manager.wait([], seconds)).reports);
  return all;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const defaults = { cwd: "/tmp", model: "prov/parent", thinking: "high", resolveModel: (pattern) => pattern.includes("/") ? pattern : `prov/${pattern}` };
// "name task text": the first word names the worker, the rest drives the fake.
const tasks = (...items) => validateTasks(items.map((item) => {
  const [name, ...rest] = item.split(" ");
  return { name, task: rest.join(" ") };
}), defaults, new Set());

test("validateTasks inherits parent model/thinking and drops thinking for explicit models", () => {
  const [inherit, explicit, suffixed] = validateTasks([
    { name: "a", task: "x" },
    { name: "b", task: "x", model: "gpt-6-astra" },
    { name: "c", task: "x", model: "gpt-6-astra:xhigh", role: "reviewer" },
  ], defaults, new Set());
  assert.equal(inherit.model, "prov/parent");
  assert.equal(inherit.thinking, "high");
  assert.equal(explicit.model, "prov/gpt-6-astra");
  assert.equal(explicit.thinking, undefined);
  assert.equal(suffixed.model, "prov/gpt-6-astra");
  assert.equal(suffixed.thinking, "xhigh");
  assert.throws(() => validateTasks([{ name: "a", task: "x" }, { name: "a", task: "y" }], defaults, new Set()), /already in use/);
  assert.throws(() => validateTasks([{ name: "Bad", task: "x" }], defaults, new Set()), /Invalid name/);
  assert.throws(() => validateTasks([{ name: "a", task: "x", role: "boss" }], defaults, new Set()), /Unknown role/);
  assert.throws(() => validateTasks([{ name: "a", task: "x" }], defaults, new Set(["a"])), /already in use/);
});

test("rpcArgs excludes editing tools for read-only roles and always excludes subagents", () => {
  const [reviewer, worker] = validateTasks([{ name: "r", task: "x", role: "reviewer" }, { name: "w", task: "x" }], defaults, new Set());
  const args = rpcArgs(reviewer, { id: "s1", dir: "/d" }, "/p.ts");
  assert.deepEqual(args.slice(args.indexOf("--exclude-tools"), args.indexOf("--exclude-tools") + 2), ["--exclude-tools", "subagents,edit,write"]);
  assert.ok(rpcArgs(worker, { id: "s1", dir: "/d" }, "/p.ts").includes("subagents"));
  assert.ok(args.includes("--session-id") && args.includes("--thinking"));
});

test("classify treats errors, aborts, tool-call endings and empty text as failures", () => {
  const text = (value, stopReason = "stop") => ({ content: [{ type: "text", text: value }], stopReason });
  assert.equal(classify(text("ok"), false).state, "done");
  assert.equal(classify(text("ok"), true).state, "cancelled");
  assert.equal(classify(undefined, false).state, "failed");
  assert.equal(classify(text(""), false).state, "failed");
  assert.equal(classify({ content: [{ type: "toolCall" }], stopReason: "toolUse" }, false).state, "failed");
  assert.match(classify({ content: [], stopReason: "error", errorMessage: "boom" }, false).error, /boom/);
});

test("runs workers in parallel, reports usage, writes per-run report files and strips parent session env", async (t) => {
  const { manager, reports, lines } = await setup(t);
  manager.spawn(tasks("one first", "two second"));
  const all = await collect(manager, 2);
  assert.deepEqual(all.map((r) => r.name).sort(), ["one", "two"]);
  assert.ok(all.every((r) => r.state === "done" && r.tokens === 1500 && r.text.startsWith("reply to:")));
  assert.equal(reports.length, 2);
  const one = all.find((r) => r.name === "one");
  assert.match(one.path, /sub-one-[a-z0-9]+-1\.md$/);
  assert.match(await readFile(one.path, "utf8"), /reply to: first/);
  const spawned = (await lines()).filter((line) => line.argv);
  assert.equal(spawned.length, 2);
  assert.ok(spawned.every((line) => line.env.PI_SUBAGENT === "1" && line.env.PI_SESSION_ID === undefined && line.env.PI_OFFLINE === undefined && line.env.prompt.startsWith("You are a worker subagent")));
  assert.equal(manager.get("one").state, "idle");
});

test("send steers a running worker", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("slow slow:600 work"));
  await delay(300);
  assert.equal(await manager.send("slow", "focus on X"), "steered");
  const { reports } = await manager.wait(["slow"], 10);
  assert.match(reports[0].text, /history: slow:600 work \/ focus on X/);
});

test("a steer that races settlement starts a tracked run instead of being lost", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w first"));
  const worker = manager.get("w");
  // Simulate the parent having missed agent_settled: the run had started
  // (agent_start seen) and is still "running" locally.
  await manager.wait(["w"], 10);
  worker.state = "running";
  worker.runActive = true;
  assert.equal(await manager.send("w", "late"), "started");
  const { reports } = await manager.wait(["w"], 10);
  assert.equal(reports[0]?.state, "done");
  assert.match(reports[0].text, /reply to: late/);
});

test("send continues an idle worker in the same process with history", async (t) => {
  const { manager, lines } = await setup(t);
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  assert.equal(await manager.send("w", "second"), "started");
  const { reports } = await manager.wait(["w"], 10);
  assert.match(reports[0].text, /reply to: second \| history: first \/ second/);
  assert.match(reports[0].path, /sub-w-[a-z0-9]+-2\.md$/);
  assert.equal((await lines()).filter((line) => line.argv).length, 1);
});

test("an idle-closed worker is revived from its session id", async (t) => {
  const { manager, lines } = await setup(t, { idleMs: 50 });
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  await delay(2500);
  assert.equal(manager.get("w").rpc, undefined);
  await manager.send("w", "again");
  const { reports } = await manager.wait(["w"], 10);
  assert.equal(reports[0].state, "done");
  const spawned = (await lines()).filter((line) => line.argv);
  assert.equal(spawned.length, 2);
  const sessionOf = (argv) => argv[argv.indexOf("--session-id") + 1];
  assert.equal(sessionOf(spawned[0].argv), sessionOf(spawned[1].argv));
});

test("stop cancels a running worker, keeps partial text, and stays continuable", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("s slow:5000 long"));
  await delay(300);
  assert.deepEqual(manager.stop(["s"]), ["s"]);
  const { reports } = await manager.wait(["s"], 10);
  assert.equal(reports[0].state, "cancelled");
  assert.match(reports[0].error, /Stopped by parent/);
  assert.equal(reports[0].text, "partial progress");
  assert.equal(manager.get("s").state, "stopped");
  await manager.send("s", "resume");
  assert.equal((await manager.wait(["s"], 10)).reports[0].state, "done");
});

test("stop during startup prevents the run instead of acknowledging a no-op abort", async (t) => {
  const { manager, lines } = await setup(t);
  manager.spawn(tasks("s preflight:400 slow:3000 work"));
  await delay(100);
  manager.stop(["s"]);
  const { reports } = await manager.wait(["s"], 10);
  assert.equal(reports[0].state, "cancelled");
  // Wait past the point where the fake would have finished the run.
  await delay(800);
  const events = await lines();
  assert.ok(!events.some((line) => line.command?.type === "abort"), "no abort is sent before agent_start");
  assert.equal(manager.get("s").rpc, undefined);
});

test("send while a stop is in progress runs next instead of steering the aborted run", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("s slow:5000 long"));
  await delay(300);
  manager.stop(["s"]);
  assert.equal(await manager.send("s", "after stop"), "queued");
  const all = await collect(manager, 2);
  assert.deepEqual(all.map((r) => r.state), ["cancelled", "done"]);
  assert.match(all[1].text, /reply to: after stop/);
});

test("an abort that loses the race with settlement never cancels the next run", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("s slow:400 slowclear first"));
  await delay(300);
  const worker = manager.get("s");
  // Stop right before the run settles on its own; a follow-up is already queued.
  manager.stop(["s"]);
  // Long enough that a stale abort (sent when clear_queue replies) would hit it.
  await manager.send("s", "slow:1500 next run");
  const all = await collect(manager, 2);
  assert.equal(all.length, 2);
  assert.equal(all[1].state, "done", `second run: ${all[1].state} ${all[1].error ?? ""}`);
  assert.match(all[1].text, /reply to: slow:1500 next run/);
  assert.equal(worker.state, "idle");
});

test("send during startup queues instead of starting a parallel prompt", async (t) => {
  const { manager, lines } = await setup(t);
  manager.spawn(tasks("s preflight:400 first"));
  await delay(50);
  assert.equal(await manager.send("s", "second"), "queued");
  const all = await collect(manager, 2);
  assert.deepEqual(all.map((r) => r.state), ["done", "done"]);
  assert.match(all[1].text, /reply to: second/);
  const prompts = (await lines()).filter((line) => line.command?.type === "prompt");
  assert.ok(prompts.every((line) => !line.command.streamingBehavior), "no steer prompt during startup");
});

test("stop cancels a run started by a steer that was in flight at settlement", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  const worker = manager.get("w");
  // The parent still believes the run is active and steers; the child is idle, so
  // this prompt starts a new run after its preflight.
  worker.state = "running";
  worker.runActive = true;
  // Preflight is long relative to the 100 ms below, so the race window is hit even under load.
  const sending = manager.send("w", "preflight:2000 slow:300 followup");
  await delay(100);
  // The local run is reconciled as settled before the steer resolves.
  worker.state = "idle";
  worker.runActive = false;
  assert.deepEqual(manager.stop(["w"]), ["w"]);
  await sending;
  const { reports } = await manager.wait(["w"], 10);
  assert.equal(reports[0]?.state, "cancelled", `${reports[0]?.state} ${reports[0]?.text ?? ""}`);
});

test("stopping a queued continuation keeps the idle shutdown of its process", async (t) => {
  const { manager } = await setup(t, { maxRunning: 1, idleMs: 300 });
  manager.spawn(tasks("a first"));
  await manager.wait(["a"], 10);
  manager.spawn(tasks("b slow:2000 busy"));
  await delay(100);
  assert.equal(await manager.send("a", "continue"), "queued");
  manager.stop(["a"]);
  assert.ok(manager.get("a").rpc, "idle process still present right after stop");
  await delay(2500);
  assert.equal(manager.get("a").rpc, undefined, "idle process closed after idleMs");
});

test("wait all returns only when every target finished", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("fast quick", "slow slow:800 long"));
  const started = Date.now();
  const { reports, pending } = await manager.wait(["fast", "slow"], 10, undefined, true);
  assert.deepEqual(reports.map((r) => r.name).sort(), ["fast", "slow"]);
  assert.deepEqual(pending, []);
  assert.ok(Date.now() - started >= 600);
  // Without all, the first report returns at once.
  manager.spawn(tasks("f2 quick", "s2 slow:800 long"));
  const first = await manager.wait(["f2", "s2"], 10);
  assert.deepEqual(first.reports.map((r) => r.name), ["f2"]);
  assert.deepEqual(first.pending, ["s2"]);
  // At the deadline it returns what finished, with the rest pending.
  manager.spawn(tasks("x slow:3000 long"));
  const timed = await manager.wait(["s2", "x"], 1.5, undefined, true);
  assert.deepEqual(timed.reports.map((r) => r.name), ["s2"]);
  assert.deepEqual(timed.pending, ["x"]);
});

test("isReady holds a report until its run batch finished; sends form their own batch", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("a quick", "b slow:800 long"));
  manager.spawn(tasks("c quick"));
  const deadline = Date.now() + 5000;
  while (manager.outbox.length < 2 && Date.now() < deadline) await delay(20);
  const a = manager.outbox.find((r) => r.name === "a");
  const c = manager.outbox.find((r) => r.name === "c");
  assert.ok(a && c);
  assert.equal(manager.isReady(a), false, "b of the same run still running");
  assert.equal(manager.isReady(c), true, "separate run call is its own batch");
  await manager.wait(["b"], 10, undefined, true);
  assert.equal(manager.isReady(a), true);
  // A send to a finished subagent starts a new batch, independent of the old one.
  manager.take();
  await manager.send("a", "slow:600 again");
  // wait consumes the reports it returns.
  const { reports: [again] } = await manager.wait(["a"], 10, undefined, true);
  assert.ok(again);
  assert.notEqual(again.batch, a.batch);
  assert.equal(manager.isReady(again), true);
});

test("a steer whose whole run arrives buffered before its response does not create a phantom run", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w slow:300 first"));
  await delay(100);
  const worker = manager.get("w");
  // Block the parent's event loop so the child's output piles up in the pipe.
  const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  block(500);
  const sending = manager.send("w", "second");
  block(300);
  await sending;
  const all = await collect(manager, 2);
  assert.deepEqual(all.map((r) => r.state), ["done", "done"]);
  await delay(300);
  assert.equal(worker.state, "idle", `state ${worker.state}, runs ${worker.runs}`);
  assert.equal(worker.runs, 2);
  assert.deepEqual(await manager.wait(["w"], 2, undefined, true), { reports: [], pending: [] });
});

test("concurrency limit queues extra workers in FIFO order", async (t) => {
  const { manager } = await setup(t, { maxRunning: 1 });
  manager.spawn(tasks("a slow:300 x", "b quick"));
  await delay(100);
  assert.equal(manager.get("a").state, "running");
  assert.equal(manager.get("b").state, "queued");
  assert.deepEqual((await collect(manager, 2)).map((r) => r.name), ["a", "b"]);
});

test("stopping a queued worker ends a wait for it immediately", async (t) => {
  const { manager } = await setup(t, { maxRunning: 1 });
  manager.spawn(tasks("a slow:3000 x", "b queued"));
  const waiting = manager.wait(["b"], 10);
  await delay(50);
  manager.stop(["b"]);
  const started = Date.now();
  assert.deepEqual(await waiting, { reports: [], pending: [] });
  assert.ok(Date.now() - started < 500);
});

test("provider errors, crashes with stderr, timeouts and headless dialogs", async (t) => {
  const { manager, lines } = await setup(t, { runTimeoutMs: 1500 });
  manager.spawn(tasks("f fail now", "c crash now", "d dialog now", "t slow:20000 hang"));
  const byName = Object.fromEntries((await collect(manager, 4)).map((report) => [report.name, report]));
  assert.equal(byName.f.state, "failed");
  assert.match(byName.f.error, /boom/);
  assert.equal(byName.c.state, "failed");
  assert.match(byName.c.error, /exited \(3\): fatal: worker crashed/);
  assert.equal(byName.d.state, "done");
  assert.ok((await lines()).some((line) => line.command?.type === "extension_ui_response" && line.command.cancelled === true));
  assert.equal(byName.t.state, "failed");
  assert.match(byName.t.error, /Timed out/);
});

test("a crashed worker's surviving descendants are killed", async (t) => {
  const { manager, lines } = await setup(t);
  manager.spawn(tasks("o orphan now"));
  const { reports } = await manager.wait(["o"], 10);
  assert.equal(reports[0].state, "failed");
  const { orphan } = (await lines()).find((line) => line.orphan);
  const deadline = Date.now() + 5000;
  while (alive(orphan) && Date.now() < deadline) await delay(100);
  assert.equal(alive(orphan), false, "descendant that ignores SIGTERM is killed");
});

test("dispose ends waits and terminates processes that ignore stdin EOF", async (t) => {
  const { manager, lines } = await setup(t);
  assert.deepEqual(await manager.wait([], 5), { reports: [], pending: [] });
  manager.spawn(tasks("s ignoreterm slow:20000 x"));
  await delay(400);
  const waiting = manager.wait([], 30);
  const started = Date.now();
  await manager.dispose();
  await waiting;
  assert.ok(Date.now() - started < 5000);
  const [{ pid }] = (await lines()).filter((line) => line.argv);
  assert.equal(alive(pid), false);
  assert.throws(() => manager.get("nope"), /No subagent/);
  await assert.rejects(manager.send("s", "x"), /shut down/);
});
