import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import rexTerminalTitle from "../extensions/rex-terminal-title/index.ts";

function fixture({ termProgram = "rex", mode = "tui", name = "Test session" } = {}) {
  const handlers = new Map();
  const titles = [];
  const widgets = [];
  let widget;
  const terminal = { setTitle(title) { assert.equal(this, terminal); titles.push(title); } };
  const originalSetTitle = terminal.setTitle;
  const ctx = {
    mode, cwd: "/work/pi-setup",
    ui: {
      setTitle: (title) => terminal.setTitle(title),
      setWidget(key, factory, options) {
        widgets.push({ key, options });
        widget?.dispose();
        widget = factory?.({ terminal });
      },
    },
  };
  const pi = { on: (event, handler) => handlers.set(event, handler), getSessionName: () => name };
  const previous = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = termProgram;
  try {
    rexTerminalTitle(pi);
  } finally {
    if (previous === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = previous;
  }
  return {
    titles, widgets, terminal, originalSetTitle,
    emit: (type) => handlers.get(type)?.({ type }, ctx),
    setName(value) { name = value; },
    get name() { return name; },
    get widget() { return widget; },
  };
}

test("shows only the session name without changing names or adding visible content", () => {
  const f = fixture();
  f.emit("session_start");
  assert.deepEqual(f.titles, ["Test session"]);
  assert.equal(f.name, "Test session");
  assert.deepEqual(f.widget.render(80), []);
  assert.equal(f.widgets[0].options.placement, "belowEditor");
  f.emit("session_shutdown");
});

test("filters later core writes, including generated names, but preserves other title text", () => {
  const f = fixture({ name: "" });
  f.emit("session_start");
  f.setName("Generated session name");
  f.terminal.setTitle(`π - ${f.name} - pi-setup`);
  assert.equal(f.titles.at(-1), "Generated session name");
  assert.equal(f.name, "Generated session name");
  for (const title of ["Custom title", "Custom title - pi-setup", "A π - calculation", "⠋ π - custom spinner"]) {
    f.terminal.setTitle(title);
    assert.equal(f.titles.at(-1), title);
  }
  f.emit("session_shutdown");
});

test("unnamed sessions keep the folder until a name is generated", () => {
  const f = fixture({ name: "" });
  f.emit("session_start");
  assert.equal(f.titles.at(-1), "pi-setup");
  f.setName("Generated session name");
  f.terminal.setTitle(`π - ${f.name} - pi-setup`);
  assert.equal(f.titles.at(-1), "Generated session name");
  f.emit("session_shutdown");
  f.setName("π - calculations");
  f.emit("session_start");
  assert.equal(f.titles.at(-1), "π - calculations");
  f.emit("session_shutdown");
});

test("preserves separators and folder text that are part of the session name", () => {
  const f = fixture({ name: "Debug - pi-setup" });
  f.emit("session_start");
  assert.equal(f.titles.at(-1), "Debug - pi-setup");
  f.terminal.setTitle("π - pi-setup - pi-setup");
  assert.equal(f.titles.at(-1), "pi-setup");
  f.terminal.setTitle("π - Debug - other-folder");
  assert.equal(f.titles.at(-1), "Debug - other-folder");
  f.emit("session_shutdown");
});

test("shutdown restores the original method and reload/session replacement can install afresh", () => {
  const f = fixture();
  for (const name of ["First session", "Reloaded session", "Resumed session"]) {
    f.setName(name);
    f.emit("session_start");
    assert.notEqual(f.terminal.setTitle, f.originalSetTitle);
    assert.equal(f.titles.at(-1), name);
    f.emit("session_shutdown");
    assert.equal(f.terminal.setTitle, f.originalSetTitle);
  }
  f.terminal.setTitle("π - default title");
  assert.equal(f.titles.at(-1), "π - default title");
});

test("disposal does not overwrite a later wrapper or leave filtering active inside it", () => {
  const f = fixture();
  f.emit("session_start");
  const filtered = f.terminal.setTitle;
  const otherWrapper = (title) => filtered(`${title} [other]`);
  f.terminal.setTitle = otherWrapper;
  f.emit("session_shutdown");
  assert.equal(f.terminal.setTitle, otherWrapper);
  f.terminal.setTitle("π - restored title");
  assert.equal(f.titles.at(-1), "π - restored title [other]");
});

test("does not touch other terminals or non-TUI transports", () => {
  for (const options of [{ termProgram: "ghostty" }, { mode: "rpc" }, { mode: "json" }, { mode: "print" }]) {
    const f = fixture(options);
    f.emit("session_start");
    f.emit("session_shutdown");
    assert.equal(f.terminal.setTitle, f.originalSetTitle);
    assert.deepEqual(f.titles, []);
    assert.deepEqual(f.widgets, []);
  }
});

test("is included in the package manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/rex-terminal-title/index.ts"));
});
