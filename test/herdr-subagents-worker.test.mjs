import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { atomic, launcher, validateTasks } from "../extensions/herdr-subagents/core.ts";
import promptExtension from "../extensions/herdr-subagents/prompt.ts";
import { snapshotProcesses } from "../extensions/herdr-subagents/process-tree.ts";

const finalEvents = `for(const event of [{type:'agent_start'},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'FINAL'}],stopReason:'stop'}},{type:'agent_end',willRetry:false},{type:'agent_settled'}]) console.log(JSON.stringify(event));`;
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
      env: { ...process.env, PI_HERDR_WORKER: "", HERDR_PANE_ID: "test:pane", PI_CODING_AGENT_DIR: join(directory, "agent"), ...extra.env }, stdio: "pipe",
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

async function checkpoint(directory, settled) {
  for (let i = 0; i < 100; i++) {
    const text = await readFile(join(directory, "checkpoint.json"), "utf8").catch(() => undefined);
    if (text) {
      const value = JSON.parse(text);
      if (value.report === "FINAL" && value.settled === settled) return value;
    }
    await delay(25);
  }
  assert.fail(`Worker did not checkpoint settled=${settled}: ${directory}`);
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
  assert.deepEqual(await checkpoint(directory, true), { report: "FINAL", settled: true });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
});

test("agent_end without agent_settled preserves text but cannot succeed", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents.replace(",{type:'agent_settled'}", ""));
  launch();
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.error, /without agent_settled/);
  assert.equal(result.report, "FINAL");
  assert.deepEqual(await checkpoint(directory, false), { report: "FINAL", settled: false });
  // Incomplete model work does not imply incomplete process cleanup.
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
});

test("a later run invalidates prior settlement and retains its own authoritative text", async (t) => {
  const { directory, launch } = await fixture(t, `${finalEvents}\n${finalEvents.replace(",{type:'agent_settled'}", "").replace("FINAL", "RETRY")}`);
  launch();
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.error, /without agent_settled/);
  assert.equal(result.report, "RETRY");
  assert.deepEqual(JSON.parse(await readFile(join(directory, "checkpoint.json"), "utf8")), { report: "RETRY", settled: false });
});

for (const settled of [false, true]) test(`private ${settled ? "settled" : "unsettled"} checkpoint survives supervisor loss before completion`, async (t) => {
  const { directory, launch } = await fixture(t, `
console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'DISPLAY ONLY'}}));
${settled ? finalEvents : finalEvents.replace(",{type:'agent_settled'}", "")}
setInterval(()=>{},1000);`);
  const { child, closed } = launch();
  assert.deepEqual(await checkpoint(directory, settled), { report: "FINAL", settled });
  assert.equal((await stat(join(directory, "checkpoint.json"))).mode & 0o777, 0o600);
  assert.equal(await stat(join(directory, "done.json")).catch(() => undefined), undefined);
  assert.equal(await stat(join(directory, "shutdown.json")).catch(() => undefined), undefined);
  child.kill("SIGKILL");
  await closed;
  assert.deepEqual(await checkpoint(directory, settled), { report: "FINAL", settled });
  assert.equal(await stat(join(directory, "done.json")).catch(() => undefined), undefined);
  assert.equal(await stat(join(directory, "shutdown.json")).catch(() => undefined), undefined);
});

test("a retry starting without a reply preserves prior text as an unsettled checkpoint", async (t) => {
  const { directory, launch } = await fixture(t, `${finalEvents}\nconsole.log(JSON.stringify({type:'agent_start'}));setInterval(()=>{},1000);`);
  launch();
  assert.deepEqual(await checkpoint(directory, false), { report: "FINAL", settled: false });
  await atomic(join(directory, "cancel.json"), {});
  const result = await done(directory);
  assert.equal(result.state, "cancelled");
  assert.equal(result.report, "FINAL");
});

test("settlement does not hide a nonzero Pi exit", async (t) => {
  const { directory, launch } = await fixture(t, `${finalEvents}\nprocess.exitCode=1;`);
  launch();
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.error, /exited with code 1/);
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
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
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
  const shutdown = await readFile(join(directory, "shutdown.json"), "utf8");
  const checkpoint = await readFile(join(directory, "checkpoint.json"), "utf8");
  const duplicate = launch();
  assert.equal((await duplicate.closed)[0], 1);
  assert.equal(await readFile(join(directory, "done.json"), "utf8"), original);
  assert.equal(await readFile(join(directory, "shutdown.json"), "utf8"), shutdown);
  assert.equal(await readFile(join(directory, "checkpoint.json"), "utf8"), checkpoint);
});

test("a parent-won startup claim fences delayed launches", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  await atomic(join(directory, "worker.json"), { cancelled: true }, true);
  await atomic(join(directory, "shutdown.json"), { verified: true }, true);
  const { closed } = launch();
  assert.equal((await closed)[0], 0);
  assert.equal(await stat(join(directory, "pi.pid")).catch(() => undefined), undefined);
  assert.equal(await stat(join(directory, "done.json")).catch(() => undefined), undefined);
  assert.equal(await stat(join(directory, "checkpoint.json")).catch(() => undefined), undefined);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
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
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
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
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
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
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
  await dead(Number(await readFile(join(directory, "descendant.pid"), "utf8")));
});

test("slow initial ps cannot time out a Pi process that already exited successfully", async (t) => {
  const { directory, launch } = await fixture(t, `await new Promise(r=>setTimeout(r,200));${finalEvents}`, { task: { timeout: 1 } });
  const preload = join(directory, "slow-ps.mjs");
  await writeFile(preload, `import cp from 'node:child_process';import {promisify} from 'node:util';import {syncBuiltinESMExports} from 'node:module';
const original=cp.execFile,exec=promisify(original),spawn=cp.spawn;let first=true,launched=false;
cp.spawn=(...args)=>{launched=true;return spawn(...args);};
const wrapped=(...args)=>original(...args);
wrapped[promisify.custom]=async(...args)=>{const result=await exec(...args);if(args[0]==='/bin/ps'&&first&&launched&&process.env.PI_HERDR_WORKER==='1'){first=false;await new Promise(r=>setTimeout(r,1500));}return result;};
cp.execFile=wrapped;syncBuiltinESMExports();`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "done", result.error);
});

test("shutdown acknowledgement waits for post-SIGKILL verification", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const preload = join(directory, "delayed-verification.mjs");
  await writeFile(preload, `import {ProcessTree} from ${JSON.stringify(processModule)};import {existsSync,writeFileSync} from 'node:fs';
const original=ProcessTree.prototype.signal;let kills=0;
ProcessTree.prototype.signal=async function(signal){
 const count=await original.call(this,signal);
 if(signal==='SIGKILL'){
  kills++;if(existsSync(${JSON.stringify(join(directory, "shutdown.json"))}))throw new Error('premature acknowledgement');
  writeFileSync(${JSON.stringify(join(directory, "kill-passes"))},String(kills));
  if(kills<3)return Math.max(1,count);
 }
 return count;
};`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "done", result.error);
  assert.ok(Number(await readFile(join(directory, "kill-passes"), "utf8")) >= 3);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
});

test("unverified survivors fail within a bounded wait without a shutdown acknowledgement", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const preload = join(directory, "unverified-survivors.mjs");
  await writeFile(preload, `import {ProcessTree} from ${JSON.stringify(processModule)};
const original=ProcessTree.prototype.signal;
ProcessTree.prototype.signal=async function(signal){const count=await original.call(this,signal);return signal==='SIGKILL'?Math.max(1,count):count;};`);
  const started = Date.now();
  const { child } = launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.cleanupError, /could not verify/);
  assert.ok(Date.now() - started < 7000);
  assert.equal(result.report, "FINAL");
  assert.equal(await stat(join(directory, "shutdown.json")).catch(() => undefined), undefined);
  assert.equal(child.exitCode, null, "failed-cleanup pane must remain available");
});

for (const stage of ["initial", "polling", "cleanup"]) test(`${stage} process snapshot failure cannot publish verified cleanup`, async (t) => {
  const { directory, launch } = await fixture(t, `${finalEvents}${stage === "polling" ? "setInterval(()=>{},1000);" : ""}`);
  const preload = join(directory, "snapshot-failure.mjs");
  if (stage === "initial") await writeFile(preload, `import cp from 'node:child_process';import {promisify} from 'node:util';import {syncBuiltinESMExports} from 'node:module';
const original=cp.execFile,exec=promisify(original),spawn=cp.spawn;let first=true,launched=false;
cp.spawn=(...args)=>{launched=true;return spawn(...args);};
const wrapped=(...args)=>original(...args);
wrapped[promisify.custom]=async(...args)=>{if(args[0]==='/bin/ps'&&first&&launched&&process.env.PI_HERDR_WORKER==='1'){first=false;throw new Error('injected snapshot failure');}return exec(...args);};
cp.execFile=wrapped;syncBuiltinESMExports();`);
  else if (stage === "polling") await writeFile(preload, `import {ProcessTree} from ${JSON.stringify(processModule)};
const original=ProcessTree.prototype.refresh;
ProcessTree.prototype.refresh=async function(snapshot){if(snapshot===undefined)throw new Error('injected snapshot failure');return original.call(this,snapshot);};`);
  else {
    await writeFile(preload, "");
    await writeFile(join(directory, "processes.json"), "invalid snapshot");
  }
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.cleanupError, /Process snapshot failed/);
  assert.equal(await stat(join(directory, "shutdown.json")).catch(() => undefined), undefined);
  const pid = Number(await readFile(join(directory, "pi.pid"), "utf8").catch(() => ""));
  if (pid) await dead(pid);
});

test("an initial snapshot missing the root cannot verify cleanup", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const preload = join(directory, "missed-root.mjs");
  await writeFile(preload, `import cp from 'node:child_process';import {promisify} from 'node:util';import {syncBuiltinESMExports} from 'node:module';
const original=cp.execFile,exec=promisify(original),spawn=cp.spawn;let first=true,launched=false;
cp.spawn=(...args)=>{launched=true;return spawn(...args);};
const wrapped=(...args)=>original(...args);
wrapped[promisify.custom]=async(...args)=>{
 const result=await exec(...args);
 if(args[0]==='/bin/ps'&&first&&launched&&process.env.PI_HERDR_WORKER==='1'){first=false;result.stdout=result.stdout.split('\\n').filter(row=>Number(row.trim().split(/\\s+/)[1])!==process.pid).join('\\n');}
 return result;
};cp.execFile=wrapped;syncBuiltinESMExports();`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.cleanupError, /Initial process snapshot missed Pi/);
  assert.equal(await stat(join(directory, "shutdown.json")).catch(() => undefined), undefined);
});

test("a signaling failure remains unsafe even if a later recheck sees no descendants", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const preload = join(directory, "signal-failure.mjs");
  await writeFile(preload, `import {ProcessTree} from ${JSON.stringify(processModule)};
const original=ProcessTree.prototype.signal;let first=true;
ProcessTree.prototype.signal=async function(signal){if(first){first=false;throw new Error('injected cleanup failure');}return original.call(this,signal);};`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.cleanupError, /Process cleanup failed.*injected cleanup failure/);
  assert.equal(await stat(join(directory, "shutdown.json")).catch(() => undefined), undefined);
});

test("failed shutdown acknowledgement publication is reported as cleanup failure", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const preload = join(directory, "ack-failure.mjs");
  await writeFile(preload, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const original=fs.rename;
fs.rename=async function(source,target){if(String(target).endsWith('/shutdown.json'))throw new Error('injected acknowledgement failure');return original(source,target);};syncBuiltinESMExports();`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.cleanupError, /Saving shutdown.json failed.*injected acknowledgement failure/);
  assert.equal(await stat(join(directory, "shutdown.json")).catch(() => undefined), undefined);
  assert.deepEqual(await checkpoint(directory, true), { report: "FINAL", settled: true });
});

test("failed checkpoint publication fails the report without confusing cleanup evidence", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const preload = join(directory, "checkpoint-failure.mjs");
  await writeFile(preload, `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const original=fs.rename;
fs.rename=async function(source,target){if(String(target).endsWith('/checkpoint.json'))throw new Error('injected checkpoint failure');return original(source,target);};syncBuiltinESMExports();`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.error, /Saving checkpoint.json failed.*injected checkpoint failure/);
  assert.equal(result.cleanupError, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
});

function rpcProgram(promptBody, otherBody = "") {
  return `import {appendFileSync} from 'node:fs';
const emit=event=>console.log(JSON.stringify(event));
const answer=(command,data={},success=true)=>emit({type:'response',id:command.id,command:command.type,success,...(success?{data}:{error:'prompt denied'})});
let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk;let newline;while((newline=input.indexOf('\\n'))>=0){
 const command=JSON.parse(input.slice(0,newline));input=input.slice(newline+1);
 appendFileSync(new URL('./commands.jsonl',import.meta.url),JSON.stringify(command)+'\\n');
 if(command.type==='prompt'){${promptBody}}
 else if(command.type==='get_state')answer(command,{pendingMessageCount:0,isStreaming:false,isCompacting:false});
 else if(command.type==='clear_queue'||command.type==='abort')answer(command);
 ${otherBody}
}});
process.stdin.on('end',()=>writeFileSync(new URL('./eof',import.meta.url),'closed'));`;
}

test("persistent worker sends RPC JSON prompt, settles, closes stdin, and acknowledges cleanup", async (t) => {
  const { directory, launch } = await fixture(t, rpcProgram(`answer(command,{disposition:'started'});${finalEvents}`), { task: { persistent: true, prompt: "@literal\\n\u2028\u2029" } });
  launch();
  const result = await done(directory);
  assert.equal(result.state, "done", result.error);
  assert.equal(result.report, "FINAL");
  const commands = (await readFile(join(directory, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(commands[0].type, "prompt");
  assert.equal(commands[0].message, "@literal\\n\u2028\u2029");
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "get_state"]);
  assert.ok(await stat(join(directory, "eof")));
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
});

test("persistent worker mailbox delivers controls once and rejects controls after settlement", async (t) => {
  const { directory, launch } = await fixture(t, rpcProgram(`answer(command,{disposition:'started'});emit({type:'agent_start'});writeFileSync(new URL('./ready',import.meta.url),'ready');`, `else if(command.type==='steer'){answer(command,{disposition:'queued'});}
else if(command.type==='follow_up'){answer(command,{disposition:'handled'});setTimeout(()=>{${finalEvents}},50);}`), { task: { persistent: true } });
  launch();
  for (let i = 0; i < 150 && !await stat(join(directory, "ready")).catch(() => undefined); i++) await delay(20);
  assert.ok(await stat(join(directory, "ready")));
  await mkdir(join(directory, "control"), { recursive: true });
  // Publish the second only after the first response, so fake Pi settles after both.
  for (const kind of ["steer", "follow_up"]) {
    const id = `request-${kind}`;
    const base = join(directory, "control", createHash("sha256").update(id).digest("hex"));
    await atomic(`${base}.json`, { id, kind, message: "literal control" });
    for (let i = 0; i < 150 && !await stat(`${base}.reply.json`).catch(() => undefined); i++) await delay(20);
    const reply = JSON.parse(await readFile(`${base}.reply.json`, "utf8"));
    assert.deepEqual(reply, { state: "accepted", disposition: kind === "steer" ? "queued" : "handled" });
    assert.equal(JSON.parse(await readFile(`${base}.attempted.json`, "utf8")).id, id);
  }
  assert.equal((await done(directory)).state, "done");
  const commands = (await readFile(join(directory, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(commands.filter((command) => command.type === "steer").length, 1);
  assert.equal(commands.filter((command) => command.type === "follow_up").length, 1);
  const base = join(directory, "control", createHash("sha256").update("late").digest("hex"));
  await atomic(`${base}.json`, { id: "late", kind: "steer", message: "too late" });
  for (let i = 0; i < 150 && !await stat(`${base}.reply.json`).catch(() => undefined); i++) await delay(20);
  assert.equal(JSON.parse(await readFile(`${base}.reply.json`, "utf8")).state, "rejected");
});

test("RPC timeout escalates and reaps detached tools when Pi cannot handle graceful abort", async (t) => {
  const program = `import {spawn} from 'node:child_process';\n` + rpcProgram(`answer(command,{disposition:'started'});
const tool=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
writeFileSync(new URL('./descendant.pid',import.meta.url),String(tool.pid));process.kill(process.pid,'SIGSTOP');`);
  const { directory, launch } = await fixture(t, program, { task: { persistent: true, timeout: 1 } });
  launch();
  const result = await done(directory);
  assert.equal(result.state, "cancelled", result.error);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
  await dead(Number(await readFile(join(directory, "pi.pid"), "utf8")));
  await dead(Number(await readFile(join(directory, "descendant.pid"), "utf8")));
});

for (const disposition of ["handled", "rejected"]) test(`persistent worker finalizes ${disposition} prompt without waiting for task timeout`, async (t) => {
  const { directory, launch } = await fixture(t, rpcProgram(`answer(command,{disposition:'${disposition}'},${disposition !== "rejected"});`), { task: { persistent: true } });
  const started = Date.now();
  launch();
  const result = await done(directory);
  assert.equal(result.state, "failed");
  assert.match(result.error, disposition === "handled" ? /handled without starting/ : /prompt rejected.*prompt denied/);
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
});

for (const cancellation of ["cancel.json", "stop.json", "SIGTERM"]) test(`persistent worker ${cancellation} clears then aborts before verified cleanup`, async (t) => {
  const { directory, launch } = await fixture(t, rpcProgram(`answer(command,{disposition:'started'});emit({type:'agent_start'});writeFileSync(new URL('./ready',import.meta.url),'ready');`), { task: { persistent: true } });
  const { child } = launch();
  for (let i = 0; i < 150 && !await stat(join(directory, "ready")).catch(() => undefined); i++) await delay(20);
  assert.ok(await stat(join(directory, "ready")));
  if (cancellation === "SIGTERM") child.kill("SIGTERM");
  else await atomic(join(directory, cancellation), {});
  const result = await done(directory);
  assert.equal(result.state, "cancelled", result.error);
  const commands = (await readFile(join(directory, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "clear_queue", "abort"]);
  assert.ok(await stat(join(directory, "eof")));
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
});

test("persistent worker cancels extension UI instead of hanging", async (t) => {
  const { directory, launch } = await fixture(t, rpcProgram(`answer(command,{disposition:'started'});emit({type:'extension_ui_request',id:'ui',method:'confirm',title:'Allow?'});`, `else if(command.type==='extension_ui_response'){if(command.id!=='ui'||command.cancelled!==true)process.exit(2);${finalEvents}}`), { task: { persistent: true } });
  launch();
  assert.equal((await done(directory)).state, "done");
});

for (const source of ["assistant", "tool", "compaction"]) test(`soft budgets stop on finalized ${source} usage`, async (t) => {
  const usage = { totalTokens: 8, cost: { total: 0.2 } };
  const event = source === "assistant" ? { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "BUDGET" }], stopReason: "stop", usage } }
    : source === "tool" ? { type: "message_end", message: { role: "toolResult", usage } }
    : { type: "compaction_end", result: { usage } };
  const { directory, launch } = await fixture(t, `console.log(${JSON.stringify(JSON.stringify(event))});setInterval(()=>{},1000);`, { task: source === "tool" ? { maxCost: 0.1 } : { maxTokens: 5 } });
  launch();
  const result = await done(directory);
  assert.equal(result.state, "cancelled", result.error);
  assert.match(result.error, /Soft (token|cost) budget reached/);
  const progress = JSON.parse(await readFile(join(directory, "progress.json"), "utf8"));
  assert.equal(progress.usage.totalTokens, 8);
  assert.equal(progress.usage.cost.total, 0.2);
});

for (const cancellation of ["cancel.json", "SIGTERM"]) test(`queued worker ${cancellation} cancels independently without starting Pi`, async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const preload = join(directory, "queued-scheduler.mjs");
  const scheduler = `import {writeFileSync} from 'node:fs';
export async function acquireSlot(directory,signal){writeFileSync(directory+'/queued','waiting');await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
export async function releaseSlot(){throw new Error('unacquired slot released');}`;
  await writeFile(preload, `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='./scheduler.ts')return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(scheduler)}`)},shortCircuit:true};return next(specifier,context);}});`);
  const { child, closed } = launch({ preload });
  for (let i = 0; i < 150 && !await stat(join(directory, "queued")).catch(() => undefined); i++) await delay(20);
  assert.ok(await stat(join(directory, "queued")));
  if (cancellation === "SIGTERM") child.kill("SIGTERM");
  else await atomic(join(directory, cancellation), {});
  await closed;
  const result = await done(directory);
  assert.equal(result.state, "cancelled", result.error);
  assert.equal(result.cleanupError, undefined);
  assert.equal(await stat(join(directory, "pi.pid")).catch(() => undefined), undefined);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "shutdown.json"), "utf8")), { verified: true });
});

for (const unsafe of [false, true]) test(`scheduler slot ${unsafe ? "retained on unverified" : "released after verified"} cleanup`, async (t) => {
  const { directory, launch } = await fixture(t, finalEvents);
  const preload = join(directory, "record-scheduler.mjs");
  const scheduler = `import {writeFileSync} from 'node:fs';
export async function acquireSlot(){}
export async function releaseSlot(directory){if(!globalThis.cleanupChecked)throw new Error('released before verified cleanup');writeFileSync(directory+'/released','released');}`;
  await writeFile(preload, `import {registerHooks} from 'node:module';import {ProcessTree} from ${JSON.stringify(processModule)};
registerHooks({resolve(specifier,context,next){if(specifier==='./scheduler.ts')return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(scheduler)}`)},shortCircuit:true};return next(specifier,context);}});
const original=ProcessTree.prototype.signal;let kills=0;
ProcessTree.prototype.signal=async function(signal){const count=await original.call(this,signal);if(signal==='SIGKILL'){kills++;if(${unsafe})return Math.max(1,count);if(kills>=2&&count===0)globalThis.cleanupChecked=true;}return count;};`);
  launch({ preload });
  const result = await done(directory);
  assert.equal(result.state, unsafe ? "failed" : "done", result.error);
  assert.equal(Boolean(await stat(join(directory, "released")).catch(() => undefined)), !unsafe);
});

test("optional agent presentation failures are diagnostic, not task failures", async (t) => {
  const { directory, launch } = await fixture(t, finalEvents, { task: { presentation: "agent" } });
  const preload = join(directory, "failed-presentation.mjs");
  const presentation = `export async function publishPresentation(){throw new Error('injected presentation failure');}`;
  await writeFile(preload, `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='./presentation.ts')return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(presentation)}`)},shortCircuit:true};return next(specifier,context);}});`);
  launch({ preload });
  assert.equal((await done(directory)).state, "done");
  for (let i = 0; i < 50 && (await readFile(join(directory, "presentation-error.log"), "utf8")).trim().split("\n").length < 2; i++) await delay(20);
  assert.equal((await readFile(join(directory, "presentation-error.log"), "utf8")).match(/injected presentation failure/g).length, 2);
});

test("streamed usage does not prematurely consume soft budgets", async (t) => {
  const { directory, launch } = await fixture(t, `console.log(JSON.stringify({type:'message_update',usage:{totalTokens:999,cost:{total:999}},assistantMessageEvent:{type:'text_delta',delta:'preview'}}));${finalEvents}`, { task: { maxTokens: 5, maxCost: 0.1 } });
  launch();
  assert.equal((await done(directory)).state, "done");
});

test("worker prompt hook preserves discovered append text and records pre-exit ancestry", async (t) => {
  const { directory } = await fixture(t, finalEvents);
  await writeFile(join(directory, "system.md"), "Worker role instructions");
  const old = { PI_HERDR_WORKER: process.env.PI_HERDR_WORKER, PI_HERDR_JOB_DIR: process.env.PI_HERDR_JOB_DIR };
  Object.assign(process.env, { PI_HERDR_WORKER: "1", PI_HERDR_JOB_DIR: directory });
  t.after(() => { for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const handlers = new Map();
  promptExtension({ on: (name, fn) => handlers.set(name, fn) });
  const systemPromptOptions = { appendSystemPrompt: "Discovered APPEND_SYSTEM", sections: { other: "Other extension" } };
  assert.equal(await handlers.get("before_agent_start")({ systemPromptOptions }), undefined);
  assert.deepEqual(systemPromptOptions, {
    appendSystemPrompt: "Discovered APPEND_SYSTEM",
    sections: { other: "Other extension", herdr_subagent: "Worker role instructions" },
  });
  await handlers.get("session_shutdown")({ reason: "reload" });
  assert.equal(await stat(join(directory, "processes.json")).catch(() => undefined), undefined);
  await handlers.get("session_shutdown")({ reason: "quit" });
  assert.ok(JSON.parse(await readFile(join(directory, "processes.json"), "utf8")).some((p) => p.pid === process.pid));
});
