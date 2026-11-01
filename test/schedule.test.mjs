import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import schedule from "../extensions/schedule/index.ts";
import { decide, LOOKBACK_MS, ON_TIME_MS, ONCE_CATCH_UP_MS } from "../extensions/schedule/dispatch.ts";
import { plistIntact, renderPlist } from "../extensions/schedule/launchd.ts";
import { interpretPrompt, parseInterpretation, promptWithout } from "../extensions/schedule/interpret.ts";
import { describeSchedule, formatDateTime, formatDuration, lastDue, nextRun, parseDuration, parseTiming, UnknownTimingError, upcoming } from "../extensions/schedule/parse.ts";
import { appendRun, claimJob, readClaim, readJobs, readLastRunAt, readRuns, releaseJob, writeJobs } from "../extensions/schedule/store.ts";

const dispatchPath = fileURLToPath(new URL("../extensions/schedule/dispatch.ts", import.meta.url));
const MIN = 60_000;
// Sun 2026-11-01 10:00 local time.
const NOW = new Date(2026, 10, 1, 10, 0, 0).getTime();
const local = (...parts) => new Date(...parts).getTime();
const tempDir = () => mkdtempSync(join(tmpdir(), "pi-schedule-test-"));

// Tests may run inside a scheduled run or a subagent; the extension stays inert there.
delete process.env.PI_SCHEDULE_RUN;
delete process.env.PI_SUBAGENT;

test("timing grammar: one-shots, intervals, calendar shortcuts and raw cron", () => {
  assert.deepEqual(parseTiming("in 20m check CI", NOW), { schedule: { kind: "once", at: NOW + 20 * MIN }, rest: "check CI" });
  assert.equal(parseTiming("in 1h30m x", NOW).schedule.at, NOW + 90 * MIN);
  // A clock time already passed today means tomorrow.
  assert.equal(parseTiming("at 15:00 x", NOW).schedule.at, local(2026, 10, 1, 15, 0));
  assert.equal(parseTiming("at 9am x", NOW).schedule.at, local(2026, 10, 2, 9, 0));
  assert.equal(parseTiming("tomorrow at 9:30pm x", NOW).schedule.at, local(2026, 10, 2, 21, 30));
  assert.deepEqual(parseTiming("every 2h ping", NOW).schedule, { kind: "every", ms: 120 * MIN, anchor: NOW });
  assert.deepEqual(parseTiming("daily 9:05 x", NOW).schedule, { kind: "cron", expr: "5 9 * * *" });
  assert.deepEqual(parseTiming("weekdays at 18:00 x", NOW).schedule, { kind: "cron", expr: "0 18 * * 1-5" });
  assert.deepEqual(parseTiming("hourly x", NOW).schedule, { kind: "cron", expr: "0 * * * *" });
  assert.deepEqual(parseTiming('cron "*/15  9-17 * * 1-5" summarize', NOW), { schedule: { kind: "cron", expr: "*/15 9-17 * * 1-5" }, rest: "summarize" });
  // The prompt keeps its own formatting.
  assert.equal(parseTiming("in 5m line one\n  line two", NOW).rest, "line one\n  line two");
});

test("timing grammar reads common natural phrasings", () => {
  // NOW is Sunday 10:00.
  const read = (input) => {
    const { schedule: s, rest } = parseTiming(input, NOW);
    return [s.kind === "once" ? formatDateTime(s.at) : describeSchedule(s, NOW), rest];
  };
  assert.deepEqual(read("everyday 5 am do this and this"), ["daily 05:00", "do this and this"]);
  assert.deepEqual(read("every day at 5am do this"), ["daily 05:00", "do this"]);
  assert.deepEqual(read("5am every day do this"), ["daily 05:00", "do this"]);
  assert.deepEqual(read("at 5 am every weekday, standup"), ["weekdays 05:00", "standup"]);
  assert.deepEqual(read("every monday at 10:30 review PRs"), ["every Monday 10:30", "review PRs"]);
  assert.deepEqual(read("mondays 9am x"), ["every Monday 09:00", "x"]);
  assert.deepEqual(read("weekends at 11am x"), ["weekends 11:00", "x"]);
  // Singular weekdays are the next occurrence; "tues" and "thurs" are not plurals.
  assert.deepEqual(read("tues 9am x"), ["2026-11-03 09:00", "x"]);
  assert.deepEqual(read("thurs at noon x"), ["2026-11-05 12:00", "x"]);
  assert.deepEqual(read("sunday 11am x"), ["2026-11-01 11:00", "x"], "later today");
  assert.deepEqual(read("sunday 9am x"), ["2026-11-08 09:00", "x"], "passed today: next week");
  assert.deepEqual(read("next sunday 11am x"), ["2026-11-08 11:00", "x"]);
  assert.deepEqual(read("tomorrow at 9 pm x"), ["2026-11-02 21:00", "x"]);
  assert.deepEqual(read("in 20 minutes x"), ["2026-11-01 10:20", "x"]);
  assert.deepEqual(read("in an hour x"), ["2026-11-01 11:00", "x"]);
  assert.deepEqual(read("on 2026-12-01 10:00 x"), ["2026-12-01 10:00", "x"]);
  assert.deepEqual(read("every 2 hours x"), ["every 2h", "x"]);
  assert.deepEqual(read("every hour x"), ["every 1h", "x"]);
  assert.throws(() => parseTiming("today at 9am x", NOW), /already passed/);
  // A day without a readable time goes to the model; without one, the message says what to add.
  assert.throws(() => parseTiming("every day check CI", NOW), (error) => error instanceof UnknownTimingError && /Add a time/.test(error.message));
  assert.throws(() => parseTiming("every weekday at 9 standup", NOW), UnknownTimingError);
  assert.throws(() => parseTiming("tomorrow morning check mail", NOW), UnknownTimingError);
  // Timing words left at the start of the prompt mean the grammar misread it: hand it to the model.
  assert.throws(() => parseTiming("at 5pm every other day x", NOW), UnknownTimingError);
  assert.throws(() => parseTiming("daily at 9am and 5pm x", NOW), UnknownTimingError);
  assert.throws(() => parseTiming("mondays and thursdays at 9am x", NOW), UnknownTimingError);
  // Ordinary task words after a complete timing stay in the prompt.
  assert.deepEqual(read("daily 9am in the repo, run tests"), ["daily 09:00", "in the repo, run tests"]);
  assert.deepEqual(read("in 5m next steps"), ["2026-11-01 10:05", "next steps"]);
  assert.deepEqual(read("daily 9am every open PR needs a review"), ["daily 09:00", "every open PR needs a review"]);
  assert.deepEqual(read("in 20m each failing test: rerun it"), ["2026-11-01 10:20", "each failing test: rerun it"]);
  assert.deepEqual(read("at 5pm today's standup notes"), ["2026-11-01 17:00", "today's standup notes"]);
  assert.deepEqual(read("on wednesday at 5pm x"), ["2026-11-04 17:00", "x"]);
});

test("timing grammar reads compound durations and never leaves timing in the prompt", () => {
  const at = (input) => formatDateTime(parseTiming(input, NOW).schedule.at);
  assert.equal(at("in 1 hour 30 minutes check CI"), "2026-11-01 11:30");
  assert.equal(parseTiming("in 1 hour 30 minutes check CI", NOW).rest, "check CI");
  assert.equal(at("in 2h 30m x"), "2026-11-01 12:30");
  assert.equal(at("in 1h, 30m x"), "2026-11-01 11:30");
  assert.equal(at("in 3 hours and 15 minutes x"), "2026-11-01 13:15");
  assert.equal(at("in an hour and a half x"), "2026-11-01 11:30");
  assert.equal(parseTiming("in 5m and then deploy", NOW).rest, "and then deploy");
  // Each of these used to schedule the first half and keep the rest as prompt text.
  for (const input of [
    "daily 9am except weekends x", "every day at 9am until friday x", "every 30m on mondays x", "at 5pm in 2 days x",
    "at 5pm this friday x", "at 5pm next week ship", "at 9am the day after tomorrow x", "every monday at 10am, thursday at 3pm x",
    "tomorrow 9am and at 5pm x", "at 17:00 UTC x", "every 2h starting at 9am x", "at 9am on the 1st of every month send", "daily 9am wednesdays too",
  ]) assert.throws(() => parseTiming(input, NOW), UnknownTimingError, input);
});

test("model fallback: canonical timing out, the prompt is the user's own text minus the timing words", () => {
  const prompt = interpretPrompt(NOW);
  assert.match(prompt, /2026-11-01 10:00 \(Sunday\)/);
  assert.match(prompt, /on YYYY-MM-DD HH:MM/);
  assert.match(prompt, /1#1/);
  assert.deepEqual(parseInterpretation('```json\n{"timing": "cron \\"0 17 */2 * *\\"", "words": "every other day"}\n```'), { timing: 'cron "0 17 */2 * *"', words: "every other day" });
  assert.throws(() => parseInterpretation('{"error": "no task"}'), /no task/);
  assert.throws(() => parseInterpretation("sure, every other day"), /did not return/);
  assert.throws(() => parseInterpretation('{"timing": "daily", "words": ""}'), /did not return/);
  assert.equal(promptWithout("on the first of every month at 9 do the invoice report", "on the first of every month at 9"), "do the invoice report");
  assert.equal(promptWithout("Every Monday and Thursday at 9am, standup", "every monday and thursday at 9am"), "standup");
  assert.equal(promptWithout("water the plants every other day", "every other day"), "water the plants");
  assert.equal(promptWithout("in 5m x", "tomorrow"), undefined, "words not in the text");
  assert.equal(promptWithout("every other day", "every other day"), undefined, "nothing left");
});

test("timing grammar rejects ambiguous or invalid input", () => {
  assert.throws(() => parseTiming("at 9 check", NOW), /Unknown timing/);
  assert.throws(() => parseTiming("at 25:00 x", NOW), /Unknown timing/);
  assert.throws(() => parseTiming("every 30s x", NOW), /Shortest interval is 1m/);
  assert.throws(() => parseTiming('cron "0 0 9 * * *" x', NOW), /5 fields/);
  assert.throws(() => parseTiming('cron "nonsense x y z w" x', NOW));
  assert.throws(() => parseTiming('cron "0 9 31 2,4,6,9,11 *" x', NOW), /never fires/);
  assert.throws(() => parseTiming("on 2026-11-31 10:00 x", NOW), /No such date/);
  assert.deepEqual(upcoming(parseTiming('cron "0 9 * * 1#1" x', NOW).schedule, NOW, 3), ["Mon 2026-11-02 09:00", "Mon 2026-12-07 09:00", "Mon 2027-01-04 09:00"]);
  assert.throws(() => parseTiming("check CI later", NOW), /Unknown timing/);
  assert.equal(parseDuration("10"), undefined);
  assert.equal(formatDuration(90 * MIN), "1h30m");
});

test("nextRun is strictly after, lastDue returns only the latest slot", () => {
  const once = { kind: "once", at: NOW + MIN };
  assert.equal(nextRun(once, NOW), NOW + MIN);
  assert.equal(nextRun(once, NOW + MIN), undefined);
  const every = { kind: "every", ms: 10 * MIN, anchor: NOW };
  assert.equal(nextRun(every, NOW), NOW + 10 * MIN);
  assert.equal(nextRun(every, NOW + 25 * MIN), NOW + 30 * MIN);
  assert.equal(lastDue(every, NOW + 25 * MIN, NOW), NOW + 20 * MIN);
  assert.equal(lastDue(every, NOW + 5 * MIN, NOW), undefined);
  const daily = { kind: "cron", expr: "0 9 * * *" };
  assert.equal(nextRun(daily, NOW), local(2026, 10, 2, 9, 0));
  // Off for three days: one slot, the latest.
  assert.equal(lastDue(daily, local(2026, 10, 4, 12, 0), NOW), local(2026, 10, 4, 9, 0));
  assert.equal(lastDue(daily, local(2026, 10, 2, 9, 0), NOW), local(2026, 10, 2, 9, 0), "a slot at exactly now is due");
  assert.equal(lastDue(daily, local(2026, 10, 2, 9, 0), local(2026, 10, 2, 9, 0)), undefined, "an already-run slot is not");
});

test("tick decisions: on time runs, catch-up runs once, stale or disabled jobs do not", () => {
  const job = (id, extra = {}) => ({ id, prompt: "p", cwd: "/tmp", schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: true, catchUp: true, timeoutSec: 60, createdAt: NOW - 30 * 24 * 60 * MIN, ...extra });
  const nine = local(2026, 10, 1, 9, 0);
  const at = (now, jobs, last = {}) => decide(jobs, (id) => last[id], now).map((d) => [d.job.id, d.action, d.slot]);
  assert.deepEqual(at(nine + 30_000, [job("a")], { a: nine - 24 * 60 * MIN }), [["a", "run", nine]]);
  assert.deepEqual(at(nine + 30_000, [job("a")], { a: nine }), [], "slot already recorded");
  assert.deepEqual(at(nine + 3 * 60 * MIN, [job("a", { catchUp: false })]), [["a", "missed", nine]]);
  assert.deepEqual(at(nine + 3 * 60 * MIN, [job("a")]), [["a", "run", nine]], "catch-up within the look-back window");
  assert.deepEqual(at(nine + ON_TIME_MS, [job("a", { catchUp: false })]), [["a", "run", nine]]);
  assert.deepEqual(at(NOW, [job("a", { enabled: false })]), []);
  // Resuming does not catch up slots that passed while paused.
  assert.deepEqual(at(nine + 60 * MIN, [job("a", { resumedAt: nine + 30 * MIN })]), []);
  const yearly = job("old", { schedule: { kind: "cron", expr: "0 9 1 1 *" }, createdAt: local(2025, 0, 1, 9, 0) });
  assert.ok(NOW - local(2026, 0, 1, 9, 0) > LOOKBACK_MS);
  assert.deepEqual(at(NOW, [yearly], { old: local(2025, 0, 1, 9, 0) }), [["old", "missed", local(2026, 0, 1, 9, 0)]], "older than the look-back window");
  // One-shots catch up only within an hour: "in 20m deploy" must not run days later.
  const once = (late) => job("once", { schedule: { kind: "once", at: NOW - late }, createdAt: NOW - late - MIN });
  assert.deepEqual(at(NOW, [once(ONCE_CATCH_UP_MS)]), [["once", "run", NOW - ONCE_CATCH_UP_MS]]);
  assert.deepEqual(at(NOW, [once(ONCE_CATCH_UP_MS + MIN)]), [["once", "missed", NOW - ONCE_CATCH_UP_MS - MIN]]);
  // A broken job is reported and skipped; the others still run.
  const errors = [];
  const broken = job("bad", { schedule: { kind: "cron", expr: "0 9 31 2 *" } });
  assert.deepEqual(decide([broken, job("a")], () => nine - 24 * 60 * MIN, nine + 30_000, (j) => errors.push(j.id)).map((d) => d.job.id), ["a"]);
  assert.deepEqual(errors, ["bad"]);
});

test("background slots follow nextRun across DST: one run when clocks go back, one when they go forward", () => {
  // Europe/Bucharest: 03:30 happens twice on 2026-10-25 and not at all on 2026-03-29.
  const script = `
    import { decide } from ${JSON.stringify(dispatchPath)};
    const job = { id: "j", prompt: "p", cwd: "/", schedule: { kind: "cron", expr: "30 3 * * *" }, enabled: true, catchUp: true, timeoutSec: 60, createdAt: 0 };
    const result = {};
    for (const [label, start] of [["back", Date.UTC(2026, 9, 24, 22)], ["forward", Date.UTC(2026, 2, 28, 22)]]) {
      let last = start;
      const runs = [];
      for (let now = start; now < start + 8 * 3600e3; now += 60e3) {
        for (const d of decide([job], () => last, now)) { last = d.slot; runs.push(new Date(d.slot).toISOString().slice(11, 16)); }
      }
      result[label] = runs;
    }
    console.log(JSON.stringify(result));`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { env: { ...process.env, TZ: "Europe/Bucharest" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { back: ["00:30"], forward: ["01:30"] });
});

test("store: corrupt jobs.json throws, claims are exclusive and stale claims are replaced", () => {
  const dir = tempDir();
  assert.deepEqual(readJobs(dir), []);
  writeFileSync(join(dir, "jobs.json"), "{oops");
  assert.throws(() => readJobs(dir));
  const claim = { pid: process.pid, startedAt: Date.now(), sessionId: "s" };
  assert.equal(claimJob(dir, "j", claim, 60_000), true);
  assert.equal(claimJob(dir, "j", { ...claim, sessionId: "t" }, 60_000), false, "live claim blocks");
  assert.equal(readClaim(dir, "j", 60_000).sessionId, "s");
  assert.equal(readClaim(dir, "j", 0), undefined, "older than the max age is stale");
  assert.equal(claimJob(dir, "j", { ...claim, sessionId: "u" }, 0), true, "stale claim is replaced");
  releaseJob(dir, "j");
  assert.equal(readClaim(dir, "j", 60_000), undefined);
  appendRun(dir, { id: "j", status: "ok", startedAt: 1, endedAt: 2 });
  assert.equal(readRuns(dir, "j").length, 1);
  // A torn state file reads as "never ran" instead of failing every job.
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "state", "j.json"), "");
  assert.equal(readLastRunAt(dir, "j"), undefined);
});

test("plist pins absolute paths, keeps runners alive and escapes XML", () => {
  const plist = renderPlist({ node: "/n/node", dispatch: "/d/dispatch.ts", dir: "/s", env: { PATH: "/a&b", PI_SCHEDULE_PI: '["/n/node","/p"]' } });
  assert.match(plist, /<string>\/n\/node<\/string><string>\/d\/dispatch.ts<\/string><string>tick<\/string>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(plist, /<string>\/a&amp;b<\/string>/);
});

test("an installed plist is intact only while node, dispatch.ts and the Pi CLI exist", () => {
  const config = (pi) => ({ node: process.execPath, dispatch: dispatchPath, dir: "/s", env: { PI_SCHEDULE_PI: JSON.stringify([process.execPath, pi]) } });
  assert.equal(plistIntact(renderPlist(config(dispatchPath))), true);
  assert.equal(plistIntact(renderPlist(config("/gone/after/nvm/upgrade/pi"))), false);
  assert.equal(plistIntact(renderPlist({ ...config(dispatchPath), node: "/gone/node" })), false);
  assert.equal(plistIntact("<plist/>"), false);
});

// Runner integration: dispatch.ts under plain node, with a fake `pi` that records its argv.
function runnerFixture(jobExtra = {}) {
  const dir = tempDir();
  const cwd = tempDir();
  const fakePi = join(dir, "fake-pi.mjs");
  writeFileSync(fakePi, `
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), run: process.env.PI_SCHEDULE_RUN }));
const prompt = process.argv.at(-1);
if (prompt === "fail") { console.error("boom"); process.exit(2); }
if (prompt === "processes") writeFileSync(${JSON.stringify(join(dir, "processes.json"))}, JSON.stringify({ runner: process.ppid, ps: execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }) }));
if (prompt === "helper") {
  // A same-group helper that ignores TERM and holds the output pipe; Pi itself exits on TERM.
  const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
  writeFileSync(${JSON.stringify(join(dir, "helper.pid"))}, String(helper.pid));
}
if (prompt === "hang" || prompt === "helper") setInterval(() => {}, 1000);
else console.log("final answer for " + prompt);
`);
  const job = { id: "job1", prompt: "say hi", cwd, schedule: { kind: "cron", expr: "* * * * *" }, enabled: true, catchUp: true, timeoutSec: 30, model: "p/m:high", createdAt: Date.now() - 5 * MIN, ...jobExtra };
  writeJobs(dir, [job]);
  const env = { ...process.env, PI_SCHEDULE_DIR: dir, PI_SCHEDULE_PI: JSON.stringify([process.execPath, fakePi]), PI_SCHEDULE_NOTIFY: "0" };
  const dispatch = (...args) => spawnSync(process.execPath, [dispatchPath, ...args], { env, encoding: "utf8", timeout: 30_000 });
  return { dir, cwd, job, dispatch, env };
}

test("run: spawns pi -p in the job cwd with a fresh session id and records the answer", () => {
  const { dir, cwd, dispatch } = runnerFixture({ prompt: "-starts with a dash" });
  const result = dispatch("run", "job1");
  assert.equal(result.status, 0, result.stderr);
  const { argv, cwd: childCwd, run } = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
  assert.equal(childCwd, realpath(cwd));
  assert.equal(run, "job1", "child extension copy stays inert");
  assert.equal(argv[0], "-p");
  assert.equal(argv[argv.indexOf("--model") + 1], "p/m:high");
  assert.deepEqual(argv.slice(-2), ["--", "-starts with a dash"]);
  const [record] = readRuns(dir, "job1");
  assert.equal(record.status, "ok");
  assert.equal(record.output, "final answer for -starts with a dash");
  assert.equal(argv[argv.indexOf("--session-id") + 1], record.sessionId);
  assert.equal(readClaim(dir, "job1", 60_000), undefined, "claim released");
});

test("run: holds an idle-sleep assertion for exactly as long as the runner lives", { skip: process.platform !== "darwin" }, async () => {
  const { dir, dispatch } = runnerFixture({ prompt: "processes" });
  assert.equal(dispatch("run", "job1").status, 0);
  const { runner, ps } = JSON.parse(readFileSync(join(dir, "processes.json"), "utf8"));
  const assertion = `/usr/bin/caffeinate -i -w ${runner}`;
  assert.ok(ps.split("\n").some((line) => line.trim().endsWith(assertion)), "caffeinate ran during the run");
  const alive = () => spawnSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" }).stdout.split("\n").some((line) => line.trim() === assertion);
  for (let i = 0; i < 20 && alive(); i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(alive(), false, "released when the runner exited");
});

test("run: a prompt starting with @ stays text instead of becoming a file argument", () => {
  const { dir, dispatch } = runnerFixture({ prompt: "@TODO.md work through it" });
  assert.equal(dispatch("run", "job1").status, 0);
  const { argv } = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
  assert.deepEqual(argv.slice(-2), ["--", " @TODO.md work through it"]);
});

test("run: a timeout also kills helpers that ignore TERM, and the runner does not linger", () => {
  const { dir, dispatch } = runnerFixture({ prompt: "helper", timeoutSec: 1 });
  const started = Date.now();
  dispatch("run", "job1");
  assert.ok(Date.now() - started < 8000, "runner exited without waiting for the helper");
  assert.equal(readRuns(dir, "job1")[0].status, "timeout");
  const pid = Number(readFileSync(join(dir, "helper.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "helper killed");
});

test("run: SIGTERM to the runner (logout) records the interruption and releases the claim", async () => {
  const { dir, env } = runnerFixture({ prompt: "hang" });
  const runner = spawn(process.execPath, [dispatchPath, "run", "job1"], { env, stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(join(dir, "argv.json")); i++) await new Promise((r) => setTimeout(r, 50));
  runner.kill("SIGTERM");
  await new Promise((r) => runner.once("exit", r));
  const [record] = readRuns(dir, "job1");
  assert.equal(record.status, "error");
  assert.match(record.output, /Interrupted by SIGTERM/);
  assert.equal(existsSync(join(dir, "running", "job1.json")), false);
});

test("run: failures, timeouts and overlapping runs are recorded, never queued", () => {
  const failing = runnerFixture({ prompt: "fail" });
  failing.dispatch("run", "job1");
  assert.deepEqual(readRuns(failing.dir, "job1").map((r) => [r.status, r.output]), [["error", "boom"]]);

  const hanging = runnerFixture({ prompt: "hang", timeoutSec: 1 });
  hanging.dispatch("run", "job1");
  assert.equal(readRuns(hanging.dir, "job1")[0].status, "timeout");

  const busy = runnerFixture();
  claimJob(busy.dir, "job1", { pid: process.pid, startedAt: Date.now(), sessionId: "other" }, 60_000);
  busy.dispatch("run", "job1");
  assert.equal(readRuns(busy.dir, "job1")[0].status, "skipped");
  assert.equal(existsSync(join(busy.dir, "argv.json")), false, "pi never started");
});

test("tick: records the slot first, then a detached runner completes the run", async () => {
  const { dir, dispatch } = runnerFixture();
  assert.equal(dispatch("tick").status, 0);
  const state = JSON.parse(readFileSync(join(dir, "state", "job1.json"), "utf8"));
  assert.ok(state.lastRunAt <= Date.now());
  for (let i = 0; i < 100 && !readRuns(dir, "job1").length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readRuns(dir, "job1")[0]?.status, "ok");
  // The detached runner logs its outcome to the same file as the tick.
  for (let i = 0; i < 50 && !/job1 ok session/.test(readFileSync(join(dir, "logs", "dispatch.log"), "utf8")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(readFileSync(join(dir, "logs", "dispatch.log"), "utf8"), /job1 ok session/);
  // The same slot is not run again.
  dispatch("tick");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(readRuns(dir, "job1").length, 1);
});

function realpath(path) {
  return spawnSync("pwd", ["-P"], { cwd: path, encoding: "utf8" }).stdout.trim();
}

// Extension: command-only, session jobs, restore.
function fakePi() {
  const registered = { tools: [], commands: new Map(), handlers: {}, entries: [], sent: [] };
  const pi = {
    registerTool(tool) { registered.tools.push(tool); },
    registerCommand(name, command) { registered.commands.set(name, command); },
    on(event, handler) { registered.handlers[event] = handler; },
    appendEntry(customType, data) { registered.entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    sendUserMessage(content, options) { registered.sent.push({ content, options }); },
    getThinkingLevel() { return "high"; },
  };
  return { pi, registered };
}

function fakeCtx(registered, { idle = true } = {}) {
  const state = { idle, notes: [] };
  return {
    state,
    cwd: "/work", hasUI: false, mode: "print",
    model: { provider: "p", id: "m" },
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    sessionManager: { getEntries: () => registered.entries },
    ui: { notify: (text, type) => state.notes.push({ text, type }), setStatus() {} },
  };
}

function loadExtension(t, dir = tempDir()) {
  process.env.PI_SCHEDULE_DIR = dir;
  process.env.PI_SCHEDULE_LAUNCHD = "0";
  t.after(() => { delete process.env.PI_SCHEDULE_DIR; delete process.env.PI_SCHEDULE_LAUNCHD; });
  const { pi, registered } = fakePi();
  schedule(pi);
  const ctx = fakeCtx(registered);
  registered.handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  const command = (args) => registered.commands.get("schedule").handler(args, ctx);
  t.after(() => registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }));
  return { pi, registered, ctx, command, dir };
}

test("registers only a command: no tool, nothing in the model context", (t) => {
  const { registered } = loadExtension(t);
  assert.equal(registered.tools.length, 0);
  assert.deepEqual([...registered.commands.keys()], ["schedule"]);
  // No context or prompt hooks either: only lifecycle events.
  assert.deepEqual(Object.keys(registered.handlers).sort(), ["session_shutdown", "session_start"]);
});

test("does nothing inside a scheduled run", () => {
  const { pi, registered } = fakePi();
  process.env.PI_SCHEDULE_RUN = "x";
  try { schedule(pi); } finally { delete process.env.PI_SCHEDULE_RUN; }
  assert.equal(registered.commands.size, 0);
});

test("session jobs fire only while idle, once per due slot, and one-shots are removed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const { registered, ctx, command } = loadExtension(t);
  await command("in 1m check CI");
  await command("every 10m status");
  assert.equal(registered.entries.at(-1).data.jobs.length, 2, "snapshot saved");
  ctx.state.idle = false;
  t.mock.timers.tick(2 * MIN);
  assert.equal(registered.sent.length, 0, "busy: nothing sent");
  ctx.state.idle = true;
  t.mock.timers.tick(15_000);
  assert.deepEqual(registered.sent.map((s) => s.content), ["check CI"]);
  assert.deepEqual(registered.sent[0].options, { deliverAs: "followUp", expandPromptTemplates: true });
  assert.deepEqual(registered.entries.at(-1).data.jobs.map((job) => job.prompt), ["status"], "one-shot removed");
  // Asleep for 35 minutes (the clock jumps, no timer runs meanwhile): the recurring job fires
  // once on wake, then waits for its next slot instead of catching up the other two.
  t.mock.timers.setTime(Date.now() + 35 * MIN);
  t.mock.timers.tick(15_000);
  assert.deepEqual(registered.sent.map((s) => s.content), ["check CI", "status"]);
  t.mock.timers.tick(15_000);
  assert.equal(registered.sent.length, 2);
  t.mock.timers.tick(10 * MIN);
  assert.equal(registered.sent.length, 3, "next slot fires on time");
});

test("session jobs survive reload; one-shots that passed while closed are dropped", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const first = loadExtension(t);
  await first.command("in 1h later");
  await first.command("daily 9:00 standup");
  await first.registered.handlers.session_shutdown({ type: "session_shutdown", reason: "reload" });

  const { pi, registered } = fakePi();
  registered.entries.push(...first.registered.entries);
  schedule(pi);
  const ctx = fakeCtx(registered);
  registered.handlers.session_start({ type: "session_start", reason: "reload" }, ctx);
  await registered.commands.get("schedule").handler("list", ctx);
  assert.match(ctx.state.notes.at(-1).text, /later[\s\S]*standup/);
  await registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });

  // Resumed two hours later: the one-shot is gone, the recurring job stays.
  t.mock.timers.tick(2 * 60 * MIN);
  const resumed = fakePi();
  resumed.registered.entries.push(...registered.entries);
  schedule(resumed.pi);
  const later = fakeCtx(resumed.registered);
  resumed.registered.handlers.session_start({ type: "session_start", reason: "resume" }, later);
  assert.deepEqual(resumed.registered.entries.at(-1).data.jobs.map((job) => job.prompt), ["standup"]);
  assert.ok(later.state.notes.some((note) => /dropped one-shot/.test(note.text)));
  await resumed.registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });
});

test("bg jobs go to the store with cwd, pinned model and options; rm and pause update it", async (t) => {
  const { command, dir, ctx } = loadExtension(t);
  await command("bg --timeout 10m --tools read,bash --no-catchup daily 9:00 summarize commits");
  const [job] = readJobs(dir);
  assert.equal(job.prompt, "summarize commits");
  assert.equal(job.cwd, "/work");
  assert.equal(job.model, "p/m:high");
  assert.equal(job.timeoutSec, 600);
  assert.equal(job.tools, "read,bash");
  assert.equal(job.catchUp, false);
  assert.deepEqual(job.schedule, { kind: "cron", expr: "0 9 * * *" });
  await command(`pause ${job.id}`);
  assert.equal(readJobs(dir)[0].enabled, false);
  await command(`resume ${job.id}`);
  assert.equal(readJobs(dir)[0].enabled, true);
  assert.ok(readJobs(dir)[0].resumedAt);
  await command(`rm ${job.id}`);
  assert.deepEqual(readJobs(dir), []);
  await command("rm nope");
  assert.equal(ctx.state.notes.at(-1).type, "error");
});

test("unknown timing asks the model once, outside the session, and saves only after confirmation", async (t) => {
  const { registered, ctx, command } = loadExtension(t);
  // Without a UI there is no confirmation, so no model call either.
  await command("at 5pm every other day water the plants");
  assert.match(ctx.state.notes.at(-1).text, /Could not read the whole timing/);
  const calls = [];
  const confirms = [];
  let answer = false;
  Object.assign(ctx, {
    hasUI: true,
    model: { provider: "p", id: "m", name: "M", reasoning: true },
    modelRegistry: {
      streamSimple(model, context, options) {
        calls.push({ context, options });
        // The model gets the timing right but would reword the task; only its timing words count.
        return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"timing": "cron \\"0 17 */2 * *\\"", "words": "at 5pm every other day", "prompt": "water plants"}' }] }) };
      },
    },
  });
  ctx.ui.confirm = async (_title, body) => { confirms.push(body); return answer; };
  await command("at 5pm every other day water the plants");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.reasoning, "low");
  assert.match(calls[0].context.messages[0].content[0].text, /every other day water the plants/);
  assert.equal(registered.entries.length, 0, "declined: nothing saved");
  answer = true;
  await command("at 5pm every other day water the plants");
  assert.deepEqual(registered.entries.at(-1).data.jobs.map((job) => [job.prompt, job.schedule.expr]), [["water the plants", "0 17 */2 * *"]]);
  assert.match(confirms[1], /cron 0 17 \*\/2 \* \*\nNext runs: \w{3} \d{4}-\d{2}-\d{2} 17:00, [\s\S]*Prompt: water the plants/);
  assert.equal(registered.sent.length, 0, "nothing reaches the conversation");
  // One word ("lsit") or an empty bg command never costs a model call.
  await command("lsit");
  await command("bg");
  assert.equal(calls.length, 2);
  assert.equal(ctx.state.notes.at(-1).type, "error");
});

test("a one-shot that passes while the confirmation is open is rejected, not saved", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { registered, ctx, command } = loadExtension(t);
  Object.assign(ctx, {
    hasUI: true,
    model: { provider: "p", id: "m" },
    modelRegistry: { streamSimple: () => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"timing": "on 2026-11-01 10:01", "words": "a minute from now-ish"}' }] }) }) },
  });
  ctx.ui.confirm = async () => { t.mock.timers.setTime(NOW + 2 * MIN); return true; };
  await command("a minute from now-ish ping me");
  assert.match(ctx.state.notes.at(-1).text, /already passed/);
  assert.equal(registered.entries.length, 0);
});

test("finished bg one-shots are pruned with their state and run files on the next change", async (t) => {
  const dir = tempDir();
  const done = { id: "old1", prompt: "p", cwd: "/work", schedule: { kind: "once", at: Date.now() - MIN }, enabled: true, catchUp: true, timeoutSec: 60, createdAt: Date.now() - 2 * MIN };
  // Dispatched (slot recorded) but its runner has not started yet: not finished.
  const pending = { ...done, id: "new1" };
  writeJobs(dir, [done, pending]);
  appendRun(dir, { id: "old1", status: "ok", slot: done.schedule.at, startedAt: 1, endedAt: 2 });
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "state", "old1.json"), JSON.stringify({ lastRunAt: done.schedule.at }));
  writeFileSync(join(dir, "state", "new1.json"), JSON.stringify({ lastRunAt: done.schedule.at }));
  const { command } = loadExtension(t, dir);
  await command("bg in 5m next");
  assert.deepEqual(readJobs(dir).map((job) => job.id).slice(0, 1), ["new1"]);
  assert.deepEqual(readJobs(dir).map((job) => job.prompt).slice(1), ["next"]);
  assert.equal(existsSync(join(dir, "state", "old1.json")), false);
  assert.equal(readRuns(dir, "old1").length, 0);
});

test("bg options must come before the timing; --opt=value works; the notice shows the prompt and tools", async (t) => {
  const { command, dir, ctx } = loadExtension(t);
  await command("bg daily 9am --tools read summarize");
  assert.match(ctx.state.notes.at(-1).text, /Put options before the timing/);
  assert.deepEqual(readJobs(dir), []);
  await command("bg --tools=read daily 9am summarize");
  assert.equal(readJobs(dir)[0].tools, "read");
  assert.match(ctx.state.notes.at(-1).text, /Prompt: summarize\ncwd \/work, p\/m:high, tools read, timeout 30m/);
});

test("resuming a bg one-shot keeps its slot; recurring jobs skip what passed while paused", async (t) => {
  const { command, dir } = loadExtension(t);
  await command("bg in 5m once");
  await command("bg daily 9am recurring");
  for (const job of readJobs(dir)) { await command(`pause ${job.id}`); await command(`resume ${job.id}`); }
  assert.deepEqual(readJobs(dir).map((job) => [job.prompt, job.resumedAt === undefined]), [["once", true], ["recurring", false]]);
});

test("a fork does not inherit session jobs, so nothing fires twice", async (t) => {
  const first = loadExtension(t);
  await first.command("every 1h check CI");
  const { pi, registered } = fakePi();
  registered.entries.push(...first.registered.entries);
  schedule(pi);
  const ctx = fakeCtx(registered);
  registered.handlers.session_start({ type: "session_start", reason: "fork" }, ctx);
  assert.deepEqual(registered.entries.at(-1).data.jobs, [], "empty snapshot keeps the fork empty on resume");
  await registered.commands.get("schedule").handler("list", ctx);
  assert.match(ctx.state.notes.at(-1).text, /No scheduled jobs/);
  registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });
});

test("session timer: earliest due job first, and an error never escapes the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const { registered, ctx, command } = loadExtension(t);
  await command("every 1m frequent");
  await command("in 90s overdue");
  // Each run of the frequent job outlasts its interval, so it is due again at every idle tick.
  const busyFor = (ms) => { ctx.state.idle = false; t.mock.timers.tick(ms); ctx.state.idle = true; t.mock.timers.tick(15_000); };
  busyFor(90_000);
  busyFor(2 * MIN);
  assert.deepEqual(registered.sent.map((s) => s.content), ["frequent", "overdue"], "creation order would send frequent twice");
  registered.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" });
  const failing = loadExtension(t);
  await failing.command("in 1m boom");
  failing.pi.sendUserMessage = () => { throw new Error("send failed"); };
  t.mock.timers.tick(2 * MIN);
  assert.equal(failing.ctx.state.notes.at(-1).text, "Schedule: send failed");
  assert.equal(failing.ctx.state.notes.at(-1).type, "error");
});

test("is included in the package manifest with cron-parser as a runtime dependency", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/schedule/index.ts"));
  assert.ok(manifest.dependencies["cron-parser"]);
});
