import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import visualExplainerToggle, {
  getVisualExplainerState,
  setVisualExplainerEnabled,
} from "../extensions/visual-explainer-toggle/index.ts";

const source = "git:github.com/nicobailon/visual-explainer";
const pinned = `${source}@release/2026-10`;
const unrelated = { source: "npm:pi-mcp-adapter", extensions: ["+index.ts"] };
const filtered = { source: pinned, extensions: ["!**/*"], skills: [], prompts: [], themes: [] };
const emptyFilters = { source, extensions: [], skills: [], prompts: [], themes: [] };

function commandOnly() {
  const commands = new Map();
  visualExplainerToggle(new Proxy({}, {
    get(_target, property) {
      assert.equal(property, "registerCommand", "controller must access no other Pi API");
      return (name, definition) => {
        assert.equal(commands.has(name), false);
        commands.set(name, definition);
      };
    },
  }));
  assert.deepEqual([...commands.keys()], ["visual-explainer"]);
  const command = commands.get("visual-explainer");
  assert.deepEqual(Object.keys(command).sort(), ["description", "getArgumentCompletions", "handler"]);
  return command;
}

async function fixture(t, packages = [unrelated, filtered]) {
  const directory = await mkdtemp(join(tmpdir(), "pi-visual-explainer-toggle-"));
  const agentDirectory = join(directory, "agent");
  const cwd = join(directory, "project");
  await mkdir(agentDirectory);
  await mkdir(cwd);
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  t.after(async () => {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  const settingsPath = join(agentDirectory, "settings.json");
  const settings = {
    packages,
    theme: "tokyo-night",
    extensions: ["./other-extension.ts"],
    skills: ["./other-skills"],
    prompts: ["./other-prompts"],
    themes: ["./other-themes"],
    customSetting: { keep: true },
  };
  await writeFile(settingsPath, JSON.stringify(settings));
  const notifications = [];
  const selections = [];
  const result = {
    settings, settingsPath, notifications, selections,
    command: commandOnly(), reloads: 0,
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

test("controller registers only the slash command, with argument completions", async () => {
  const command = commandOnly();
  for (const [prefix, values] of [
    ["", ["on", "off", "status"]], ["o", ["on", "off"]],
    ["on", ["on"]], ["of", ["off"]], ["s", ["status"]],
  ]) {
    assert.deepEqual(await command.getArgumentCompletions(prefix), values.map((value) => ({ value, label: value })));
  }
  assert.equal(await command.getArgumentCompletions("unknown"), null);
  assert.equal(await command.getArgumentCompletions("on off"), null);
});

test("state is on/off/filtered without resolving package resources", () => {
  for (const entry of [source, { source }, { source, autoload: true }]) {
    assert.equal(getVisualExplainerState([entry]), "on");
  }
  for (const entry of [
    { source, autoload: false }, emptyFilters,
    { source, autoload: false, extensions: ["!**/*", "-index.ts"] },
  ]) {
    assert.equal(getVisualExplainerState([entry]), "off");
  }
  for (const filters of [
    { autoload: false, extensions: ["+index.ts"] },
    { autoload: false, skills: ["skills/special"] },
    { extensions: ["!**/*"], skills: [], prompts: [], themes: [] },
    { extensions: ["!**/*", "+index.ts"] },
    { extensions: ["missing/**/*.ts"] }, { extensions: [] },
  ]) {
    assert.equal(getVisualExplainerState([{ source, ...filters }]), "filtered");
  }
  for (const resource of ["extensions", "skills", "prompts", "themes"]) {
    assert.equal(getVisualExplainerState([{ source, autoload: false, [resource]: ["+resource"] }]), "filtered");
  }
  assert.equal(getVisualExplainerState([source, { source, autoload: false }]), "filtered");
  assert.equal(getVisualExplainerState([source, pinned]), "on");
  assert.equal(getVisualExplainerState([]), undefined);
});

test("matches exact canonical/HTTPS git repositories, preserving every source and pin", () => {
  for (const spelling of [source, `${source}.git`,
    "https://github.com/nicobailon/visual-explainer",
    "git:https://github.com/nicobailon/visual-explainer.git",
  ]) {
    for (const ref of ["", "@v1.2.3", "@deadbeef123", "@feature/diagrams", "@release@candidate"]) {
      const registered = spelling + ref;
      assert.equal(getVisualExplainerState([registered]), "on");
      const off = setVisualExplainerEnabled([registered], false);
      assert.deepEqual(off, [{ source: registered, autoload: false }]);
      assert.deepEqual(setVisualExplainerEnabled(off, true), [registered]);
    }
  }
  for (const other of [
    `${source}-other`, `${source}-other@v1`, `${source}/child`, `${source}.git-other`,
    `${source}@`, `npm:visual-explainer`, "./visual-explainer",
    "git:github.com/someone/visual-explainer", "git:github.com/nicobailon/visual-explainer-other",
    "https://github.com.evil/nicobailon/visual-explainer", `${source} @v1`,
  ]) {
    assert.equal(getVisualExplainerState([other]), undefined, other);
    assert.equal(setVisualExplainerEnabled([other], false), undefined, other);
  }
});

test("updates all matching entries without mutating input or unrelated registrations", () => {
  const sibling = { source: `${source}-other@v2`, skills: ["+special"] };
  const packages = ["../../pi-setup", unrelated, source, filtered, sibling];
  const before = structuredClone(packages);
  const off = setVisualExplainerEnabled(packages, false);
  assert.deepEqual(off, [packages[0], unrelated, { source, autoload: false }, { source: pinned, autoload: false }, sibling]);
  assert.strictEqual(off[1], unrelated);
  assert.strictEqual(off[4], sibling);
  assert.deepEqual(packages, before);
  assert.deepEqual(setVisualExplainerEnabled(packages, true), [packages[0], unrelated, source, pinned, sibling]);
  assert.deepEqual(packages, before);
});

test("filtered status is read-only; explicit on/off normalize whole-package loading", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.settingsPath, "utf8");
  await f.command.handler("status", f.ctx);
  assert.match(f.notifications.at(-1).message, /filtered in global settings/);
  assert.match(f.notifications.at(-1).message, /depends on resource matches/);
  assert.equal(await readFile(f.settingsPath, "utf8"), before);
  assert.equal(f.reloads, 0);
  for (const operation of ["on", "off"]) {
    await writeFile(f.settingsPath, before);
    const reloads = f.reloads;
    await f.command.handler(`  ${operation.toUpperCase()}  `, f.ctx);
    assert.deepEqual(JSON.parse(await readFile(f.settingsPath, "utf8")), {
      ...f.settings,
      packages: [unrelated, operation === "on" ? pinned : { source: pinned, autoload: false }],
    });
    assert.equal(f.reloads, reloads + 1);
    assert.match(f.notifications.at(-1).message, /in global settings; reloading Pi/);
    if (operation === "off") {
      assert.match(f.notifications.at(-1).message, /remains installed/);
      assert.match(f.notifications.at(-1).message, /Prior session history is unchanged; use \/new/);
    }
    const normalized = await readFile(f.settingsPath, "utf8");
    await f.command.handler(operation, f.ctx);
    assert.match(f.notifications.at(-1).message, /already/);
    assert.equal(f.reloads, reloads + 1, "already in the requested state needs no reload");
    assert.equal(await readFile(f.settingsPath, "utf8"), normalized);
    await f.command.handler("status", f.ctx);
    assert.match(f.notifications.at(-1).message, new RegExp(`is ${operation} in global settings`));
    assert.equal(await readFile(f.settingsPath, "utf8"), normalized);
  }
});

test("selector offers opposite state first and retains the pinned install", async (t) => {
  const f = await fixture(t, [unrelated, { source: pinned, autoload: false }]);
  for (const [state, choice, expected] of [
    ["off", "On", pinned], ["on", "Off", { source: pinned, autoload: false }],
  ]) {
    await f.command.handler("", f.ctx);
    assert.match(f.selections.at(-1).title, new RegExp(`currently ${state} in global settings`));
    assert.match(f.selections.at(-1).choices[0], new RegExp(`^${choice}`));
    assert.equal(f.selections.at(-1).choices.length, 2);
    assert.deepEqual(JSON.parse(await readFile(f.settingsPath, "utf8")).packages, [unrelated, expected]);
  }
  assert.equal(f.reloads, 2);
});

test("filtered selector defaults on; cancellation and no-UI invocation never write", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.settingsPath, "utf8");
  await f.command.handler("", { ...f.ctx, hasUI: false });
  assert.match(f.notifications.at(-1).message, /filtered in global settings.*Usage:/);
  assert.equal(f.selections.length, 0);
  await f.command.handler("", { ...f.ctx, ui: { ...f.ctx.ui, select: async () => undefined } });
  assert.equal(await readFile(f.settingsPath, "utf8"), before);
  assert.equal(f.reloads, 0);
  await f.command.handler("", f.ctx);
  assert.match(f.selections[0].title, /currently filtered/);
  assert.match(f.selections[0].choices[0], /^On/);
  assert.equal(f.reloads, 1);
  assert.equal(JSON.parse(await readFile(f.settingsPath, "utf8")).packages[1], pinned);
  await f.command.handler("off", { ...f.ctx, hasUI: false });
  assert.equal(f.reloads, 2, "explicit operations do not require a selector/UI");
});

test("selector respects explicit second choice instead of treating selection as inversion", async (t) => {
  const f = await fixture(t);
  await f.command.handler("", {
    ...f.ctx, ui: { ...f.ctx.ui, select: async (_title, choices) => choices[1] },
  });
  assert.deepEqual(JSON.parse(await readFile(f.settingsPath, "utf8")).packages[1], { source: pinned, autoload: false });
  assert.equal(f.reloads, 1);
});

test("invalid arguments, missing registration and missing settings never rewrite", async (t) => {
  const f = await fixture(t, [unrelated, `${source}-other`]);
  const before = await readFile(f.settingsPath, "utf8");
  await f.command.handler("on off", f.ctx);
  assert.match(f.notifications.at(-1).message, /Usage: \/visual-explainer \[on\|off\|status\]/);
  assert.equal(f.notifications.at(-1).type, "warning");
  await f.command.handler("on", f.ctx);
  assert.match(f.notifications.at(-1).message, /not registered in global/);
  assert.equal(f.notifications.at(-1).type, "error");
  assert.equal(await readFile(f.settingsPath, "utf8"), before);
  await rm(f.settingsPath);
  await f.command.handler("on", f.ctx);
  assert.match(f.notifications.at(-1).message, /not registered in global/);
  await assert.rejects(readFile(f.settingsPath), { code: "ENOENT" });
  assert.equal(f.reloads, 0);
  assert.equal(f.selections.length, 0);
});

test("malformed JSON and package shapes fail closed without rewriting", async (t) => {
  const f = await fixture(t);
  for (const contents of [
    "{invalid", "null", "42",
    ...[null, "wrong", {}, [null], [3], [[]], [{}], [{ source: 3 }],
      [{ source, autoload: "false" }], [{ source, skills: null }],
      [{ source, extensions: "index.ts" }], [{ source, prompts: [1] }],
      [source, { source: "npm:unrelated", themes: [false] }],
    ].map((packages) => JSON.stringify({ packages })),
  ]) {
    await writeFile(f.settingsPath, contents);
    await f.command.handler("off", f.ctx);
    assert.match(f.notifications.at(-1).message, /Could not read global Pi settings/, contents);
    assert.equal(f.notifications.at(-1).type, "error");
    assert.equal(await readFile(f.settingsPath, "utf8"), contents);
  }
  assert.equal(f.reloads, 0);
});

test("global status and updates preserve trusted project overrides verbatim", async (t) => {
  const f = await fixture(t, [unrelated, source]);
  await mkdir(join(f.ctx.cwd, ".pi"));
  const projectPath = join(f.ctx.cwd, ".pi", "settings.json");
  const project = JSON.stringify({ packages: [{ source, autoload: false }], theme: "project-theme" });
  await writeFile(projectPath, project);
  const ctx = { ...f.ctx, isProjectTrusted: () => true };
  await f.command.handler("status", ctx);
  assert.match(f.notifications.at(-1).message, /is on in global settings/);
  await f.command.handler("off", ctx);
  assert.equal(await readFile(projectPath, "utf8"), project);
  assert.deepEqual(JSON.parse(await readFile(f.settingsPath, "utf8")), {
    ...f.settings, packages: [unrelated, { source, autoload: false }],
  });
  await writeFile(projectPath, "{malformed-project");
  await f.command.handler("on", ctx);
  assert.equal(f.reloads, 2, "project errors do not block global-only changes");
  assert.equal(await readFile(projectPath, "utf8"), "{malformed-project");
});

test("failed persistence reports an error and never reloads or claims success", async (t) => {
  const f = await fixture(t);
  await f.command.handler("", {
    ...f.ctx,
    ui: { ...f.ctx.ui, select: async (_title, choices) => {
      await writeFile(f.settingsPath, "{changed-while-selecting");
      return choices[0];
    } },
  });
  assert.match(f.notifications.at(-1).message, /Could not update global Pi settings/);
  assert.equal(f.notifications.at(-1).type, "error");
  assert.equal(f.notifications.some(({ message }) => message.includes("reloading Pi")), false);
  assert.equal(f.reloads, 0);
  assert.equal(await readFile(f.settingsPath, "utf8"), "{changed-while-selecting");
});
