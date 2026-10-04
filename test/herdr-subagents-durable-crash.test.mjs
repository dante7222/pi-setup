import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openCoordinator } from "../extensions/herdr-subagents/durable/engine.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { json, scopeFor } from "../extensions/herdr-subagents/core.ts";
import { claimScope } from "../extensions/herdr-subagents/ownership.ts";
import { identityAlive } from "../extensions/herdr-subagents/identity.ts";
import { durableDirectory, durableRequest, shutdownDurable, startDurable, stopDurable } from "../extensions/herdr-subagents/durable/transport.ts";

async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await delay(40); } while (Date.now() < deadline);
  throw new Error("Timed out waiting for durable crash recovery");
}

test("actual durable Bash cannot outlive SIGKILL and successful recovered cancellation", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-shell-core-crash-"));
  const fixture = new URL("./fixtures/durable-engine-shell-actor.mjs", import.meta.url);
  const actor = spawn(process.execPath, [fixture.pathname, directory], { stdio: "ignore" });
  const exit = once(actor, "exit");
  let engine;
  t.after(async () => {
    actor.kill("SIGKILL"); await exit;
    await engine?.close();
    await rm(directory, { recursive: true, force: true });
  });
  await until(() => access(join(directory, "ready")).then(() => true, () => false));
  const job = await json(join(directory, "job-id.json"));
  actor.kill("SIGKILL"); await exit;
  const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider); faux.setResponses([]);
  engine = await openCoordinator(directory, models, directory);
  await engine.dispatch({ action: "cancel", id: "all", requestId: "cancel-after-crash" });
  const report = await engine.dispatch({ action: "read", id: job.id });
  assert.equal(report.outcome, "cancelled");
  for (const id of await readdir(join(directory, "executions"))) assert.equal((await json(join(directory, "executions", id, "shutdown.json"))).verified, true);
  await delay(3200);
  await assert.rejects(access(join(directory, "after")), /ENOENT/);
  assert.equal(faux.state.callCount, 0);
});

test("SIGKILL coordinator recovery stays paused, deduplicates admission and applies offline Stop before replay", { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-hard-crash-"));
  const prior = process.env.PI_HERDR_WORKER;
  process.env.PI_HERDR_WORKER = "";
  const scope = scopeFor("hard-crash", {
    ...process.env, PI_HERDR_WORKER: "", PI_HERDR_DURABLE_FAUX: "1", PI_CODING_AGENT_DIR: directory,
    PI_HERDR_OWNER_PID: String(process.pid), HERDR_ENV: "1", HERDR_SOCKET_PATH: "fake", HERDR_PANE_ID: "parent", HERDR_WORKSPACE_ID: "test",
  });
  const path = join(durableDirectory(scope), "lease.json");
  t.after(async () => {
    try {
      await shutdownDurable(scope).catch(() => {});
      const lease = await json(path);
      if (lease) {
        await until(async () => !await identityAlive(lease.identity), 5000).catch(async () => {
          if (await identityAlive(lease.identity)) process.kill(lease.identity.pid, "SIGKILL");
        });
        if (/^\/tmp\/pi-hd-[A-Za-z0-9]+\/ipc$/.test(lease.socket)) await rm(dirname(lease.socket), { recursive: true, force: true });
      }
      await rm(directory, { recursive: true, force: true });
    } finally { if (prior === undefined) delete process.env.PI_HERDR_WORKER; else process.env.PI_HERDR_WORKER = prior; }
  });
  await claimScope(scope);
  await startDurable(scope, true);
  const request = { action: "spawn", requestId: "crash-task", name: "slow", prompt: "Faux only", model: { provider: "faux", modelId: "slow" } };
  const started = await durableRequest(scope, request);
  await until(async () => (await durableRequest(scope, { action: "status" })).taskGraph.total > 0);
  await delay(200);
  const firstLease = await json(path);
  assert.ok(await identityAlive(firstLease.identity));
  process.kill(firstLease.identity.pid, "SIGKILL");
  await until(async () => !await identityAlive(firstLease.identity));

  const reopened = await startDurable(scope, true);
  assert.equal(reopened.scheduling, "paused");
  assert.equal(reopened.recoveryRequired, true);
  assert.equal(reopened.jobs[0].id, started.id);
  assert.deepEqual(await durableRequest(scope, request), started);
  assert.equal((await durableRequest(scope, { action: "read", id: started.id })).ready, false);
  await delay(300);
  assert.equal((await durableRequest(scope, { action: "status" })).scheduling, "paused");

  const secondLease = await json(path);
  process.kill(secondLease.identity.pid, "SIGKILL");
  await until(async () => !await identityAlive(secondLease.identity));
  await stopDurable(scope);
  assert.ok(await json(join(durableDirectory(scope), "parent-stop.json")));
  await startDurable(scope, true);
  // Recovered cancellation may need scheduler abort handlers, but must never
  // restart the slow faux generation or require its thirty-second completion.
  await durableRequest(scope, { action: "resume" });
  const report = await until(async () => {
    const page = await durableRequest(scope, { action: "read", id: started.id });
    return page.ready ? page : undefined;
  }, 5000);
  assert.equal(report.outcome, "cancelled");
  await durableRequest(scope, { action: "ack", receipt: report.receipt });
  await shutdownDurable(scope);
});
