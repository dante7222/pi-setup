import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { isolateHerdrEnvironment } from "./helpers/herdr-test-environment.mjs";
import { atomic, json, locked, scopeFor } from "../extensions/herdr-subagents/core.ts";
import { claimScope } from "../extensions/herdr-subagents/ownership.ts";
import { identityAlive, processIdentity } from "../extensions/herdr-subagents/identity.ts";
import {
  durableAtomic, durableDirectory, durableRequest, encodeFrame, MAX_FRAME_BYTES,
  readFrame, shutdownDurable, socketRequest, startDurable, stopDurable,
} from "../extensions/herdr-subagents/durable/transport.ts";

const cli = new URL("../skills/herdr-subagents/durable.mjs", import.meta.url);
async function eventually(fn, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!await fn()) {
    if (Date.now() >= deadline) assert.fail("Condition did not settle in time");
    await delay(100);
  }
}
async function setup(t, ownerPid = process.pid) {
  const root = await mkdtemp(join(tmpdir(), "durable-transport-"));
  let scope;
  // Both scope.env and process.env are checked by the production worker fence.
  // This is a private, faux-only parent fixture, never the invoking Pi session.
  const env = isolateHerdrEnvironment(t, {
    PI_HERDR_WORKER: "0", PI_HERDR_DURABLE_FAUX: "1",
    PI_CODING_AGENT_DIR: root, PI_SESSION_ID: randomUUID(), PI_HERDR_OWNER_PID: String(ownerPid),
    HERDR_ENV: "1", HERDR_SOCKET_PATH: join(root, "unused.sock"), HERDR_PANE_ID: "test", HERDR_WORKSPACE_ID: "test",
    HERDR_BIN_PATH: join(root, "no-herdr"), PI_HERDR_PI_BIN: join(root, "no-pi"),
  }, async () => {
    try {
      const lease = scope && await json(join(durableDirectory(scope), "lease.json"));
      if (lease && await identityAlive(lease.identity) && lease.identity.pid !== process.pid) {
        process.kill(lease.identity.pid, "SIGTERM");
        await eventually(async () => !await identityAlive(lease.identity));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  scope = scopeFor(env.PI_SESSION_ID, env);
  await claimScope(scope);
  return scope;
}
async function command(scope, args, input) {
  const child = spawn(process.execPath, [cli.pathname, ...args], { env: scope.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test("explicit opt-in, worker fence, and offline operations never start storage", async (t) => {
  const scope = await setup(t);
  await assert.rejects(startDurable(scope, false), /experimental/);
  const workerScope = { ...scope, env: { ...scope.env, PI_HERDR_WORKER: "1" } };
  const guarded = [
    (candidate) => startDurable(candidate, true),
    (candidate) => durableRequest(candidate, { action: "status" }),
    shutdownDurable, stopDurable,
  ];
  for (const operation of guarded) await assert.rejects(operation(workerScope), /Subagents/);
  process.env.PI_HERDR_WORKER = "1";
  try {
    // A parent-looking scope must not defeat the process-level recursion fence.
    for (const operation of guarded) await assert.rejects(operation(scope), /Subagents/);
  } finally { process.env.PI_HERDR_WORKER = scope.env.PI_HERDR_WORKER; }
  await assert.rejects(durableRequest(scope, { action: "status" }), /offline/);
  await shutdownDurable(scope);
  assert.equal(await json(join(durableDirectory(scope), "lease.json")), undefined);
  await stopDurable(scope);
  assert.match((await json(join(durableDirectory(scope), "parent-stop.json"))).requestId, /^parent-stop:/);
  assert.equal(await json(join(durableDirectory(scope), "lease.json")), undefined);
  assert.equal(await stat(join(durableDirectory(scope), "storage")).catch(() => undefined), undefined);
});

test("fixture restores inherited environment and removes storage after setup errors", async (t) => {
  const previous = { ...process.env };
  let root;
  await t.test("failed parent claim", async (t) => {
    await assert.rejects(setup(t, -1), /identity/);
    root = process.env.PI_CODING_AGENT_DIR;
    assert.notEqual(root, previous.PI_CODING_AGENT_DIR);
    assert.equal(process.env.PI_HERDR_WORKER, "0");
    assert.equal(process.env.PI_HERDR_DURABLE_FAUX, "1");
    for (const key of ["PI_HERDR_GROUP", "PI_HERDR_PARENT_GROUP", "PI_HERDR_JOB_DIR", "PI_HERDR_DURABLE_BOOT"]) {
      assert.equal(process.env[key], undefined);
    }
  });
  assert.deepEqual({ ...process.env }, previous);
  assert.equal(await stat(root).catch(() => undefined), undefined);
});

test("emergency Stop publication and same-parent capability do not wait behind pane cleanup", { timeout: 10000 }, async (t) => {
  const scope = await setup(t);
  await locked(scope, async () => {
    const fresh = { ...scope, authority: undefined };
    await claimScope(fresh);
    await stopDurable(fresh);
    assert.ok(await json(join(durableDirectory(scope), "parent-stop.json")));
    assert.equal(await json(join(durableDirectory(scope), "lease.json")), undefined);
  });
});

test("aborted start/shutdown cannot execute after queued admission", async (t) => {
  const scope = await setup(t);
  for (const operation of [startDurable, shutdownDurable]) {
    const controller = new AbortController();
    let result;
    await locked(scope, async () => {
      result = assert.rejects(operation === startDurable ? startDurable(scope, true, controller.signal) : shutdownDurable(scope, controller.signal), /abort/i);
      await delay(50); controller.abort();
    });
    await result;
  }
  assert.equal(await json(join(durableDirectory(scope), "lease.json")), undefined);
});

test("simultaneous CLI starts admit one detached private owner; requests and viewer use IPC", { timeout: 90_000 }, async (t) => {
  const scope = await setup(t);
  const results = await Promise.all(Array.from({ length: 3 }, () => command(scope, ["start", "--experimental"])));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const directory = durableDirectory(scope);
  const lease = await json(join(directory, "lease.json"));
  assert.equal(lease.state, "ready");
  assert.notEqual(lease.identity.pid, process.pid);
  assert.equal(await identityAlive(lease.identity), true);
  assert.ok(Buffer.byteLength(lease.socket) < 100);
  assert.equal((await stat(lease.socket)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "lease.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(lease.socket))).mode & 0o777, 0o700);
  await durableRequest(scope, { action: "status" });
  const requested = await command(scope, ["request", "-"], JSON.stringify({ action: "status" }));
  assert.equal(requested.code, 0, requested.stderr);
  assert.equal(JSON.parse(requested.stdout).backend, "pi-durable");
  assert.equal((await json(join(directory, "lease.json"))).token, lease.token);
  await assert.rejects(durableRequest(scope, { action: "not-an-action" }), /action/i);
  for (const seconds of [-1, 61, "invalid"]) {
    await assert.rejects(durableRequest(scope, { action: "wait", seconds }), /seconds must be between/i);
    assert.equal(await identityAlive(lease.identity), true, "invalid waits must not crash the owner during lock release");
    await durableRequest(scope, { action: "status" });
  }
  await assert.rejects(socketRequest(lease, { ...scope.authority, token: "stale" }, { action: "status" }, 0), /fenced/);
  const duplicate = await command({ ...scope, env: { ...scope.env, PI_HERDR_DURABLE_BOOT: lease.token } }, ["serve", directory]);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /fenced/);
  const unavailable = await durableRequest(scope, {
    action: "spawn", requestId: "not-paid", name: "not-paid", prompt: "Do not run.",
    model: { provider: "openai", modelId: "gpt-4o" }, tools: "read-only",
  });
  await eventually(async () => (await durableRequest(scope, { action: "status" })).jobs.some((job) => job.id === unavailable.id && job.status === "failed"));
  assert.match(JSON.stringify(await durableRequest(scope, { action: "read", id: unavailable.id })), /model|provider/i);
  const spawnRequest = { action: "spawn", requestId: "spawn-1", name: "reader", prompt: "Reply briefly.", model: { provider: "faux", modelId: "faux" }, tools: "read-only" };
  const created = await durableRequest(scope, spawnRequest);
  assert.ok(created && typeof created === "object");
  assert.equal(JSON.stringify(await durableRequest(scope, spawnRequest)), JSON.stringify(created));
  const snapshot = JSON.stringify(await durableRequest(scope, { action: "status" }));
  assert.match(snapshot, /reader/);
  const id = created.id ?? created.job?.id;
  assert.equal(typeof id, "string", JSON.stringify(created));
  const viewer = await command(scope, ["view", id]);
  assert.equal(viewer.code, 0, viewer.stderr);
  assert.ok(viewer.stdout.length <= 16_001);
  assert.equal((await json(join(directory, "lease.json"))).token, lease.token);
  await shutdownDurable(scope);
  await eventually(async () => !await identityAlive(lease.identity));
  await assert.rejects(durableRequest(scope, { action: "status" }), /offline/);
});

test("stale boot/start identity is recoverable; live PID alone is not ownership", { timeout: 60_000 }, async (t) => {
  const scope = await setup(t);
  await stopDurable(scope); // Creates only private control metadata.
  const directory = durableDirectory(scope);
  const identity = await processIdentity();
  await durableAtomic(join(directory, "lease.json"), {
    version: 1, token: "stale", state: "booting", identity: { ...identity, boot: "previous-boot" },
    parent: scope.authority, cwd: process.cwd(), agentDir: scope.env.PI_CODING_AGENT_DIR, socket: "/tmp/not-used",
  });
  await startDurable(scope, true);
  const lease = await json(join(directory, "lease.json"));
  assert.notEqual(lease.token, "stale");
  assert.equal((await json(join(directory, "parent-stop.json"))).completed, true, "offline cancellation must finish before startup reports ready");
  await shutdownDurable(scope);
});

test("parent death pauses the server, transfer rejects stale captured authority", { timeout: 60_000 }, async (t) => {
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => parent.kill("SIGKILL"));
  await once(parent, "spawn");
  const scope = await setup(t, parent.pid);
  await startDurable(scope, true);
  const lease = await json(join(durableDirectory(scope), "lease.json"));
  parent.kill("SIGKILL");
  await once(parent, "close");
  await eventually(async () => !await identityAlive(lease.identity));
  const replacement = { ...scope, ownerPid: process.pid, authority: undefined };
  await claimScope(replacement);
  await assert.rejects(durableRequest(scope, { action: "status" }), /fenced/);
  await assert.rejects(stopDurable(scope), /fenced/);
  await startDurable(replacement, true);
  await shutdownDurable(replacement);
});

test("dispatch rechecks authority inside admission, not only client startup", { timeout: 60_000 }, async (t) => {
  const scope = await setup(t);
  await startDurable(scope, true);
  const lease = await json(join(durableDirectory(scope), "lease.json"));
  await atomic(join(scope.root, "owner.json"), { ...scope.authority, token: "transferred", pane: "test", workspace: "test" });
  await assert.rejects(socketRequest(lease, scope.authority, { action: "resume" }, 0), /fenced|closed|ECONN/);
  await eventually(async () => !await identityAlive(lease.identity));
});

test("reopen/status/read/view stay paused; offline parent Stop fences work until cancellation completes", { timeout: 90_000 }, async (t) => {
  const scope = await setup(t);
  const directory = durableDirectory(scope);
  await startDurable(scope, true);
  const child = await durableRequest(scope, {
    action: "spawn", requestId: "slow-1", name: "slow", prompt: "Stay pending.",
    model: { provider: "faux", modelId: "slow" }, tools: "read-only",
  });
  let lease = await json(join(directory, "lease.json"));
  await shutdownDurable(scope);
  await eventually(async () => !await identityAlive(lease.identity));
  const reopened = await startDurable(scope, true);
  assert.equal(reopened.scheduling, "paused");
  assert.equal(reopened.jobs[0].reportReady, false);
  await durableRequest(scope, { action: "read", id: child.id });
  const viewed = await command(scope, ["view", child.id]);
  assert.equal(viewed.code, 0, viewed.stderr);
  const observed = await durableRequest(scope, { action: "wait", seconds: 0 });
  assert.equal(observed.scheduling, "paused");
  assert.equal(observed.jobs[0].reportReady, false);
  await durableRequest(scope, { action: "resume" });
  assert.equal((await durableRequest(scope, { action: "status" })).scheduling, "running");
  lease = await json(join(directory, "lease.json"));
  await shutdownDurable(scope);
  await eventually(async () => !await identityAlive(lease.identity));
  await stopDurable(scope);
  assert.ok(await json(join(directory, "parent-stop.json")));
  const cancelled = await startDurable(scope, true);
  assert.equal(cancelled.jobs[0].status, "cancelled");
  assert.equal(cancelled.scheduling, "paused");
  assert.equal((await json(join(directory, "parent-stop.json"))).completed, true);
  await shutdownDurable(scope);
});

test("live durable cancellation bypasses a scope lock held by ordinary pane cleanup", { timeout: 30000 }, async (t) => {
  const scope = await setup(t);
  await startDurable(scope, true);
  await durableRequest(scope, { action: "spawn", requestId: "blocked-stop", name: "blocked-stop", prompt: "Stay pending", model: { provider: "faux", modelId: "slow" } });
  await locked(scope, async () => {
    const beginning = Date.now();
    await stopDurable(scope);
    assert.ok(Date.now() - beginning < 5000, "Durable cancellation waited for ordinary cleanup");
  });
  assert.equal((await durableRequest(scope, { action: "status" })).liveJobs, 0);
  await shutdownDurable(scope);
});

test("completed Stop fences queued socket and client mutations, even disconnected clients and after restart", { timeout: 60000 }, async (t) => {
  const scope = await setup(t);
  await startDurable(scope, true);
  const source = await durableRequest(scope, { action: "spawn", requestId: "source", name: "source", prompt: "Stay pending", model: { provider: "faux", modelId: "slow" } });
  const directory = durableDirectory(scope);
  const lease = await json(join(directory, "lease.json"));
  const requests = [
    { action: "spawn", requestId: "socket-queued", name: "socket-queued", prompt: "Must not run", model: { provider: "faux", modelId: "slow" } },
    { action: "send", id: source.id, requestId: "queued-send", message: "Must not run", kind: "follow_up" },
    { action: "resume" },
  ];
  const results = [];
  await locked(scope, async () => {
    const controller = new AbortController();
    for (const [index, request] of requests.entries()) {
      results.push(assert.rejects(socketRequest(lease, scope.authority, request, 0, index === 0 ? controller.signal : undefined), /fenced|aborted/i));
    }
    results.push(assert.rejects(durableRequest(scope, { ...requests[0], requestId: "client-queued", name: "client-queued" }), /fenced/i));
    // All three server calls AND the client-side call must be waiting for the
    // held scope lock. No timing-only assumption that the request arrived.
    await eventually(async () => (await readdir(join(scope.root, "locks"))).filter((name) => name.endsWith(".json")).length >= 5);
    controller.abort();
    await stopDurable(scope);
    const stop = await json(join(directory, "parent-stop.json"));
    assert.equal(stop.completed, true);
    assert.equal(stop.generation, 1);
  });
  await Promise.all(results);
  const snapshot = await durableRequest(scope, { action: "status" });
  assert.equal(snapshot.liveJobs, 0);
  assert.equal(snapshot.total, 1, "pre-Stop submissions must never be admitted afterward");
  await shutdownDurable(scope);
  await eventually(async () => !await identityAlive(lease.identity));
  await startDurable(scope, true);
  const reopened = await json(join(directory, "lease.json"));
  await assert.rejects(socketRequest(reopened, scope.authority, requests[0], 0), /fenced/i);
  await assert.rejects(durableRequest(scope, { action: "spawn" }), /requestId|model|field|action|object/i);
  // A fresh explicit request samples the retained generation and remains usable.
  const fresh = await durableRequest(scope, { ...requests[0], requestId: "fresh", name: "fresh" });
  assert.equal(typeof fresh.id, "string");
  await stopDurable(scope);
  assert.equal((await json(join(directory, "parent-stop.json"))).generation, 2);
  await shutdownDurable(scope);
});

test("long polling does not hold admission against intentional parent Stop", { timeout: 60_000 }, async (t) => {
  const scope = await setup(t);
  await startDurable(scope, true);
  await durableRequest(scope, {
    action: "spawn", requestId: "slow-stop", name: "slow", prompt: "Stay pending.",
    model: { provider: "faux", modelId: "slow" }, tools: "read-only",
  });
  const controller = new AbortController();
  const waiting = durableRequest(scope, { action: "wait", seconds: 60 }, controller.signal);
  waiting.catch(() => {});
  await delay(200);
  const start = Date.now();
  await stopDurable(scope);
  assert.ok(Date.now() - start < 5000, "Stop waited behind the long poll");
  controller.abort();
  await waiting.catch(() => {});
  await eventually(async () => (await durableRequest(scope, { action: "status" })).liveJobs === 0);
  await shutdownDurable(scope);
});

test("framing is bounded, fragmented-safe, single-request and deadline-limited", async (t) => {
  const directory = await mkdtemp("/tmp/pi-hd-test-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer({ allowHalfOpen: true });
  await new Promise((resolve) => server.listen(join(directory, "ipc"), resolve));
  t.after(() => server.close());
  async function receive(parts, timeout = 500) {
    const connected = once(server, "connection");
    const socket = createConnection({ path: join(directory, "ipc"), allowHalfOpen: true });
    socket.on("error", () => {});
    const [peer] = await connected;
    peer.on("error", () => {});
    const result = readFrame(peer, timeout);
    result.catch(() => {});
    for (const part of parts) { socket.write(part); await delay(5); }
    socket.end();
    try { return await result; } finally { socket.destroy(); peer.destroy(); }
  }
  const frame = encodeFrame({ message: "héllo" });
  assert.deepEqual(await receive([frame.subarray(0, 1), frame.subarray(1, 3), frame.subarray(3)]), { message: "héllo" });
  await assert.rejects(receive([frame, frame]), /framing/);
  await assert.rejects(receive([frame.subarray(0, frame.length - 1)]), /framing/);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  await assert.rejects(receive([oversized.subarray(0, 2), oversized.subarray(2)]), /too large/);
  assert.throws(() => encodeFrame("x".repeat(MAX_FRAME_BYTES)), /too large/);
  await assert.rejects(receive([Buffer.from([0, 0, 0, 1, 33])]), /JSON|Unexpected/);
  const connected = once(server, "connection");
  const socket = createConnection(join(directory, "ipc"));
  const [peer] = await connected;
  await assert.rejects(readFrame(peer, 20), /timed out/);
  socket.destroy();
  const abortedConnection = once(server, "connection");
  const abortedSocket = createConnection(join(directory, "ipc"));
  const [abortedPeer] = await abortedConnection;
  const controller = new AbortController();
  const abortedRead = readFrame(abortedPeer, 1000, controller.signal);
  controller.abort();
  await assert.rejects(abortedRead, /aborted/);
  abortedSocket.destroy();
});
