import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import webAccessToggle from "../extensions/web-access-toggle/index.ts";

const filtered = {
  source: "npm:pi-web-access@0.13.0",
  extensions: ["!**/*"],
  skills: ["!**/*"],
  prompts: [],
  themes: [],
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-filters-"));
  const agentDirectory = join(directory, "agent");
  const cwd = join(directory, "project");
  await mkdir(agentDirectory);
  await mkdir(cwd);
  const oldAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  t.after(async () => {
    if (oldAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  const settingsPath = join(agentDirectory, "settings.json");
  const unrelated = { source: "npm:pi-mcp-adapter", extensions: ["+index.ts"] };
  const settings = { packages: [unrelated, filtered], theme: "tokyo-night" };
  await writeFile(settingsPath, JSON.stringify(settings));
  let command;
  webAccessToggle({ registerCommand: (_name, definition) => { command = definition; } });
  const notifications = [];
  const selections = [];
  const result = {
    settingsPath, settings, notifications, selections, reloads: 0,
    command,
    ctx: {
      cwd, hasUI: true, isProjectTrusted: () => false,
      reload: async () => { result.reloads++; },
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
        select: async (title, choices) => {
          selections.push({ title, choices });
          return choices[0];
        },
      },
    },
  };
  return result;
}

test("filtered status is read-only and explicit on/off normalize exclusion-only filters", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.settingsPath, "utf8");
  await f.command.handler("status", f.ctx);
  assert.match(f.notifications.at(-1).message, /filtered in global settings/);
  assert.equal(await readFile(f.settingsPath, "utf8"), before);
  assert.equal(f.reloads, 0);
  for (const operation of ["on", "off"]) {
    await writeFile(f.settingsPath, before);
    const reloads = f.reloads;
    await f.command.handler(operation, f.ctx);
    const settings = JSON.parse(await readFile(f.settingsPath, "utf8"));
    assert.deepEqual(settings, {
      ...f.settings,
      packages: [f.settings.packages[0], operation === "on"
        ? filtered.source : { source: filtered.source, autoload: false }],
    });
    assert.equal(f.reloads, reloads + 1);
    await f.command.handler(operation, f.ctx);
    assert.equal(f.reloads, reloads + 1, "known matching state needs no reload");
  }
});

test("filtered selector defaults to restoring loading and supports cancellation/no UI", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.settingsPath, "utf8");
  await f.command.handler("", { ...f.ctx, hasUI: false });
  assert.match(f.notifications.at(-1).message, /filtered in global settings/);
  assert.equal(f.selections.length, 0);
  await f.command.handler("", {
    ...f.ctx, ui: { ...f.ctx.ui, select: async () => undefined },
  });
  assert.equal(await readFile(f.settingsPath, "utf8"), before);
  assert.equal(f.reloads, 0);
  await f.command.handler("", f.ctx);
  assert.match(f.selections[0].title, /currently filtered/);
  assert.match(f.selections[0].choices[0], /^On/);
  assert.equal(f.reloads, 1);
  assert.equal(JSON.parse(await readFile(f.settingsPath, "utf8")).packages[1], filtered.source);
});

test("invalid or absent global registration fails without rewriting settings", async (t) => {
  const f = await fixture(t);
  for (const [contents, expected] of [
    ["{invalid", /Could not read global Pi settings/],
    [JSON.stringify({ packages: ["npm:unrelated"] }), /not registered in global/],
  ]) {
    await writeFile(f.settingsPath, contents);
    await f.command.handler("on", f.ctx);
    assert.match(f.notifications.at(-1).message, expected);
    assert.equal(f.notifications.at(-1).type, "error");
    assert.equal(await readFile(f.settingsPath, "utf8"), contents);
  }
  assert.equal(f.reloads, 0);
});
