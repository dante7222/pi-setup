import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { isolateHerdrEnvironment } from "./helpers/herdr-test-environment.mjs";
import {
  createAgentSession,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import sessionGroups from "../extensions/session-groups/index.ts";
import { readSessionGroupMembership } from "../extensions/session-groups/membership.ts";
import { SessionGroupStore } from "../extensions/session-groups/store.ts";

// These are parent-runtime fixtures. Worker inheritance has its own tests;
// ambient subagent policy must not change the parent lifecycle under test.
beforeEach((t) => {
  isolateHerdrEnvironment(t, { PI_HERDR_WORKER: "0", PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? "" });
});

const request = "Add the approved decision to shared group context.";
const editArgs = {
  userRequestQuote: "Add the approved decision",
  edits: [{ oldText: "# lifecycle\n", newText: "# lifecycle\n\nApproved decision.\n" }],
};
const membership = (manager) => readSessionGroupMembership(manager.getEntries())?.groupId;
const setMembership = (manager, groupId) => manager.appendCustomEntry("ventris-session-group-membership", { version: 1, groupId });

async function withRuntime(run, { precedingInput, followingInput } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-groups-runtime-"));
  const agentDir = join(directory, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const runtimes = [];
  const notifications = [];
  const confirmations = [];
  const errors = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, "models-store.json"),
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only-not-a-real-key");
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const store = new SessionGroupStore();
  let instanceCount = 0;
  const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "Test system prompt",
      extensionFactories: [
        (pi) => {
          if (precedingInput) pi.on("input", precedingInput);
          // Exercise awaits on both sides of the Session Groups shutdown hook.
          pi.on("session_shutdown", async () => { await Promise.resolve(); });
        },
        (pi) => { instanceCount++; sessionGroups(pi); },
        (pi) => {
          if (followingInput) pi.on("input", followingInput);
          pi.on("session_shutdown", async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
        },
      ],
    });
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader,
      settingsManager,
      modelRuntime,
      model,
      thinkingLevel: "off",
      sessionManager,
      sessionStartEvent,
    });
    // No test may reach a provider, even if it forgets to install mockResponses.
    result.session.agent.streamFunction = () => { throw new Error("Unexpected provider request in lifecycle test"); };
    await result.session.bindExtensions({
      mode: "tui",
      uiContext: {
        notify: (message, type) => notifications.push({ message, type }),
        confirm: async (title, message) => { confirmations.push({ title, message }); return true; },
      },
      onError: (error) => errors.push(error),
    });
    return { ...result, services: { cwd: directory, agentDir }, diagnostics: [] };
  };
  const create = async (manager) => {
    const runtime = await createAgentSessionRuntime(createRuntime, { cwd: directory, agentDir, sessionManager: manager });
    runtimes.push(runtime);
    return runtime;
  };
  const reply = (tool = false) => ({
    role: "assistant",
    content: tool ? [{ type: "toolCall", id: `edit-${Date.now()}`, name: "edit_group_context", arguments: editArgs }] : [{ type: "text", text: "Done." }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: tool ? "toolUse" : "stop",
    timestamp: Date.now(),
  });
  const mockResponses = (session, getReply) => {
    let count = 0;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      Promise.resolve().then(() => getReply(count++)).then((message) => {
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    };
  };
  try {
    await run({ directory, store, create, reply, mockResponses, notifications, confirmations, instances: () => instanceCount });
    assert.deepEqual(errors, []);
  } finally {
    for (const runtime of runtimes) await runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
}

for (const asynchronous of [false, true]) {
  test(`actual ExtensionRunner authorizes delivered input after a preceding ${asynchronous ? "async" : "sync"} handler`, async () => {
    await withRuntime(async ({ directory, store, create, reply, mockResponses, confirmations }) => {
      const group = await store.createGroup("lifecycle");
      const manager = SessionManager.inMemory(directory);
      setMembership(manager, group.id);
      const runtime = await create(manager);
      mockResponses(runtime.session, (count) => reply(count === 0));
      await runtime.session.prompt(request);
      assert.equal(confirmations.length, 1);
      assert.match((await store.readContext(group.id)).content, /Approved decision/);
    }, { precedingInput: asynchronous ? async () => { await Promise.resolve(); return { action: "continue" }; } : () => ({ action: "continue" }) });
  });
}

for (const scenario of ["handled", "transformed", "image-transformed", "extension", "ambiguous", "stale-reproduction"]) {
  test(`actual runner rejects ${scenario} input authorization`, async () => {
    await withRuntime(async ({ directory, store, create, reply, mockResponses, confirmations }) => {
      const group = await store.createGroup("lifecycle");
      const manager = SessionManager.inMemory(directory);
      setMembership(manager, group.id);
      const runtime = await create(manager);
      mockResponses(runtime.session, (count) => reply(count === 0));
      if (["handled", "ambiguous", "stale-reproduction"].includes(scenario)) await runtime.session.prompt(request);
      await runtime.session.prompt(["handled", "stale-reproduction"].includes(scenario) ? "Continue normally." : request, scenario === "extension" ? { source: "extension" } : undefined);
      assert.equal(confirmations.length, 0);
      assert.doesNotMatch((await store.readContext(group.id)).content, /Approved decision/);
    }, {
      precedingInput: async () => ({ action: "continue" }),
      followingInput: (() => {
        let inputs = 0;
        return async () => {
          inputs++;
          if (["handled", "ambiguous", "stale-reproduction"].includes(scenario) && inputs === 1) return { action: "handled" };
          if (scenario === "transformed") return { action: "transform", text: "Continue normally." };
          if (scenario === "stale-reproduction") return { action: "transform", text: request };
          if (scenario === "image-transformed") return { action: "transform", text: request, images: [{ type: "image", data: "AA==", mimeType: "image/png" }] };
          return { action: "continue" };
        };
      })(),
    });
  });
}

for (const streamingBehavior of ["steer", "followUp"]) {
  test(`actual agent streaming ${streamingBehavior} authorizes only its delivered message`, async () => {
    await withRuntime(async ({ directory, store, create, reply, mockResponses, confirmations }) => {
      const group = await store.createGroup("lifecycle");
      const manager = SessionManager.inMemory(directory);
      setMembership(manager, group.id);
      const runtime = await create(manager);
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      mockResponses(runtime.session, async (count) => {
        if (count === 0) { entered.resolve(); await release.promise; return reply(true); }
        // Follow-ups wait for a no-tool response; steering arrives immediately
        // after the first (rejected) tool batch.
        return reply(count === (streamingBehavior === "steer" ? 1 : 2));
      });
      const running = runtime.session.prompt("Continue normally.");
      await entered.promise;
      await runtime.session.prompt(request, { streamingBehavior });
      assert.equal(confirmations.length, 0);
      release.resolve();
      await running;
      assert.equal(confirmations.length, 1);
      const toolResults = runtime.session.messages.filter((message) => message.role === "toolResult");
      assert.deepEqual(toolResults.map((message) => message.isError), [true, false]);
      assert.match((await store.readContext(group.id)).content, /Approved decision/);
    }, { precedingInput: async () => { await Promise.resolve(); return { action: "continue" }; } });
  });
}

for (const scenario of ["transformed", "extension", "ambiguous", "stale-reproduction"]) {
  test(`actual streaming delivery rejects ${scenario} authorization`, async () => {
    await withRuntime(async ({ directory, store, create, reply, mockResponses, confirmations }) => {
      const group = await store.createGroup("lifecycle");
      const manager = SessionManager.inMemory(directory);
      setMembership(manager, group.id);
      const runtime = await create(manager);
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      mockResponses(runtime.session, async (count) => {
        if (count === 0) { entered.resolve(); await release.promise; return reply(false); }
        return reply(count === 1);
      });
      const running = runtime.session.prompt("Continue normally.");
      await entered.promise;
      await runtime.session.prompt(request, { streamingBehavior: "steer", source: scenario === "extension" ? "extension" : "interactive" });
      if (scenario === "ambiguous") await runtime.session.prompt(request, { streamingBehavior: "steer", source: "extension" });
      if (scenario === "stale-reproduction") await runtime.session.prompt("Unrelated streaming request.", { streamingBehavior: "steer" });
      release.resolve();
      await running;
      assert.equal(confirmations.length, 0);
      assert.doesNotMatch((await store.readContext(group.id)).content, /Approved decision/);
    }, {
      precedingInput: async () => ({ action: "continue" }),
      followingInput: (event) => {
        if (!event.streamingBehavior) return { action: "continue" };
        if (scenario === "transformed") return { action: "transform", text: "No shared changes." };
        if (scenario === "stale-reproduction") return event.text === request ? { action: "handled" } : { action: "transform", text: request };
        return { action: "continue" };
      },
    });
  });
}

test("Pi 0.85.0 preceding transforms expose no original input provenance", async () => {
  const observed = [];
  await withRuntime(async ({ directory, create, reply, mockResponses }) => {
    const runtime = await create(SessionManager.inMemory(directory));
    mockResponses(runtime.session, () => reply(false));
    await runtime.session.prompt("Explain the plan; do not change shared context.");
    await runtime.session.prompt(request);
    // Both events reaching this extension have identical text/source. The API
    // cannot prove raw user intent here; execution-time confirmation is required.
    assert.deepEqual(observed[0], observed[1]);
    assert.equal(observed[0].text, request);
    assert.equal(observed[0].source, "interactive");
    assert.equal("originalText" in observed[0], false);
    assert.equal("inputId" in observed[0], false);
  }, {
    precedingInput: async () => ({ action: "transform", text: request }),
    followingInput: (event) => { observed.push({ ...event }); return { action: "continue" }; },
  });
});

test("actual runtime inherits unflushed persisted membership across teardown awaits and fresh instances", async () => {
  await withRuntime(async ({ directory, store, create, instances }) => {
    const group = await store.createGroup("lifecycle");
    const manager = SessionManager.create(directory, join(directory, "sessions"));
    setMembership(manager, group.id);
    const runtime = await create(manager);
    const oldSession = runtime.session;
    await assert.rejects(access(manager.getSessionFile()), { code: "ENOENT" });
    await runtime.newSession();
    assert.notEqual(runtime.session, oldSession);
    assert.notEqual(runtime.session.sessionManager, manager);
    assert.equal(instances(), 2);
    assert.equal(membership(runtime.session.sessionManager), group.id);
    await assert.rejects(access(manager.getSessionFile()), { code: "ENOENT" });
  });
});

test("actual concurrent ephemeral fork and clone preserve latest session-wide membership by manager identity", async () => {
  await withRuntime(async ({ directory, store, create }) => {
    const firstGroup = await store.createGroup("first");
    const secondGroup = await store.createGroup("second");
    const managers = [SessionManager.inMemory(directory), SessionManager.inMemory(directory)];
    const entryIds = managers.map((manager) => manager.appendMessage({ role: "user", content: "old branch", timestamp: Date.now() }));
    setMembership(managers[0], firstGroup.id);
    setMembership(managers[1], secondGroup.id);
    const [first, second] = await Promise.all(managers.map(create));
    await Promise.all([first.fork(entryIds[0]), second.fork(entryIds[1], { position: "at" })]);
    assert.equal(first.session.sessionManager, managers[0]);
    assert.equal(second.session.sessionManager, managers[1]);
    assert.equal(membership(first.session.sessionManager), firstGroup.id);
    assert.equal(membership(second.session.sessionManager), secondGroup.id);
  });
});

test("actual concurrent persisted replacements do not exchange source memberships", async () => {
  await withRuntime(async ({ directory, store, create }) => {
    const groups = await Promise.all([store.createGroup("first"), store.createGroup("second")]);
    const runtimes = await Promise.all(groups.map(async (group) => {
      const manager = SessionManager.create(directory, join(directory, "sessions"));
      setMembership(manager, group.id);
      return create(manager);
    }));
    await Promise.all(runtimes.map((runtime) => runtime.newSession()));
    assert.deepEqual(runtimes.map((runtime) => membership(runtime.session.sessionManager)), groups.map((group) => group.id));
  });
});

test("persisted fork and clone inherit the latest source group even outside the selected branch", async () => {
  await withRuntime(async ({ directory, store, create, reply }) => {
    const oldGroup = await store.createGroup("old");
    const latestGroup = await store.createGroup("latest");
    for (const position of ["before", "at"]) {
      const manager = SessionManager.create(directory, join(directory, "sessions"));
      setMembership(manager, oldGroup.id);
      const entry = manager.appendMessage({ role: "user", content: "earlier branch", timestamp: Date.now() });
      manager.appendMessage(reply(false));
      setMembership(manager, latestGroup.id);
      const runtime = await create(manager);
      await runtime.fork(entry, { position });
      assert.notEqual(runtime.session.sessionManager, manager);
      assert.equal(membership(runtime.session.sessionManager), latestGroup.id);
    }
  });
});

test("ephemeral /new reports the missing runtime identity instead of guessing another runtime's handoff", async () => {
  await withRuntime(async ({ directory, store, create, notifications }) => {
    const groups = await Promise.all([store.createGroup("first"), store.createGroup("second")]);
    const runtimes = await Promise.all(groups.map(async (group) => {
      const manager = SessionManager.inMemory(directory);
      setMembership(manager, group.id);
      return create(manager);
    }));
    await Promise.all(runtimes.map((runtime) => runtime.newSession()));
    assert.deepEqual(runtimes.map((runtime) => membership(runtime.session.sessionManager)), [null, null]);
    assert.equal(notifications.filter(({ message }) => message.includes("cannot safely correlate")).length, 2);
  });
});
