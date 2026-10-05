import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import permissions from "../extensions/permissions/index.ts";

const ask = { toolName: "bash", input: { command: "npm test" } };
const otherAsk = { toolName: "bash", input: { command: "npm run build" } };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let tries = 0; tries < 100; tries++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("expected asynchronous condition did not settle");
}

async function promptly(promise) {
  let settled = false;
  const observed = promise.finally(() => { settled = true; });
  await waitFor(() => settled);
  return observed;
}

function dialogs(cooperative = true) {
  const opened = [];
  let active = 0;
  let maxActive = 0;
  return {
    opened,
    get maxActive() { return maxActive; },
    select(title, choices, options) {
      const pending = deferred();
      active++;
      maxActive = Math.max(maxActive, active);
      const onAbort = () => pending.resolve(undefined);
      if (cooperative) options.signal.addEventListener("abort", onAbort, { once: true });
      opened.push({ title, choices, options, ...pending });
      return pending.promise.finally(() => {
        active--;
        options.signal.removeEventListener("abort", onAbort);
      });
    },
  };
}

function harness(select, entries = [], flagValues = {}) {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map(Object.entries(flagValues));
  permissions({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, flag) => { if (!flags.has(name)) flags.set(name, flag.default); },
    getFlag: (name) => flags.get(name),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  });
  const context = (sessionId = "session-1", options = {}) => {
    const notifications = [];
    const statuses = [];
    return {
      cwd: "/repo",
      mode: "tui",
      hasUI: true,
      signal: undefined,
      sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
      ui: {
        select,
        notify: (...args) => notifications.push(args),
        setStatus: (...args) => statuses.push(args),
        theme: { fg: (_color, text) => text, bold: (text) => text },
      },
      notifications,
      statuses,
      ...options,
    };
  };
  return {
    entries, flags, handlers, context,
    start: (ctx, reason = "startup") => handlers.get("session_start")({ type: "session_start", reason }, ctx),
    stop: (ctx, reason = "quit") => handlers.get("session_shutdown")({ type: "session_shutdown", reason }, ctx),
    call: (event, ctx) => handlers.get("tool_call")(event, ctx),
    command: (name, args, ctx) => commands.get(name).handler(args, ctx),
  };
}

function delayedLoads(t) {
  const loads = [];
  t.mock.method(fsPromises, "stat", async () => ({ isFile: () => true, size: 1 }));
  t.mock.method(fsPromises, "readFile", () => {
    const load = deferred();
    loads.push(load);
    return load.promise;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return loads;
}

test("parallel asks serialize dialogs; allow once never becomes a session grant", async () => {
  const ui = dialogs();
  const h = harness(ui.select);
  const ctx = h.context();
  await h.start(ctx);
  const first = h.call(ask, ctx);
  const second = h.call(ask, ctx);
  const third = h.call(otherAsk, ctx);
  await waitFor(() => ui.opened.length === 1);
  assert.equal(await h.call({ toolName: "read", input: { path: "README.md" } }, ctx), undefined);
  assert.equal((await h.call({ toolName: "edit", input: { path: "README.md" } }, ctx)).block, true);
  assert.equal(ui.opened.length, 1);
  ui.opened[0].resolve("Allow once");
  assert.equal(await first, undefined);
  await waitFor(() => ui.opened.length === 2);
  ui.opened[1].resolve("Allow once");
  assert.equal(await second, undefined);
  await waitFor(() => ui.opened.length === 3);
  ui.opened[2].resolve("Deny");
  assert.equal((await third).block, true);
  assert.equal(ui.maxActive, 1);
  assert.deepEqual(h.entries, []);
});

test("queued identical requests recheck session grants without another prompt", async () => {
  const ui = dialogs();
  const h = harness(ui.select);
  const ctx = h.context();
  await h.start(ctx);
  const calls = Array.from({ length: 12 }, () => h.call(ask, ctx));
  await waitFor(() => ui.opened.length === 1);
  ui.opened[0].resolve("Allow for this session");
  assert.deepEqual(await Promise.all(calls), Array(12).fill(undefined));
  assert.equal(ui.opened.length, 1);
  assert.equal(ui.maxActive, 1);
  assert.equal(h.entries.length, 1);
  assert.deepEqual(h.entries[0].data.keys, [createHash("sha256").update("bash\0npm test").digest("hex")]);
  assert.equal(JSON.stringify(h.entries).includes("npm test"), false);
  const different = h.call(otherAsk, ctx);
  await waitFor(() => ui.opened.length === 2);
  ui.opened[1].resolve("Deny");
  assert.equal((await different).block, true);
});

test("queued and pre-aborted calls cancel promptly without opening stale UI", async () => {
  const ui = dialogs();
  const h = harness(ui.select);
  const ctx = h.context();
  await h.start(ctx);
  const first = h.call(ask, ctx);
  await waitFor(() => ui.opened.length === 1);
  const abort = new AbortController();
  const queuedCtx = h.context("session-1", { signal: abort.signal });
  const queued = h.call(otherAsk, queuedCtx);
  const following = h.call(otherAsk, ctx);
  abort.abort();
  assert.equal((await promptly(queued)).block, true);
  assert.equal((await promptly(h.call(ask, queuedCtx))).block, true);
  assert.equal(ui.opened.length, 1);
  ui.opened[0].resolve("Allow once");
  assert.equal(await first, undefined);
  await waitFor(() => ui.opened.length === 2);
  ui.opened[1].resolve("Deny");
  assert.equal((await following).block, true);
  assert.equal(ui.maxActive, 1);
});

test("active cancellation dismisses cooperative UI and releases the next prompt", async () => {
  const ui = dialogs();
  const h = harness(ui.select);
  const abort = new AbortController();
  const ctx = h.context("session-1", { signal: abort.signal });
  await h.start(ctx);
  const first = h.call(ask, ctx);
  const next = h.call(otherAsk, h.context());
  await waitFor(() => ui.opened.length === 1);
  abort.abort();
  assert.equal((await promptly(first)).block, true);
  assert.equal(ui.opened[0].options.signal.aborted, true);
  await waitFor(() => ui.opened.length === 2);
  ui.opened[1].resolve("Allow once");
  assert.equal(await next, undefined);
  assert.equal(ui.maxActive, 1);
  assert.deepEqual(h.entries, []);
});

for (const choice of ["Allow once", "Allow for this session"]) {
  test(`noncooperative late ${choice} after active abort cannot approve`, async () => {
    const ui = dialogs(false);
    const h = harness(ui.select);
    const abort = new AbortController();
    const ctx = h.context("session-1", { signal: abort.signal });
    await h.start(ctx);
    const first = h.call(ask, ctx);
    const next = h.call(ask, h.context());
    await waitFor(() => ui.opened.length === 1);
    abort.abort();
    assert.equal((await promptly(first)).block, true);
    await setImmediate();
    assert.equal(ui.opened.length, 1, "a still-live adapter must retain its dialog slot");
    ui.opened[0].resolve(choice);
    await waitFor(() => ui.opened.length === 2);
    assert.deepEqual(h.entries, []);
    ui.opened[1].resolve("Deny");
    assert.equal((await next).block, true);
    assert.equal(ui.maxActive, 1);
  });
}

for (const choice of ["Allow once", "Allow for this session"]) {
  test(`already resolved ${choice} still checks abort before accepting the selection`, async () => {
    const abort = new AbortController();
    const h = harness(() => {
      // Settle the cancellation race with an approval, then abort before its
      // awaiting continuation. Only the post-select guard can reject it.
      const result = Promise.resolve(choice);
      queueMicrotask(() => queueMicrotask(() => abort.abort()));
      return result;
    });
    const ctx = h.context("session-1", { signal: abort.signal });
    await h.start(ctx);
    assert.equal((await h.call(ask, ctx)).block, true);
    assert.deepEqual(h.entries, []);
  });
}

test("throwing and rejecting prompts release the queue", async () => {
  let count = 0;
  const h = harness(() => {
    count++;
    if (count === 1) throw new Error("sync UI failure");
    if (count === 2) return Promise.reject(new Error("async UI failure"));
    return Promise.resolve("Allow once");
  });
  const ctx = h.context();
  await h.start(ctx);
  const [first, second, third] = await Promise.all([h.call(ask, ctx), h.call(ask, ctx), h.call(ask, ctx)]);
  assert.match(first.reason, /Permission prompt failed: sync UI failure/);
  assert.match(second.reason, /Permission prompt failed: async UI failure/);
  assert.equal(third, undefined);
  assert.equal(count, 3);
});

for (const reason of ["new", "resume", "fork", "reload", "quit", "start-without-shutdown"]) {
  test(`${reason} invalidates active/queued approvals and old context state`, async () => {
    const ui = dialogs(false);
    const h = harness(ui.select);
    const ctx = h.context();
    await h.start(ctx);
    const active = h.call(ask, ctx);
    const queued = h.call(ask, ctx);
    await waitFor(() => ui.opened.length === 1);
    if (reason !== "start-without-shutdown") {
      await h.stop(ctx, reason);
      await h.stop(ctx, reason); // idempotent cleanup
      assert.equal((await h.call(ask, ctx)).block, true);
    }
    const nextCtx = h.context(reason === "reload" ? "session-1" : "session-2");
    await h.start(nextCtx, reason === "start-without-shutdown" || reason === "quit" ? "startup" : reason);
    assert.equal((await promptly(active)).block, true);
    assert.equal((await promptly(queued)).block, true);
    assert.equal(ui.opened[0].options.signal.aborted, true);
    const next = h.call(ask, nextCtx);
    await setImmediate();
    assert.equal(ui.opened.length, 1);
    ui.opened[0].resolve("Allow for this session");
    await waitFor(() => ui.opened.length === 2);
    assert.deepEqual(h.entries, []);
    ui.opened[1].resolve("Deny");
    assert.equal((await next).block, true);
    assert.equal(ui.maxActive, 1);
  });
}

test("late rejected adapter after shutdown is consumed without leaking grants", async () => {
  const ui = dialogs(false);
  const h = harness(ui.select);
  const ctx = h.context();
  await h.start(ctx);
  const active = h.call(ask, ctx);
  await waitFor(() => ui.opened.length === 1);
  await h.stop(ctx);
  assert.equal((await promptly(active)).block, true);
  ui.opened[0].reject(new Error("late UI failure"));
  await setImmediate();
  assert.deepEqual(h.entries, []);
});

for (const oldOutcome of ["allow", "deny", "error"]) {
  test(`stale startup config ${oldOutcome} cannot overwrite a newer session`, async (t) => {
    const loads = delayedLoads(t);
    const h = harness(async () => "Deny");
    const oldCtx = h.context();
    const oldStart = h.start(oldCtx);
    await waitFor(() => loads.length === 1);
    const nextCtx = h.context("session-2");
    const nextStart = h.start(nextCtx, "new");
    await waitFor(() => loads.length === 2);
    const currentPolicy = oldOutcome === "allow" ? "deny" : "allow";
    loads[1].resolve(JSON.stringify({ permission: currentPolicy }));
    await nextStart;
    if (oldOutcome === "error") loads[0].reject(new Error("stale config error"));
    else loads[0].resolve(JSON.stringify({ permission: oldOutcome }));
    await oldStart;
    const result = await h.call(ask, nextCtx);
    assert.equal(result?.block, currentPolicy === "deny" ? true : undefined);
    assert.deepEqual(oldCtx.notifications, []);
    assert.deepEqual(oldCtx.statuses, []);
    assert.equal((await h.call(ask, oldCtx)).block, true);
  });
}

test("shutdown suppresses startup and YOLO-disable config completions", async (t) => {
  const loads = delayedLoads(t);
  const h = harness(async () => "Deny");
  const ctx = h.context();
  const starting = h.start(ctx);
  await waitFor(() => loads.length === 1);
  await h.stop(ctx, "reload");
  loads[0].resolve(JSON.stringify({ permission: "allow" }));
  await starting;
  assert.deepEqual(ctx.statuses, []);
  assert.equal((await h.call(ask, ctx)).block, true);

  const yoloEntry = { type: "custom", customType: "ventris-permissions", data: {
    version: 1, sessionId: "session-1", operation: "yolo", enabled: true,
  } };
  const yolo = harness(async () => "Deny", [yoloEntry]);
  const oldCtx = yolo.context();
  await yolo.start(oldCtx);
  const disabling = yolo.command("yolo", "", oldCtx);
  await waitFor(() => loads.length === 2);
  await yolo.stop(oldCtx, "new");
  const nextCtx = yolo.context("session-2");
  const nextStart = yolo.start(nextCtx, "new");
  await waitFor(() => loads.length === 3);
  loads[2].resolve(JSON.stringify({ permission: "deny" }));
  await nextStart;
  const oldStatuses = oldCtx.statuses.length;
  const oldNotifications = oldCtx.notifications.length;
  loads[1].resolve(JSON.stringify({ permission: "allow" }));
  await disabling;
  assert.equal((await yolo.call(ask, nextCtx)).block, true);
  assert.equal(oldCtx.statuses.length, oldStatuses);
  assert.equal(oldCtx.notifications.length, oldNotifications);
  assert.deepEqual(yolo.entries, [yoloEntry, {
    type: "custom", customType: "ventris-permissions", data: {
      version: 1, sessionId: "session-1", operation: "yolo", enabled: false,
    },
  }]);
});

test("session replacement clears prior grants and YOLO but keeps durable session scoping", async () => {
  let prompts = 0;
  const h = harness(async () => { prompts++; return "Allow for this session"; });
  const oldCtx = h.context();
  await h.start(oldCtx);
  assert.equal(await h.call(ask, oldCtx), undefined);
  await h.command("yolo", "", oldCtx);
  await h.stop(oldCtx, "new");
  const nextCtx = h.context("session-2");
  await h.start(nextCtx, "new");
  assert.match((await h.call({ toolName: "write", input: { path: "README.md" } }, nextCtx)).reason, /Denied by/);
  assert.equal(await h.call(ask, nextCtx), undefined);
  assert.equal(prompts, 2);
  assert.deepEqual(h.entries.filter((entry) => entry.data.operation === "grant").map((entry) => entry.data.sessionId), [
    "session-1", "session-2",
  ]);
});

test("in-flight config loads cannot overwrite newer YOLO toggles", async (t) => {
  const loads = delayedLoads(t);
  const h = harness(async () => assert.fail("YOLO must not prompt"));
  const ctx = h.context();
  const starting = h.start(ctx);
  await waitFor(() => loads.length === 1);
  await h.command("yolo", "", ctx);
  loads[0].resolve(JSON.stringify({ permission: "deny" }));
  await starting;
  assert.equal(await h.call({ toolName: "read", input: {} }, ctx), undefined);
  const disabling = h.command("yolo", "", ctx);
  await waitFor(() => loads.length === 2);
  await h.command("yolo", "", ctx);
  loads[1].reject(new Error("obsolete configuration failure"));
  await disabling;
  assert.equal(await h.call({ toolName: "read", input: {} }, ctx), undefined);
  assert.deepEqual(h.entries.map((entry) => entry.data.enabled), [true, false, true]);
});

for (const oldOutcome of ["allow", "error"]) {
  test(`resumed YOLO disable survives reload during policy load and stale ${oldOutcome}`, async (t) => {
    const original = harness(async () => assert.fail("must not prompt"));
    const originalCtx = original.context();
    await original.start(originalCtx);
    await original.command("yolo", "", originalCtx);
    await original.stop(originalCtx, "quit");

    const loads = delayedLoads(t);
    const resumed = harness(async () => assert.fail("must not prompt"), original.entries);
    const resumedCtx = resumed.context();
    await resumed.start(resumedCtx, "resume");
    assert.equal(loads.length, 0, "durable enable was restored without loading policy");
    assert.equal(await resumed.call({ toolName: "read", input: {} }, resumedCtx), undefined);
    const disabling = resumed.command("yolo", "", resumedCtx);
    assert.equal(resumed.entries.at(-1).data.enabled, false, "disable is durable before the first await");
    await waitFor(() => loads.length === 1);
    assert.match((await resumed.call(ask, resumedCtx)).reason, /Permissions unavailable/);
    await resumed.stop(resumedCtx, "reload");
    const oldStatuses = resumedCtx.statuses.length;
    const oldNotifications = resumedCtx.notifications.length;

    const reloaded = harness(async () => assert.fail("must not prompt"), resumed.entries);
    const nextCtx = reloaded.context();
    const starting = reloaded.start(nextCtx, "reload");
    await waitFor(() => loads.length === 2);
    assert.match((await reloaded.call(ask, nextCtx)).reason, /Permissions unavailable/);
    loads[1].resolve(JSON.stringify({ permission: "deny" }));
    await starting;
    assert.match((await reloaded.call(ask, nextCtx)).reason, /Denied by/);
    assert.equal(nextCtx.notifications.some(([message]) => message.includes("YOLO mode active")), false);

    if (oldOutcome === "error") loads[0].reject(new Error("obsolete disable load"));
    else loads[0].resolve(JSON.stringify({ permission: "allow" }));
    await disabling;
    assert.match((await reloaded.call(ask, nextCtx)).reason, /Denied by/);
    assert.equal(resumedCtx.statuses.length, oldStatuses);
    assert.equal(resumedCtx.notifications.length, oldNotifications);
    assert.deepEqual(reloaded.entries.map((entry) => entry.data.enabled), [true, false]);
  });
}

for (const end of ["abort", "reload", "new", "start-without-shutdown"]) {
  for (const outcome of ["exists", "error"]) {
    test(`read classification cancels promptly on ${end}, consumes late ${outcome}, and never probes again`, async (t) => {
      const h = harness(async () => assert.fail("cancelled classification must not prompt"));
      const abort = new AbortController();
      const ctx = h.context("session-1", { signal: abort.signal });
      await h.start(ctx);
      const pending = deferred();
      let probes = 0;
      t.mock.method(fsPromises, "access", () => { probes++; return pending.promise; });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const call = h.call({ toolName: "read", input: { path: "secret AM.txt" } }, ctx);
      await waitFor(() => probes === 1);
      if (end === "abort") abort.abort();
      else if (end === "start-without-shutdown") await h.start(h.context("session-2"), "new");
      else await h.stop(ctx, end);
      // A real replaced ExtensionContext rejects even getters. The resolver
      // must finish using captured plain data, without touching old UI/state.
      for (const key of ["cwd", "ui", "mode", "hasUI", "sessionManager", "signal"]) {
        Object.defineProperty(ctx, key, { get() { assert.fail(`stale context: ${key}`); } });
      }
      const result = await promptly(call);
      assert.equal(result.block, true);
      assert.match(result.reason, /cancelled/);
      assert.deepEqual(h.entries, []);
      if (outcome === "error") pending.reject(new Error("late filesystem failure"));
      else pending.resolve();
      await setImmediate();
      assert.equal(probes, 1);
      assert.deepEqual(h.entries, []);
    });
  }
}

test("pre-aborted and YOLO reads never probe; YOLO enabled during classification is rechecked", async (t) => {
  const h = harness(async () => assert.fail("must not prompt"));
  const ctx = h.context();
  await h.start(ctx);
  const pending = deferred();
  let probes = 0;
  t.mock.method(fsPromises, "access", () => { probes++; return pending.promise; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const abort = new AbortController();
  abort.abort();
  assert.equal((await h.call({ toolName: "read", input: { path: ".env" } }, h.context("session-1", { signal: abort.signal }))).block, true);
  assert.equal(probes, 0);
  const checking = h.call({ toolName: "read", input: { path: ".env" } }, ctx);
  await waitFor(() => probes === 1);
  await h.command("yolo", "", ctx);
  for (const input of [{}, { path: "file://[broken" }, { path: ".env" }]) {
    assert.equal(await h.call({ toolName: "read", input }, ctx), undefined);
  }
  assert.equal(probes, 1);
  pending.resolve();
  assert.equal(await checking, undefined);
});

test("queued asks recheck YOLO rather than reprompting", async () => {
  const ui = dialogs();
  const h = harness(ui.select);
  const ctx = h.context();
  await h.start(ctx);
  const first = h.call(ask, ctx);
  const queued = h.call(otherAsk, ctx);
  await waitFor(() => ui.opened.length === 1);
  await h.command("yolo", "", ctx);
  ui.opened[0].resolve("Deny");
  assert.equal((await first).block, true);
  assert.equal(await queued, undefined);
  assert.equal(ui.opened.length, 1);
});

test("RPC keeps its timeout, no-UI asks fail closed, and denies beat restored hashes", async () => {
  let options;
  const h = harness(async (_title, _choices, opts) => { options = opts; return undefined; });
  const ctx = h.context("session-1", { mode: "rpc" });
  await h.start(ctx);
  assert.equal((await h.call(ask, ctx)).block, true);
  assert.equal(options.timeout, 30_000);
  assert.ok(options.signal instanceof AbortSignal);
  options = undefined;
  assert.equal((await h.call(ask, h.context("session-1", { mode: "print", hasUI: false }))).block, true);
  assert.equal(options, undefined);
  const denied = harness(async () => assert.fail("deny must not prompt"), [{
    type: "custom", customType: "ventris-permissions", data: {
      version: 1, sessionId: "session-1", operation: "grant",
      keys: [createHash("sha256").update("edit\0README.md").digest("hex")],
    },
  }]);
  const deniedCtx = denied.context();
  await denied.start(deniedCtx);
  assert.match((await denied.call({ toolName: "write", input: { path: "README.md" } }, deniedCtx)).reason, /Denied by/);
});

test("malformed file URLs fail closed instead of prompting or allowing", async () => {
  const h = harness(async () => assert.fail("malformed paths must not prompt"));
  const ctx = h.context();
  await h.start(ctx);
  for (const path of ["file:///repo/%ZZ", "file:///repo/a%2Fb", "file://[bad"]) {
    const result = await h.call({ toolName: "read", input: { path } }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /rejected malformed read input/);
  }
});

test("permissions remain disabled in the package and YOLO defaults to false", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.pi.extensions.some((path) => path.includes("permissions") || path === "./extensions"), false);
  assert.equal(harness(async () => "Deny").flags.get("yolo"), false);
});
