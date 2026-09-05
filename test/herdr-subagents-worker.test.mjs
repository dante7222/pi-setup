import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { atomic, launcher, validateTasks } from "../extensions/herdr-subagents/core.ts";
import promptExtension from "../extensions/herdr-subagents/prompt.ts";
import { snapshotProcesses } from "../extensions/herdr-subagents/process-tree.ts";

const finalEvents = `for(const event of [{type:'agent_start'},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'FINAL'}],stopReason:'stop'}},{type:'agent_end'}]) console.log(JSON.stringify(event));`;
const processModule = new URL("../extensions/herdr-subagents/process-tree.ts", import.meta.url).href;

async function fixture(t, program, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-fault-"));
  const pi = join(directory, "pi.mjs");
  const task = validateTasks([{ name: "fault-test", prompt: "literal", timeout: 10, ...options.task }], {})[0];
  await atomic(join(directory, "job.json"), { id: "123456abcdef", pane: "test:pane", terminal: "owned", launched: true, task, created: Date.now(), cursor: 0 });
  await writeFile(pi, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(directory, "pi.pid"))},String(process.pid));\n${program}`);
  await atomic(join(directory, "launch.json"), { pi: process.execPath, args: [pi] });
  if (options.cancel) await atomic(join(directory, "cancel.json"), {});
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    // Test-owned processes only; ensure failures in the implementation cannot leak.
    for (const name of ["pi.pid", "descendant.pid"]) {
      const pid = Number(await readFile(join(directory, name), "utf8").catch(() => ""));
      if (pid > 1) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  const launch = (extra = {}) => {
    const child = spawn(process.execPath, [...(extra.preload ? ["--import", extra.preload] : []), launcher, "worker", directory], {
      env: { ...process.env, HERDR_PANE_ID: "test:pane", ...extra.env }, stdio: "pipe",
    });
    children.push(child);
    const output = { stdout: "", stderr: "" };
    child.stdout.setEncoding("utf8").on("data", (s) => { output.stdout += s; });
    child.stderr.setEncoding("utf8").on("data", (s) => { output.stderr += s; });
    return { child, output, closed: once(child, "close") };
  };
  return { directory, launch };
}

async function done(directory) {
  for (let i = 0; i < 300; i++) {
    const text = await readFile(join(directory, "done.json"), "utf8").catch(() => undefined);
    if (text) return JSON.parse(text);
    await delay(25);
  }
  assert.fail(`Worker did not finalize: ${directory}`);
}

async function dead(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    const entry = (await snapshotProcesses()).find((p) => p.pid === pid);
    if (!entry || /^[ZX]/.test(entry.state)) return;
    await delay(25);
  }
  assert.fail(`Test-owned process ${pid} survived cleanup`);
}

test("worker preview accepts invalid builtin and structured custom tool arguments", async (t) => {
  const { directory, launch } = await fixture(t, `
for(const args of [{path:42},{command:{script:'x'}},null]) console.log(JSON.stringify({type:'tool_execution_start',toolName:'custom',args}));
${finalEvents}`);
  launch();
  const result = await done(directory);
  assert.equal(result.state, "done", result.error);
  assert.equal(result.report, "FINAL");
});

for (const invalid of ["null", "not-json", '{"type":"message_end","message":{"role":"assistant","content":null}}']) test(`malformed event ${invalid} fails safely and reaps Pi`, async (t) => {
  const { directory, launch } = await fixture(t, `console.log(${JSON.stringify(invalid)}); setInterval(()=>{},1000);`);
  launch();
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.error, /JSON|assistant message/);
  await dead(Number(await readFile(join(directory, "pi.pid"), "utf8")));
});

test("logging exceptions finalize failure without leaving Pi alive", async (t) => {
  const { directory, launch } = await fixture(t, `console.log(JSON.stringify({type:'agent_start'})); setInterval(()=>{},1000);`);
  const preload = join(directory, "disk-full.mjs");
  await writeFile(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const open=fs.openSync,write=fs.writeSync; let target;
fs.openSync=function(path,...args){const fd=open(path,...args);if(String(path).endsWith('/events.jsonl'))target=fd;return fd;};
fs.writeSync=function(fd,...args){if(fd===target)throw Object.assign(new Error('injected ENOSPC'),{code:'ENOSPC'});return write(fd,...args);};syncBuiltinESMExports();`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.error, /ENOSPC/);
  await dead(Number(await readFile(join(directory, "pi.pid"), "utf8")));
});

test("pre-existing cancellation prevents executing Pi at all", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents, { cancel: true });
  const { closed } = launch();
  await closed;
  assert.equal((await done(directory)).state, "cancelled");
  assert.equal(await stat(join(directory, "pi.pid")).catch(() => undefined), undefined);
});

test("wrong-pane and duplicate invocations cannot replace a legitimate completion", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const wrong = launch({ env: { HERDR_PANE_ID: "wrong" } });
  assert.equal((await wrong.closed)[0], 1);
  assert.equal(await stat(join(directory, "done.json")).catch(() => undefined), undefined);
  launch();
  assert.equal((await done(directory)).state, "done");
  const original = await readFile(join(directory, "done.json"), "utf8");
  const duplicate = launch();
  assert.equal((await duplicate.closed)[0], 1);
  assert.equal(await readFile(join(directory, "done.json"), "utf8"), original);
});

test("a parent-won startup claim fences delayed launches", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  await atomic(join(directory, "worker.json"), { cancelled: true }, true);
  const { closed } = launch();
  assert.equal((await closed)[0], 0);
  assert.equal(await stat(join(directory, "pi.pid")).catch(() => undefined), undefined);
});

test("stderr UTF-8 survives byte boundaries and displayed C1 sequences are stripped", async (t) => {
  const { directory, launch } = await fixture(t, `
for(const byte of Buffer.from('界')) {process.stderr.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,10));}
for(const delta of ['\\u009b','2J','\\u009d52;c;payload\\u009c']) console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta}}));
${finalEvents}`, { task: { model: "test/\u009b2J-model" } });
  const { output } = launch();
  assert.equal((await done(directory)).state, "done");
  assert.ok(output.stdout.includes("界"));
  assert.ok(!/[\x80-\x9f]/.test(output.stdout));
  assert.equal(await readFile(join(directory, "stderr.log"), "utf8"), "界");
});

for (const detached of [false, true]) test(`normal exit reaps ${detached ? "detached inherited-pipe" : "same-group"} descendants`, async (t) => {
  const { directory, launch } = await fixture(t, `
import {spawn} from 'node:child_process'; import {snapshotProcesses} from ${JSON.stringify(processModule)};
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:${detached},stdio:'inherit'});
writeFileSync(new URL('./descendant.pid',import.meta.url),String(child.pid));
await new Promise(r=>setTimeout(r,100));
writeFileSync(new URL('./processes.json',import.meta.url),JSON.stringify(await snapshotProcesses()));
${finalEvents}
process.exit(0);`);
  launch();
  const result = await done(directory);
  assert.equal(result.state, "done", result.error);
  await dead(Number(await readFile(join(directory, "descendant.pid"), "utf8")));
});

test("timeout cleans detached tool group even when Pi cannot handle SIGTERM", async (t) => {
  const { directory, launch } = await fixture(t, `
import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
writeFileSync(new URL('./descendant.pid',import.meta.url),String(child.pid));
process.kill(process.pid,'SIGSTOP');`, { task: { timeout: 1 } });
  launch();
  const result = await done(directory);
  assert.equal(result.state, "cancelled", result.error);
  await dead(Number(await readFile(join(directory, "pi.pid"), "utf8")));
  await dead(Number(await readFile(join(directory, "descendant.pid"), "utf8")));
});

test("late SIGTERM shutdown handoff is merged before final escalation", async (t) => {
  const hook = new URL("../extensions/herdr-subagents/prompt.ts", import.meta.url).href;
  const { directory, launch } = await fixture(t, `
import {spawn} from 'node:child_process'; import hook from ${JSON.stringify(hook)};
const handlers=new Map();hook({on:(name,fn)=>handlers.set(name,fn)});
process.on('SIGTERM',async()=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
 writeFileSync(new URL('./descendant.pid',import.meta.url),String(child.pid));
 await handlers.get('session_shutdown')({reason:'quit'});
 process.exit(0);
});
writeFileSync(new URL('./ready',import.meta.url),'ready');setInterval(()=>{},1000);`);
  launch();
  for (let i = 0; i < 100 && !await stat(join(directory, "ready")).catch(() => undefined); i++) await delay(25);
  assert.ok(await stat(join(directory, "ready")));
  await atomic(join(directory, "cancel.json"), {});
  const result = await done(directory);
  assert.equal(result.state, "cancelled", result.error);
  assert.ok(!result.cleanupError, result.error);
  await dead(Number(await readFile(join(directory, "descendant.pid"), "utf8")));
});

test("slow initial ps cannot time out a Pi process that already exited successfully", async (t) => {
  const { directory, launch } = await fixture(t, `await new Promise(r=>setTimeout(r,200));${finalEvents}`, { task: { timeout: 1 } });
  const preload = join(directory, "slow-ps.mjs");
  await writeFile(preload, `import cp from 'node:child_process';import {promisify} from 'node:util';import {syncBuiltinESMExports} from 'node:module';
const original=cp.execFile,exec=promisify(original);let first=true;
const wrapped=(...args)=>original(...args);
wrapped[promisify.custom]=async(...args)=>{const result=await exec(...args);if(args[0]==='/bin/ps'&&first){first=false;await new Promise(r=>setTimeout(r,1500));}return result;};
cp.execFile=wrapped;syncBuiltinESMExports();`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "done", result.error);
});

test("worker prompt hook preserves discovered append text and records pre-exit ancestry", async (t) => {
  const { directory } = await fixture(t, finalEvents);
  await writeFile(join(directory, "system.md"), "Worker role instructions");
  const old = { PI_HERDR_WORKER: process.env.PI_HERDR_WORKER, PI_HERDR_JOB_DIR: process.env.PI_HERDR_JOB_DIR };
  Object.assign(process.env, { PI_HERDR_WORKER: "1", PI_HERDR_JOB_DIR: directory });
  t.after(() => { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const handlers = new Map();
  promptExtension({ on: (name, fn) => handlers.set(name, fn) });
  const result = await handlers.get("before_agent_start")({ systemPrompt: "Base\nGlobal APPEND_SYSTEM\nTrusted project APPEND_SYSTEM" });
  assert.equal(result.systemPrompt, "Base\nGlobal APPEND_SYSTEM\nTrusted project APPEND_SYSTEM\n\nWorker role instructions");
  await handlers.get("session_shutdown")({ reason: "reload" });
  assert.equal(await stat(join(directory, "processes.json")).catch(() => undefined), undefined);
  await handlers.get("session_shutdown")({ reason: "quit" });
  assert.ok(JSON.parse(await readFile(join(directory, "processes.json"), "utf8")).some((p) => p.pid === process.pid));
});
