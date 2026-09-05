import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { ProcessTree, snapshotProcesses } from "../extensions/herdr-subagents/process-tree.ts";

const exec = promisify(execFile);
const supported = process.platform === "darwin" || process.platform === "linux";
const options = { skip: !supported, timeout: 15_000 };
const helperURL = new URL("../extensions/herdr-subagents/process-tree.ts", import.meta.url).href;
const fixtureSource = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotProcesses } from ${JSON.stringify(helperURL)};
const [mode, dir, name = "root"] = process.argv.slice(2);
writeFileSync(join(dir, name + ".pid"), String(process.pid));
process.on("SIGUSR1", () => writeFileSync(join(dir, name + ".signaled"), "yes"));
// Deliberately require supervisor escalation, not cooperative Pi shutdown.
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
if (mode === "leaf") writeFileSync(join(dir, name + ".ready"), "yes");
else {
  process.on("message", async (message) => {
    if (message.action === "exit") {
      if (message.snapshot) writeFileSync(join(dir, "shutdown.json"), JSON.stringify(await snapshotProcesses()));
      process.exit(0);
    }
    const args = [process.argv[1], "leaf", dir, message.name];
    const child = message.bash
      ? spawn("/bin/bash", ["-c", 'trap "" TERM; "$1" --experimental-strip-types "$2" leaf "$3" "$4" & wait',
          "fixture", process.execPath, process.argv[1], dir, message.name], { detached: true, stdio: "ignore" })
      : spawn(process.execPath, ["--experimental-strip-types", ...args], { detached: !!message.detached, stdio: "ignore" });
    writeFileSync(join(dir, message.name + ".leader.pid"), String(child.pid));
    child.on("error", (error) => { throw error; });
    process.send({ pid: child.pid });
  });
  process.send({ ready: true });
}
`;

async function waitFor(check, description) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(25);
  }
}

async function state(pid) {
  try {
    return (await exec("/bin/ps", ["-p", String(pid), "-o", "stat="], { timeout: 2000 })).stdout.trim();
  } catch (error) {
    if (error.code === 1 && !error.stdout.trim()) return "";
    throw error;
  }
}

async function dead(pid) {
  const status = await state(pid);
  // Linux container init may not reap orphans immediately. Zombies cannot run.
  return !status || status.startsWith("Z");
}

async function exists(path) {
  try { await readFile(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-process-tree-test-"));
  let root;
  t.after(async () => {
    try {
      // Independent cleanup: do not rely on the implementation under test.
      // Include orphan PIDs saved by the fixture, plus still-attached descendants.
      const pids = new Set(root?.pid ? [root.pid] : []);
      for (const name of (await readdir(dir)).filter((name) => name.endsWith(".pid"))) {
        pids.add(Number(await readFile(join(dir, name), "utf8")));
      }
      const snapshot = await snapshotProcesses();
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of snapshot) {
          if (pids.has(entry.ppid) && !pids.has(entry.pid)) { pids.add(entry.pid); changed = true; }
        }
      }
      for (const entry of snapshot.filter((entry) => pids.has(entry.pid))) {
        for (const target of entry.pid === entry.pgid ? [-entry.pgid, entry.pid] : [entry.pid]) {
          try { process.kill(target, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
      await waitFor(async () => (await Promise.all([...pids].map(dead))).every(Boolean), "fixture cleanup");
    } finally {
      if (root?.connected) root.disconnect();
      await rm(dir, { recursive: true, force: true });
    }
  });
  const script = join(dir, "fixture.mjs");
  await writeFile(script, fixtureSource);
  root = spawn(process.execPath, ["--experimental-strip-types", script, "root", dir], {
    detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  assert.deepEqual((await once(root, "message"))[0], { ready: true });
  return {
    root, dir,
    async spawn(name, settings = {}) {
      const reply = once(root, "message");
      root.send({ action: "spawn", name, ...settings });
      const [{ pid: leader }] = await reply;
      await waitFor(() => exists(join(dir, name + ".ready")), "leaf ready");
      return { leader, pid: Number(await readFile(join(dir, name + ".pid"), "utf8")) };
    },
    async exit(snapshot = false) {
      const exited = once(root, "exit");
      root.send({ action: "exit", snapshot });
      assert.deepEqual(await exited, [0, null]);
    },
  };
}

test("snapshot contains normalized identities only; invalid root PIDs are rejected", options, async () => {
  const rows = await snapshotProcesses();
  const self = rows.find((entry) => entry.pid === process.pid);
  assert.ok(self);
  assert.deepEqual(Object.keys(self).sort(), ["pgid", "pid", "ppid", "start", "state"]);
  assert.match(self.start, /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  for (const pid of [0, 1, -1, 1.5, NaN, Infinity, 2 ** 32, process.pid]) {
    assert.throws(() => new ProcessTree(pid), /owned child PID/);
  }
});

test("SIGSTOP Pi cannot protect detached Bash and its TERM-resistant child from escalation", options, async (t) => {
  const f = await fixture(t);
  const unrelated = await fixture(t);
  const tree = new ProcessTree(f.root.pid);
  await tree.refresh();
  const child = await f.spawn("bash-child", { bash: true });
  const snapshot = await snapshotProcesses();
  assert.equal(snapshot.find((entry) => entry.pid === child.leader).pgid, child.leader);
  assert.equal(snapshot.find((entry) => entry.pid === child.pid).ppid, child.leader);
  process.kill(f.root.pid, "SIGSTOP");
  await waitFor(async () => (await state(f.root.pid)).startsWith("T"), "root stopped");
  // Even a final refresh after STOP must discover the detached Bash group.
  await tree.signal("SIGTERM");
  assert.equal(await dead(child.leader), false);
  assert.equal(await dead(child.pid), false);
  assert.match(await state(f.root.pid), /^T/);
  await tree.signal("SIGKILL");
  await waitFor(async () => (await Promise.all([f.root.pid, child.leader, child.pid].map(dead))).every(Boolean), "stopped tree killed");
  assert.equal(await dead(unrelated.root.pid), false);
});

test("root group survives leader exit, including children born after the previous sample", options, async (t) => {
  const f = await fixture(t);
  const tree = new ProcessTree(f.root.pid);
  await tree.refresh(); // No child exists yet.
  const child = await f.spawn("same-group");
  await f.exit();
  const snapshot = await snapshotProcesses();
  assert.equal(snapshot.find((entry) => entry.pid === child.pid).pgid, f.root.pid);
  assert.notEqual(snapshot.find((entry) => entry.pid === child.pid).ppid, f.root.pid);
  await tree.refresh();
  await tree.signal("SIGKILL");
  await waitFor(() => dead(child.pid), "same-group orphan killed");
  await tree.signal("SIGKILL"); // Idempotent once the whole tree has disappeared.
});

test("a discovered detached group is retained after both Pi and Bash leaders exit", options, async (t) => {
  const f = await fixture(t);
  const tree = new ProcessTree(f.root.pid);
  const child = await f.spawn("detached", { bash: true });
  await tree.refresh();
  await f.exit();
  process.kill(child.leader, "SIGKILL");
  await waitFor(() => dead(child.leader), "Bash leader dead");
  assert.equal(await dead(child.pid), false);
  await tree.refresh();
  await tree.signal("SIGKILL");
  await waitFor(() => dead(child.pid), "detached leaderless group killed");
});

test("zombie-only detached groups are not signaled while their parent is stopped", options, async (t) => {
  const f = await fixture(t);
  const child = await f.spawn("zombie", { detached: true });
  const tree = new ProcessTree(f.root.pid);
  await tree.refresh();
  process.kill(f.root.pid, "SIGSTOP");
  await waitFor(async () => (await state(f.root.pid)).startsWith("T"), "parent stopped");
  process.kill(child.pid, "SIGKILL");
  await waitFor(() => dead(child.pid), "child exited without parent reaping it");
  assert.equal(await tree.signal("SIGKILL"), 1, "Only the still-live parent group is signaled");
  await waitFor(() => dead(f.root.pid), "parent exited");
});

test("a non-leader root does not claim its shared group or signal unrelated siblings", options, async (t) => {
  const f = await fixture(t);
  const owned = await f.spawn("owned");
  const sibling = await f.spawn("sibling");
  const tree = new ProcessTree(owned.pid);
  await tree.refresh();
  await tree.signal("SIGUSR1");
  await waitFor(() => exists(join(f.dir, "owned.signaled")), "owned signal received");
  await delay(100);
  assert.equal(await exists(join(f.dir, "sibling.signaled")), false);
  assert.equal(await exists(join(f.dir, "root.signaled")), false);
  await tree.signal("SIGKILL");
  await waitFor(() => dead(owned.pid), "owned non-leader killed");
  assert.equal(await dead(sibling.pid), false);
  assert.equal(await dead(f.root.pid), false);
});

test("trusted shutdown snapshot closes normal-exit detached-child polling gap", options, async (t) => {
  const f = await fixture(t);
  const tree = new ProcessTree(f.root.pid);
  await tree.refresh();
  const child = await f.spawn("late-detached", { detached: true });
  await f.exit(true); // Models an awaited session_shutdown hook, without polling.
  await tree.refresh(); // Root group has already disappeared; handoff arrives later.
  const saved = JSON.parse(await readFile(join(f.dir, "shutdown.json"), "utf8"));
  await tree.refresh(saved);
  await tree.signal("SIGKILL");
  await waitFor(() => dead(child.pid), "hook-discovered orphan killed");
});

test("stale root identity cannot signal a reused PID or process group", options, async (t) => {
  const f = await fixture(t);
  const child = await f.spawn("survivor");
  const rows = await snapshotProcesses();
  const root = rows.find((entry) => entry.pid === f.root.pid);
  const tree = new ProcessTree(f.root.pid);
  // Deterministic PID reuse simulation: the saved owner predates the live process.
  await tree.refresh([{ ...root, start: "Mon Jan 1 00:00:00 2001" }]);
  await tree.signal("SIGUSR1");
  await assert.rejects(tree.refresh(rows), /root identity/);
  await tree.signal("SIGUSR1"); // A rejected operation must not poison the queue.
  await delay(100);
  assert.equal(await exists(join(f.dir, "root.signaled")), false);
  assert.equal(await exists(join(f.dir, "survivor.signaled")), false);
  assert.equal(await dead(child.pid), false);
});

test("a missing root on initialization never attaches to a later numeric occupant", options, async (t) => {
  const f = await fixture(t);
  const tree = new ProcessTree(f.root.pid);
  await tree.refresh([]);
  await tree.refresh();
  await tree.signal("SIGUSR1");
  await delay(100);
  assert.equal(await exists(join(f.dir, "root.signaled")), false);
});

test("stale non-leader PID identity is revalidated before individual signaling", options, async (t) => {
  const f = await fixture(t);
  const unrelated = await fixture(t);
  const child = await unrelated.spawn("unrelated");
  const rows = await snapshotProcesses();
  const root = rows.find((entry) => entry.pid === f.root.pid);
  const other = rows.find((entry) => entry.pid === child.pid);
  const tree = new ProcessTree(f.root.pid);
  await tree.refresh([root, { ...other, ppid: root.pid, start: "Mon Jan 1 00:00:00 2001" }]);
  await tree.signal("SIGUSR1");
  await waitFor(() => exists(join(f.dir, "root.signaled")), "root signaled");
  await delay(100);
  assert.equal(await exists(join(unrelated.dir, "unrelated.signaled")), false);
});

test("stale detached descendant identity cannot signal a reused child PID/group", options, async (t) => {
  const f = await fixture(t);
  const unrelated = await fixture(t);
  const rows = await snapshotProcesses();
  const root = rows.find((entry) => entry.pid === f.root.pid);
  const other = rows.find((entry) => entry.pid === unrelated.root.pid);
  const tree = new ProcessTree(f.root.pid);
  await tree.refresh([root, { ...other, ppid: root.pid, start: "Mon Jan 1 00:00:00 2001" }]);
  await Promise.all([tree.refresh(), tree.signal("SIGUSR1"), tree.refresh()]);
  await waitFor(() => exists(join(f.dir, "root.signaled")), "root signaled");
  await delay(100);
  assert.equal(await exists(join(unrelated.dir, "root.signaled")), false);
});
