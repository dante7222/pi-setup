import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import promptExtension from "../extensions/herdr-subagents/prompt.ts";

for (const forced of [undefined, "Earlier extension's forced prompt", ""]) {
  test(`worker role composes with ${forced === undefined ? "structured sections" : forced ? "a prior forced prompt" : "an empty forced prompt"} in real Pi`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "herdr-prompt-"));
    const agentDir = join(directory, "agent");
    const cwd = join(directory, "project");
    await mkdir(agentDir);
    await mkdir(cwd);
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Discovered global append instructions");
    await writeFile(join(directory, "system.md"), "Worker role version one");
    const old = { PI_HERDR_WORKER: process.env.PI_HERDR_WORKER, PI_HERDR_JOB_DIR: process.env.PI_HERDR_JOB_DIR };
    Object.assign(process.env, { PI_HERDR_WORKER: "1", PI_HERDR_JOB_DIR: directory });
    let session;
    t.after(async () => {
      session?.dispose();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    });

    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
    await modelRuntime.setRuntimeApiKey("anthropic", "test-only-not-a-real-key");
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Base prompt",
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", (event) => {
            event.systemPromptOptions.sections.earlier = "Earlier section";
            if (forced !== undefined) return { systemPrompt: forced };
          });
        },
        promptExtension,
        (pi) => {
          pi.on("before_agent_start", (event) => {
            event.systemPromptOptions.sections.later = "Later section";
          });
        },
      ],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) }));
    const errors = [];
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
    const requests = [];
    session.agent.streamFunction = (_model, context) => {
      requests.push({
        prompt: getCurrentSystemPrompt(context.messages),
        systemMessages: context.messages.filter((message) => message.role === "system"),
      });
      const message = {
        role: "assistant", content: [{ type: "text", text: "Done" }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    };

    await session.prompt("First request");
    await writeFile(join(directory, "system.md"), "Worker role version two");
    await session.prompt("Second request");
    await session.prompt("Unchanged third request");
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 3);
    for (const [index, role] of ["Worker role version one", "Worker role version two", "Worker role version two"].entries()) {
      const { prompt, systemMessages } = requests[index];
      assert.equal(prompt.split(role).length - 1, 1, "role must appear exactly once");
      if (forced !== undefined) {
        assert.equal(prompt, `${forced}\n\n${role}`);
        assert.equal(systemMessages.length, 1);
        assert.equal(systemMessages[0].content, prompt);
        assert.equal(systemMessages[0].sections, undefined);
      } else {
        assert.equal(systemMessages.length, index === 0 ? 1 : 2);
        assert.equal(systemMessages[0].content, "", "worker must not force an opaque leading prompt");
        assert.equal(systemMessages[0].sections.herdr_subagent, "<herdr_subagent>\nWorker role version one\n</herdr_subagent>");
        if (index > 0) assert.deepEqual(systemMessages.at(-1).sections, { herdr_subagent: `<herdr_subagent>\n${role}\n</herdr_subagent>` });
        for (const text of ["Base prompt", "Discovered global append instructions", "Earlier section", "Later section", `<herdr_subagent>\n${role}\n</herdr_subagent>`]) {
          assert.ok(prompt.includes(text), `Missing prompt contribution: ${text}`);
        }
      }
    }
    assert.ok(!requests[1].prompt.includes("Worker role version one"));
    assert.equal(requests[2].prompt, requests[1].prompt);
    const systemMessages = session.messages.filter((message) => message.role === "system");
    assert.equal(systemMessages.length, 2, "unchanged role must not append another system patch");
    assert.equal(systemMessages[0].sections.herdr_subagent, "<herdr_subagent>\nWorker role version one\n</herdr_subagent>");
    assert.deepEqual(systemMessages.at(-1).sections, { herdr_subagent: "<herdr_subagent>\nWorker role version two\n</herdr_subagent>" });
    assert.equal(getCurrentSystemMessage(session.messages).sections.herdr_subagent, "<herdr_subagent>\nWorker role version two\n</herdr_subagent>");
    assert.ok(session.messages.every((message) => message.role !== "custom"));
  });
}
