import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import visualExplainerToggle from "../extensions/visual-explainer-toggle/index.ts";

// Use a local native-package fixture so this regression needs no installation,
// network, credentials, or model call. The actual git install is smoke-tested
// separately; package resource filtering is the same for both source kinds.
test("off loads no upstream resources and adds exactly zero prompt/tool context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-visual-loading-"));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  const packageDir = join(directory, "visual-explainer");
  const skillDir = join(packageDir, "plugins", "visual-explainer");
  const sessions = [];
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(skillDir, "commands"), { recursive: true });
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "visual-explainer",
      pi: {
        extensions: ["./plugins/visual-explainer/extension.mjs"],
        skills: ["./plugins/visual-explainer"],
        prompts: ["./plugins/visual-explainer/commands"],
      },
    }));
    await writeFile(join(skillDir, "extension.mjs"), `
export default function (pi) {
  pi.registerTool({
    name: "visual_explainer",
    label: "Visual Explainer",
    description: "UPSTREAM_DESCRIPTION_SENTINEL",
    promptSnippet: "UPSTREAM_SNIPPET_SENTINEL",
    promptGuidelines: ["UPSTREAM_GUIDELINE_SENTINEL"],
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  });
}
`);
    await writeFile(join(skillDir, "SKILL.md"), [
      "---", "name: visual-explainer", "description: UPSTREAM_SKILL_SENTINEL", "---",
      "UPSTREAM_INSTRUCTIONS_SENTINEL", "",
    ].join("\n"));
    await writeFile(join(skillDir, "commands", "generate-web-diagram.md"),
      "---\ndescription: UPSTREAM_PROMPT_SENTINEL\n---\nUPSTREAM_TEMPLATE_SENTINEL\n");

    async function load(packages, controller) {
      const settingsManager = SettingsManager.inMemory({ packages });
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noContextFiles: true,
        extensionFactories: controller ? [visualExplainerToggle] : [],
      });
      await resourceLoader.reload();
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const { session } = await createAgentSession({
        cwd, agentDir, settingsManager, resourceLoader,
        model: getModel("anthropic", "claude-sonnet-4-5"),
        sessionManager: SessionManager.inMemory(cwd),
      });
      sessions.push(session);
      return { session, resourceLoader, settingsManager };
    }

    const baseline = await load([], false);
    const disabled = [{ source: packageDir, autoload: false }];
    const off = await load(disabled, true);
    const assertOff = () => {
      assert.equal(off.session.systemPrompt, baseline.session.systemPrompt);
      assert.deepEqual(off.session.getAllTools(), baseline.session.getAllTools());
      assert.deepEqual(off.session.getActiveToolNames(), baseline.session.getActiveToolNames());
      assert.deepEqual(off.resourceLoader.getSkills(), baseline.resourceLoader.getSkills());
      assert.deepEqual(off.resourceLoader.getPrompts(), baseline.resourceLoader.getPrompts());
      assert.deepEqual(off.resourceLoader.getThemes(), baseline.resourceLoader.getThemes());
      const extensions = off.resourceLoader.getExtensions().extensions;
      assert.equal(extensions.length, 1, "only the UI controller loads");
      assert.equal(extensions[0].tools.size, 0);
      assert.equal(extensions[0].handlers.size, 0);
      assert.deepEqual([...extensions[0].commands.keys()], ["visual-explainer"]);
      assert.doesNotMatch(off.session.systemPrompt, /visual[-_]explainer|UPSTREAM_/i);
    };
    assertOff();

    // Positive control: the same package must actually load when enabled.
    off.settingsManager.setPackages([packageDir]);
    await off.session.reload();
    assert.deepEqual(off.resourceLoader.getExtensions().errors, []);
    assert.ok(off.session.getActiveToolNames().includes("visual_explainer"));
    assert.match(off.session.systemPrompt, /UPSTREAM_SNIPPET_SENTINEL/);
    assert.match(off.session.systemPrompt, /UPSTREAM_GUIDELINE_SENTINEL/);
    assert.match(off.session.systemPrompt, /UPSTREAM_SKILL_SENTINEL/);
    assert.ok(off.resourceLoader.getSkills().skills.some((skill) => skill.name === "visual-explainer"));
    assert.ok(off.resourceLoader.getPrompts().prompts.some((prompt) => prompt.name === "generate-web-diagram"));

    off.settingsManager.setPackages(disabled);
    await off.session.reload();
    assert.deepEqual(off.resourceLoader.getExtensions().errors, []);
    assertOff();
  } finally {
    for (const session of sessions) session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
