import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
// Test-only parity oracle; production never imports private Pi modules.
import { resolveReadPathAsync } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import permissions from "../extensions/permissions/index.ts";

function createHarness(entries = [], sessionId = "session-1", flagValues = {}) {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map(Object.entries(flagValues));
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerFlag(name, definition) {
      if (!flags.has(name)) flags.set(name, definition.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
  };
  permissions(pi);
  return { handlers, commands, entries, sessionId };
}

function createContext(harness, options = {}) {
  const notifications = [];
  const statuses = [];
  let selectCount = 0;
  const ctx = {
    cwd: options.cwd ?? "/repo",
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    signal: undefined,
    sessionManager: {
      getSessionId: () => harness.sessionId,
      getEntries: () => harness.entries,
    },
    ui: {
      theme: {
        fg: (color, text) => `<${color}>${text}</${color}>`,
        bold: (text) => `<bold>${text}</bold>`,
      },
      select: async () => {
        selectCount++;
        return options.choice ?? "Deny";
      },
      notify: (message, type) => notifications.push({ message, type }),
      setStatus: (key, value) => statuses.push({ key, value }),
    },
  };
  return {
    ctx,
    notifications,
    statuses,
    getSelectCount: () => selectCount,
  };
}

test("extension asks, remembers hashed session grants, and clears them", async () => {
  const harness = createHarness();
  const first = createContext(harness, { choice: "Allow for this session" });
  await harness.handlers.get("session_start")({}, first.ctx);

  const call = { toolName: "bash", input: { command: "npm test" } };
  assert.equal(await harness.handlers.get("tool_call")(call, first.ctx), undefined);
  assert.equal(first.getSelectCount(), 1);
  assert.equal(harness.entries.length, 1);
  assert.match(harness.entries[0].data.keys[0], /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(harness.entries).includes("npm test"), false);

  assert.equal(await harness.handlers.get("tool_call")(call, first.ctx), undefined);
  assert.equal(first.getSelectCount(), 1);

  const restoredHarness = createHarness(harness.entries);
  const restored = createContext(restoredHarness, { choice: "Deny" });
  await restoredHarness.handlers.get("session_start")({}, restored.ctx);
  assert.equal(
    await restoredHarness.handlers.get("tool_call")(call, restored.ctx),
    undefined,
  );
  assert.equal(restored.getSelectCount(), 0);

  await restoredHarness.commands.get("permissions").handler("clear", restored.ctx);
  const denied = await restoredHarness.handlers.get("tool_call")(call, restored.ctx);
  assert.equal(denied.block, true);
  assert.equal(restored.getSelectCount(), 1);
});

test("yolo bypasses config loading, denies, prompts, and input classification", async () => {
  const previous = process.env.PI_PERMISSION_CONFIG;
  process.env.PI_PERMISSION_CONFIG = join(
    tmpdir(),
    `missing-pi-permissions-${process.pid}-${Date.now()}.json`,
  );

  try {
    const harness = createHarness([], "session-yolo", { yolo: true });
    const ui = createContext(harness, { choice: "Deny" });
    await harness.handlers.get("session_start")({}, ui.ctx);

    assert.equal(
      await harness.handlers.get("tool_call")(
        { toolName: "read", input: {} },
        ui.ctx,
      ),
      undefined,
    );
    assert.equal(
      await harness.handlers.get("tool_call")(
        { toolName: "bash", input: { command: "rm -rf /" } },
        ui.ctx,
      ),
      undefined,
    );
    assert.equal(ui.getSelectCount(), 0);
    assert.equal(
      ui.statuses.some(
        ({ value }) => value === "<bold><error>YOLO mode</error></bold>",
      ),
      true,
    );
    assert.equal(
      ui.notifications.some(({ message, type }) =>
        type === "warning" && message.includes("YOLO mode active")),
      true,
    );

    await harness.commands.get("yolo").handler("", ui.ctx);
    assert.equal(
      ui.notifications.some(({ message }) => message.includes("forced by --yolo")),
      true,
    );
    assert.equal(
      await harness.handlers.get("tool_call")(
        { toolName: "read", input: {} },
        ui.ctx,
      ),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_CONFIG;
    else process.env.PI_PERMISSION_CONFIG = previous;
  }
});

test("slash yolo mode toggles, persists, and reloads policy on disable", async () => {
  const entries = [];
  const harness = createHarness(entries, "session-slash-yolo");
  const ui = createContext(harness, { choice: "Deny" });
  await harness.handlers.get("session_start")({}, ui.ctx);
  assert.equal(ui.statuses.at(-1).value, undefined);

  await harness.commands.get("yolo").handler("", ui.ctx);
  assert.equal(
    await harness.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "npm test" } },
      ui.ctx,
    ),
    undefined,
  );
  assert.equal(ui.getSelectCount(), 0);
  assert.equal(ui.statuses.at(-1).value, "<bold><error>YOLO mode</error></bold>");

  const restoredHarness = createHarness(entries, "session-slash-yolo");
  const restored = createContext(restoredHarness, { choice: "Deny" });
  await restoredHarness.handlers.get("session_start")({}, restored.ctx);
  assert.equal(
    await restoredHarness.handlers.get("tool_call")(
      { toolName: "read", input: {} },
      restored.ctx,
    ),
    undefined,
  );

  await restoredHarness.commands.get("yolo").handler("", restored.ctx);
  const denied = await restoredHarness.handlers.get("tool_call")(
    { toolName: "bash", input: { command: "npm test" } },
    restored.ctx,
  );
  assert.equal(denied.block, true);
  assert.equal(restored.getSelectCount(), 1);
  assert.equal(restored.statuses.at(-1).value, undefined);

  const disabledHarness = createHarness(entries, "session-slash-yolo");
  const disabled = createContext(disabledHarness, { choice: "Deny" });
  await disabledHarness.handlers.get("session_start")({}, disabled.ctx);
  const blocked = await disabledHarness.handlers.get("tool_call")(
    { toolName: "bash", input: { command: "npm test" } },
    disabled.ctx,
  );
  assert.equal(blocked.block, true);
  assert.equal(disabled.getSelectCount(), 1);
});

test("configured deny overrides prompting and session grants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-permissions-"));
  const configPath = join(directory, "deny.json");
  const previous = process.env.PI_PERMISSION_CONFIG;

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        permission: {
          "*": "ask",
          bash: {
            "*": "ask",
            "rm *": "deny",
          },
        },
      }),
    );
    process.env.PI_PERMISSION_CONFIG = configPath;

    const harness = createHarness();
    const ui = createContext(harness, { choice: "Allow for this session" });
    await harness.handlers.get("session_start")({}, ui.ctx);
    const result = await harness.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm file" } },
      ui.ctx,
    );

    assert.equal(result.block, true);
    assert.match(result.reason, /Denied by/);
    assert.equal(ui.getSelectCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_CONFIG;
    else process.env.PI_PERMISSION_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured native read target denies block fallback aliases without UI or input mutation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-read-"));
  const previous = process.env.PI_PERMISSION_CONFIG;
  const configPath = join(cwd, "policy.json");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_PERMISSION_CONFIG;
    else process.env.PI_PERMISSION_CONFIG = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  process.env.PI_PERMISSION_CONFIG = configPath;
  const native = createReadToolDefinition("/unused-cwd");
  for (const [alias, filename] of [
    ["secret AM.txt", "secret\u202fAM.txt"],
    ["secret\u202fAM.txt", "secret\u202fAM.txt"],
    ["secret PM.txt", "secret\u202fPM.txt"],
    ["quote's.txt", "quote’s.txt"],
    ["café.txt", "cafe\u0301.txt"],
    ["café's.txt", "cafe\u0301’s.txt"],
  ]) {
    await writeFile(join(cwd, filename), `contents of ${filename}`);
    for (const path of [alias, pathToFileURL(join(cwd, alias)).href, pathToFileURL(join(cwd, filename)).href]) {
      // On normalization-insensitive filesystems native read can select NFC
      // for an NFD filename. Classify precisely the spelling native selected.
      const selected = await resolveReadPathAsync(path, cwd);
      const resource = relative(cwd, selected).replaceAll("\\", "/");
      await writeFile(configPath, JSON.stringify({ permission: {
        "*": "allow", read: { "*": "allow", [resource]: "deny" },
      } }));
      const input = Object.freeze({ path });
      const result = await native.execute("native-read", input, undefined, undefined, { cwd });
      assert.equal(result.content[0].text, `contents of ${filename}`);
      for (const mode of ["tui", "rpc", "print", "json"]) {
        const h = createHarness();
        const ui = createContext(h, { cwd, mode, hasUI: mode === "tui" || mode === "rpc", choice: "Allow once" });
        await h.handlers.get("session_start")({}, ui.ctx);
        const denied = await h.handlers.get("tool_call")({ toolName: "read", input }, ui.ctx);
        assert.equal(denied.block, true, path);
        assert.match(denied.reason, /Denied by/);
        assert.equal(ui.getSelectCount(), 0);
        assert.deepEqual(h.entries, []);
        assert.equal(input.path, path);
      }
    }
  }
});

test("read asks and session hashes refer to the selected target, not its lexical alias", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-read-ask-"));
  const configPath = join(cwd, "policy.json");
  const previous = process.env.PI_PERMISSION_CONFIG;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_PERMISSION_CONFIG;
    else process.env.PI_PERMISSION_CONFIG = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, "secret\u202fAM.txt"), "secret");
  await writeFile(configPath, JSON.stringify({ permission: { "*": "allow", read: "ask" } }));
  process.env.PI_PERMISSION_CONFIG = configPath;
  const hash = (resource) => createHash("sha256").update(`read\0${resource}`).digest("hex");
  const h = createHarness([{ type: "custom", customType: "ventris-permissions", data: {
    version: 1, sessionId: "session-1", operation: "grant", keys: [hash("secret AM.txt")],
  } }]);
  const headless = createContext(h, { cwd, mode: "print", hasUI: false });
  await h.handlers.get("session_start")({}, headless.ctx);
  const call = { toolName: "read", input: { path: "secret\u202fAM.txt" } };
  assert.match((await h.handlers.get("tool_call")(call, headless.ctx)).reason, /has no permission UI/);
  assert.equal(headless.getSelectCount(), 0);
  const once = createContext(h, { cwd, choice: "Allow once" });
  assert.equal(await h.handlers.get("tool_call")(call, once.ctx), undefined);
  assert.equal(h.entries.length, 1);
  const ui = createContext(h, { cwd, choice: "Allow for this session" });
  assert.equal(await h.handlers.get("tool_call")(call, ui.ctx), undefined);
  assert.equal(ui.getSelectCount(), 1);
  assert.deepEqual(h.entries.at(-1).data.keys, [hash("secret\u202fAM.txt")]);
  assert.equal(await h.handlers.get("tool_call")({ toolName: "read", input: {
    path: pathToFileURL(join(cwd, "secret\u202fAM.txt")).href,
  } }, headless.ctx), undefined);
});

test("read checks the exact winner and still requires external-directory permission", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-read-exact-"));
  const configPath = join(cwd, "policy.json");
  const previous = process.env.PI_PERMISSION_CONFIG;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_PERMISSION_CONFIG;
    else process.env.PI_PERMISSION_CONFIG = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  await writeFile(join(cwd, "secret AM.txt"), "public exact target");
  await writeFile(join(cwd, "secret\u202fAM.txt"), "secret fallback target");
  await writeFile(configPath, JSON.stringify({ permission: {
    "*": "allow", read: { "*": "allow", "secret\u202fAM.txt": "deny" }, external_directory: "deny",
  } }));
  process.env.PI_PERMISSION_CONFIG = configPath;
  const h = createHarness();
  const ui = createContext(h, { cwd, mode: "print", hasUI: false });
  await h.handlers.get("session_start")({}, ui.ctx);
  const call = { toolName: "read", input: { path: "secret\u202fAM.txt" } };
  assert.equal(await h.handlers.get("tool_call")(call, ui.ctx), undefined);
  const result = await createReadToolDefinition(cwd).execute("native-exact", call.input);
  assert.equal(result.content[0].text, "public exact target");
  assert.match((await h.handlers.get("tool_call")({ toolName: "read", input: {
    path: pathToFileURL(join(cwd, "secret\u202fAM.txt")).href,
  } }, ui.ctx)).reason, /Denied by/);
  const outside = createContext(h, { cwd: join(cwd, "nested"), mode: "print", hasUI: false });
  assert.match((await h.handlers.get("tool_call")({ toolName: "read", input: {
    path: pathToFileURL(join(cwd, "secret\u202fAM.txt")).href,
  } }, outside.ctx)).reason, /external_directory/);
  assert.equal(ui.getSelectCount(), 0);
});

test("invalid config and noninteractive asks fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-permissions-"));
  const configPath = join(directory, "invalid.json");
  const previous = process.env.PI_PERMISSION_CONFIG;

  try {
    await writeFile(configPath, "{not json");
    process.env.PI_PERMISSION_CONFIG = configPath;

    const invalidHarness = createHarness();
    const invalid = createContext(invalidHarness);
    await invalidHarness.handlers.get("session_start")({}, invalid.ctx);
    const blocked = await invalidHarness.handlers.get("tool_call")(
      { toolName: "read", input: { path: "README.md" } },
      invalid.ctx,
    );
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /Permissions unavailable/);

    delete process.env.PI_PERMISSION_CONFIG;
    const headlessHarness = createHarness();
    const headless = createContext(headlessHarness, { hasUI: false, mode: "print" });
    await headlessHarness.handlers.get("session_start")({}, headless.ctx);
    const asked = await headlessHarness.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "pwd" } },
      headless.ctx,
    );
    assert.equal(asked.block, true);
    assert.match(asked.reason, /has no permission UI/);
  } finally {
    if (previous === undefined) delete process.env.PI_PERMISSION_CONFIG;
    else process.env.PI_PERMISSION_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
