import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  atomic, cleanup, collect, jobs, locked, RequestDiagnosticError, requestFingerprint,
  requestStatus, scopeFor, spawnTasks, status, validateTasks,
} from "../extensions/herdr-subagents/core.ts";
import { processIdentity } from "../extensions/herdr-subagents/identity.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "request-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = join(directory, "herdr.mjs");
  const statePath = join(directory, "panes.json");
  await writeFile(statePath, JSON.stringify({ calls: [], panes: [{ pane_id: "main", terminal_id: "parent" }] }));
  await writeFile(backend, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.FAKE_STATE, args=process.argv.slice(2);
const state=JSON.parse(readFileSync(file,'utf8'));state.calls.push(args);
let result={};
if(args[1]==='current') result={pane:state.panes[0]};
if(args[1]==='list') result={panes:state.panes};
if(args[1]==='layout') result={layout:{panes:state.panes.map(p=>({...p,rect:{width:100,height:40}}))}};
if(args[1]==='split') { const pane={pane_id:'p'+state.calls.length,terminal_id:'t'+state.calls.length};state.panes.push(pane);result={pane}; }
if(args[1]==='close') state.panes=state.panes.filter(p=>p.pane_id!==args[2]);
writeFileSync(file,JSON.stringify(state));
if(process.env.FAKE_FAIL===args[1]) {console.error('injected failure');process.exit(1);}
if(args[1]!=='run') console.log(JSON.stringify({result}));
`);
  await chmod(backend, 0o700);
  const env = { ...process.env, PI_HERDR_WORKER: "", PI_CODING_AGENT_DIR: directory,
    HERDR_ENV: "1", HERDR_PANE_ID: "main", HERDR_WORKSPACE_ID: "w", HERDR_SOCKET_PATH: "fake.sock",
    HERDR_BIN_PATH: backend, PI_HERDR_PI_BIN: process.execPath, FAKE_STATE: statePath };
  const scope = scopeFor("session-a", env);
  const tasks = validateTasks([{ name: "private-worker", prompt: "SECRET_PROMPT_NEVER_OUTPUT", model: "private/model" }], {}, directory);
  const calls = async () => JSON.parse(await readFile(statePath, "utf8")).calls;
  const journal = (id) => join(scope.root, "requests", `${createHash("sha256").update(id).digest("hex")}.json`);
  const record = async (id, value) => { await mkdir(join(scope.root, "requests"), { recursive: true }); await atomic(journal(id), value); };
  return { directory, scope, tasks, calls, journal, record };
}

function noLeak(value, f) {
  const text = JSON.stringify(value);
  for (const secret of ["SECRET_PROMPT_NEVER_OUTPUT", "private/model", f.directory, '"task":', '"prompt":', '"cwd":', '"fingerprint":']) assert.ok(!text.includes(secret), secret);
  assert.ok(Buffer.byteLength(text) < 6000);
}

async function diagnosticError(promise, code, expected) {
  let result;
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof RequestDiagnosticError);
    assert.equal(error.code, code);
    assert.deepEqual(error.diagnostic, expected);
    assert.deepEqual(error.inspection, { action: "request_status", requestId: expected.requestId });
    result = error;
    return true;
  });
  return result;
}

test("request history retains actually launched, collected, closed jobs without Herdr or private payloads", async (t) => {
  const f = await fixture(t);
  const [job] = await spawnTasks(f.scope, f.tasks, "history");
  await atomic(join(f.scope.root, job.id, "done.json"), { state: "done", report: "SECRET_REPORT" });
  await atomic(join(f.scope.root, job.id, "shutdown.json"), { verified: true });
  await collect(f.scope, 0, async () => {});
  await cleanup(f.scope);
  assert.deepEqual(await status(f.scope), { jobs: [] });
  const before = await f.calls();
  const diagnostic = await requestStatus({ ...f.scope, env: { ...f.scope.env, HERDR_BIN_PATH: "/no-herdr" } }, "history");
  assert.deepEqual(diagnostic, { requestId: "history", scope: basename(f.scope.root), found: true, admissionState: "done",
    jobs: [{ id: job.id, name: "private-worker", collected: true, closed: true, artifactMissing: false }] });
  noLeak(diagnostic, f);
  assert.ok(!JSON.stringify(diagnostic).includes("SECRET_REPORT"));
  assert.deepEqual(await spawnTasks(f.scope, f.tasks, "history"), await jobs(f.scope));
  assert.deepEqual(await f.calls(), before);
});

test("unknown IDs and different Pi sessions are isolated; restored panes retain the same scope identity", async (t) => {
  const f = await fixture(t);
  await spawnTasks(f.scope, f.tasks, "shared-id");
  const other = scopeFor("session-b", f.scope.env);
  const missing = await requestStatus(other, "shared-id");
  assert.deepEqual(missing, { requestId: "shared-id", scope: basename(other.root), found: false, jobs: [] });
  assert.notEqual(missing.scope, (await requestStatus(f.scope, "shared-id")).scope);
  assert.deepEqual(await requestStatus(f.scope, "unknown"), { ...missing, requestId: "unknown", scope: basename(f.scope.root) });
  const restored = scopeFor("session-a", { ...f.scope.env, HERDR_SOCKET_PATH: "restored.sock", HERDR_PANE_ID: "restored" });
  assert.deepEqual(await requestStatus(restored, "shared-id"), await requestStatus(f.scope, "shared-id"));
  for (const invalid of ["../escape", "", "a".repeat(129), "x\n", 123]) await assert.rejects(requestStatus(f.scope, invalid), /Invalid spawn requestId/);
});

test("conflicts include stable structured diagnostics before resolving changed defaults, without launch side effects", async (t) => {
  const f = await fixture(t);
  const intent = [{ name: "private-worker", prompt: "SECRET_PROMPT_NEVER_OUTPUT" }];
  let resolutions = 0;
  await spawnTasks(f.scope, { intent, resolve: async () => { resolutions++; return f.tasks; } }, "collision");
  const before = await f.calls();
  const expected = await requestStatus(f.scope, "collision");
  const error = await diagnosticError(spawnTasks(f.scope, { intent: [{ ...intent[0], prompt: "different" }], resolve: async () => { throw new Error("Must not resolve"); } }, "collision"), "REQUEST_ID_CONFLICT", expected);
  assert.match(error.message, /different tasks/);
  noLeak(error, f);
  await spawnTasks(f.scope, { intent, resolve: async () => { throw new Error("Changed defaults must not resolve"); } }, "collision");
  assert.equal(resolutions, 1);
  assert.deepEqual(await f.calls(), before);
});

test("interrupted and failed admissions forbid replay while reporting saved jobs", async (t) => {
  const f = await fixture(t);
  const [job] = await spawnTasks(f.scope, f.tasks, "interrupted");
  const record = JSON.parse(await readFile(f.journal("interrupted"), "utf8"));
  await f.record("interrupted", { ...record, state: "starting" });
  const before = await f.calls();
  const expected = await requestStatus(f.scope, "interrupted");
  assert.equal(expected.jobs[0].id, job.id);
  const error = await diagnosticError(spawnTasks(f.scope, f.tasks, "interrupted"), "REQUEST_NOT_REPLAYABLE", expected);
  assert.match(error.message, /starting.*not be replayed/);
  assert.deepEqual(await f.calls(), before);
  const failedTasks = [{ ...f.tasks[0], name: "lost-split" }];
  await assert.rejects(spawnTasks({ ...f.scope, env: { ...f.scope.env, FAKE_FAIL: "split" } }, failedTasks, "failed"), /ownership is unresolved/);
  const failed = await requestStatus(f.scope, "failed");
  assert.equal(failed.admissionState, "failed");
  assert.equal(failed.jobs.length, 1);
  const afterFailure = await f.calls();
  const failure = await diagnosticError(spawnTasks(f.scope, failedTasks, "failed"), "REQUEST_NOT_REPLAYABLE", failed);
  assert.match(failure.message, /failed.*not be replayed/);
  assert.deepEqual(await f.calls(), afterFailure);
});

test("missing or unusable job artifacts are explicit, never relaunched and do not expose parser input", async (t) => {
  const f = await fixture(t);
  const [job] = await spawnTasks(f.scope, f.tasks, "missing");
  const before = await f.calls();
  for (const contents of [undefined, '{"SECRET_PROMPT_NEVER_OUTPUT":', JSON.stringify({ ...job, id: "../escape" })]) {
    await rm(join(f.scope.root, job.id, "job.json"), { force: true });
    if (contents !== undefined) await writeFile(join(f.scope.root, job.id, "job.json"), contents);
    const diagnostic = await requestStatus(f.scope, "missing");
    assert.deepEqual(diagnostic.jobs, [{ id: job.id, artifactMissing: true }]);
    assert.equal(diagnostic.artifactsIncomplete, true);
    const error = await diagnosticError(spawnTasks(f.scope, f.tasks, "missing"), "REQUEST_ARTIFACT_MISSING", diagnostic);
    assert.match(error.message, /artifact missing/);
    noLeak(error, f);
  }
  assert.deepEqual(await f.calls(), before);
});

test("malformed journals stay found, bound jobs and output, and cannot bypass replay fencing", async (t) => {
  const f = await fixture(t);
  const fingerprint = requestFingerprint([f.tasks, undefined]);
  const ids = Array.from({ length: 20 }, (_, n) => n.toString(16).padStart(12, "0"));
  const variants = [null, [], {}, { fingerprint, state: "SECRET_PROMPT_NEVER_OUTPUT", jobs: [] },
    { fingerprint, state: "done", jobs: ["../escape", ids[0], ids[0], "x".repeat(100000)] },
    { fingerprint, state: "done", jobs: ids }];
  for (const value of variants) {
    await f.record("corrupt", value);
    const diagnostic = await requestStatus(f.scope, "corrupt");
    assert.equal(diagnostic.found, true);
    assert.equal(diagnostic.artifactsIncomplete, true);
    assert.ok(diagnostic.jobs.length <= 16);
    const error = await diagnosticError(spawnTasks(f.scope, f.tasks, "corrupt"), "REQUEST_NOT_REPLAYABLE", diagnostic);
    noLeak(error, f);
  }
  const bounded = await requestStatus(f.scope, "corrupt");
  assert.equal(bounded.jobs.length, 16);
  assert.equal(bounded.jobsOmitted, 4);
  await writeFile(f.journal("corrupt"), '{"SECRET_PROMPT_NEVER_OUTPUT":');
  assert.equal((await requestStatus(f.scope, "corrupt")).found, true);
  await truncate(f.journal("corrupt"), 33 * 1024 * 1024);
  const oversized = await requestStatus(f.scope, "corrupt");
  assert.deepEqual(oversized.jobs, []);
  assert.equal(oversized.artifactsIncomplete, true);
  await diagnosticError(spawnTasks(f.scope, f.tasks, "corrupt"), "REQUEST_NOT_REPLAYABLE", oversized);
  assert.deepEqual(await f.calls(), []);
});

test("completed admission rejects empty or shortened job lists instead of reporting successful replay", async (t) => {
  const f = await fixture(t);
  const tasks = [f.tasks[0], { ...f.tasks[0], name: "second" }];
  await spawnTasks(f.scope, tasks, "shortened");
  const saved = JSON.parse(await readFile(f.journal("shortened"), "utf8"));
  const before = await f.calls();
  for (const ids of [[], saved.jobs.slice(0, 1)]) {
    await f.record("shortened", { ...saved, jobs: ids });
    const diagnostic = await requestStatus(f.scope, "shortened");
    assert.equal(diagnostic.artifactsIncomplete, true);
    await diagnosticError(spawnTasks(f.scope, tasks, "shortened"), "REQUEST_NOT_REPLAYABLE", diagnostic);
  }
  assert.deepEqual(await f.calls(), before);
});

test("artifact symlinks and symlinked directories cannot import another scope's metadata", async (t) => {
  const f = await fixture(t);
  const [job] = await spawnTasks(f.scope, f.tasks, "links");
  const external = join(f.directory, "external");
  await mkdir(external);
  await atomic(join(external, "job.json"), { ...job, task: { ...job.task, name: "outside" } });
  await rm(join(f.scope.root, job.id), { recursive: true });
  await symlink(external, join(f.scope.root, job.id));
  assert.deepEqual((await requestStatus(f.scope, "links")).jobs, [{ id: job.id, artifactMissing: true }]);
  await rm(join(f.scope.root, job.id));
  await mkdir(join(f.scope.root, job.id));
  await symlink(join(external, "job.json"), join(f.scope.root, job.id, "job.json"));
  assert.equal((await requestStatus(f.scope, "links")).jobs[0].artifactMissing, true);
  const saved = await readFile(f.journal("links"));
  await writeFile(join(external, "record.json"), saved);
  await rm(f.journal("links"));
  await symlink(join(external, "record.json"), f.journal("links"));
  const diagnostic = await requestStatus(f.scope, "links");
  assert.equal(diagnostic.found, true);
  assert.equal(diagnostic.artifactsIncomplete, true);
  assert.deepEqual(diagnostic.jobs, []);
});

test("ownership and abort admission fence historical inspection and replay", async (t) => {
  const f = await fixture(t);
  await spawnTasks(f.scope, f.tasks, "owned");
  const identity = await processIdentity();
  const authority = { token: "owner-a", identity };
  await atomic(join(f.scope.root, "owner.json"), authority);
  const owned = { ...f.scope, authority };
  assert.equal((await requestStatus(owned, "owned")).found, true);
  const before = await f.calls();
  let pending, replay;
  await locked(f.scope, async () => {
    pending = assert.rejects(requestStatus(owned, "owned"), /ownership changed or ended/);
    replay = assert.rejects(spawnTasks(owned, f.tasks, "owned"), /ownership changed or ended/);
    await delay(60);
    await atomic(join(f.scope.root, "owner.json"), { ...authority, token: "owner-b" });
  });
  await Promise.all([pending, replay]);
  const controller = new AbortController();
  await locked(f.scope, async () => {
    pending = assert.rejects(requestStatus(f.scope, "owned", controller.signal), /abort/i);
    replay = assert.rejects(spawnTasks(f.scope, f.tasks, "owned", controller.signal), /abort/i);
    await delay(60);
    controller.abort();
  });
  await Promise.all([pending, replay]);
  const newScope = scopeFor("never-created", f.scope.env);
  await assert.rejects(requestStatus(newScope, "unknown", controller.signal), /abort/i);
  await assert.rejects(readdir(newScope.root), { code: "ENOENT" });
  assert.deepEqual(await f.calls(), before);
  assert.deepEqual(await readdir(join(f.scope.root, "locks")), []);
});
