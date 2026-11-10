import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { classify, SubagentManager } from "../extensions/subagents/manager.ts";
import { rpcArgs, systemPrompt, validateTasks } from "../extensions/subagents/tasks.ts";

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
    // A short shutdown grace keeps the tests of stuck processes fast.
    limits: { closeGraceMs: 400, ...limits },
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

test("rpcArgs gives read-only roles a small read-only loadout and keeps workers from orchestrating", () => {
  const [reviewer, worker] = validateTasks([{ name: "r", task: "x", role: "reviewer" }, { name: "w", task: "x" }], defaults, new Set());
  const args = rpcArgs(reviewer, { id: "s1", dir: "/d" }, "/p.ts");
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,grep,find,ls,bash"]);
  assert.ok(args.includes("--no-skills") && args.includes("--no-mcp"));
  // Extensions still load (e.g. bash timeouts); the prompt extension is always explicit.
  assert.ok(!args.includes("--no-extensions") && args.at(-1) === "/p.ts");
  const workerArgs = rpcArgs(worker, { id: "s1", dir: "/d" }, "/p.ts");
  assert.deepEqual(workerArgs.slice(workerArgs.indexOf("--exclude-tools"), workerArgs.indexOf("--exclude-tools") + 2), ["--exclude-tools", "subagents"]);
  assert.ok(!workerArgs.includes("--tools") && !workerArgs.includes("--no-skills"));
  assert.ok(args.includes("--session-id") && args.includes("--thinking"));
});

test("validateTasks expands ~, rejects a missing cwd, and passes the parent's trust only to workers in its project", () => {
  const [home] = validateTasks([{ name: "h", task: "x", cwd: "~" }], defaults, new Set());
  assert.equal(home.cwd, homedir());
  assert.throws(() => validateTasks([{ name: "m", task: "x", cwd: "no-such-dir" }], defaults, new Set()), /cwd for "m" is not a directory: \/tmp\/no-such-dir/);
  const [same, other] = validateTasks([{ name: "a", task: "x" }, { name: "b", task: "x", cwd: "~" }], { ...defaults, trusted: true }, new Set());
  assert.equal(same.trusted, true);
  assert.equal(other.trusted, undefined, "another directory is Pi's own decision");
  const args = (task) => rpcArgs(task, { id: "s1", dir: "/d" }, "/p.ts");
  assert.ok(args(same).includes("--approve") && !args(same).includes("--no-approve"));
  assert.ok(args({ ...same, trusted: false }).includes("--no-approve"));
  assert.ok(!args(other).some((arg) => arg.includes("approve")));
  assert.ok(!args(home).some((arg) => arg.includes("approve")), "no decision without a parent context");
});

test("the worker system prompt depends on the role only", () => {
  const [a, b] = validateTasks([{ name: "a", task: "x" }, { name: "b", task: "y" }], defaults, new Set());
  assert.equal(systemPrompt(a.role), systemPrompt(b.role));
  assert.doesNotMatch(systemPrompt("explorer"), /named/);
  assert.match(systemPrompt("explorer"), /^You are an explorer subagent\./);
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
  // input + output + cacheWrite (10 + 5 + 3); cacheRead and totalTokens re-count cached context.
  assert.ok(all.every((r) => r.state === "done" && r.tokens === 18 && r.text.startsWith("reply to:")));
  assert.equal(reports.length, 2);
  const one = all.find((r) => r.name === "one");
  assert.match(one.path, /sub-one-[a-z0-9]+-1\.md$/);
  assert.match(await readFile(one.path, "utf8"), /reply to: first/);
  const spawned = (await lines()).filter((line) => line.argv);
  assert.equal(spawned.length, 2);
  assert.ok(spawned.every((line) => line.env.PI_SUBAGENT === "1" && line.env.PI_SESSION_ID === undefined && line.env.PI_OFFLINE === undefined && line.env.prompt.startsWith("You are a worker subagent")));
  assert.equal(manager.get("one").state, "idle");
});

test("reports list files changed by successful edits and flag files concurrent subagents also edited", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("a edit:src/x.ts edit:/abs/y.ts editfail:src/bad.ts slow:900 work", "b edit:src/x.ts edit:src/z.ts slow:200 quick"));
  const all = await collect(manager, 2);
  const byName = Object.fromEntries(all.map((report) => [report.name, report]));
  assert.deepEqual(byName.a.files, ["/tmp/src/x.ts", "/abs/y.ts"], "failed edits do not count");
  assert.deepEqual(byName.b.files, ["/tmp/src/x.ts", "/tmp/src/z.ts"]);
  // b finished while a was running; a finished after b's run had started: both see it.
  assert.deepEqual(byName.b.overlaps, { "/tmp/src/x.ts": ["a"] });
  assert.deepEqual(byName.a.overlaps, { "/tmp/src/x.ts": ["b"] });
  // A later run that overlaps nothing reports no overlap, and starts with an empty file list.
  await manager.send("b", "quick");
  const { reports: [again] } = await manager.wait(["b"], 10, undefined, true);
  assert.deepEqual(again.files, []);
  assert.equal(again.overlaps, undefined);
});

test("{report:name} inserts a finished subagent's full report into tasks and messages", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("a first"));
  await manager.wait(["a"], 10);
  assert.throws(() => manager.spawn(tasks("b see {report:nope}")), /"nope" has no finished report/);
  assert.equal(manager.workers.has("b"), false, "nothing starts when a reference fails");
  manager.spawn(tasks("b use {report:a}"));
  const { reports: [b] } = await manager.wait(["b"], 10);
  assert.match(b.text, /^reply to: use <report from="a">\nreply to: first \|/);
  // A task may cite the report of the same-name worker it replaces.
  manager.spawn(tasks("a redo {report:a}"));
  const { reports: [a] } = await manager.wait(["a"], 10);
  assert.match(a.text, /^reply to: redo <report from="a">\nreply to: first/);
  assert.equal(await manager.send("b", "compare {report:a}"), "started");
  const { reports: [sent] } = await manager.wait(["b"], 10);
  assert.match(sent.text, /reply to: compare <report from="a">\nreply to: redo/);
  await assert.rejects(manager.send("b", "{report:ghost}"), /"ghost" has no finished report/);
  // A backslash keeps the placeholder as text, e.g. in a task about this feature.
  manager.spawn(tasks("c explain \\{report:nope} and \\{report:a}"));
  const { reports: [c] } = await manager.wait(["c"], 10);
  assert.match(c.text, /^reply to: explain \{report:nope\} and \{report:a\} \|/);
});

test("a task or message that starts with a slash is sent as text, not as a Pi command", async (t) => {
  const { manager, lines } = await setup(t);
  manager.spawn(tasks("s /skill:deploy slow:400 now"));
  await delay(200);
  assert.equal(await manager.send("s", "/compact please"), "steered");
  const { reports: [report] } = await manager.wait(["s"], 10, undefined, true);
  assert.equal(report.state, "done");
  const prompts = (await lines()).filter((line) => line.command?.type === "prompt").map((line) => line.command.message);
  assert.deepEqual(prompts, [" /skill:deploy slow:400 now", " /compact please"]);
});

test("a message consumed by a worker extension is an error, not a steer", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w slow:600 first"));
  await delay(200);
  await assert.rejects(manager.send("w", "consume this"), /did not reach the subagent/);
  const { reports: [report] } = await manager.wait(["w"], 10, undefined, true);
  assert.equal(report.state, "done");
});

test("a run that reaches its turn limit is steered to report, and ended when it keeps going", async (t) => {
  const { manager } = await setup(t, { maxTurns: 1, wrapUpTurns: 5 });
  manager.spawn(tasks("w slow:600 work"));
  const { reports: [asked] } = await manager.wait(["w"], 10);
  assert.equal(asked.state, "done");
  assert.equal(asked.partial, true);
  assert.match(asked.text, /history: slow:600 work \/ Your turn limit is almost reached/);
  await manager.get("w").wrapUpCleanup;
  manager.limits.wrapUpTurns = 0;
  manager.spawn(tasks("x slow:5000 loop"));
  const { reports: [ended] } = await manager.wait(["x"], 10);
  assert.equal(ended.state, "failed");
  assert.match(ended.error, /Stopped after 1 turns/);
  assert.equal(ended.text, "partial progress");
  assert.equal(manager.get("x").rpc?.alive, true, "an aborted run keeps its process and session");
});

test("only maxIdle finished workers keep a process, and stop frees the rest", async (t) => {
  const { manager, lines } = await setup(t, { maxIdle: 1 });
  manager.spawn(tasks("a slow:100 x", "b slow:300 x", "c slow:600 x"));
  await collect(manager, 3);
  const live = () => [...manager.workers.values()].filter((worker) => worker.rpc).map((worker) => worker.task.name);
  assert.deepEqual(live(), ["c"], "the most recently finished keeps its process");
  assert.deepEqual(manager.stop(["a", "b", "c"]), [], "nothing was running");
  assert.deepEqual(live(), []);
  // A closed worker is still continued from its session.
  assert.equal(await manager.send("a", "again"), "started");
  const { reports: [again] } = await manager.wait(["a"], 10, undefined, true);
  assert.equal(again.state, "done");
  const sessionOf = (argv) => argv[argv.indexOf("--session-id") + 1];
  const spawned = (await lines()).filter((line) => line.argv).map((line) => sessionOf(line.argv));
  assert.equal(spawned.length, 4);
  assert.equal(spawned[3], manager.get("a").sessionId);
});

test("a closing process takes no request and is replaced, after it exited, for the next run", async (t) => {
  const { manager, lines } = await setup(t);
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  const worker = manager.get("w");
  const rpc = worker.rpc;
  // Closed but still attached, as when a stop closes a child whose settlement was already buffered.
  const closing = rpc.close();
  assert.equal(rpc.alive, false);
  const started = Date.now();
  await assert.rejects(rpc.request({ type: "get_state" }), /not running/);
  assert.ok(Date.now() - started < 200, "rejected at once instead of timing out");
  assert.equal(await manager.send("w", "again"), "started");
  assert.equal(worker.rpc, undefined, "the next run waits for the old process");
  const { reports: [report] } = await manager.wait(["w"], 10, undefined, true);
  assert.equal(report.state, "done", report.error);
  assert.match(report.text, /reply to: again/);
  await closing;
  assert.equal((await lines()).filter((line) => line.argv).length, 2);
});

test("a run near its deadline is steered to report, marked partial, and its queue cleared", async (t) => {
  const { manager, lines } = await setup(t, { runTimeoutMs: 4000, wrapUpMs: 3000 });
  manager.spawn(tasks("w slow:2000 work"));
  const { reports: [report] } = await manager.wait(["w"], 10);
  assert.equal(report.state, "done");
  assert.equal(report.partial, true);
  assert.match(report.text, /history: slow:2000 work \/ Your time limit is almost reached/);
  // Reporting is immediate; the reuse barrier can still be clearing the queue.
  await manager.get("w").wrapUpCleanup;
  const commands = (await lines()).filter((line) => line.command).map((line) => line.command.type);
  assert.ok(commands.indexOf("clear_queue") > commands.indexOf("steer"), commands.join(","));
  // The next run starts without a wrap-up flag.
  await manager.send("w", "quick");
  const { reports: [next] } = await manager.wait(["w"], 10);
  assert.equal(next.partial, undefined);
});

test("a continuation waits for delayed wrap-up steering and the queue-clear acknowledgement", async (t) => {
  const { manager, lines } = await setup(t, { runTimeoutMs: 3000, wrapUpMs: 2500 });
  manager.spawn(tasks("w slowsteer:800 slowclear slow:700 first"));
  const { reports: [first] } = await manager.wait(["w"], 10);
  assert.equal(first.state, "done");
  assert.equal(first.partial, true);
  await manager.send("w", "second");
  const { reports: [second] } = await manager.wait(["w"], 10, undefined, true);
  assert.equal(second.state, "done");
  assert.doesNotMatch(second.text, /Your time limit is almost reached/);
  const events = await lines();
  const steered = events.findIndex((event) => event.replied === "steer");
  const clearing = events.findIndex((event) => event.command?.type === "clear_queue");
  const cleared = events.findIndex((event) => event.replied === "clear_queue");
  const continued = events.findIndex((event) => event.command?.type === "prompt" && event.command.message === "second");
  assert.ok(steered >= 0 && clearing > steered, "clear_queue must follow the steering acknowledgement");
  assert.ok(cleared >= 0 && continued > cleared, "the continuation must follow the clear_queue acknowledgement");
});

test("messages sent after wrap-up queue locally until cleanup finishes", async (t) => {
  const { manager, lines } = await setup(t, { runTimeoutMs: 3000, wrapUpMs: 0 });
  manager.spawn(tasks("w slowsteer:800 slowclear slow:300 first"));
  const worker = manager.get("w");
  await worker.rpc.request({ type: "get_state" });
  manager.wrapUp(worker);
  assert.equal(await manager.send("w", "second"), "queued");
  const all = await collect(manager, 2);
  assert.deepEqual(all.map((report) => report.state), ["done", "done"]);
  assert.equal(all[0].partial, true);
  assert.equal(all[1].partial, undefined);
  assert.doesNotMatch(all[1].text, /Your time limit is almost reached/);
  const events = await lines();
  const cleared = events.findIndex((event) => event.replied === "clear_queue");
  const continued = events.findIndex((event) => event.command?.message === "second");
  assert.ok(cleared >= 0 && continued > cleared);
  assert.equal(events[continued].command.type, "prompt");
});

test("failed wrap-up steering or clearing discards the uncertain child before continuation", async (t) => {
  for (const [name, trigger, timeoutCommand] of [
    ["steer rejection", "rejectsteer", undefined],
    ["steer timeout", "slowsteer:500", "steer"],
    ["clear rejection", "rejectclear", undefined],
    ["clear timeout", "slowclear", "clear_queue"],
  ]) {
    await t.test(name, async (t) => {
      const { manager, lines } = await setup(t, { runTimeoutMs: 3000, wrapUpMs: 0 });
      manager.spawn(tasks(`w slow:200 ${trigger} first`));
      const worker = manager.get("w");
      const rpc = worker.rpc;
      await rpc.request({ type: "get_state" });
      const request = rpc.request.bind(rpc);
      rpc.request = (command, timeout) => request(command, command.type === timeoutCommand ? 50 : timeout);
      manager.wrapUp(worker);
      const { reports: [first] } = await manager.wait(["w"], 10);
      assert.equal(first.state, "done", "cleanup must preserve the completed report");
      await manager.send("w", "second");
      const { reports: [second] } = await manager.wait(["w"], 10, undefined, true);
      assert.equal(second.state, "done");
      assert.doesNotMatch(second.text, /Your time limit is almost reached/);
      assert.notEqual(worker.rpc, rpc);
      assert.equal(rpc.alive, false, "the old process must close before session revival");
      assert.equal((await lines()).filter((event) => event.argv).length, 2);
    });
  }
});

test("stopping a continuation blocked on wrap-up cleanup never submits its prompt", async (t) => {
  const { manager, lines } = await setup(t, { maxRunning: 1, runTimeoutMs: 3000, wrapUpMs: 0 });
  manager.spawn(tasks("w slowsteer:800 slow:200 first"));
  const worker = manager.get("w");
  await worker.rpc.request({ type: "get_state" });
  manager.wrapUp(worker);
  await manager.wait(["w"], 10);
  await manager.send("w", "must not run");
  manager.spawn(tasks("other quick"));
  assert.equal(worker.state, "running", "cleanup retains the running-slot reservation");
  assert.equal(manager.get("other").state, "queued", "cleanup cannot exceed maxRunning");
  manager.stop(["w"]);
  const all = await collect(manager, 2);
  assert.deepEqual(all.map((report) => report.state), ["cancelled", "done"]);
  assert.equal(worker.runs, 2);
  assert.equal((await lines()).some((event) => event.command?.message === "must not run"), false);
});

test("stopping during successful cleanup cannot expose a closing child to a follow-up", async (t) => {
  const { manager, lines } = await setup(t, { runTimeoutMs: 5000, wrapUpMs: 0 });
  manager.spawn(tasks("w ignoreterm slow:200 slowclear first"));
  const worker = manager.get("w");
  const rpc = worker.rpc;
  await rpc.request({ type: "get_state" });
  manager.wrapUp(worker);
  await manager.wait(["w"], 10);
  await manager.send("w", "must not run");
  manager.stop(["w"]);
  const { reports: [cancelled] } = await manager.wait(["w"], 10);
  assert.equal(cancelled.state, "cancelled");
  await manager.send("w", "resume");
  const { reports: [resumed] } = await manager.wait(["w"], 10, undefined, true);
  assert.equal(resumed.state, "done");
  assert.notEqual(worker.rpc, rpc);
  assert.equal(rpc.alive, false);
  const events = await lines();
  assert.ok(events.some((event) => event.replied === "clear_queue"), "cleanup acknowledges before the old child exits");
  assert.ok(events.some((event) => event.ignored === "SIGTERM"));
  assert.equal(events.some((event) => event.command?.message === "must not run"), false);
});

test("replacing a worker during wrap-up cleanup leaves its successor untouched", async (t) => {
  const { manager, lines } = await setup(t, { runTimeoutMs: 3000, wrapUpMs: 0 });
  manager.spawn(tasks("w slowsteer:800 slow:200 first"));
  const old = manager.get("w");
  await old.rpc.request({ type: "get_state" });
  manager.wrapUp(old);
  await manager.wait(["w"], 10);
  const cleanup = old.wrapUpCleanup;
  assert.ok(cleanup);
  const [replacement] = manager.spawn(tasks("w replacement"));
  const { reports: [report] } = await manager.wait(["w"], 10);
  await cleanup;
  assert.equal(report.state, "done");
  assert.equal(manager.get("w"), replacement);
  assert.equal(replacement.rpc.alive, true);
  assert.equal(replacement.runs, 1);
  assert.equal((await lines()).filter((event) => event.argv).length, 2);
  assert.deepEqual(manager.take(), [], "old cleanup must not produce another report");
});

test("disposing during wrap-up cleanup cannot revive a waiting continuation", async (t) => {
  const { manager, lines } = await setup(t, { runTimeoutMs: 3000, wrapUpMs: 0 });
  manager.spawn(tasks("w slowsteer:800 slow:200 first"));
  const worker = manager.get("w");
  await worker.rpc.request({ type: "get_state" });
  manager.wrapUp(worker);
  await manager.wait(["w"], 10);
  const cleanup = worker.wrapUpCleanup;
  await manager.send("w", "must not run");
  await manager.dispose();
  await cleanup;
  assert.equal(worker.rpc, undefined);
  assert.equal(worker.state, "stopped");
  assert.equal((await lines()).some((event) => event.command?.message === "must not run"), false);
  assert.deepEqual(await manager.wait([], 0), { reports: [], pending: [] });
});

test("idle shutdown is rearmed after wrap-up cleanup", async (t) => {
  const { manager } = await setup(t, { runTimeoutMs: 3000, wrapUpMs: 0, idleMs: 20 });
  manager.spawn(tasks("w slowsteer:400 slow:200 first"));
  const worker = manager.get("w");
  const rpc = worker.rpc;
  await rpc.request({ type: "get_state" });
  manager.wrapUp(worker);
  await manager.wait(["w"], 10);
  assert.ok(worker.wrapUpCleanup, "idle shutdown waits for cleanup");
  await worker.wrapUpCleanup;
  await rpc.exited;
  assert.equal(worker.rpc, undefined);
  assert.equal(worker.state, "idle");
});

test("wrap-up defers to an older ordinary steer and cannot contaminate the run it starts", async (t) => {
  const { manager, lines } = await setup(t, { wrapUpMs: 0 });
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  const worker = manager.get("w");
  // Simulate a missed settlement, as in the ordinary steer-racing-settlement test.
  worker.state = "running";
  worker.runActive = true;
  const sending = manager.send("w", "preflight:500 slow:300 second");
  manager.wrapUp(worker);
  assert.equal(worker.wrappedUp, false);
  worker.state = "idle";
  worker.runActive = false;
  await sending;
  const { reports: [second] } = await manager.wait(["w"], 10, undefined, true);
  assert.equal(second.state, "done");
  assert.equal(second.partial, undefined);
  assert.doesNotMatch(second.text, /Your time limit is almost reached/);
  assert.equal((await lines()).some((event) => event.command?.type === "steer"), false);
});

test("a launch that fails synchronously fails the run at once and keeps the queue moving", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "subagents-"));
  const blocker = join(base, "file");
  await writeFile(blocker, "");
  const reports = [];
  // The session dir sits under a regular file, so creating it throws inside launch.
  const manager = new SubagentManager({
    dir: join(blocker, "sessions"), env: process.env, promptExtension: "/p.ts",
    invocation: { command: process.execPath, prefix: [fake] },
    hooks: { changed() {}, report(report) { reports.push(report); } },
    limits: { maxRunning: 1 },
  });
  t.after(async () => { await manager.dispose(); await rm(base, { recursive: true, force: true }); });
  const created = manager.spawn(tasks("a first", "b second"));
  assert.deepEqual(created.map((worker) => worker.state), ["failed", "failed"]);
  assert.deepEqual(manager.outbox.map((report) => [report.name, report.state]), [["a", "failed"], ["b", "failed"]]);
  assert.equal(reports.length, 2);
  assert.match(manager.outbox[0].error, /^Could not start worker: ENOTDIR/);
  assert.deepEqual([...manager.busyNames()], []);
  assert.equal(manager.running, 0);
  // The undelivered task stays for a retry by send.
  assert.equal(manager.get("a").pendingPrompt, "first");
});

test("stopping a run that has no process ends it instead of leaving it running", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  const worker = manager.get("w");
  await worker.rpc.close();
  assert.equal(worker.rpc, undefined);
  worker.state = "running";
  assert.deepEqual(manager.stop(["w"]), ["w"]);
  assert.equal(worker.state, "stopped");
  assert.equal(manager.take()[0]?.state, "cancelled");
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
  // Closing a process sends its own abort, without an id; the manager requests none.
  assert.ok(!events.some((line) => line.command?.type === "abort" && line.command.id), "no abort is requested before agent_start");
  assert.ok(events.some((line) => line.command?.type === "abort" && !line.command.id), "close aborts ahead of stdin EOF");
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

test("a fresh queued worker that was stopped keeps its task for a later send", async (t) => {
  const { manager } = await setup(t, { maxRunning: 1 });
  manager.spawn(tasks("a slow:300 x", "b original"));
  manager.stop(["b"]);
  await manager.send("b", "extra");
  const { reports } = await manager.wait(["b"], 10, undefined, true);
  assert.match(reports.at(-1).text, /reply to: original\n\nextra/);
});

test("stop validates every name before stopping any", async (t) => {
  const { manager } = await setup(t, { maxRunning: 1 });
  manager.spawn(tasks("a slow:300 x", "b queued"));
  assert.throws(() => manager.stop(["b", "nope"]), /No subagent named "nope"/);
  assert.equal(manager.get("b").state, "queued");
});

test("finished names can be reused; busy names cannot", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w slow:400 first"));
  assert.throws(() => manager.spawn(tasks("w again")), /already in use/);
  await manager.wait(["w"], 10);
  const old = manager.get("w");
  const [fresh] = manager.spawn(tasks("w again"));
  assert.notEqual(fresh, old);
  assert.notEqual(fresh.sessionId, old.sessionId);
  assert.equal(old.rpc, undefined);
  const { reports } = await manager.wait(["w"], 10);
  assert.match(reports[0].text, /reply to: again \| history: again \|/);
});

test("a named wait ignores reports of a replaced same-name worker", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w first"));
  // Finish without consuming the report, as when the parent is busy.
  const deadline = Date.now() + 5000;
  while (!manager.outbox.length && Date.now() < deadline) await delay(20);
  manager.spawn(tasks("w slow:400 second"));
  const { reports } = await manager.wait(["w"], 10);
  assert.equal(reports.length, 1);
  assert.match(reports[0].text, /reply to: slow:400 second/);
  assert.equal(manager.outbox.length, 1, "old report stays for automatic delivery");
});

test("send stops waiting for a slow steer reply on abort and still tracks the run", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  const worker = manager.get("w");
  // The parent missed settlement, so this steer starts a run behind a long preflight.
  worker.state = "running";
  worker.runActive = true;
  const controller = new AbortController();
  const sending = manager.send("w", "preflight:1500 later", controller.signal);
  await delay(100);
  worker.state = "idle";
  worker.runActive = false;
  const started = Date.now();
  controller.abort();
  assert.equal(await sending, "sent");
  assert.ok(Date.now() - started < 500);
  const { reports } = await manager.wait(["w"], 10, undefined, true);
  assert.match(reports[0]?.text ?? "", /reply to: preflight:1500 later/);
});

test("a send while a steer reply is outstanding runs after it instead of colliding", async (t) => {
  const { manager } = await setup(t, { steerReplyMs: 50 });
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  const worker = manager.get("w");
  worker.state = "running";
  worker.runActive = true;
  assert.equal(await manager.send("w", "preflight:800 steered"), "sent");
  worker.state = "idle";
  worker.runActive = false;
  assert.equal(await manager.send("w", "afterwards"), "queued");
  const all = await collect(manager, 2);
  assert.deepEqual(all.map((r) => r.state), ["done", "done"]);
  assert.match(all[0].text, /reply to: preflight:800 steered/);
  assert.match(all[1].text, /reply to: afterwards/);
});

test("an unanswered steer closes the child so a stopped run cannot start unseen", async (t) => {
  const { manager } = await setup(t, { steerReplyMs: 25, runTimeoutMs: 400 });
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  const worker = manager.get("w");
  const rpc = worker.rpc;
  worker.state = "running";
  worker.runActive = true;
  assert.equal(await manager.send("w", "preflight:900 late"), "sent");
  worker.state = "idle";
  worker.runActive = false;
  assert.deepEqual(manager.stop(["w"]), ["w"]);
  await manager.wait(["w"], 5, undefined, true);
  assert.equal(worker.rpc, undefined);
  await delay(1200);
  assert.equal(rpc.alive, false);
  assert.deepEqual(manager.take(), [], "the prompt never ran");
});

test("a steer refused with an error response keeps the worker and its run", async (t) => {
  const { manager } = await setup(t);
  manager.spawn(tasks("w slow:600 first"));
  await delay(200);
  const rpc = manager.get("w").rpc;
  await assert.rejects(manager.send("w", "reject now"), /compaction is in progress/);
  assert.equal(manager.get("w").rpc, rpc);
  const { reports } = await manager.wait(["w"], 10, undefined, true);
  assert.equal(reports[0].state, "done");
  assert.equal(manager.get("w").state, "idle");
});

test("a queued continuation drops the previous run's finish time", async (t) => {
  const { manager } = await setup(t, { maxRunning: 1 });
  manager.spawn(tasks("w first"));
  await manager.wait(["w"], 10);
  assert.ok(manager.get("w").finishedAt);
  manager.spawn(tasks("busy slow:2000 x"));
  await delay(100);
  assert.equal(await manager.send("w", "again"), "queued");
  manager.stop(["w"]);
  assert.equal(manager.get("w").state, "stopped");
  assert.equal(manager.get("w").finishedAt, undefined);
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
