import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const transport = fileURLToPath(new URL("./herdr-subagents-durable-transport.test.mjs", import.meta.url));
const helper = new URL("./helpers/herdr-test-environment.mjs", import.meta.url).href;

async function runFixture(args, options) {
  try { return await exec(process.execPath, args, options); }
  catch (error) {
    // execFile's default rejection hides the nested TAP stdout, concealing the
    // actual assertion when an inherited-environment probe fails under load.
    throw new Error(`${error.message}\nNested stdout:\n${error.stdout ?? ""}\nNested stderr:\n${error.stderr ?? ""}`, { cause: error });
  }
}

async function workerEnvironment(t, worker) {
  const root = await mkdtemp(join(tmpdir(), "herdr-test-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "auth.json"), "{}\n");
  await writeFile(join(root, "settings.json"), "{}\n");
  // Allowlist OS essentials: no caller credentials, Node preload, live socket,
  // agent directory, or real executable overrides reach the child test runner.
  return {
    PATH: process.env.PATH || "/usr/bin:/bin", HOME: root, TMPDIR: tmpdir(),
    PI_CODING_AGENT_DIR: root, PI_SESSION_ID: "inherited-worker-session",
    HERDR_ENV: "1", HERDR_SOCKET_PATH: join(root, "not-a-socket"),
    HERDR_PANE_ID: "inherited-worker-pane", HERDR_WORKSPACE_ID: "inherited-workspace",
    HERDR_BIN_PATH: join(root, "must-not-run-herdr"),
    PI_HERDR_WORKER: worker, PI_HERDR_OWNER_PID: String(process.pid),
    PI_HERDR_JOB_DIR: join(root, "must-not-read-job"), PI_HERDR_GROUP: "inherited-group",
    PI_HERDR_PARENT_GROUP: "inherited-parent-group", PI_HERDR_DURABLE_BOOT: "stale-boot-token",
    PI_HERDR_PI_BIN: join(root, "must-not-run-pi"), PI_HERDR_DURABLE_FAUX: "1",
    PI_HERDR_FUTURE_MARKER: "also-must-not-leak",
  };
}

for (const worker of ["0", "1"]) {
  test(`durable fixtures isolate inherited PI_HERDR_WORKER=${worker} with faux-only IPC`, { timeout: 120_000 }, async (t) => {
    const env = await workerEnvironment(t, worker);
    const { stdout, stderr } = await runFixture([
      "--test", "--test-reporter=tap",
      "--test-name-pattern=explicit opt-in|fixture restores inherited|simultaneous CLI starts",
      transport,
    ], { env, timeout: 110_000, maxBuffer: 1024 * 1024 });
    assert.match(stdout, /# fail 0/, stderr);
    for (const name of ["explicit opt-in", "fixture restores inherited", "simultaneous CLI starts"]) {
      assert.match(stdout, new RegExp(`ok \\d+ - ${name}`), stderr);
    }
    assert.deepEqual((await readdir(env.PI_CODING_AGENT_DIR)).sort(), ["auth.json", "settings.json"]);
  });
}

for (const worker of ["0", "1"]) {
  test(`codemode and parent-group fixtures isolate inherited PI_HERDR_WORKER=${worker}`, { timeout: 120_000 }, async (t) => {
    const env = await workerEnvironment(t, worker);
    const files = ["herdr-subagents-codemode", "session-groups-lifecycle", "session-groups-membership"];
    const { stdout, stderr } = await runFixture([
      "--test", "--test-reporter=tap", ...files.map((file) => fileURLToPath(new URL(`./${file}.test.mjs`, import.meta.url))),
    ], { env, timeout: 110_000, maxBuffer: 1024 * 1024 });
    assert.match(stdout, /# fail 0/, stderr);
    assert.match(stdout, /# cancelled 0/, stderr);
    assert.deepEqual((await readdir(env.PI_CODING_AGENT_DIR)).sort(), ["auth.json", "settings.json"]);
  });
}

test("nested fixture failures retain stdout, stderr and the original cause", async (t) => {
  const env = await workerEnvironment(t, "1");
  await assert.rejects(runFixture(["--input-type=module", "-e", "console.log('nested TAP failure');console.error('nested stderr');process.exitCode=1;"], { env, timeout: 10000 }), (error) => {
    assert.match(error.message, /Nested stdout:\nnested TAP failure/);
    assert.match(error.message, /Nested stderr:\nnested stderr/);
    assert.equal(error.cause.code, 1);
    return true;
  });
});

test("test-only environment restoration survives body and cleanup failures", { timeout: 15_000 }, async (t) => {
  const env = await workerEnvironment(t, "1");
  const script = `
    import assert from 'node:assert/strict';
    import test from 'node:test';
    import { isolateHerdrEnvironment } from ${JSON.stringify(helper)};
    const inherited = { ...process.env };
    for (const failure of ['body', 'cleanup']) {
      test(failure, (t) => {
        const isolated = isolateHerdrEnvironment(t, {
          PI_HERDR_WORKER: '0', PI_HERDR_DURABLE_FAUX: '1',
          PI_CODING_AGENT_DIR: 'test-only-config',
        }, async () => {
          if (failure === 'cleanup') throw Error('injected cleanup failure');
        });
        assert.equal(isolated.PI_HERDR_FUTURE_MARKER, undefined);
        assert.equal(isolated.HERDR_SOCKET_PATH, undefined);
        process.env.PI_HERDR_ADDED_DURING_TEST = 'temporary';
        if (failure === 'body') throw Error('injected body failure');
      });
      // afterEach runs before t.after; a subsequent sequential test observes
      // the completed teardown even when the preceding test deliberately fails.
      test('restored after ' + failure, () => {
        assert.deepEqual({ ...process.env }, inherited);
        console.log('INHERITED_ENV_RESTORED');
      });
    }
  `;
  const result = await exec(process.execPath, ["--input-type=module", "-e", script], {
    env, timeout: 10_000, maxBuffer: 1024 * 1024,
  }).then(() => assert.fail("Failure probe unexpectedly passed"), (error) => error);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /injected body failure/);
  assert.match(result.stdout, /injected cleanup failure/);
  assert.equal(result.stdout.match(/INHERITED_ENV_RESTORED/g)?.length, 2, result.stdout);
});
