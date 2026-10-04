import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { atomic, json, launcher } from "../extensions/herdr-subagents/core.ts";
import { processIdentity } from "../extensions/herdr-subagents/identity.ts";
import { publishPresentation, reattachJob, resumeArgv } from "../extensions/herdr-subagents/presentation.ts";

async function fixture(t, presentation = "agent") {
  const root = await mkdtemp(join(tmpdir(), "pi presentation spaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const job = { id: "012345abcdef", task: { name: "review", role: "reviewer", cwd: root, prompt: "NEVER EXECUTE THIS TASK", timeout: 30, extensions: [], ...(presentation ? { presentation } : {}) }, pane: "w:p-old", terminal: "old-terminal", cursor: 0, created: 1, launched: true };
  const directory = join(root, job.id);
  await mkdir(directory, { mode: 0o700 });
  await atomic(join(directory, "job.json"), job);
  await atomic(join(directory, "worker.json"), { pid: process.pid, identity: await processIdentity() });
  const backend = join(root, "herdr.mjs");
  const statePath = join(root, "fake.json");
  await atomic(statePath, { calls: [], pid: process.pid, panes: [{ pane_id: "w:p-main", terminal_id: "main" }, { pane_id: "w:p-new", terminal_id: "new-terminal" }], infos: 0 });
  await writeFile(backend, `#!${process.execPath}
import {readFileSync, writeFileSync} from 'node:fs';
const path = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
let result = {};
if (args[1] === 'list') result = {panes: state.panes};
if (args[1] === 'process-info') {
 state.infos++;
 const pane = args[args.indexOf('--pane') + 1];
 const pid = state.pid ?? process.ppid;
 result = {process_info: {pane_id: pane, ...(state.foreground ? {foreground_processes: [{pid}]} : {shell_pid: pid})}};
 if (state.changeTerminalAt === state.infos) state.panes[1].terminal_id = 'raced-terminal';
 if (state.changeClaimAt === state.infos) {
  const file = process.env.FAKE_JOB + '/worker.json';
  const claim = JSON.parse(readFileSync(file, 'utf8')); claim.identity.start = 'reused'; writeFileSync(file, JSON.stringify(claim));
 }
}
writeFileSync(path, JSON.stringify(state));
if (args[1] === state.fail) process.exit(1);
if (['list', 'process-info'].includes(args[1])) console.log(JSON.stringify({result}));
`);
  await chmod(backend, 0o700);
  const env = { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: "w:p-new", HERDR_WORKSPACE_ID: "w", HERDR_SOCKET_PATH: "mock.sock", HERDR_BIN_PATH: backend, FAKE_STATE: statePath, FAKE_JOB: directory };
  const original = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); });
  return { root, directory, job, env, statePath, scope: { root, pane: "w:p-main", workspace: "w", env } };
}

async function update(path, patch) { await atomic(path, { ...await json(path), ...patch }); }

async function waitFor(fn) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await delay(25); }
  throw new Error("Timed out waiting for test condition");
}

test("quiet/default presentation is a strict no-op, even outside Herdr", async (t) => {
  const { directory, job, statePath } = await fixture(t, undefined);
  delete job.task.presentation;
  delete process.env.HERDR_ENV;
  const before = await readdir(directory);
  await publishPresentation(directory, job, "working");
  job.task.presentation = "quiet";
  await publishPresentation(directory, job, "idle");
  assert.deepEqual(await readdir(directory), before);
  assert.deepEqual((await json(statePath)).calls, []);
});

test("resume argv uses only the custom viewer, preserves spaces/double quotes, and rejects Herdr-invalid input", () => {
  const argv = resumeArgv('/tmp/has spaces/"quoted"/012345abcdef');
  assert.deepEqual(argv, ["node", launcher, "resume-job", '/tmp/has spaces/"quoted"/012345abcdef']);
  assert.ok(isAbsolute(argv[1]) && isAbsolute(argv[3]));
  assert.ok(!argv.includes("pi") && !argv.includes("--resume"));
  for (const directory of ["/tmp/it's", "/tmp/line\nfeed", "/tmp/\0", "/tmp/\u0085", "/tmp/" + "界".repeat(3000)]) {
    assert.throws(() => resumeArgv(directory), /Invalid Herdr resume argv/);
  }
});

test("agent presentation sends bounded metadata, custom session command, and durable increasing sequences", async (t) => {
  const { directory, job, statePath } = await fixture(t);
  job.task.name = "a\x1b[31m\n" + "😀".repeat(100);
  await Promise.all([publishPresentation(directory, job, "working"), publishPresentation(directory, job, "idle")]);
  const reports = (await json(statePath)).calls.filter((args) => args.includes("--seq"));
  assert.deepEqual(reports.map((args) => Number(args[args.indexOf("--seq") + 1])), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(reports.map((args) => args[1]), ["report-agent", "report-agent-session", "report-metadata", "report-agent", "report-agent-session", "report-metadata"]);
  for (const args of reports.filter((args) => args.includes("--"))) assert.deepEqual(args.slice(args.indexOf("--") + 1), resumeArgv(directory));
  const metadata = reports[2];
  const title = metadata[metadata.indexOf("--title") + 1];
  assert.ok(Array.from(title).length <= 80);
  assert.doesNotMatch(title, /[\x00-\x1f\x7f-\x9f]/);
  assert.equal((await json(join(directory, "presentation.json"))).seq, 6);
  assert.equal((await stat(join(directory, "presentation.json"))).mode & 0o777, 0o600);
  await update(statePath, { fail: "report-agent" });
  await assert.rejects(publishPresentation(directory, job, "blocked"));
  assert.equal((await json(join(directory, "presentation.json"))).seq, 7);
  await update(statePath, { fail: undefined });
  await publishPresentation(directory, job, "blocked");
  assert.equal((await json(join(directory, "presentation.json"))).seq, 10);
});

for (const foreground of [false, true]) test(`reattach proves ${foreground ? "foreground" : "shell"} supervisor identity with a NEW terminal`, async (t) => {
  const { scope, job, directory, statePath } = await fixture(t);
  await update(statePath, { foreground });
  const before = await readFile(join(directory, "worker.json"), "utf8");
  const attached = await reattachJob(scope, job.id, "w:p-new");
  assert.equal(attached.terminal, "new-terminal");
  assert.equal(attached.pane, "w:p-new");
  assert.equal(await readFile(join(directory, "worker.json"), "utf8"), before);
  assert.ok((await json(statePath)).infos >= 2);
});

test("reattach fails closed for a matching pane/title but mismatched PID, reused PID, previous boot, or narrowed wrong pane", async (t) => {
  const { scope, job, directory, statePath } = await fixture(t);
  const claim = await json(join(directory, "worker.json"));
  await update(statePath, { pid: 2147483647 });
  await assert.rejects(reattachJob(scope, job.id), /matching process evidence/);
  await update(statePath, { pid: process.pid });
  for (const identity of [{ ...claim.identity, start: "old process" }, { ...claim.identity, boot: "old boot" }]) {
    await atomic(join(directory, "worker.json"), { pid: process.pid, identity });
    await assert.rejects(reattachJob(scope, job.id), /No live claimed/);
  }
  await atomic(join(directory, "worker.json"), { ...claim, pid: 2147483647 });
  await assert.rejects(reattachJob(scope, job.id), /valid owned worker claim/);
  await atomic(join(directory, "worker.json"), claim);
  await assert.rejects(reattachJob(scope, job.id, "w:p-absent"), /matching process evidence/);
  await assert.rejects(reattachJob(scope, "../escape"), /Invalid job ID/);
  assert.deepEqual(await json(join(directory, "job.json")), job);
});

test("reattach revalidates terminal and claim immediately before saving", async (t) => {
  const { scope, job, directory, statePath } = await fixture(t);
  await update(statePath, { changeTerminalAt: 2 });
  await assert.rejects(reattachJob(scope, job.id, "w:p-new"), /terminal identity changed/);
  assert.deepEqual(await json(join(directory, "job.json")), job);
  await update(statePath, { infos: 0, changeTerminalAt: undefined, changeClaimAt: 2 });
  await assert.rejects(reattachJob(scope, job.id, "w:p-new"), /claim changed/);
  assert.deepEqual(await json(join(directory, "job.json")), job);
});

test("multiple matching panes are ambiguous and never authorize attachment", async (t) => {
  const { scope, job, directory, statePath } = await fixture(t);
  const state = await json(statePath);
  await update(statePath, { panes: [...state.panes, { pane_id: "w:p-duplicate", terminal_id: "other-terminal" }] });
  await assert.rejects(reattachJob(scope, job.id), /exactly one pane/);
  assert.deepEqual(await json(join(directory, "job.json")), job);
});

for (const presentation of ["agent", "quiet"]) test(`cold restore ${presentation} viewer never starts Pi or rewrites execution evidence; explicit reattach uses its private identity`, async (t) => {
  const { scope, job, directory, statePath, env } = await fixture(t, presentation);
  await atomic(join(directory, "worker.json"), { pid: process.pid, identity: { ...await processIdentity(), boot: "old boot" } });
  await atomic(join(directory, "launch.json"), { pi: "/must-never-execute", args: ["NEVER"] });
  await atomic(join(directory, "done.json"), { state: "failed", report: "saved" });
  await atomic(join(directory, "shutdown.json"), { verified: false });
  await writeFile(join(directory, "events.jsonl"), "SECRET RAW TRANSCRIPT");
  await writeFile(join(directory, "result.md"), "saved report\n\x1b[31m" + "z".repeat(20000));
  const paths = ["worker.json", "job.json", "done.json", "shutdown.json", "launch.json", "result.md"];
  const evidence = await Promise.all(paths.map((path) => readFile(join(directory, path), "utf8")));
  await update(statePath, { pid: null }); // Mock process-info uses the calling viewer's parent PID.
  const module = new URL("../extensions/herdr-subagents/presentation.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {replayViewer} from ${JSON.stringify(module)}; await replayViewer(${JSON.stringify(directory)});`], { env, stdio: "pipe" });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const viewer = await waitFor(() => json(join(directory, "viewer.json")));
  assert.equal(viewer.identity.pid, child.pid);
  assert.equal(viewer.terminal, "new-terminal");
  assert.equal((await stat(join(directory, "viewer.json"))).mode & 0o777, 0o600);
  await waitFor(() => stdout.includes("saved report"));
  assert.ok(stdout.length < 12500);
  assert.doesNotMatch(stdout, /SECRET RAW TRANSCRIPT|NEVER EXECUTE|\x1b/);
  assert.match(stdout, /read-only|Read-only/);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(directory, path), "utf8"))), evidence);
  await update(statePath, { pid: child.pid });
  assert.equal((await reattachJob(scope, job.id, "w:p-new")).terminal, "new-terminal");
  await writeFile(join(directory, "result.md"), "updated saved report");
  await waitFor(() => stdout.includes("updated saved report"));
  assert.equal(child.exitCode, null, "viewer must retain completed reports until the pane closes");
  child.kill("SIGTERM");
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal((await json(join(directory, "viewer.json"))).active, false);
  assert.equal(await readFile(join(directory, "worker.json"), "utf8"), evidence[0]);
  assert.equal(await readFile(join(directory, "shutdown.json"), "utf8"), evidence[3]);
  const reports = (await json(statePath)).calls.filter((args) => args.includes("--seq"));
  if (presentation === "agent") assert.equal(reports.at(-1)[1], "release-agent");
  else assert.deepEqual(reports, []);
  assert.ok(!(await json(statePath)).calls.some((args) => ["run", "send-text", "send-keys", "split", "close"].includes(args[1])));
});
