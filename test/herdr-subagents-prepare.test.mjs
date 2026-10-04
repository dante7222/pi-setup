import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  atomic, cleanup, collect, jobs, locked, prepareTasks, RequestDiagnosticError,
  requestFingerprint, requestStatus, scopeFor, spawnTasks, validateTasks,
} from "../extensions/herdr-subagents/core.ts";
import { processIdentity } from "../extensions/herdr-subagents/identity.ts";
import { configurePresets, resolveTasks } from "../extensions/herdr-subagents/policy.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "prepare-requests-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = join(directory, "herdr.mjs");
  const statePath = join(directory, "panes.json");
  await writeFile(statePath, JSON.stringify({ calls: [], panes: [{ pane_id: "main", terminal_id: "parent" }] }));
  await writeFile(backend, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.FAKE_STATE,args=process.argv.slice(2),state=JSON.parse(readFileSync(file,'utf8'));state.calls.push(args);
let result={};
if(args[1]==='current') result={pane:state.panes[0]};
if(args[1]==='list') result={panes:state.panes};
if(args[1]==='layout') result={layout:{panes:state.panes.map(p=>({...p,rect:{width:100,height:40}}))}};
if(args[1]==='split'){const pane={pane_id:'p'+state.calls.length,terminal_id:'t'+state.calls.length};state.panes.push(pane);result={pane};}
if(args[1]==='close') state.panes=state.panes.filter(p=>p.pane_id!==args[2]);
writeFileSync(file,JSON.stringify(state));
if(process.env.FAKE_FAIL===args[1]){console.error('injected failure');process.exit(1);}
if(args[1]!=='run') console.log(JSON.stringify({result}));
`);
  await chmod(backend, 0o700);
  const env = { ...process.env, PI_HERDR_WORKER: "", PI_CODING_AGENT_DIR: directory,
    HERDR_ENV: "1", HERDR_PANE_ID: "main", HERDR_WORKSPACE_ID: "w", HERDR_SOCKET_PATH: "fake.sock",
    HERDR_BIN_PATH: backend, PI_HERDR_PI_BIN: process.execPath, FAKE_STATE: statePath };
  const scope = scopeFor("prepared-session", env);
  const journal = (id) => join(scope.root, "requests", `${createHash("sha256").update(id).digest("hex")}.json`);
  const saved = async (id) => JSON.parse(await readFile(journal(id), "utf8"));
  const calls = async () => JSON.parse(await readFile(statePath, "utf8")).calls;
  const plan = (intent) => ({ intent, resolve: (input) => resolveTasks(scope, input, env, directory) });
  return { directory, scope, env, journal, saved, calls, plan };
}

const intent = [{ name: "private-worker", prompt: "SECRET_PROMPT" }];

async function rejectsDiagnostic(promise, code = "REQUEST_NOT_REPLAYABLE") {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof RequestDiagnosticError);
    assert.equal(error.code, code);
    assert.deepEqual(error.inspection, { action: "request_status", requestId: error.diagnostic.requestId });
    assert.ok(!JSON.stringify(error).includes("SECRET_PROMPT"));
    return true;
  });
}

test("prepare snapshots exact large intent privately without reading defaults or launching jobs", async (t) => {
  const f = await fixture(t);
  await mkdir(f.scope.root, { recursive: true, mode: 0o700 });
  await writeFile(join(f.scope.root, "presets.json"), "invalid defaults must not be read");
  const input = Array.from({ length: 4 }, (_, i) => ({ name: `worker-${i}`, prompt: "SECRET_PROMPT".repeat(7000), cwd: "missing-relative", extensions: ["missing-extension"], preset: "missing" }));
  const original = structuredClone(input);
  assert.ok(JSON.stringify(input).length > 262144);
  const pending = prepareTasks({ ...f.scope, env: new Proxy({}, { get() { throw new Error("Must not read defaults"); } }) }, input);
  input[0].prompt = "mutated";
  input[0].extensions.push("mutated");
  const result = await pending;
  assert.deepEqual(Object.keys(result), ["requestId"]);
  assert.match(result.requestId, /^[a-f0-9-]{36}$/);
  const saved = await f.saved(result.requestId);
  assert.deepEqual(saved, { state: "prepared", prepared: true, requestId: result.requestId, intent: original, fingerprint: requestFingerprint([original, undefined]), jobs: [] });
  assert.deepEqual((await readdir(f.scope.root)).sort(), ["locks", "presets.json", "requests"]);
  assert.deepEqual(await readdir(join(f.scope.root, "locks")), []);
  assert.deepEqual(await f.calls(), []);
  assert.equal((await stat(f.scope.root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.scope.root, "requests"))).mode & 0o777, 0o700);
  assert.equal((await stat(f.journal(result.requestId))).mode & 0o777, 0o600);
  assert.deepEqual(await requestStatus(f.scope, result.requestId), { requestId: result.requestId, scope: basename(f.scope.root), found: true, admissionState: "prepared", jobs: [] });
  const second = await prepareTasks(f.scope, original);
  assert.notEqual(second.requestId, result.requestId);
  assert.equal((await jobs(f.scope)).length, 0);
  // Normal process-identity/ownership checks still run; no Herdr or worker launch.
  assert.deepEqual(await f.calls(), []);
});

test("prepare rejects invalid/non-JSON tasks, duplicate names and oversize before publishing", async (t) => {
  const f = await fixture(t);
  const invalid = [undefined, null, {}, [], Array(17).fill(intent[0]), [intent[0], intent[0]],
    [{ ...intent[0], name: "Bad" }], [{ ...intent[0], prompt: " " }], [{ ...intent[0], prompt: "x".repeat(100001) }],
    ...[{ role: null }, { timeout: null }, { extensions: null }, { timeout: 0 }, { timeout: 1.5 }, { role: "bad" }, { thinking: "bad" }, { maxCost: NaN }, { maxCost: Infinity },
      { maxTokens: 0 }, { preset: " " }, { model: " " }, { cwd: 1 }, { persistent: null },
      { unknown: true }, { extensions: [""] }, { model: undefined }, { prompt: new Date() }, { toJSON() { return intent[0]; } }].map((extra) => [{ ...intent[0], ...extra }])];
  for (const value of invalid) await assert.rejects(prepareTasks(f.scope, value));
  const large = [{ ...intent[0], extensions: ["x".repeat(16 * 1024 * 1024)] }];
  await assert.rejects(prepareTasks(f.scope, large), /16 MiB/);
  assert.deepEqual(await f.calls(), []);
  await assert.rejects(stat(f.scope.root), { code: "ENOENT" });
});

test("UUID collisions use first-writer publication without replacing any historical request", async (t) => {
  const f = await fixture(t);
  const historical = "00000000-0000-4000-8000-000000000000";
  await mkdir(join(f.scope.root, "requests"), { recursive: true, mode: 0o700 });
  const previous = { state: "failed", fingerprint: "old-private-fingerprint", jobs: [] };
  await atomic(f.journal(historical), previous);
  const randomUUID = crypto.randomUUID;
  try {
    crypto.randomUUID = () => historical;
    syncBuiltinESMExports();
    await assert.rejects(prepareTasks(f.scope, intent), /fresh prepared request ID/);
    assert.deepEqual(await f.saved(historical), previous);
    let first = true;
    crypto.randomUUID = () => { if (first) { first = false; return historical; } return randomUUID(); };
    syncBuiltinESMExports();
    const prepared = await prepareTasks(f.scope, intent);
    assert.notEqual(prepared.requestId, historical);
    assert.deepEqual(await f.saved(historical), previous);
    assert.equal((await readdir(join(f.scope.root, "requests"))).length, 2);
  } finally {
    crypto.randomUUID = randomUUID;
    syncBuiltinESMExports();
  }
});

test("prepared IDs survive scope reconstruction and concurrent/repeated/closed retries without re-resolution", async (t) => {
  const f = await fixture(t);
  const { requestId } = await prepareTasks(f.scope, intent);
  const restored = scopeFor("prepared-session", { ...f.env, HERDR_PANE_ID: "restored", HERDR_SOCKET_PATH: "restored.sock" });
  let resolutions = 0;
  const plan = { resolve: async (input) => { resolutions++; return resolveTasks(restored, input, f.env, f.directory); } };
  const [first, second] = await Promise.all([spawnTasks(restored, plan, requestId), spawnTasks(restored, plan, requestId)]);
  // Either contender may win; compare their wire values, not in-memory optional undefined fields.
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
  assert.equal(resolutions, 1);
  const [job] = first;
  const journal = await f.saved(requestId);
  assert.equal(journal.prepared, true);
  assert.equal(journal.requestId, requestId);
  assert.deepEqual(journal.intent, intent);
  await atomic(join(f.scope.root, job.id, "done.json"), { state: "done", report: "done" });
  await atomic(join(f.scope.root, job.id, "shutdown.json"), { verified: true });
  await collect(f.scope, 0, async () => {});
  await cleanup(f.scope);
  const before = await f.calls();
  const [replayed] = await spawnTasks(restored, { resolve: async () => { throw new Error("Must not resolve"); } }, requestId);
  assert.equal(replayed.id, job.id);
  assert.equal(replayed.closed, true);
  assert.deepEqual(await f.calls(), before);
});

test("first admission alone resolves changed defaults and presets, preserving raw snapshot despite resolver mutation", async (t) => {
  const f = await fixture(t);
  const input = [...intent, { name: "preset-worker", prompt: "SECRET_PROMPT", preset: "review" }];
  const { requestId } = await prepareTasks(f.scope, input);
  await configurePresets(f.scope, { review: { model: "first/preset", thinking: "low" } });
  Object.assign(f.env, { PI_PROVIDER: "first", PI_MODEL: "model", PI_REASONING_LEVEL: "high" });
  const first = await spawnTasks(f.scope, { resolve: async (raw) => {
    const tasks = await resolveTasks(f.scope, raw, f.env, f.directory);
    raw[0].prompt = "resolver mutation";
    return tasks;
  } }, requestId);
  assert.equal(first[0].task.model, "first/model");
  assert.equal(first[1].task.model, "first/preset");
  assert.equal(first[0].task.cwd, f.directory);
  assert.deepEqual((await f.saved(requestId)).intent, input);
  const before = await f.calls();
  Object.assign(f.env, { PI_PROVIDER: "changed", PI_MODEL: "changed", PI_REASONING_LEVEL: "off" });
  await configurePresets(f.scope, {});
  const forbidden = async () => { throw new Error("Defaults must not be re-read"); };
  assert.deepEqual(await spawnTasks(f.scope, { resolve: forbidden }, requestId), JSON.parse(JSON.stringify(first)));
  assert.deepEqual(await spawnTasks(f.scope, { intent: input, resolve: forbidden }, requestId), JSON.parse(JSON.stringify(first)));
  await rejectsDiagnostic(spawnTasks(f.scope, { intent: [{ ...input[0], model: "first/model" }, input[1]], resolve: forbidden }, requestId), "REQUEST_ID_CONFLICT");
  assert.deepEqual(await f.calls(), before);
});

test("prepared execution refuses oversized resolved artifacts before launching", async (t) => {
  const f = await fixture(t);
  const largeTask = await prepareTasks(f.scope, [{ ...intent[0], model: "x".repeat(5 * 1024 * 1024) }]);
  await assert.rejects(spawnTasks(f.scope, f.plan(), largeTask.requestId), /4 MiB/);
  assert.deepEqual(await f.calls(), []);
  assert.equal((await requestStatus(f.scope, largeTask.requestId)).admissionState, "prepared");
  const tasks = Array.from({ length: 16 }, (_, i) => ({ name: `worker-${i}`, prompt: "inspect" }));
  const largeDefaults = await prepareTasks(f.scope, tasks);
  const plan = { resolve: (raw) => resolveTasks(f.scope, raw, { PI_PROVIDER: "fixture", PI_MODEL: "x".repeat(2 * 1024 * 1024) }, f.directory) };
  await assert.rejects(spawnTasks(f.scope, plan, largeDefaults.requestId), /32 MiB/);
  assert.ok((await f.calls()).every((args) => ["current", "list"].includes(args[1])));
  assert.deepEqual(await jobs(f.scope), []);
  assert.equal((await requestStatus(f.scope, largeDefaults.requestId)).admissionState, "prepared");
});

test("preparation does not reserve names or validate preset/cwd availability", async (t) => {
  const f = await fixture(t);
  const first = await prepareTasks(f.scope, intent);
  const second = await prepareTasks(f.scope, intent);
  const unavailable = await prepareTasks(f.scope, [{ ...intent[0], name: "unavailable", preset: "later" }]);
  await assert.rejects(spawnTasks(f.scope, f.plan(), unavailable.requestId), /Unknown model preset/);
  assert.equal((await requestStatus(f.scope, unavailable.requestId)).admissionState, "prepared");
  const missing = await prepareTasks(f.scope, [{ ...intent[0], name: "missing", cwd: join(f.directory, "missing") }]);
  await assert.rejects(spawnTasks(f.scope, f.plan(), missing.requestId), /ENOENT/);
  assert.deepEqual(await f.calls(), []);
  await spawnTasks(f.scope, f.plan(), first.requestId);
  await assert.rejects(spawnTasks(f.scope, f.plan(), second.requestId), /already has that name/);
  assert.equal((await requestStatus(f.scope, second.requestId)).admissionState, "prepared");
});

test("unknown, raw, cross-scope and continuation IDs fail closed before resolving", async (t) => {
  const f = await fixture(t);
  const forbidden = { resolve: async () => { throw new Error("Must not resolve"); } };
  await rejectsDiagnostic(spawnTasks(f.scope, forbidden, "unknown"));
  await rejectsDiagnostic(spawnTasks(f.scope, forbidden));
  const { requestId } = await prepareTasks(f.scope, intent);
  await rejectsDiagnostic(spawnTasks(scopeFor("other-session", f.env), forbidden, requestId));
  await rejectsDiagnostic(spawnTasks(f.scope, forbidden, requestId, undefined, "0123456789ab"));
  await rejectsDiagnostic(spawnTasks(f.scope, { ...forbidden, intent }, requestId, undefined, "0123456789ab"));
  await rejectsDiagnostic(spawnTasks(f.scope, { ...forbidden, intent: [{ ...intent[0], prompt: "changed" }] }, requestId), "REQUEST_ID_CONFLICT");
  assert.deepEqual(await f.calls(), []);
  const raw = validateTasks([{ ...intent[0], name: "raw" }], {}, f.directory);
  await spawnTasks(f.scope, raw, "raw-id");
  const before = await f.calls();
  await rejectsDiagnostic(spawnTasks(f.scope, forbidden, "raw-id"));
  assert.deepEqual(await f.calls(), before);
});

test("failed and interrupted prepared-origin admissions retain immutable intent and cannot replay", async (t) => {
  const f = await fixture(t);
  const { requestId } = await prepareTasks(f.scope, intent);
  await assert.rejects(spawnTasks({ ...f.scope, env: { ...f.env, FAKE_FAIL: "rename" } }, f.plan(), requestId), /rolled back/);
  const saved = await f.saved(requestId);
  assert.equal(saved.state, "failed");
  assert.equal(saved.prepared, true);
  assert.equal(saved.requestId, requestId);
  assert.deepEqual(saved.intent, intent);
  assert.equal(saved.fingerprint, requestFingerprint([intent, undefined]));
  const before = await f.calls();
  for (const state of ["failed", "starting"]) {
    await atomic(f.journal(requestId), { ...saved, state });
    await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId));
    assert.equal((await requestStatus(f.scope, requestId)).admissionState, state);
  }
  assert.deepEqual(await f.calls(), before);
});

test("prepared payload, marker, ID, hash and state corruption never permit ID-only admission", async (t) => {
  const f = await fixture(t);
  const { requestId } = await prepareTasks(f.scope, intent);
  const saved = await f.saved(requestId);
  const variants = [null, {}, { ...saved, prepared: false }, { ...saved, prepared: undefined }, { ...saved, requestId: "different" },
    { ...saved, requestId: undefined }, { ...saved, fingerprint: "a".repeat(64) }, { ...saved, intent: [{ ...intent[0], prompt: "changed" }] },
    { ...saved, intent: [intent[0], intent[0]], fingerprint: requestFingerprint([[intent[0], intent[0]], undefined]) },
    { ...saved, intent: [{ ...intent[0], extra: true }], fingerprint: requestFingerprint([[{ ...intent[0], extra: true }], undefined]) },
    { ...saved, jobs: ["0123456789ab"] }, { ...saved, tasks: [] }, { ...saved, pi: "private" },
    { ...saved, previousId: "0123456789ab" }, { ...saved, state: "unknown" }];
  for (const record of variants) {
    await atomic(f.journal(requestId), record);
    const status = await requestStatus(f.scope, requestId);
    assert.equal(status.found, true);
    assert.equal(status.artifactsIncomplete, true);
    assert.ok(!JSON.stringify(status).includes("SECRET_PROMPT"));
    await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId));
  }
  await writeFile(f.journal(requestId), '{"SECRET_PROMPT":');
  await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId));
  await truncate(f.journal(requestId), 33 * 1024 * 1024);
  await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId));
  await rm(f.journal(requestId));
  await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId));
  assert.equal((await requestStatus(f.scope, requestId)).found, false);
  assert.deepEqual(await f.calls(), []);
});

test("symlinked requests files/directories are never read or used for preparation", async (t) => {
  const f = await fixture(t);
  const { requestId } = await prepareTasks(f.scope, intent);
  const saved = await f.saved(requestId);
  const external = join(f.directory, "external");
  await mkdir(external);
  const externalFile = join(external, basename(f.journal(requestId)));
  await atomic(externalFile, saved);
  await rm(f.journal(requestId));
  await symlink(externalFile, f.journal(requestId));
  await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId));
  await rm(join(f.scope.root, "requests"), { recursive: true });
  await symlink(external, join(f.scope.root, "requests"));
  await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId));
  await assert.rejects(prepareTasks(f.scope, intent), /symlink/);
  assert.deepEqual(await readdir(external), [basename(externalFile)]);
  assert.deepEqual(await f.calls(), []);
});

test("done prepared replay refuses missing job artifacts and corrupted prepared origin", async (t) => {
  const f = await fixture(t);
  const { requestId } = await prepareTasks(f.scope, intent);
  const [job] = await spawnTasks(f.scope, f.plan(), requestId);
  const before = await f.calls();
  await rm(join(f.scope.root, job.id, "job.json"));
  await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId), "REQUEST_ARTIFACT_MISSING");
  const saved = await f.saved(requestId);
  await atomic(f.journal(requestId), { ...saved, prepared: false });
  await rejectsDiagnostic(spawnTasks(f.scope, f.plan(), requestId));
  assert.deepEqual(await f.calls(), before);
});

test("abort and changed owner fence preparation and lock-queued prepared admissions", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareTasks(f.scope, intent, controller.signal), /abort/i);
  await assert.rejects(stat(f.scope.root), { code: "ENOENT" });
  const { requestId } = await prepareTasks(f.scope, intent);
  const before = await readdir(join(f.scope.root, "requests"));
  const writing = new AbortController();
  const pendingPrepare = prepareTasks(f.scope, intent, writing.signal);
  writing.abort();
  await assert.rejects(pendingPrepare, /abort/i);
  assert.deepEqual(await readdir(join(f.scope.root, "requests")), before);
  const authority = { token: "owner-a", identity: await processIdentity() };
  await atomic(join(f.scope.root, "owner.json"), authority);
  const owned = { ...f.scope, authority };
  let pending;
  await locked(f.scope, async () => {
    pending = assert.rejects(spawnTasks(owned, f.plan(), requestId), /ownership changed or ended/);
    await delay(60);
    await atomic(join(f.scope.root, "owner.json"), { ...authority, token: "owner-b" });
  });
  await pending;
  await assert.rejects(prepareTasks(owned, intent), /ownership changed or ended/);
  assert.deepEqual(await readdir(join(f.scope.root, "requests")), before);
  const waiting = new AbortController();
  await locked(f.scope, async () => {
    pending = assert.rejects(spawnTasks(f.scope, f.plan(), requestId, waiting.signal), /abort/i);
    await delay(60);
    waiting.abort();
  });
  await pending;
  assert.equal((await requestStatus(f.scope, requestId)).admissionState, "prepared");
  assert.deepEqual(await f.calls(), []);
});
