import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    cwd: "/repo",
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
