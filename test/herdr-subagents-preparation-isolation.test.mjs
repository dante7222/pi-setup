import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { atomic, locked, prepareTasks } from "../extensions/herdr-subagents/core.ts";
import { processIdentity } from "../extensions/herdr-subagents/identity.ts";

const exec = promisify(execFile);
const tasks = [{ name: "prepared", prompt: "private test payload" }];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-preparation-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, pane: "fake-parent", workspace: "fake-workspace", env: {} };
}

async function queued(scope, settled) {
  const deadline = Date.now() + 5000;
  while ((await readdir(join(scope.root, "locks"))).length < 2) {
    assert.equal(settled(), false, "Preparation must join scoped admission before publication");
    assert.ok(Date.now() < deadline, "Preparation never queued for admission");
    await delay(10);
  }
}

test("standalone preparation/core imports work without Pi aliases or development dependencies", async (t) => {
  const scope = await fixture(t);
  const target = join(scope.root, "implementation");
  await cp(new URL("../extensions/herdr-subagents/", import.meta.url), target, { recursive: true });
  const script = join(scope.root, "probe.mjs");
  await writeFile(script, `import {prepareTasks} from './implementation/core.ts';
const result=await prepareTasks({root:${JSON.stringify(join(scope.root, "private-state"))},env:{}},${JSON.stringify(tasks)});
console.log(JSON.stringify(result));`);
  const result = await exec(process.execPath, ["--experimental-strip-types", script], {
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: scope.root, TMPDIR: tmpdir() }, timeout: 15000,
  }).catch((error) => { throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`, { cause: error }); });
  assert.equal(typeof JSON.parse(result.stdout).requestId, "string");
});

for (const reason of ["abort", "ownership"]) test(`queued preparation is fenced by ${reason} before publishing`, async (t) => {
  const scope = await fixture(t);
  const authority = { token: "owner-a", identity: await processIdentity() };
  assert.ok(authority.identity);
  await atomic(join(scope.root, "owner.json"), authority);
  const owned = { ...scope, authority };
  const controller = new AbortController();
  let outcome;
  let settled = false;
  await locked(scope, async () => {
    outcome = prepareTasks(owned, tasks, controller.signal).then(
      (value) => { settled = true; return { value }; },
      (error) => { settled = true; return { error }; },
    );
    try {
      await queued(scope, () => settled);
      if (reason === "abort") controller.abort(new Error("prepare admission aborted"));
      else await atomic(join(scope.root, "owner.json"), { ...authority, token: "owner-b" });
    } catch (error) { controller.abort(); throw error; }
  });
  assert.match(String((await outcome).error), reason === "abort" ? /abort/i : /ownership changed or ended/i);
  await assert.rejects(readdir(join(scope.root, "requests")), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(scope.root, "locks")), []);
});

test("matching but dead parent identity cannot prepare an operation", async (t) => {
  const scope = await fixture(t);
  const identity = await processIdentity();
  const authority = { token: "dead-owner", identity: { ...identity, pid: 2147483647 } };
  await atomic(join(scope.root, "owner.json"), authority);
  await assert.rejects(prepareTasks({ ...scope, authority }, tasks), /ownership changed or ended/i);
  await assert.rejects(readdir(join(scope.root, "requests")), { code: "ENOENT" });
});

test("abort during temporary preparation write prevents publication and cleans its temporary file", async (t) => {
  const scope = await fixture(t);
  const controller = new AbortController();
  const original = fs.writeFile;
  t.mock.method(fs, "writeFile", async (path, ...args) => {
    const result = await original(path, ...args);
    if (String(path).startsWith(join(scope.root, "requests") + "/") && String(path).endsWith(".tmp")) controller.abort(new Error("abort before publish"));
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(prepareTasks(scope, tasks, controller.signal), /abort before publish/);
  assert.deepEqual(await readdir(join(scope.root, "requests")), []);
  assert.deepEqual(await readdir(join(scope.root, "locks")), []);
});
