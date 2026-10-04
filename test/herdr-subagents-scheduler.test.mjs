import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { atomic, json, locked } from "../extensions/herdr-subagents/core.ts";
import { processIdentity } from "../extensions/herdr-subagents/identity.ts";
import { acquireSlot, configure, releaseSlot, settings } from "../extensions/herdr-subagents/scheduler.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-scheduler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = { root, pane: "main", workspace: "test", env: process.env };
  const add = async (number, created = number) => {
    const id = number.toString(16).padStart(12, "0");
    const directory = join(root, id);
    await mkdir(directory, { mode: 0o700 });
    await atomic(join(directory, "job.json"), { id, created, cursor: 0, task: { name: `job-${number}` } });
    return directory;
  };
  return { scope, add };
}

async function waitFor(path) {
  for (let i = 0; i < 300; i++) {
    if (await stat(path).catch(() => undefined)) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function finish(directory) {
  await atomic(join(directory, "shutdown.json"), { verified: true });
  await releaseSlot(directory);
}

function controller(t) {
  const result = new AbortController();
  t.after(() => result.abort());
  return result;
}

test("scheduler defaults to four, persists private settings, validates writes and reads", async (t) => {
  const { scope } = await fixture(t);
  assert.deepEqual(await settings(scope), { concurrency: 4 });
  for (const value of [0, 17, -1, 1.5, NaN, Infinity, "4", null, undefined]) {
    await assert.rejects(configure(scope, value), /integer in 1\.\.16/);
  }
  assert.deepEqual(await configure(scope, 16), { concurrency: 16 });
  assert.deepEqual(await settings(scope), { concurrency: 16 });
  assert.equal((await stat(join(scope.root, "settings.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(scope.root)).mode & 0o777, 0o700);
  assert.deepEqual(await configure(scope, 1), { concurrency: 1 });
  const other = await fixture(t);
  assert.deepEqual(await settings(other.scope), { concurrency: 4 });
  for (const value of [{ concurrency: 0 }, { concurrency: "3" }, {}, null]) {
    await atomic(join(scope.root, "settings.json"), value);
    await assert.rejects(settings(scope), /integer in 1\.\.16/);
  }
  await writeFile(join(scope.root, "settings.json"), "invalid JSON");
  await assert.rejects(settings(scope), SyntaxError);
});

test("four active slots block a fifth until verified cleanup, independently of open jobs", { timeout: 15000 }, async (t) => {
  const { scope, add } = await fixture(t);
  const signal = controller(t).signal;
  const directories = [];
  // Scheduler capacity is not the open-job cap: even this synthetic backlog is valid.
  for (let i = 1; i <= 20; i++) directories.push(await add(i));
  for (const directory of directories.slice(0, 4)) await acquireSlot(directory, signal);
  let admitted = false;
  const next = acquireSlot(directories[4], signal).then(() => { admitted = true; });
  await waitFor(join(directories[4], "waiting.json"));
  await releaseSlot(directories[0]);
  await delay(150);
  assert.equal(admitted, false, "cleanup without verified shutdown must retain its slot");
  assert.ok(await json(join(directories[0], "active.json")));
  await finish(directories[0]);
  await next;
  assert.equal(admitted, true);
  assert.equal((await stat(join(directories[4], "active.json"))).mode & 0o777, 0o600);
  assert.equal(await json(join(directories[4], "waiting.json")), undefined);
  for (const directory of directories.slice(1, 5)) await finish(directory);
  assert.equal((await readdir(scope.root)).filter((name) => /^[a-f0-9]{12}$/.test(name)).length, 20);
});

test("parallel supervisor processes never exceed configured capacity", { timeout: 30000 }, async (t) => {
  const { scope, add } = await fixture(t);
  await configure(scope, 3);
  const scheduler = new URL("../extensions/herdr-subagents/scheduler.ts", import.meta.url).href;
  const core = new URL("../extensions/herdr-subagents/core.ts", import.meta.url).href;
  const events = join(scope.root, "events.jsonl");
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); });
  const attempts = [];
  for (let i = 1; i <= 10; i++) {
    const directory = await add(i);
    const program = `import {acquireSlot,releaseSlot} from ${JSON.stringify(scheduler)};
import {atomic} from ${JSON.stringify(core)};
import {appendFile} from 'node:fs/promises';
const directory=${JSON.stringify(directory)}, events=${JSON.stringify(events)};
await acquireSlot(directory,new AbortController().signal);
await appendFile(events,JSON.stringify({event:'start',id:${i}})+'\\n');
await new Promise(r=>setTimeout(r,120));
await appendFile(events,JSON.stringify({event:'end',id:${i}})+'\\n');
await atomic(directory+'/shutdown.json',{verified:true});
await releaseSlot(directory);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: "pipe" });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    attempts.push(once(child, "close").then(([code]) => assert.equal(code, 0, stderr)));
  }
  await Promise.all(attempts);
  const active = new Set();
  let peak = 0;
  const entries = (await readFile(events, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const entry of entries) {
    if (entry.event === "start") {
      assert.equal(active.has(entry.id), false);
      active.add(entry.id);
      peak = Math.max(peak, active.size);
      assert.ok(active.size <= 3, `capacity exceeded: ${JSON.stringify(entries)}`);
    } else assert.equal(active.delete(entry.id), true);
  }
  assert.equal(entries.length, 20);
  assert.equal(active.size, 0);
  assert.ok(peak > 1, "configured concurrency should allow actual overlap");
});

test("registered waiters use created/id FIFO order", { timeout: 15000 }, async (t) => {
  const { scope, add } = await fixture(t);
  await configure(scope, 1);
  const signal = controller(t).signal;
  const blocker = await add(1);
  await acquireSlot(blocker, signal);
  const later = await add(2, 30);
  const tiedSecond = await add(4, 10);
  const first = await add(3, 10);
  const order = [];
  const waiting = [];
  for (const directory of [later, tiedSecond, first]) {
    waiting.push(acquireSlot(directory, signal).then(async () => { order.push(directory); await finish(directory); }));
    await waitFor(join(directory, "waiting.json"));
  }
  await finish(blocker);
  await Promise.all(waiting);
  assert.deepEqual(order, [first, tiedSecond, later]);
});

test("queued abort is interruptible even while parent holds the scope lock", { timeout: 10000 }, async (t) => {
  const { scope, add } = await fixture(t);
  await configure(scope, 1);
  const first = await add(1);
  await acquireSlot(first, controller(t).signal);
  const queued = await add(2);
  const abort = controller(t);
  const rejected = assert.rejects(acquireSlot(queued, abort.signal), /abort/i);
  await waitFor(join(queued, "waiting.json"));
  await locked(scope, async () => {
    abort.abort();
    await rejected;
    assert.equal(await json(join(queued, "active.json")), undefined);
    assert.equal(await json(join(queued, "waiting.json")), undefined);
  });
  await finish(first);
  const third = await add(3);
  await acquireSlot(third, controller(t).signal);
  await finish(third);
});

test("already-aborted requests cannot publish waiting or active markers", async (t) => {
  const { add } = await fixture(t);
  const directory = await add(1);
  const abort = controller(t);
  abort.abort();
  await assert.rejects(acquireSlot(directory, abort.signal), /abort/i);
  assert.equal(await json(join(directory, "waiting.json")), undefined);
  assert.equal(await json(join(directory, "active.json")), undefined);
});

test("dead or reused supervisor identity and completion alone retain unknown descendant slots", { timeout: 15000 }, async (t) => {
  const { scope, add } = await fixture(t);
  await configure(scope, 1);
  const stale = await add(1);
  const identity = { ...await processIdentity(), start: "previous supervisor" };
  await atomic(join(stale, "active.json"), { token: "stale-unique-claim", identity });
  await atomic(join(stale, "worker.json"), { pid: process.pid, identity });
  await atomic(join(stale, "done.json"), { state: "failed", report: "synthetic completion" });
  await atomic(join(stale, "shutdown.json"), { verified: false });
  const next = await add(2);
  let admitted = false;
  const pending = acquireSlot(next, controller(t).signal).then(() => { admitted = true; });
  await waitFor(join(next, "waiting.json"));
  await releaseSlot(stale);
  await delay(200);
  assert.equal(admitted, false);
  assert.equal((await json(join(stale, "active.json"))).token, "stale-unique-claim");
  await atomic(join(stale, "shutdown.json"), { verified: true });
  await pending;
  assert.equal(admitted, true, "verified shutdown permits conservative capacity recovery");
  await finish(next);
});

test("unversioned active markers without job metadata still consume capacity", { timeout: 10000 }, async (t) => {
  const { scope, add } = await fixture(t);
  await configure(scope, 1);
  const unknown = await add(1);
  await rm(join(unknown, "job.json"));
  await atomic(join(unknown, "active.json"), {});
  await atomic(join(unknown, "shutdown.json"), { verified: "true" });
  const next = await add(2);
  const abort = controller(t);
  const pending = assert.rejects(acquireSlot(next, abort.signal), /abort/i);
  await waitFor(join(next, "waiting.json"));
  await delay(150);
  assert.equal(await json(join(next, "active.json")), undefined);
  abort.abort();
  await pending;
  assert.deepEqual(await json(join(unknown, "active.json")), {});
});

test("duplicate acquisition cannot overwrite or release an existing slot", async (t) => {
  const { add } = await fixture(t);
  const directory = await add(1);
  const signal = controller(t).signal;
  await acquireSlot(directory, signal);
  const marker = await json(join(directory, "active.json"));
  await assert.rejects(acquireSlot(directory, signal), /already owns an active slot/);
  assert.deepEqual(await json(join(directory, "active.json")), marker);
  await finish(directory);
  assert.equal(await json(join(directory, "active.json")), undefined);
});

test("release cannot deadlock parent cancellation and cannot erase another marker", { timeout: 10000 }, async (t) => {
  const { scope, add } = await fixture(t);
  const directory = await add(1);
  await acquireSlot(directory, controller(t).signal);
  await locked(scope, async () => {
    await finish(directory);
    assert.equal(await json(join(directory, "active.json")), undefined);
    await releaseSlot(directory);
  });
  const replaced = await add(2);
  await acquireSlot(replaced, controller(t).signal);
  const marker = { token: "different-owner", identity: await processIdentity() };
  await atomic(join(replaced, "active.json"), marker);
  await finish(replaced);
  assert.deepEqual(await json(join(replaced, "active.json")), marker);
});

test("capacity changes wake waiters and reductions do not revoke active ownership", { timeout: 15000 }, async (t) => {
  const { scope, add } = await fixture(t);
  await configure(scope, 1);
  const signal = controller(t).signal;
  const first = await add(1);
  const second = await add(2);
  const third = await add(3);
  await acquireSlot(first, signal);
  const waiting = acquireSlot(second, signal);
  await waitFor(join(second, "waiting.json"));
  await configure(scope, 2);
  await waiting;
  await configure(scope, 1);
  let admitted = false;
  const pending = acquireSlot(third, signal).then(() => { admitted = true; });
  await waitFor(join(third, "waiting.json"));
  await finish(first);
  await delay(150);
  assert.equal(admitted, false);
  assert.ok(await json(join(second, "active.json")));
  await finish(second);
  await pending;
  await finish(third);
});

test("dead queue owners do not block FIFO, but their active markers would", { timeout: 10000 }, async (t) => {
  const { scope, add } = await fixture(t);
  await configure(scope, 1);
  const dead = await add(1);
  await atomic(join(dead, "waiting.json"), { token: "dead", created: 1, id: "000000000001", identity: { ...await processIdentity(), boot: "previous boot" } });
  const next = await add(2);
  await acquireSlot(next, controller(t).signal);
  await finish(next);
});
