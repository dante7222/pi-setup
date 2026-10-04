import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { atomic, jobs, json, locked, save, scopeFor, spawnTasks, validateTasks } from "../extensions/herdr-subagents/core.ts";
import { continueTask, sendTask, stopTask } from "../extensions/herdr-subagents/conversations.ts";
import { claimScope } from "../extensions/herdr-subagents/ownership.ts";
import { bootIdentity, processIdentity } from "../extensions/herdr-subagents/identity.ts";
import { ProcessTree, snapshotProcesses } from "../extensions/herdr-subagents/process-tree.ts";
import { recoverTask } from "../extensions/herdr-subagents/recovery.ts";
import { configurePresets, resolveTasks } from "../extensions/herdr-subagents/policy.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-experience-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const backend = join(directory, "herdr.mjs");
  await writeFile(backend, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.FAKE_STATE;
const state=JSON.parse(readFileSync(file,'utf8'));
const args=process.argv.slice(2);let result={};
if(args[1]==='list')result={panes:state.panes};
if(args[1]==='current')result={pane:state.panes[0]};
if(args[1]==='layout')result={layout:{panes:state.panes.map(p=>({...p,rect:{width:100,height:40}}))}};
if(args[1]==='split'){const i=state.next++; const pane={pane_id:'w:p-'+i,terminal_id:'t-'+i};state.panes.push(pane);result={pane};}
if(args[1]==='close')state.panes=state.panes.filter(p=>p.pane_id!==args[2]);
writeFileSync(file,JSON.stringify(state));if(args[1]!=='run')console.log(JSON.stringify({result}));
`);
  await chmod(backend, 0o700);
  const state = join(directory, "panes.json");
  await writeFile(state, JSON.stringify({ panes: [{ pane_id: "main", terminal_id: "parent" }], next: 1 }));
  const scope = scopeFor("persistent-parent", {
    ...process.env, PI_HERDR_WORKER: "", PI_HERDR_OWNER_PID: String(process.pid), PI_CODING_AGENT_DIR: directory,
    HERDR_ENV: "1", HERDR_SOCKET_PATH: "test", HERDR_PANE_ID: "main", HERDR_WORKSPACE_ID: "w",
    HERDR_BIN_PATH: backend, PI_HERDR_PI_BIN: process.execPath, FAKE_STATE: state,
  });
  await mkdir(scope.root, { recursive: true });
  return { directory, scope };
}
async function jobFixture(t) {
  const context = await fixture(t);
  const job = { id: "abcdef123456", task: validateTasks([{ name: "persistent", prompt: "first", persistent: true }], {}, context.directory)[0], cursor: 0, created: 1, conversationId: "abcdef123456" };
  await mkdir(join(context.scope.root, job.id));
  await save(context.scope, job);
  return { ...context, job, jobdir: join(context.scope.root, job.id) };
}

test("persistent attempts share a private session but require consumed report and verified shutdown", async (t) => {
  const { scope, directory } = await fixture(t);
  const task = validateTasks([{ name: "conversation", prompt: "first literal @file", persistent: true }], {}, directory)[0];
  const [first] = await spawnTasks(scope, [task], "initial");
  const launch = await json(join(scope.root, first.id, "launch.json"));
  assert.ok(launch.args.includes("rpc"));
  assert.ok(!launch.args.includes("--no-session"));
  assert.equal(launch.args[launch.args.indexOf("--session-id") + 1], first.conversationId);
  await assert.rejects(continueTask(scope, first.id, "second", "next"), /Acknowledge/);
  first.collected = true;
  await save(scope, first);
  await assert.rejects(continueTask(scope, first.id, "second", "next"), /cleanup is unverified/);
  await atomic(join(scope.root, first.id, "shutdown.json"), { verified: true });
  await atomic(join(scope.root, first.id, "done.json"), { state: "done", report: "immutable" });
  const [second] = await continueTask(scope, first.id, "second", "next");
  assert.notEqual(second.id, first.id);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(second.previousId, first.id);
  assert.equal(second.task.prompt, "second");
  assert.equal((await json(join(scope.root, first.id, "done.json"))).report, "immutable");
  assert.equal((await continueTask(scope, first.id, "second", "next"))[0].id, second.id);
  await assert.rejects(continueTask(scope, first.id, "third", "other"), /newer attempt/);
  assert.equal((await jobs(scope)).filter((job) => !job.closed).length, 1);
});

test("only one concurrent continuation can own a conversation", async (t) => {
  const { scope, job, jobdir } = await jobFixture(t);
  job.collected = true; job.closed = true;
  await save(scope, job);
  await atomic(join(jobdir, "shutdown.json"), { verified: true });
  const outcomes = await Promise.allSettled([continueTask(scope, job.id, "a", "a"), continueTask(scope, job.id, "b", "b")]);
  assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal((await jobs(scope)).length, 2);
});

test("parent ownership fences a second live process, permits dead-owner adoption", async (t) => {
  const { scope } = await fixture(t);
  await claimScope(scope);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await assert.rejects(claimScope({ ...scope, ownerPid: child.pid }), /Another live Pi/);
  const identity = await processIdentity();
  await atomic(join(scope.root, "owner.json"), { identity: { ...identity, start: "old incarnation" }, pane: "old", workspace: "w" });
  await claimScope({ ...scope, pane: "new" });
  assert.equal((await json(join(scope.root, "owner.json"))).pane, "new");
});

test("control requests replay receipts, reject ID collisions and never reuse initial prompts", async (t) => {
  const { scope, job, jobdir } = await jobFixture(t);
  await atomic(join(jobdir, "worker.json"), { pid: process.pid, identity: await processIdentity() });
  const key = createHash("sha256").update("message-1").digest("hex");
  const sending = sendTask(scope, job.id, "new instruction", "steer", "message-1");
  for (let i = 0; i < 100 && !await json(join(jobdir, "control", `${key}.json`)); i++) await delay(10);
  assert.deepEqual(await json(join(jobdir, "control", `${key}.json`)), { id: "message-1", kind: "steer", message: "new instruction" });
  await atomic(join(jobdir, "control", `${key}.reply.json`), { state: "accepted", disposition: "queued" });
  assert.equal((await sending).state, "accepted");
  await atomic(join(jobdir, "done.json"), { state: "done", report: "finished" });
  assert.equal((await sendTask(scope, job.id, "new instruction", "steer", "message-1")).state, "accepted");
  await assert.rejects(sendTask(scope, job.id, "different", "steer", "message-1"), /different message/);
  await assert.rejects(sendTask(scope, job.id, "new", "steer", "message-2"), /settled/);
});

test("closed RPC mailboxes reject late unattempted controls, including final-scan races", async (t) => {
  const { scope, job, jobdir } = await jobFixture(t);
  await atomic(join(jobdir, "worker.json"), { identity: await processIdentity() });
  await mkdir(join(jobdir, "control"));
  await atomic(join(jobdir, "control", "closed.json"), { error: "worker stopped" });
  assert.equal((await sendTask(scope, job.id, "late", "steer", "late-id")).state, "rejected");
  await rm(join(jobdir, "control", "closed.json"));
  const key = createHash("sha256").update("racing-id").digest("hex");
  const sending = sendTask(scope, job.id, "racing", "follow_up", "racing-id");
  for (let i = 0; i < 100 && !await json(join(jobdir, "control", `${key}.json`)); i++) await delay(10);
  await atomic(join(jobdir, "control", "closed.json"), { error: "closed after publication" });
  assert.deepEqual(await sending, { state: "rejected", error: "closed after publication" });
});

test("intentional stop retains pane and artifacts rather than claiming termination", async (t) => {
  const { scope, job, jobdir } = await jobFixture(t);
  assert.deepEqual(await stopTask(scope, job.id), { stopped: job.id, settled: false });
  assert.deepEqual(await json(join(jobdir, "cancel.json")), {});
  assert.equal((await jobs(scope))[0].closed, undefined);
  assert.equal(await json(join(jobdir, "shutdown.json")), undefined);
});

test("recovery refuses live supervisors and missing execution evidence", async (t) => {
  const { scope, job, jobdir } = await jobFixture(t);
  const identity = await processIdentity();
  await atomic(join(jobdir, "worker.json"), { pid: process.pid, identity });
  await assert.rejects(recoverTask(scope, job.id), /proven dead/);
  await atomic(join(jobdir, "worker.json"), { pid: process.pid, identity: { ...identity, start: "dead" } });
  await assert.rejects(recoverTask(scope, job.id), /No trustworthy/);
  assert.equal(await json(join(jobdir, "shutdown.json")), undefined);
});

test("explicit recovery reaps only saved proven child ownership and preserves the failure report", async (t) => {
  const { scope, job, jobdir } = await jobFixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  const exited = once(child, "exit");
  t.after(() => child.kill("SIGKILL"));
  const tree = new ProcessTree(child.pid);
  await tree.refresh();
  const boot = await bootIdentity();
  await atomic(join(jobdir, "worker.json"), { identity: { ...await processIdentity(), start: "dead" } });
  await atomic(join(jobdir, "execution.json"), { boot, tree: await tree.evidence() });
  await atomic(join(jobdir, "done.json"), { state: "failed", report: "partial evidence", cleanupError: "crashed" });
  await atomic(join(jobdir, "active.json"), {});
  assert.deepEqual(await recoverTask(scope, job.id), { id: job.id, recovered: true });
  await exited;
  assert.equal((await json(join(jobdir, "shutdown.json"))).verified, true);
  assert.equal(await json(join(jobdir, "active.json")), undefined);
  assert.equal((await json(join(jobdir, "done.json"))).report, "partial evidence");
});

test("new boot proves old execution ended without trusting reused numeric PIDs", async (t) => {
  const { scope, job, jobdir } = await jobFixture(t);
  await atomic(join(jobdir, "worker.json"), { identity: { ...await processIdentity(), boot: "old boot" } });
  await recoverTask(scope, job.id);
  assert.equal((await json(join(jobdir, "shutdown.json"))).verified, true);
  assert.equal((await json(join(jobdir, "done.json"))).state, "failed");
});

test("already admitted runners are fenced after their parent dies and ownership transfers", async (t) => {
  const { scope } = await fixture(t);
  const parent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => parent.kill("SIGKILL"));
  const stale = { ...scope, ownerPid: parent.pid };
  await claimScope(stale);
  const exit = once(parent, "exit"); parent.kill("SIGTERM"); await exit;
  await claimScope(scope);
  let mutated = false;
  await assert.rejects(locked(stale, async () => { mutated = true; }), /fenced/);
  assert.equal(mutated, false);
  assert.equal(await locked(scope, async () => "current"), "current");
});

test("orphan recovery merges late detached descendants from Pi's shutdown handoff", async (t) => {
  const { scope, job, jobdir } = await jobFixture(t);
  const root = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process');process.on('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});process.send(child.pid);});setInterval(()=>{},1000);`], { stdio: ["ignore", "ignore", "ignore", "ipc"], detached: true });
  t.after(() => root.kill("SIGKILL"));
  const tree = new ProcessTree(root.pid); await tree.refresh();
  await atomic(join(jobdir, "execution.json"), { boot: await bootIdentity(), tree: await tree.evidence() });
  const message = once(root, "message"); root.send("spawn"); const [descendant] = await message;
  t.after(() => { try { process.kill(descendant, "SIGKILL"); } catch {} });
  await atomic(join(jobdir, "processes.json"), await snapshotProcesses());
  const exit = once(root, "exit"); root.kill("SIGKILL"); await exit;
  await atomic(join(jobdir, "worker.json"), { identity: { ...await processIdentity(), start: "dead" } });
  await recoverTask(scope, job.id);
  assert.ok(!(await snapshotProcesses()).some((entry) => entry.pid === descendant && !/^[ZX]/.test(entry.state)));
  assert.equal((await json(join(jobdir, "shutdown.json"))).verified, true);
});

test("model presets are explicit, validated and resolved into immutable launch tasks", async (t) => {
  const { scope, directory } = await fixture(t);
  await configurePresets(scope, { review: { model: "provider/model", thinking: "high", maxTokens: 1000, maxCost: 1 } });
  const [task] = await resolveTasks(scope, [{ name: "review", prompt: "inspect", preset: "review" }], {}, directory);
  assert.equal(task.model, "provider/model"); assert.equal(task.thinking, "high"); assert.equal(task.maxTokens, 1000);
  const [override] = await resolveTasks(scope, [{ name: "override", prompt: "inspect", preset: "review", model: "other/model" }], {}, directory);
  assert.equal(override.thinking, undefined);
  await assert.rejects(resolveTasks(scope, [{ name: "bad", prompt: "inspect", preset: "missing" }], {}, directory), /Unknown model preset/);
  await assert.rejects(configurePresets(scope, { bad: { model: "p/m", maxTokens: -1 } }), /maxTokens/);
  await assert.rejects(configurePresets(scope, { bad: { model: "p/m", extensions: [] } }), /Presets require/);
});

test("admission serializes explicit intent, settings and duplicate retries; aborted contenders never resolve", async (t) => {
  const { scope, directory } = await fixture(t);
  await claimScope(scope);
  await configurePresets(scope, { review: { model: "preset/first", thinking: "low" } });
  const intent = [{ name: "inherited", prompt: "inspect" }, { name: "preset", prompt: "inspect", preset: "review" }];
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const resolving = new Promise((resolve) => { entered = resolve; });
  const initial = spawnTasks(scope, { intent, resolve: async (input) => {
    entered(); await gate;
    return resolveTasks(scope, input, { PI_PROVIDER: "first", PI_MODEL: "model", PI_REASONING_LEVEL: "high", PI_HERDR_PARENT_GROUP: "original-group" }, directory);
  } }, "stable");
  await resolving;
  const retry = { intent: intent.map((task) => Object.fromEntries(Object.entries(task).reverse())), resolve: async () => assert.fail("Retry must not resolve defaults or presets") };
  const duplicate = spawnTasks(scope, retry, "stable");
  const controller = new AbortController();
  const aborted = assert.rejects(spawnTasks(scope, retry, "stable", controller.signal), /abort/i);
  controller.abort(); await aborted;
  release();
  const first = await initial;
  assert.deepEqual(await duplicate, JSON.parse(JSON.stringify(first)));
  assert.equal(first[0].task.group, "original-group");
  assert.equal(first[0].task.model, "first/model");
  assert.equal(first[0].task.thinking, "high");
  assert.equal(first[0].task.cwd, directory);
  const path = join(scope.root, "requests", `${createHash("sha256").update("stable").digest("hex")}.json`);
  const record = await json(path);
  assert.deepEqual(record.intent, intent);
  assert.deepEqual(record.tasks, JSON.parse(JSON.stringify(first.map((job) => job.task))));
  assert.equal(record.pi, process.execPath);
  await configurePresets(scope, {});
  const changed = { intent, resolve: (input) => resolveTasks(scope, input, {
    PI_PROVIDER: "changed", PI_MODEL: "other", PI_REASONING_LEVEL: "off", PI_HERDR_PARENT_GROUP: "changed-group",
  }, "/missing/cwd") };
  assert.deepEqual(await spawnTasks(scope, changed, "stable"), JSON.parse(JSON.stringify(first)));
  const stale = { ...scope, authority: { ...scope.authority, token: "stale" } };
  await assert.rejects(spawnTasks(stale, retry, "stable"), /fenced/);
  for (const change of [{ group: "inherit" }, { model: "first/model" }, { thinking: "high" }, { cwd: directory }, { prompt: "different" }]) {
    await assert.rejects(spawnTasks(scope, { ...retry, intent: [{ ...intent[0], ...change }, intent[1]] }, "stable"), /different tasks/);
  }
  assert.equal((await jobs(scope)).length, 2);
});

test("cancellation after initial intent publication leaves a non-replayable record and original snapshot", async (t) => {
  const { scope, directory } = await fixture(t);
  const intent = [{ name: "cancelled", prompt: "inspect" }];
  const controller = new AbortController();
  const path = join(scope.root, "requests", `${createHash("sha256").update("cancel").digest("hex")}.json`);
  const rejected = assert.rejects(spawnTasks(scope, { intent, resolve: (input) => resolveTasks(scope, input, {}, directory) }, "cancel", controller.signal), /abort/i);
  for (let i = 0; i < 500 && !await json(path); i++) await delay(1);
  const admitted = await json(path);
  assert.equal(admitted.state, "starting");
  assert.deepEqual(admitted.intent, intent);
  assert.equal(admitted.tasks[0].cwd, directory);
  controller.abort();
  await rejected;
  assert.equal((await json(path)).state, "failed");
  await assert.rejects(spawnTasks(scope, { intent, resolve: async () => assert.fail("Failed launches must not resolve or relaunch") }, "cancel"), /failed.*not be replayed/);
  assert.equal((await json(join(directory, "panes.json"))).panes.length, 1);
});
