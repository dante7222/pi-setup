import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { atomic } from "../extensions/herdr-subagents/core.ts";
import { RpcControl } from "../extensions/herdr-subagents/rpc-control.ts";

async function fixture(t, handle = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-rpc-control-"));
  await mkdir(join(directory, "control"));
  const records = [];
  const failures = [];
  let rpc;
  const input = new Writable({ write(chunk, _encoding, callback) {
    const record = JSON.parse(String(chunk));
    records.push(record);
    callback();
    queueMicrotask(() => handle(record, rpc));
  } });
  rpc = new RpcControl(directory, input, (error) => failures.push(String(error)));
  t.after(async () => { await rpc.finish(); await rm(directory, { recursive: true, force: true }); });
  const request = async (id, kind = "steer", message = "literal\n\u2028\u2029") => {
    const hash = createHash("sha256").update(id).digest("hex");
    const base = join(directory, "control", hash);
    await atomic(`${base}.json`, { id, kind, message });
    return base;
  };
  return { directory, rpc, input, records, failures, request };
}

function respond(rpc, command, data = {}, success = true) {
  rpc.event({ type: "response", id: command.id, command: command.type, success, ...(success ? { data } : { error: "blocked by extension" }) });
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail("condition did not complete");
}

async function reply(base) {
  let value;
  await until(async () => {
    value = await readFile(`${base}.reply.json`, "utf8").then(JSON.parse).catch(() => undefined);
    return value;
  });
  return value;
}

test("RPC initial prompt preserves literal JSONL and closes only after final settlement/state", async (t) => {
  const f = await fixture(t, (command, rpc) => {
    respond(rpc, command, command.type === "prompt" ? { disposition: "started" } : { pendingMessageCount: 0, isStreaming: false, isCompacting: false });
  });
  await f.rpc.start("@literal\n\u2028\u2029");
  assert.equal(f.records[0].message, "@literal\n\u2028\u2029");
  f.rpc.event({ type: "agent_start" });
  f.rpc.event({ type: "agent_end" });
  assert.equal(f.input.writableEnded, false);
  f.rpc.event({ type: "agent_settled" });
  await until(() => f.input.writableEnded);
  assert.deepEqual(f.records.map((record) => record.type), ["prompt", "get_state"]);
  assert.deepEqual(f.failures, []);
});

for (const disposition of ["handled", "rejected"]) test(`RPC ${disposition} initial prompt resolves without waiting for settlement`, async (t) => {
  const f = await fixture(t, (command, rpc) => respond(rpc, command, { disposition }, disposition !== "rejected"));
  await assert.rejects(f.rpc.start("/extension-command"), disposition === "handled" ? /handled without starting/ : /rejected.*blocked/);
});

test("mailbox attempts precede transmission, correlate out-of-order responses, and never replay", async (t) => {
  const f = await fixture(t);
  const a = await f.request("a", "steer");
  const b = await f.request("b", "follow_up");
  await f.rpc.poll();
  await until(() => f.records.length === 2);
  for (const base of [a, b]) assert.ok(JSON.parse(await readFile(`${base}.attempted.json`, "utf8")).attemptedAt);
  const steer = f.records.find((record) => record.type === "steer");
  const followUp = f.records.find((record) => record.type === "follow_up");
  respond(f.rpc, followUp, { disposition: "handled" });
  respond(f.rpc, steer, {}, false);
  assert.deepEqual(await reply(a), { state: "rejected", error: "blocked by extension" });
  assert.deepEqual(await reply(b), { state: "accepted", disposition: "handled" });
  await f.rpc.poll();
  assert.equal(f.records.length, 2);
});

test("attempted command after supervisor loss is uncertain and is never replayed", async (t) => {
  const f = await fixture(t);
  const base = await f.request("old-attempt");
  await atomic(`${base}.attempted.json`, { id: "old-attempt" });
  await f.rpc.poll();
  assert.equal((await reply(base)).state, "uncertain");
  assert.equal(f.records.length, 0);
});

test("settlement rejects unsent mailbox commands clearly", async (t) => {
  const f = await fixture(t, (command, rpc) => respond(rpc, command, command.type === "prompt" ? { disposition: "started" } : { pendingMessageCount: 0 }));
  await f.rpc.start("task");
  const base = await f.request("before-settlement");
  f.rpc.event({ type: "agent_settled" });
  assert.deepEqual(await reply(base), { state: "rejected", error: "Agent settled; control was not submitted before settlement." });
  await until(() => f.input.writableEnded);
  assert.ok(!f.records.some((record) => record.type === "steer"));
});

test("settlement waits for in-flight replies and reports stranded queued controls", async (t) => {
  const f = await fixture(t, (command, rpc) => {
    if (command.type === "prompt") respond(rpc, command, { disposition: "started" });
    if (command.type === "get_state") respond(rpc, command, { pendingMessageCount: 1 });
  });
  await f.rpc.start("task");
  const base = await f.request("racing-control");
  await f.rpc.poll();
  await until(() => f.records.some((record) => record.type === "steer"));
  f.rpc.event({ type: "agent_settled" });
  await delay(30);
  assert.equal(f.input.writableEnded, false);
  assert.ok(!f.records.some((record) => record.type === "get_state"));
  respond(f.rpc, f.records.find((record) => record.type === "steer"), { disposition: "queued" });
  await until(() => f.failures.length);
  assert.equal((await reply(base)).state, "uncertain");
  assert.match(f.failures[0], /queued controls still pending/);
});

test("cancellation clears queue before abort, closes stdin, and preserves uncertainty", async (t) => {
  const f = await fixture(t, (command, rpc) => respond(rpc, command, { disposition: "queued" }));
  const base = await f.request("cancelled");
  await f.rpc.poll();
  assert.equal((await reply(base)).state, "accepted");
  await f.rpc.abort();
  await f.rpc.finish("Cancelled by parent.");
  assert.deepEqual(f.records.map((record) => record.type), ["steer", "clear_queue", "abort"]);
  assert.equal(f.input.writableEnded, true);
  assert.equal((await reply(base)).state, "uncertain");
});

test("extension dialogs are cancelled noninteractively; notifications need no reply", async (t) => {
  const f = await fixture(t, (command, rpc) => { if (command.type === "get_state") respond(rpc, command, {}); });
  for (const method of ["select", "confirm", "input", "editor", "notify", "setTitle"]) f.rpc.event({ type: "extension_ui_request", id: method, method });
  await until(() => f.records.length === 5);
  assert.deepEqual(f.records.filter((record) => record.type === "extension_ui_response"), ["select", "confirm", "input", "editor"].map((id) => ({ type: "extension_ui_response", id, cancelled: true })));
  assert.equal(f.records.filter((record) => record.type === "get_state").length, 1);
  assert.deepEqual(f.failures, []);
});

test("unsupported startup dialogs fail promptly when Pi has not attached its stdin reader", async (t) => {
  const f = await fixture(t);
  f.rpc.event({ type: "extension_ui_request", id: "startup", method: "confirm" });
  await until(() => f.failures.length);
  assert.match(f.failures[0], /startup dialog.*stdin reader/);
});

test("malformed mailbox requests are rejected without terminating the worker", async (t) => {
  const f = await fixture(t);
  const base = await f.request("invalid");
  await atomic(`${base}.json`, { id: "wrong-hash", kind: "steer", message: "x" });
  await f.rpc.poll();
  assert.equal((await reply(base)).state, "rejected");
  assert.deepEqual(f.failures, []);
  assert.deepEqual(f.records, []);
});
