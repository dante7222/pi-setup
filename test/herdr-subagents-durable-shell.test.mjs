import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createDurableEnvironment, recoverExecutions } from "../extensions/herdr-subagents/durable/environment.ts";
import { identityAlive, processIdentity } from "../extensions/herdr-subagents/identity.ts";
import { snapshotProcesses } from "../extensions/herdr-subagents/process-tree.ts";

const options = { skip: !["darwin", "linux"].includes(process.platform), timeout: 20_000 };
const fixture = fileURLToPath(new URL("./fixtures/durable-shell-actor.mjs", import.meta.url));
const ctx = BACKGROUND_CONTEXT;
const exists = async (path) => access(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
async function waitFor(check, message) {
  const deadline = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < deadline, message); await delay(20); }
}
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "durable-shell-test-"));
  t.after(async () => { await recoverExecutions(dir); await rm(dir, { recursive: true, force: true }); });
  return { dir, env: createDurableEnvironment(dir, "conversation", dir) };
}
async function execution(dir) {
  const ids = await readdir(join(dir, "executions"));
  assert.equal(ids.length, 1);
  return join(dir, "executions", ids[0]);
}
async function acknowledgement(dir) {
  const path = await execution(dir);
  const ack = JSON.parse(await readFile(join(path, "shutdown.json"), "utf8"));
  assert.equal(ack.verified, true);
  const claim = JSON.parse(await readFile(join(path, "supervisor.json"), "utf8"));
  if (claim.identity) await waitFor(async () => !await identityAlive(claim.identity), "supervisor exits after acknowledgement");
  return ack;
}
async function actor(t, dir) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fixture, "coordinator", dir], { stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  await waitFor(() => exists(join(dir, "ready")), "Bash reached delayed effect boundary");
  return { child, exited };
}

test("durable shell delegates files; streams and spills complete output; forces worker env", options, async (t) => {
  const { dir, env } = await setup(t);
  assert.equal(env.id, "node:local");
  assert.equal((await env.writeFile("file", "text", ctx)).ok, true);
  assert.equal((await env.readTextFile("file", ctx)).value, "text");
  let output = "";
  const result = await env.exec('printf "worker=%s\\n" "$PI_HERDR_WORKER"; printf err >&2; printf "\\303\\251"', {
    inheritEnv: false, env: { PI_HERDR_WORKER: "0" },
    spill: { afterBytes: 2, afterLines: 2 }, onOutput: (text, context) => { assert.equal(context, ctx); output += text; },
  }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.value.exitCode, 0);
  assert.match(output, /worker=1/); assert.match(output, /err/); assert.match(output, /é/);
  assert.equal(await readFile(result.value.spillPath, "utf8"), output);
  await acknowledgement(dir);
  const request = JSON.parse(await readFile(join(await execution(dir), "request.json"), "utf8"));
  assert.equal(request.timeout, 120);
});

test("private inherited and explicit environments use bounded anonymous pipes, never artifacts or argv", options, async (t) => {
  const { dir, env } = await setup(t);
  const inherited = `inherited-secret-${randomUUID()}`;
  const explicit = `explicit-secret-${randomUUID()}`;
  const saved = { secret: process.env.DURABLE_INHERITED_SECRET, nodeOptions: process.env.NODE_OPTIONS };
  process.env.DURABLE_INHERITED_SECRET = inherited;
  // Neither the supervisor nor its gated helper may load caller Node hooks.
  process.env.NODE_OPTIONS = `--require=${join(dir, "must-not-load.cjs")}`;
  t.after(() => {
    if (saved.secret === undefined) delete process.env.DURABLE_INHERITED_SECRET;
    else process.env.DURABLE_INHERITED_SECRET = saved.secret;
    if (saved.nodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved.nodeOptions;
  });
  let output = "";
  const pending = env.exec('[ -n "$DURABLE_INHERITED_SECRET" ] && [ -n "$DURABLE_EXPLICIT_SECRET" ] && [ -n "$NODE_OPTIONS" ] && [ "$PI_HERDR_WORKER" = 1 ] && [ "${#PAD_A}/${#PAD_B}/${#PAD_C}" = 49152/49152/49152 ] && printf "present\\n"; touch ready; while [ ! -e release ]; do sleep 0.05; done', {
    env: { DURABLE_EXPLICIT_SECRET: explicit, PAD_A: "a".repeat(49152), PAD_B: "b".repeat(49152), PAD_C: "c".repeat(49152), PI_HERDR_WORKER: "0" },
    spill: { afterBytes: 0, afterLines: 0 }, onOutput: (text) => { output += text; },
  }, ctx);
  try {
    await waitFor(() => exists(join(dir, "ready")), "large private environment passes post-journal gate without deadlock");
    const argv = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    for (const secret of [inherited, explicit]) assert.equal(argv.includes(secret), false, "secret absent from live argv");
    const path = await execution(dir);
    const request = JSON.parse(await readFile(join(path, "request.json"), "utf8"));
    assert.equal(Object.hasOwn(request, "env"), false);
    await writeFile(join(dir, "release"), "");
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.value.exitCode, 0);
  } finally {
    await env.cleanup(ctx);
    await pending;
  }
  assert.equal(output, "present\n");
  await acknowledgement(dir);
  const path = await execution(dir);
  for (const name of await readdir(path, { recursive: true })) {
    const artifact = await readFile(join(path, name), "utf8");
    for (const secret of [inherited, explicit]) assert.equal(artifact.includes(secret), false, `secret absent from ${name}`);
    if (name.endsWith(".json")) JSON.parse(artifact);
  }
  // inheritEnv=false excludes both the parent's secret and NODE_OPTIONS, while
  // explicit values and the mandatory fence overrides still reach Bash.
  let isolatedOutput = "";
  const isolated = createDurableEnvironment(dir, "isolated", dir);
  try {
    const result = await isolated.exec('[ -z "${DURABLE_INHERITED_SECRET+x}" ] && [ -z "${NODE_OPTIONS+x}" ] && [ -n "$DURABLE_EXPLICIT_SECRET" ] && [ "$PI_HERDR_WORKER" = 1 ] && printf "present\\n"', {
      inheritEnv: false, env: { DURABLE_EXPLICIT_SECRET: explicit, PI_HERDR_WORKER: "0" },
      onOutput: (text) => { isolatedOutput += text; },
    }, ctx);
    assert.equal(result.ok, true);
    assert.equal(result.value.exitCode, 0);
    assert.equal(isolatedOutput, "present\n");
  } finally { await isolated.cleanup(ctx); }
  for (const id of await readdir(join(dir, "executions"))) {
    for (const name of await readdir(join(dir, "executions", id))) {
      const artifact = await readFile(join(dir, "executions", id, name), "utf8");
      for (const secret of [inherited, explicit]) assert.equal(artifact.includes(secret), false, `secret absent from ${name}`);
    }
  }
});

test("invalid and oversized private environments are rejected before launch", options, async (t) => {
  const { dir, env } = await setup(t);
  for (const value of [42, null, "x".repeat(1024 * 1024), "\u0001".repeat(200_000), "private\0value"]) {
    const result = await env.exec("touch forbidden", { inheritEnv: false, env: { PRIVATE: value } }, ctx);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "spawn_error");
    assert.equal(await exists(join(dir, "executions")), false);
    assert.equal(await exists(join(dir, "forbidden")), false);
  }
});

test("BASH_ENV executes only after the startup ownership fence", options, async (t) => {
  const { dir, env } = await setup(t);
  const hook = join(dir, "bash-env");
  await writeFile(hook, 'if ! /usr/bin/find "$DIRECTORY/executions" -name execution.json | /usr/bin/grep -q .; then echo unsafe >"$DIRECTORY/unsafe"; fi\nprintf "startup-hook\\n"\n');
  let output = "";
  const result = await env.exec("echo command", { env: { BASH_ENV: hook, DIRECTORY: dir }, onOutput: (text) => { output += text; } }, ctx);
  assert.equal(result.ok, true);
  assert.equal(output, "startup-hook\ncommand\n");
  assert.equal(await exists(join(dir, "unsafe")), false);
  await acknowledgement(dir);
});

test("cancellation waits for verified cleanup before returning aborted", options, async (t) => {
  const { dir, env } = await setup(t);
  const controller = new AbortController();
  const result = env.exec("touch ready; sleep 3; echo survived >after", undefined, withAbortSignal(controller.signal, ctx));
  await waitFor(() => exists(join(dir, "ready")), "shell ready");
  controller.abort();
  assert.equal((await result).error.code, "aborted");
  await acknowledgement(dir);
  await delay(3100);
  assert.equal(await exists(join(dir, "after")), false);
});

for (const killSupervisor of [false, true]) test(`SIGKILL coordinator${killSupervisor ? " AND supervisor" : ""}: recovery blocks the delayed 3s effect`, options, async (t) => {
  const { dir } = await setup(t);
  const { child, exited } = await actor(t, dir);
  const path = await execution(dir);
  if (killSupervisor) {
    const claim = JSON.parse(await readFile(join(path, "supervisor.json"), "utf8"));
    assert.equal(await identityAlive(claim.identity), true);
    process.kill(claim.identity.pid, "SIGKILL");
  }
  child.kill("SIGKILL"); await exited;
  await recoverExecutions(dir);
  await acknowledgement(dir);
  await delay(3200);
  assert.equal(await exists(join(dir, "after")), false);
});

test("independent supervisor cancels on coordinator death without recovery", options, async (t) => {
  const { dir } = await setup(t);
  const { child, exited } = await actor(t, dir);
  child.kill("SIGKILL"); await exited;
  const path = await execution(dir);
  await waitFor(() => exists(join(path, "shutdown.json")), "independent cleanup acknowledgement");
  await acknowledgement(dir);
  await delay(3200);
  assert.equal(await exists(join(dir, "after")), false);
});

test("normal completion cleans a discovered detached descendant", options, async (t) => {
  const { dir, env } = await setup(t);
  const result = await env.exec('"$NODE" --experimental-strip-types "$FIXTURE" descendant "$DIRECTORY"', {
    env: { NODE: process.execPath, FIXTURE: fixture, DIRECTORY: dir },
  }, ctx);
  assert.equal(result.ok, true); assert.equal(result.value.exitCode, 0);
  const pid = Number(await readFile(join(dir, "leaf.pid"), "utf8"));
  assert.equal((await snapshotProcesses()).some((entry) => entry.pid === pid && !/^[ZX]/.test(entry.state)), false);
  await acknowledgement(dir);
  await delay(3100);
  assert.equal(await exists(join(dir, "after")), false);
});

test("lost supervisor ownership evidence fails closed and never fabricates an ack", options, async (t) => {
  const { dir } = await setup(t);
  const { child, exited } = await actor(t, dir);
  const path = await execution(dir);
  const claim = JSON.parse(await readFile(join(path, "supervisor.json"), "utf8"));
  process.kill(claim.identity.pid, "SIGKILL");
  child.kill("SIGKILL"); await exited;
  const evidencePath = join(path, "execution.json");
  const evidence = await readFile(evidencePath, "utf8");
  await rm(evidencePath);
  try {
    await assert.rejects(recoverExecutions(dir), (error) => error instanceof AggregateError && /ownership evidence missing/.test(String(error.errors[0])));
    assert.equal(await exists(join(path, "shutdown.json")), false);
  } finally {
    await writeFile(evidencePath, evidence, { mode: 0o600 });
    await recoverExecutions(dir);
  }
  await acknowledgement(dir);
});

test("timeout semantics, callback failures, bounded large-output spool, and cleanup", options, async (t) => {
  const { dir, env } = await setup(t);
  for (const timeout of [0, -1, NaN, Infinity, 2147484]) assert.equal((await env.exec("true", { timeout }, ctx)).error.code, "timeout");
  assert.equal((await env.exec("sleep 3", { timeout: 0.05 }, ctx)).error.code, "timeout");
  assert.equal((await env.exec("echo output; sleep 3", { onOutput: () => { throw new Error("callback failure"); } }, ctx)).error.code, "callback_error");
  let count = 0;
  const result = await env.exec('"$NODE" -e "process.stdout.write(Buffer.alloc(4*1024*1024, 120))"', {
    env: { NODE: process.execPath }, spill: { afterBytes: 1024, afterLines: 100 }, onOutput: (text) => { count += text.length; },
  }, ctx);
  assert.equal(result.ok, true); assert.equal(count, 4 * 1024 * 1024);
  assert.equal((await readFile(result.value.spillPath)).length, count);
  const running = env.exec("touch ready; sleep 3; echo survived >after", undefined, ctx);
  await waitFor(() => exists(join(dir, "ready")), "cleanup shell ready");
  await env.cleanup(ctx);
  assert.equal((await running).error.code, "aborted");
  await recoverExecutions(dir);
});

test("startup recovery fences a delayed supervisor before it can spawn Bash", options, async (t) => {
  const { dir } = await setup(t);
  const path = join(dir, "executions", randomUUID());
  await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(path, "request.json"), JSON.stringify({ coordinator: await processIdentity(), conversationId: "delayed", command: "echo forbidden >after", cwd: dir, timeout: 120 }));
  await recoverExecutions(dir);
  const worker = fileURLToPath(new URL("../extensions/herdr-subagents/durable/shell-worker.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", worker, path], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  child.stdio[3].on("error", () => {});
  child.stdio[3].end("{}");
  assert.deepEqual(await once(child, "exit"), [0, null]);
  assert.equal(await exists(join(dir, "after")), false);
  assert.equal(await exists(join(path, "spawning.json")), false);
  await acknowledgement(dir);
});

test("boot mismatch never signals a reused live PID or process group", options, async (t) => {
  const { dir } = await setup(t);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const exited = once(unrelated, "exit");
  t.after(async () => { unrelated.kill("SIGKILL"); await exited; });
  const identity = await processIdentity(unrelated.pid);
  assert.ok(identity);
  const path = join(dir, "executions", randomUUID());
  await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(path, "execution.json"), JSON.stringify({ boot: "different-boot", tree: {
    root: identity.pid, start: identity.start, processes: [[identity.pid, identity.start]], groups: [[identity.pid, identity.start]],
  } }));
  await recoverExecutions(dir);
  assert.equal(await identityAlive(identity), true);
  await acknowledgement(dir);
});
