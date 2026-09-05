import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import extension from "../extensions/herdr-subagents/index.ts";
import { agentDirectory, atomic, cleanup, closeJob, closeJobs, collect, jobs, launcher, locked, PAGE_BYTES, piArgs, reportPage, save, scopeFor, spawnTasks, splitTarget, status, systemPrompt, validateTasks } from "../extensions/herdr-subagents/core.ts";
import { finalReport } from "../extensions/herdr-subagents/worker.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = join(directory, "herdr.mjs");
  const statePath = join(directory, "panes.json");
  await writeFile(statePath, JSON.stringify({ calls: [], panes: [{ pane_id: "w:p-main", terminal_id: "main" }], next: 1 }));
  await writeFile(backend, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.FAKE_STATE;
const state=JSON.parse(readFileSync(file,'utf8'));
const args=process.argv.slice(2);
state.calls.push(args);
let result={};
if(args[1]==='list') result={panes:state.panes};
if(args[1]==='current') result={pane:state.panes[0]};
if(args[1]==='layout') result={layout:{panes:state.panes.map(p=>({...p,rect:{width:100,height:40}}))}};
if(args[1]==='split') {
 const id=state.next++;
 const pane={pane_id:'w:p-'+id,terminal_id:'term-'+id};
 state.panes.push(pane); result={pane};
}
if(args[1]==='close') state.panes=state.panes.filter(p=>p.pane_id!==args[2]);
writeFileSync(file,JSON.stringify(state));
if(args[1]==='close' && process.env.FAKE_CLOSE_MISSING) { console.error(JSON.stringify({error:{code:'pane_not_found'}})); process.exit(1); }
if(process.env.FAKE_FAIL===args[1]) { console.error('injected failure'); process.exit(1); }
if(!['run','report-agent'].includes(args[1])) console.log(JSON.stringify({result}));
`);
  await chmod(backend, 0o700);
  const env = { ...process.env, PI_HERDR_WORKER: "", PI_CODING_AGENT_DIR: directory, HERDR_ENV: "1", HERDR_PANE_ID: "w:p-main", HERDR_WORKSPACE_ID: "w", HERDR_SOCKET_PATH: "test.sock", HERDR_BIN_PATH: backend, PI_HERDR_PI_BIN: process.execPath, FAKE_STATE: statePath };
  const scope = scopeFor("test-session", env);
  return { directory, statePath, env, scope, backend };
}

function task(name, extra = {}) { return validateTasks([{ name, prompt: "test task", ...extra }], {}, process.cwd())[0]; }

async function cli(scope, args, input = "") {
  const child = spawn(process.execPath, [launcher, ...args], {
    env: { ...scope.env, PI_SESSION_ID: "test-session" }, stdio: "pipe",
  });
  const closed = once(child, "close");
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim().split("\n").length, 1);
  return JSON.parse(stdout);
}

async function completed(scope, job, text, state = "done") {
  await writeFile(join(scope.root, job.id, "result.md"), text);
  await atomic(join(scope.root, job.id, "done.json"), { state, report: text }, true);
}

test("input validation, independent model/thinking and literal task delivery", () => {
  const env = { PI_PROVIDER: "provider", PI_MODEL: "model", PI_REASONING_LEVEL: "high" };
  const [inherited] = validateTasks([{ name: "review", prompt: "@secret $(touch pwned)", role: "reviewer" }], env);
  assert.equal(inherited.model, "provider/model");
  assert.equal(inherited.thinking, "high");
  const [explicit] = validateTasks([{ name: "review", prompt: inherited.prompt, role: "reviewer", cwd: process.cwd(), model: "provider/model", thinking: "high" }], env);
  assert.deepEqual(inherited, explicit, "Omitting matching defaults must preserve the entire resolved task");
  const [custom] = validateTasks([{ name: "custom", prompt: "x", model: "other/model:low" }], env);
  assert.equal(custom.thinking, undefined);
  const args = piArgs(inherited);
  assert.deepEqual(args.slice(0, 10), ["--mode", "json", "-p", "--no-session", "--name", "review", "--model", "provider/model", "--thinking", "high"]);
  assert.equal(args[10], "-e");
  assert.match(args[11], /herdr-subagents\/prompt\.ts$/);
  assert.ok(!args.includes("--append-system-prompt"));
  assert.ok(!args.includes(inherited.prompt));
  assert.match(systemPrompt(inherited), /Do not spawn agents/);
  for (const input of [[], Array(17).fill({ name: "a", prompt: "x" }), [{ name: "../bad", prompt: "x" }], [{ name: "a", prompt: "" }], [{ name: "a", prompt: "x", role: "__proto__" }], [{ name: "a", prompt: "x", model: 3 }], [{ name: "a", prompt: "x", timeout: 0 }], [{ name: "a", prompt: "x", tools: "bash" }], [{ name: "a", prompt: "x" }, { name: "a", prompt: "x" }]]) {
    assert.throws(() => validateTasks(input));
  }
});

test("all roles retain normal Pi resource and tool discovery; extra extensions are additive", () => {
  for (const role of ["reviewer", "explorer", "tester", "worker"]) {
    const args = piArgs(task("configured", { role, extensions: ["/tmp/extra-extension.ts"] }));
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--tools", "--exclude-tools", "--no-tools", "--no-builtin-tools"]) {
      assert.ok(!args.includes(flag), `${role} unexpectedly restricts ${flag}`);
    }
    assert.deepEqual(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2), ["-e", "/tmp/extra-extension.ts"]);
  }
});

test("scope cannot follow focus or recurse; session and socket isolate ownership", async (t) => {
  const { env, scope } = await fixture(t);
  assert.throws(() => scopeFor(undefined, { ...env, HERDR_ENV: "0" }));
  assert.throws(() => scopeFor("x", { ...env, PI_HERDR_WORKER: "1" }));
  assert.notEqual(scope.root, scopeFor("other", env).root);
  assert.notEqual(scope.root, scopeFor("test-session", { ...env, HERDR_SOCKET_PATH: "other.sock" }).root);
});

test("layout leaves main alone after first split, chooses largest owned area", () => {
  const layout = { panes: [
    { pane_id: "main", rect: { width: 200, height: 60 } },
    { pane_id: "a", rect: { width: 50, height: 50 } },
    { pane_id: "b", rect: { width: 30, height: 20 } },
  ] };
  assert.deepEqual(splitTarget(layout, [], "main"), { pane: "main", direction: "right" });
  assert.deepEqual(splitTarget(layout, ["a", "b"], "main"), { pane: "a", direction: "down" });
});

test("16-job CLI workflow keeps bounded metadata, explicit names/focus/cwd and unread-pane safety", async (t) => {
  const { scope, statePath } = await fixture(t);
  // Maximum-length names exercise real serialized output, not an estimated schema.
  const tasks = Array.from({ length: 16 }, (_, i) => ({ name: `job-${String(i).padStart(2, "0")}-${"x".repeat(25)}`, prompt: "test task" }));
  const started = await cli(scope, ["spawn"], JSON.stringify(tasks));
  const launched = await jobs(scope);
  assert.equal(launched.length, 16);
  assert.deepEqual(started, { jobs: launched.map((job) => ({ id: job.id, name: job.task.name })) });
  assert.ok(Buffer.byteLength(JSON.stringify(started)) <= 1100);
  await assert.rejects(spawnTasks(scope, [task("overflow")]), /At most 16/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.panes.length, 17);
  for (const call of state.calls.filter((call) => call[1] === "split")) assert.ok(call.includes("--no-focus") && call.includes("--cwd"));
  assert.equal(state.calls.filter((call) => call[1] === "rename").length, 16);
  for (const job of launched) assert.ok(job.pane && job.terminal, "Pane identity must remain available in job.json");
  const progress = await cli(scope, ["status"]);
  assert.deepEqual(progress, { root: scope.root, jobs: launched.map((job) => ({ id: job.id, name: job.task.name, state: "running" })) });
  // Normalize only the machine-specific artifact directory for a portable budget.
  assert.ok(Buffer.byteLength(JSON.stringify({ ...progress, root: "/artifacts" })) <= 1400);
  const waiting = await cli(scope, ["collect"]);
  assert.deepEqual(waiting, { reports: [], pending: 16 });
  assert.ok(Buffer.byteLength(JSON.stringify(waiting)) <= 30);
  assert.deepEqual(await cli(scope, ["close"]), { closed: [] });
  for (const job of launched) await completed(scope, job, "finished");
  const collected = await cli(scope, ["collect"]);
  assert.deepEqual(collected, { reports: launched.map((job) => ({ id: job.id, name: job.task.name, state: "done", complete: true, text: "finished" })), pending: 0 });
  for (const report of collected.reports) assert.ok(Buffer.byteLength(JSON.stringify({ ...report, text: "" })) <= 110);
  assert.deepEqual(await cli(scope, ["close"]), { closed: launched.map((job) => job.task.name) });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).panes.length, 1);
  assert.equal((await stat(scope.root)).mode & 0o777, 0o700);
});

test("compact status preserves positive collected/closed flags and failure states", async (t) => {
  const { scope } = await fixture(t);
  const [running, consumed, cancelled] = await spawnTasks(scope, [task("running"), task("consumed"), task("cancelled")]);
  await completed(scope, consumed, "checked");
  await collect(scope, 0, async () => {});
  await completed(scope, cancelled, "partial evidence", "cancelled");
  await closeJob(scope, cancelled, true);
  assert.deepEqual((await status(scope)).jobs, [
    { id: running.id, name: "running", state: "running" },
    { id: consumed.id, name: "consumed", state: "done", collected: true },
    { id: cancelled.id, name: "cancelled", state: "cancelled", closed: true },
  ]);
});

test("concurrent spawn is serialized and partial launch rolls back only created panes", async (t) => {
  const { scope, statePath } = await fixture(t);
  const attempts = await Promise.allSettled([spawnTasks(scope, [task("same")]), spawnTasks(scope, [task("same")])]);
  assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
  await assert.rejects(spawnTasks({ ...scope, env: { ...scope.env, FAKE_FAIL: "rename" } }, [task("failed")]), /rolled back/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.panes.length, 2);
  assert.equal((await jobs(scope)).filter((job) => !job.closed).length, 1);
});

test("status cannot classify an in-progress launch as a disappeared worker", async (t) => {
  const { scope } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("launching")]);
  let inspection;
  await locked(scope, async () => {
    await save(scope, { ...job, pane: undefined, terminal: undefined });
    let settled = false;
    inspection = status(scope).then((result) => { settled = true; return result; });
    await delay(75);
    assert.equal(settled, false);
    await save(scope, job);
  });
  assert.equal((await inspection).jobs[0].state, "running");
  assert.equal(await stat(join(scope.root, job.id, "done.json")).catch(() => undefined), undefined);
});

test("unique lock claims recover dead holders without deleting concurrent successors", async (t) => {
  const { scope, directory } = await fixture(t);
  await mkdir(join(scope.root, "locks"), { recursive: true });
  await atomic(join(scope.root, "locks", "00000000-dead.json"), { pid: 99999999, choosing: false, ticket: 1 });
  const counter = join(directory, "counter");
  await writeFile(counter, "0");
  const module = new URL("../extensions/herdr-subagents/core.ts", import.meta.url).href;
  const program = `import {locked} from ${JSON.stringify(module)}; import {readFile,writeFile} from 'node:fs/promises';
for(let i=0;i<3;i++) await locked({root:${JSON.stringify(scope.root)}},async()=>{const n=Number(await readFile(${JSON.stringify(counter)},'utf8'));await new Promise(r=>setTimeout(r,5));await writeFile(${JSON.stringify(counter)},String(n+1));});`;
  await Promise.all(Array.from({ length: 8 }, async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
  }));
  assert.equal(await readFile(counter, "utf8"), "24");
});

test("cancellation waits for the supervisor's final report rather than consuming a placeholder", async (t) => {
  const { scope } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("cancelled")]);
  await atomic(join(scope.root, job.id, "worker.json"), { pid: process.pid }, true);
  let closed = false;
  const closing = closeJob(scope, job, true).then(() => { closed = true; });
  await delay(100);
  assert.equal(closed, false);
  await collect(scope, 0, async (output) => { assert.deepEqual(output.reports, []); assert.equal(output.pending, 1); });
  assert.equal((await jobs(scope))[0].collected, undefined);
  await completed(scope, job, "Important partial findings", "cancelled");
  await closing;
  await collect(scope, 0, async (output) => {
    assert.equal(output.reports[0].text, "Important partial findings");
    assert.equal(output.reports[0].state, "cancelled");
    assert.equal(output.pending, 0);
  });
});

test("fallback completion is immutable, including its paginated report snapshot", async (t) => {
  const { scope } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("fallback")]);
  // Simulate the user closing the terminal before the supervisor could finalize.
  job.closed = true;
  job.endedAt = Date.now() - 5001;
  await save(scope, job);
  await writeFile(join(scope.root, job.id, "result.md"), "original ".repeat(3000));
  const chunks = [];
  await collect(scope, 0, async (output) => chunks.push(output.reports[0].text));
  const snapshot = JSON.parse(await readFile(join(scope.root, job.id, "done.json"), "utf8"));
  await completed(scope, job, "late replacement");
  let pending = 1;
  while (pending) await collect(scope, 0, async (output) => { chunks.push(...output.reports.map((r) => r.text)); pending = output.pending; });
  assert.equal(chunks.join(""), `${snapshot.error}\n\n${snapshot.report}`);
  assert.equal(JSON.parse(await readFile(join(scope.root, job.id, "done.json"), "utf8")).state, "cancelled");
});

test("collection is bounded, lossless Unicode pagination; no transcript enters report", async (t) => {
  const { scope } = await fixture(t);
  const [job, running] = await spawnTasks(scope, [task("long"), task("running")]);
  const text = '😀中文\n\u0000"\\\r\n'.repeat(8000) + "END";
  await completed(scope, job, text);
  const chunks = [];
  let pages = 0;
  while (!(await jobs(scope)).find((j) => j.id === job.id).collected) {
    await collect(scope, 0, async (output) => {
      assert.ok(Buffer.byteLength(JSON.stringify(output)) < PAGE_BYTES);
      assert.equal(JSON.stringify(output).split("\n").length, 1);
      for (const report of output.reports) {
        assert.equal(report.offset ?? 0, chunks.join("").length);
        assert.equal(Object.hasOwn(report, "offset"), chunks.length > 0);
        assert.equal(typeof report.complete, "boolean");
        chunks.push(report.text);
      }
      assert.ok(output.pending >= 1);
      pages++;
    });
    assert.ok(pages < 100);
  }
  assert.equal(chunks.join(""), text);
  assert.ok(pages > 1);
  assert.deepEqual(await cleanup(scope), ["long"]);
  assert.equal((await jobs(scope)).find((j) => j.id === running.id).closed, undefined);
  assert.equal(await readFile(join(scope.root, job.id, "result.md"), "utf8"), text);
  await assert.rejects(closeJob(scope, running), /collect the entire report/);
});

test("failed output delivery doesn't advance cursor or close a job", async (t) => {
  const { scope } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("delivery")]);
  await completed(scope, job, "result");
  await assert.rejects(collect(scope, 0, async () => { throw new Error("broken pipe"); }), /broken pipe/);
  assert.equal((await jobs(scope))[0].cursor, 0);
  assert.deepEqual(await cleanup(scope), []);
});

test("disappeared/replaced panes never count as success and identity prevents unsafe close", async (t) => {
  const { scope, statePath } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("lost")]);
  let state = JSON.parse(await readFile(statePath, "utf8"));
  state.panes[1].terminal_id = "replaced";
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(closeJob(scope, job, true), /identity changed/);
  assert.equal((await status(scope)).jobs[0].state, "ending");
  const ending = (await jobs(scope))[0];
  ending.endedAt = Date.now() - 5001;
  await save(scope, ending);
  assert.equal((await status(scope)).jobs[0].state, "failed");
  state.panes = state.panes.slice(0, 1);
  await writeFile(statePath, JSON.stringify(state));
  await collect(scope, 0, async (output) => assert.equal(output.reports[0].state, "failed"));
  await cleanup(scope);
  assert.equal((await jobs(scope))[0].closed, true);
});

test("close tolerates Herdr auto-removing a completed pane", async (t) => {
  const { scope } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("auto-closed")]);
  await completed(scope, job, "ok");
  await collect(scope, 0, async () => {});
  assert.deepEqual(await cleanup({ ...scope, env: { ...scope.env, FAKE_CLOSE_MISSING: "1" } }), ["auto-closed"]);
  assert.equal((await jobs(scope))[0].closed, true);
});

test("all 16 reports fit bounded pages without loss", async (t) => {
  const { scope } = await fixture(t);
  const launched = await spawnTasks(scope, Array.from({ length: 16 }, (_, i) => task(`batch-${i}`)));
  for (const job of launched) await completed(scope, job, "x".repeat(1500));
  let pending = 16;
  const received = new Map();
  while (pending) {
    await collect(scope, 0, async (output) => {
      assert.ok(Buffer.byteLength(JSON.stringify(output)) < PAGE_BYTES);
      pending = output.pending;
      for (const report of output.reports) {
        const previous = received.get(report.id) || "";
        assert.equal(report.offset ?? 0, previous.length);
        assert.equal(Object.hasOwn(report, "offset"), previous.length > 0);
        assert.equal(report.complete, previous.length + report.text.length === 1500);
        received.set(report.id, previous + report.text);
      }
    });
  }
  assert.equal(received.size, 16);
  for (const text of received.values()) assert.equal(text, "x".repeat(1500));
});

test("final report rejects incomplete/error/aborted/length turns but accepts retry success", () => {
  const last = { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop" };
  assert.deepEqual(finalReport(last, 0, true), { text: "final", error: undefined });
  assert.ok(finalReport(last, 1, true).error);
  assert.ok(finalReport(last, 0, false).error);
  for (const stopReason of ["error", "aborted", "length", "pending", "deferred", "toolUse"]) assert.ok(finalReport({ ...last, stopReason }, 0, true).error);
  assert.ok(finalReport({ ...last, content: [...last.content, { type: "toolCall", name: "bash" }] }, 0, true).error);
  assert.ok(finalReport(undefined, 0, true).error);
  assert.equal(reportPage("😀END", 0, 3), "");
  assert.equal(reportPage("😀END", 0, 4), "😀");
});

test("worker captures exact events/final text and retains its pane without registering a Herdr agent", async (t) => {
  const { scope, env, directory, statePath } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("worker-test", { prompt: "@literal $(not-a-command)" })]);
  const calls = JSON.parse(await readFile(statePath, "utf8")).calls;
  const jobdir = join(scope.root, job.id);
  const fakePi = join(directory, "pi.mjs");
  await writeFile(fakePi, `import {writeFileSync} from 'node:fs';
let input='';for await(const chunk of process.stdin) input+=chunk;
writeFileSync(${JSON.stringify(join(directory, "stdin"))},input);
const events=[{type:'agent_start'},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'result 😀\\nEND'}],stopReason:'stop'}},{type:'agent_end'}];
const bytes=Buffer.from(events.map(e=>JSON.stringify(e)).join('\\n')+'\\n');
for(let i=0;i<bytes.length;i+=3) process.stdout.write(bytes.subarray(i,i+3));
`);
  await atomic(join(jobdir, "launch.json"), { pi: process.execPath, args: [fakePi] });
  const child = spawn(process.execPath, [launcher, "worker", jobdir], { env: { ...env, HERDR_PANE_ID: job.pane }, stdio: "pipe" });
  const closed = once(child, "close");
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let i = 0; i < 200; i++) {
    if (await stat(join(jobdir, "done.json")).catch(() => undefined)) break;
    await delay(25);
  }
  assert.equal(JSON.parse(await readFile(join(jobdir, "done.json"), "utf8")).state, "done", stderr);
  assert.equal(await readFile(join(directory, "stdin"), "utf8"), job.task.prompt);
  assert.equal(await readFile(join(jobdir, "result.md"), "utf8"), "result 😀\nEND");
  const events = await readFile(join(jobdir, "events.jsonl"), "utf8");
  assert.match(events, /😀/);
  assert.equal(events.trim().split("\n").length, 3);
  assert.equal(child.exitCode, null);
  child.kill("SIGTERM");
  await closed;
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).calls, calls, "Worker lifecycle must not call Herdr or register agent state");
});

for (const trigger of ["timeout", "cancel"]) test(`worker ${trigger} kills its process group and publishes cancellation`, async (t) => {
  const { scope, env, directory, statePath } = await fixture(t);
  const [job] = await spawnTasks(scope, [task(trigger, { timeout: trigger === "timeout" ? 1 : 60 })]);
  const calls = JSON.parse(await readFile(statePath, "utf8")).calls;
  const jobdir = join(scope.root, job.id);
  const fakePi = join(directory, "slow.mjs");
  await writeFile(fakePi, `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(join(directory, "started"))},String(process.pid)); setInterval(()=>{},1000);`);
  await atomic(join(jobdir, "launch.json"), { pi: process.execPath, args: [fakePi] });
  const child = spawn(process.execPath, [launcher, "worker", jobdir], { env: { ...env, HERDR_PANE_ID: job.pane }, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const closed = once(child, "close");
  if (trigger === "cancel") {
    for (let i = 0; i < 200 && !await stat(join(directory, "started")).catch(() => undefined); i++) await delay(25);
    assert.ok(await stat(join(directory, "started")));
    await atomic(join(jobdir, "cancel.json"), {});
  }
  await closed;
  const done = JSON.parse(await readFile(join(jobdir, "done.json"), "utf8"));
  assert.equal(done.state, "cancelled");
  assert.match(done.error, trigger === "timeout" ? /Timed out/ : /Cancelled by parent/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).calls, calls, "Interrupted workers must not register agent state either");
});

test("extension adds zero tools/prompt messages; settle closes only consumed panes, reload preserves workers", async (t) => {
  const { scope, env } = await fixture(t);
  const old = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
  const handlers = new Map();
  const commands = new Map();
  extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, fn) => commands.set(name, fn) });
  assert.deepEqual([...handlers.keys()], ["agent_settled", "session_shutdown"]);
  const [read, unread] = await spawnTasks(scope, [task("read"), task("unread")]);
  await completed(scope, read, "ok");
  await collect(scope, 0, async () => {});
  const ctx = { sessionManager: { getSessionId: () => "test-session" }, isIdle: () => true, hasUI: false };
  await handlers.get("agent_settled")({}, ctx);
  assert.equal((await jobs(scope)).find((j) => j.id === read.id).closed, true);
  await handlers.get("session_shutdown")({ reason: "reload" }, ctx);
  assert.equal((await jobs(scope)).find((j) => j.id === unread.id).closed, undefined);
  await completed(scope, unread, "Unread final");
  await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
  assert.equal((await jobs(scope)).find((j) => j.id === unread.id).closed, true);
  assert.ok(commands.has("subagents"));
});

test("tilde config paths match Pi and extension anchors relative paths", async (t) => {
  const { env } = await fixture(t);
  assert.equal(agentDirectory({ PI_CODING_AGENT_DIR: "~/.pi/agent" }), agentDirectory({}));
  const path = join(env.PI_CODING_AGENT_DIR, "config with spaces");
  assert.equal(agentDirectory({ PI_CODING_AGENT_DIR: pathToFileURL(path).href }), path);
  const old = { ...process.env };
  Object.assign(process.env, env, { PI_CODING_AGENT_DIR: ".test-agent-dir" });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
  extension({ on() {}, registerCommand() {} });
  assert.equal(process.env.PI_CODING_AGENT_DIR, join(process.cwd(), ".test-agent-dir"));
});

test("moved workers resolve by terminal across workspaces; moved callers use current identity", async (t) => {
  const { scope, statePath } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("moved")]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.panes[0].pane_id = "w2:p-parent";
  state.panes[1].pane_id = "w2:p-worker";
  await writeFile(statePath, JSON.stringify(state));
  assert.equal((await status(scope)).jobs[0].state, "running");
  await completed(scope, job, "moved result");
  await collect(scope, 0, async (output) => assert.equal(output.reports[0].text, "moved result"));
  await cleanup(scope);
  let updated = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(updated.panes.length, 1);
  assert.ok(updated.calls.some((args) => args[1] === "close" && args[2] === "w2:p-worker"));
  await spawnTasks(scope, [task("after-move")]);
  updated = JSON.parse(await readFile(statePath, "utf8"));
  const split = updated.calls.filter((args) => args[1] === "split").at(-1);
  assert.equal(split[split.indexOf("--pane") + 1], "w2:p-parent");
});

test("identity is revalidated after cancellation acknowledgement", async (t) => {
  const { scope, statePath } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("replaced-during-wait")]);
  const jobdir = join(scope.root, job.id);
  await atomic(join(jobdir, "worker.json"), { pid: process.pid }, true);
  const closing = assert.rejects(closeJob(scope, job, true), /identity changed/);
  for (let i = 0; i < 100 && !await stat(join(jobdir, "cancel.json")).catch(() => undefined); i++) await delay(10);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.panes[1].terminal_id = "replacement";
  await writeFile(statePath, JSON.stringify(state));
  await completed(scope, job, "partial", "cancelled");
  await closing;
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).panes.length, 2);
  assert.ok(!(await jobs(scope))[0].closed);
});

test("rejected launch is fenced and rolled back without waiting for a nonexistent worker", async (t) => {
  const { scope, statePath } = await fixture(t);
  await assert.rejects(spawnTasks({ ...scope, env: { ...scope.env, FAKE_FAIL: "run" } }, [task("rejected")]), /rolled back/);
  const [job] = await jobs(scope);
  assert.equal(job.closed, true);
  assert.equal(JSON.parse(await readFile(join(scope.root, job.id, "worker.json"), "utf8")).cancelled, true);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).panes.length, 1);
});

test("lost split response is reported as unresolved rather than falsely claiming rollback", async (t) => {
  const { scope, statePath } = await fixture(t);
  await assert.rejects(spawnTasks({ ...scope, env: { ...scope.env, FAKE_FAIL: "split" } }, [task("lost-response")]), /rollback incomplete.*ownership is unresolved/);
  const [job] = await jobs(scope);
  assert.equal(job.creating, true);
  assert.ok(!job.closed);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).panes.length, 2);
});

test("batch cancellation shares one grace period and attempts jobs after failures", async (t) => {
  const { scope, statePath } = await fixture(t);
  const launched = await spawnTasks(scope, [task("stalled-a"), task("stalled-b"), task("complete")]);
  for (const job of launched.slice(0, 2)) await atomic(join(scope.root, job.id, "worker.json"), { pid: process.pid }, true);
  await completed(scope, launched[2], "ok");
  const start = Date.now();
  await assert.rejects(closeJobs(scope, launched, true, 500), /stalled-a.*stalled-b/);
  assert.ok(Date.now() - start < 1300, "Cancellation must not spend a fresh grace period per job");
  assert.equal((await jobs(scope)).find((j) => j.id === launched[2].id).closed, true);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).panes.length, 3);
});

test("saved reports remain collectible during Herdr outage; unfinished jobs expose a bounded warning", async (t) => {
  const { scope } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("offline")]);
  await completed(scope, job, "offline report");
  const offline = { ...scope, env: { ...scope.env, FAKE_FAIL: "list" } };
  await collect(offline, 0, async (output) => assert.equal(output.reports[0].text, "offline report"));
  await spawnTasks(scope, [task("unfinished")]);
  await collect(offline, 0, async (output) => {
    assert.equal(output.pending, 1);
    assert.match(output.warning, /Herdr pane list/);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) < PAGE_BYTES);
  });
});

test("status paginates large closed/unread backlogs", async (t) => {
  const { scope } = await fixture(t);
  for (let i = 0; i < 70; i++) {
    const job = { id: i.toString(16).padStart(12, "0"), task: task(`history-${i}`), closed: true, created: i, cursor: 0 };
    await mkdir(join(scope.root, job.id), { recursive: true });
    await save(scope, job);
    await completed(scope, job, "unread");
  }
  let offset = 0;
  const ids = [];
  do {
    const page = await status(scope, offset);
    assert.ok(page.jobs.length <= 16);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < PAGE_BYTES);
    ids.push(...page.jobs.map((j) => j.id));
    offset = page.next;
  } while (offset !== undefined);
  assert.equal(new Set(ids).size, 70);
});

test("cancellation recovers a parent crash after fencing but before completion publication", async (t) => {
  const { scope } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("cancel-crash")]);
  await atomic(join(scope.root, job.id, "worker.json"), { cancelled: true }, true);
  await closeJob(scope, job, true, Date.now() + 500);
  assert.equal(job.closed, true);
  const done = JSON.parse(await readFile(join(scope.root, job.id, "done.json"), "utf8"));
  assert.equal(done.state, "cancelled");
});

test("a cancellation broadcast write failure does not prevent later jobs closing", async (t) => {
  const { scope } = await fixture(t);
  const launched = await spawnTasks(scope, [task("bad-broadcast"), task("later-job")]);
  await mkdir(join(scope.root, launched[0].id, "cancel.json"));
  await completed(scope, launched[1], "ready");
  await assert.rejects(closeJobs(scope, launched, true), /EISDIR|directory/);
  assert.equal((await jobs(scope)).find((job) => job.id === launched[1].id).closed, true);
});

test("failed process cleanup prevents automatic pane closure", async (t) => {
  const { scope } = await fixture(t);
  const [job] = await spawnTasks(scope, [task("unsafe-close")]);
  await atomic(join(scope.root, job.id, "done.json"), { state: "failed", report: "", cleanupError: "ps unavailable" }, true);
  await collect(scope, 0, async () => {});
  await assert.rejects(cleanup(scope), /ps unavailable.*pane retained/);
});
