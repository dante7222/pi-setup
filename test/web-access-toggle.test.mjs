import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import webAccessToggle, {
  getWebAccessEnabled,
  setWebAccessEnabled,
} from "../extensions/web-access-toggle/index.ts";

const disabledWithEmptyFilters = {
  source: "npm:pi-web-access",
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
};

test("recognizes enabled and disabled pi-web-access package entries", () => {
  assert.equal(getWebAccessEnabled(["npm:pi-web-access"]), true);
  assert.equal(
    getWebAccessEnabled([{ source: "npm:pi-web-access", autoload: false }]),
    false,
  );
  assert.equal(getWebAccessEnabled([disabledWithEmptyFilters]), false);
  assert.equal(
    getWebAccessEnabled([
      {
        source: "npm:pi-web-access",
        autoload: false,
        extensions: ["+index.ts"],
      },
    ]),
    true,
  );
  assert.equal(getWebAccessEnabled(["npm:pi-mcp-adapter"]), undefined);
});

test("changes package loading without removing its registration", () => {
  const packages = ["../../pi-setup", "npm:pi-web-access@0.13.0"];
  assert.deepEqual(setWebAccessEnabled(packages, false), [
    "../../pi-setup",
    { source: "npm:pi-web-access@0.13.0", autoload: false },
  ]);
  assert.deepEqual(
    setWebAccessEnabled(
      ["../../pi-setup", { source: "npm:pi-web-access", autoload: false }],
      true,
    ),
    ["../../pi-setup", "npm:pi-web-access"],
  );
});

test("slash command selects the opposite state and reloads Pi", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-access-toggle-"));
  const agentDirectory = join(directory, "agent");
  const projectDirectory = join(directory, "project");
  const settingsPath = join(agentDirectory, "settings.json");
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;

  try {
    await mkdir(agentDirectory, { recursive: true });
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        packages: ["npm:pi-mcp-adapter", disabledWithEmptyFilters],
      }, null, 2)}\n`,
    );
    process.env.PI_CODING_AGENT_DIR = agentDirectory;

    const commands = new Map();
    webAccessToggle({
      registerCommand(name, definition) {
        commands.set(name, definition);
      },
    });

    const notifications = [];
    const selections = [];
    let reloads = 0;
    const ctx = {
      cwd: projectDirectory,
      hasUI: true,
      isProjectTrusted: () => true,
      reload: async () => {
        reloads++;
      },
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
        select: async (title, choices) => {
          selections.push({ title, choices });
          return choices[0];
        },
      },
    };

    await commands.get("web-access").handler("", ctx);
    let settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(settings.packages, [
      "npm:pi-mcp-adapter",
      "npm:pi-web-access",
    ]);
    assert.equal(reloads, 1);
    assert.match(selections[0].title, /currently off/);
    assert.match(selections[0].choices[0], /^On/);

    await commands.get("web-access").handler("", ctx);
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(settings.packages, [
      "npm:pi-mcp-adapter",
      { source: "npm:pi-web-access", autoload: false },
    ]);
    assert.equal(reloads, 2);
    assert.match(selections[1].title, /currently on/);
    assert.match(selections[1].choices[0], /^Off/);
    assert.equal(
      notifications.some(({ message }) => message.includes("reloading Pi")),
      true,
    );
  } finally {
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
