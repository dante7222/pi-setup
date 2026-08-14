import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sessionGroups from "../extensions/session-groups/index.ts";
import { readSessionGroupMembership } from "../extensions/session-groups/membership.ts";
import { SessionGroupStore } from "../extensions/session-groups/store.ts";

async function withExtension(run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-groups-extension-"));
  const agentDirectory = join(directory, "agent");
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const previousPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory);
  const zedPath = join(binDirectory, "zed");
  await writeFile(zedPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(zedPath, 0o700);
  process.env.PATH = `${binDirectory}:${previousPath ?? ""}`;

  const entries = [];
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const activeTools = ["read", "bash"];
  const emitted = [];
  const eventHandlers = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
      activeTools.push(definition.name);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools.splice(0, activeTools.length, ...names);
    },
    appendEntry(customType, data) {
      entries.push({
        type: "custom",
        id: `entry-${entries.length}`,
        parentId: null,
        timestamp: "2026-08-13T20:47:59.123Z",
        customType,
        data,
      });
    },
    getSessionName: () => "Partition production table",
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    events: {
      emit(channel, data) {
        emitted.push({ channel, data });
        eventHandlers.get(channel)?.(data);
      },
      on(channel, handler) {
        eventHandlers.set(channel, handler);
        return () => eventHandlers.delete(channel);
      },
    },
  };
  const notifications = [];
  const confirmations = [];
  const confirmationAnswers = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => undefined,
    sessionManager: {
      getEntries: () => [...entries],
      getSessionId: () => "019cda47-9baf-7000-8000-000000000099",
      getSessionFile: () => join(directory, "session.jsonl"),
      getHeader: () => null,
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
      confirm: async (title, message) => {
        confirmations.push({ title, message });
        return confirmationAnswers.shift() ?? false;
      },
      select: async () => undefined,
      input: async () => undefined,
      custom: async () => undefined,
    },
  };

  sessionGroups(pi);
  const store = new SessionGroupStore();
  try {
    await run({
      store,
      entries,
      handlers,
      command: commands.get("group"),
      tool: tools.get("edit_group_context"),
      changelogTool: tools.get("group_changelog"),
      activeTools,
      emitted,
      notifications,
      confirmations,
      confirmationAnswers,
      ctx,
    });
  } finally {
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("exposes the context-edit tool only while the session is grouped", async () => {
  await withExtension(async ({
    store,
    handlers,
    command,
    tool,
    changelogTool,
    activeTools,
    ctx,
  }) => {
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
    assert.equal(changelogTool.promptSnippet, undefined);
    assert.equal(changelogTool.promptGuidelines, undefined);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    assert.deepEqual(activeTools, ["read", "bash"]);

    activeTools.push("edit_group_context", "group_changelog");
    await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.deepEqual(activeTools, ["read", "bash"]);

    await store.createGroup("partitioning");
    await command.handler("join partitioning", ctx);
    assert.equal(activeTools.includes("edit_group_context"), true);
    assert.equal(activeTools.includes("group_changelog"), true);

    activeTools.splice(activeTools.indexOf("edit_group_context"), 1);
    await handlers.get("session_shutdown")({ reason: "reload" }, ctx);
    activeTools.push("edit_group_context");
    await handlers.get("session_start")({ reason: "reload" }, ctx);
    assert.equal(activeTools.includes("edit_group_context"), false);
    assert.equal(activeTools.includes("group_changelog"), true);

    activeTools.push("edit_group_context");
    activeTools.splice(activeTools.indexOf("group_changelog"), 1);
    await handlers.get("session_shutdown")({ reason: "reload" }, ctx);
    activeTools.push("group_changelog");
    await handlers.get("session_start")({ reason: "reload" }, ctx);
    assert.equal(activeTools.includes("edit_group_context"), true);
    assert.equal(activeTools.includes("group_changelog"), false);

    await command.handler("leave", ctx);
    assert.deepEqual(activeTools, ["read", "bash"]);
  });
});

test("real command controller persists membership changes but not rename", async () => {
  await withExtension(
    async ({ store, entries, handlers, command, confirmationAnswers, ctx }) => {
      const group = await store.createGroup("partitioning");
      await handlers.get("session_start")({ reason: "startup" }, ctx);
      assert.equal(readSessionGroupMembership(entries).groupId, null);

      await command.handler("join partitioning", ctx);
      assert.equal(readSessionGroupMembership(entries).groupId, group.id);
      const entriesAfterJoin = entries.length;

      await command.handler("rename orders partitioning", ctx);
      assert.equal(entries.length, entriesAfterJoin);
      assert.equal((await store.readMetadata(group.id)).name, "orders partitioning");

      await command.handler("leave", ctx);
      assert.equal(readSessionGroupMembership(entries).groupId, null);

      await command.handler("join orders partitioning", ctx);
      assert.equal(readSessionGroupMembership(entries).groupId, group.id);
      confirmationAnswers.push(true);
      await command.handler("delete", ctx);
      assert.equal(readSessionGroupMembership(entries).groupId, null);
    },
  );
});

test("fresh startup automatically joins the global active group", async () => {
  await withExtension(async ({
    store,
    entries,
    handlers,
    activeTools,
    emitted,
    notifications,
    ctx,
  }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    entries.push({
      type: "session_info",
      id: "fresh-name",
      parentId: null,
      timestamp: "2026-08-13T20:47:59.123Z",
      name: "Named fresh session",
    });

    await handlers.get("session_start")({ reason: "startup" }, ctx);
    assert.equal(readSessionGroupMembership(entries).groupId, group.id);
    assert.equal(activeTools.includes("edit_group_context"), true);
    assert.equal(activeTools.includes("group_changelog"), true);
    assert.equal(emitted.at(-1).data.group.name, "partitioning");
    assert.equal(
      notifications.some(({ message }) => message.includes("global active session group")),
      true,
    );
  });
});

test("refreshes and injects group context on every prompt without session copies", async () => {
  await withExtension(async ({ store, entries, handlers, emitted, ctx }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    const membershipEntryCount = entries.length;

    const first = await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.match(first.systemPrompt, /# partitioning/);
    assert.match(first.systemPrompt, /only through edit_group_context/);
    assert.equal("message" in first, false);
    assert.equal(entries.length, membershipEntryCount);

    await writeFile(
      store.contextPath(group.id),
      "# partitioning\n\n## Decisions\n\nUse monthly partitions.\n",
      "utf8",
    );
    await store.renameGroup(group.id, "orders partitioning");
    const repeatedStart = await handlers.get("before_agent_start")(
      { prompt: "retry", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.doesNotMatch(repeatedStart.systemPrompt, /Use monthly partitions/);
    assert.doesNotMatch(repeatedStart.systemPrompt, /orders partitioning/);

    await handlers.get("agent_settled")({}, ctx);
    const nextTurn = await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.match(nextTurn.systemPrompt, /Use monthly partitions/);
    assert.match(nextTurn.systemPrompt, /orders partitioning/);
    assert.equal(emitted.at(-1).data.group.name, "orders partitioning");
    assert.equal((await store.readContext(group.id)).revision, 1);
    assert.equal(entries.length, membershipEntryCount);
  });
});

test("reads and appends the optional changelog only on demand", async () => {
  await withExtension(async ({
    store,
    handlers,
    changelogTool,
    confirmations,
    confirmationAnswers,
    ctx,
  }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);

    const absent = await changelogTool.execute(
      "read-absent",
      { action: "read" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(absent.content[0].text, /No changelog exists/);

    const request = "Add our completed backfill work to the group changelog.";
    await handlers.get("input")({ text: request, source: "interactive" }, ctx);
    const before = await handlers.get("before_agent_start")(
      { prompt: request, systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.doesNotMatch(before.systemPrompt, /Completed historical backfill/);

    confirmationAnswers.push(true);
    const appended = await changelogTool.execute(
      "append",
      {
        action: "append",
        entry: "- Completed historical backfill.\n- Added failure monitoring.",
      },
      undefined,
      undefined,
      ctx,
    );
    assert.doesNotMatch(appended.content[0].text, /Completed historical backfill/);
    assert.match(confirmations.at(-1).title, /Append to shared group changelog/);
    const stored = await readFile(store.changelogPath(group.id), "utf8");
    assert.match(stored, /Partition production table/);
    assert.match(stored, /Completed historical backfill/);

    await assert.rejects(
      changelogTool.execute(
        "declined-append",
        { action: "append", entry: "- This entry must not be stored." },
        undefined,
        undefined,
        ctx,
      ),
      /did not approve/,
    );
    assert.doesNotMatch(
      await readFile(store.changelogPath(group.id), "utf8"),
      /must not be stored/,
    );

    const read = await changelogTool.execute(
      "read",
      { action: "read" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(read.content[0].text, /Completed historical backfill/);

    await handlers.get("agent_settled")({}, ctx);
    const next = await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.doesNotMatch(next.systemPrompt, /Completed historical backfill/);
  });
});

test("omits oversized context entirely and directs the user to edit it", async () => {
  await withExtension(async ({ store, handlers, notifications, ctx }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    await writeFile(store.contextPath(group.id), Buffer.alloc(65_537, 0x78));

    const result = await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.match(result.systemPrompt, /context unavailable/);
    assert.match(result.systemPrompt, /\/group edit/);
    assert.doesNotMatch(result.systemPrompt, /<session_group_context/);
    assert.equal(
      notifications.some(
        ({ message }) => message.includes("65537 bytes") && message.includes("/group edit"),
      ),
      true,
    );

    await writeFile(store.contextPath(group.id), "# partitioning\n", "utf8");
    const repeatedStart = await handlers.get("before_agent_start")(
      { prompt: "retry", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.match(repeatedStart.systemPrompt, /context unavailable/);
    await handlers.get("agent_settled")({}, ctx);
    const repairedTurn = await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.match(repairedTurn.systemPrompt, /# partitioning/);
    assert.doesNotMatch(repairedTurn.systemPrompt, /context unavailable/);
  });
});

test("distinguishes repairable context loss from metadata corruption", async () => {
  await withExtension(async ({ store, handlers, command, emitted, ctx }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    await rm(store.contextPath(group.id));

    const missing = await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.match(missing.systemPrompt, /context file is missing/);
    assert.match(missing.systemPrompt, /\/group edit/);
    assert.equal(emitted.at(-1).data.group.id, group.id);

    await handlers.get("agent_settled")({}, ctx);
    await command.handler("edit", ctx);
    assert.match((await store.readContext(group.id)).content, /^# partitioning/);

    await writeFile(store.metadataPath(group.id), "{}\n", "utf8");
    await handlers.get("agent_settled")({}, ctx);
    const corrupt = await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.match(corrupt.systemPrompt, /metadata must be repaired/);
    assert.doesNotMatch(corrupt.systemPrompt, /\/group edit/);
    assert.equal(emitted.at(-1).data.group.name, "unavailable");
  });
});

test("agent tool requires current direct authorization and returns a visible diff", async () => {
  await withExtension(async ({
    store,
    handlers,
    tool,
    confirmations,
    confirmationAnswers,
    ctx,
  }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);

    await handlers.get("input")(
      {
        text: "Add the monthly partition decision to our shared group context.",
        source: "interactive",
      },
      ctx,
    );
    await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    const snapshot = await store.readContext(group.id);
    confirmationAnswers.push(true);
    const result = await tool.execute(
      "tool-call",
      {
        groupId: group.id,
        expectedRevision: snapshot.revision,
        expectedSha256: snapshot.sha256,
        userRequestQuote: "Add the monthly partition decision",
        edits: [
          {
            oldText: "## Decisions\n",
            newText: "## Decisions\n\n- Use monthly partitions.\n",
          },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.match(result.content[0].text, /revision 0 to 1/);
    assert.match(result.details.diff, /Use monthly partitions/);
    assert.match(result.details.patch, /context\.md/);
    assert.match((await store.readContext(group.id)).content, /Use monthly partitions/);
    assert.match(confirmations.at(-1).title, /Update shared session-group context/);
    assert.match(confirmations.at(-1).message, /Use monthly partitions/);

    confirmationAnswers.push(true);
    await assert.rejects(
      tool.execute(
        "stale-tool-call",
        {
          groupId: group.id,
          expectedRevision: snapshot.revision,
          expectedSha256: snapshot.sha256,
          userRequestQuote: "Add the monthly partition decision",
          edits: [{ oldText: "## Notes\n", newText: "## Notes\n\nMore\n" }],
        },
        undefined,
        undefined,
        ctx,
      ),
      /context changed/,
    );
  });
});

test("agent tool rejects mismatched and extension-originated authorization", async () => {
  await withExtension(async ({ store, handlers, tool, ctx }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    await handlers.get("input")(
      { text: "Stale handled input: update shared context.", source: "interactive" },
      ctx,
    );
    await handlers.get("input")(
      { text: "Continue implementation without changing shared context.", source: "interactive" },
      ctx,
    );
    await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    const snapshot = await store.readContext(group.id);
    const args = {
      groupId: group.id,
      expectedRevision: snapshot.revision,
      expectedSha256: snapshot.sha256,
      userRequestQuote: "update shared context",
      edits: [{ oldText: "## Notes\n", newText: "## Notes\n\nMore\n" }],
    };
    await assert.rejects(
      tool.execute("tool-call", args, undefined, undefined, ctx),
      /exact substring/,
    );

    await handlers.get("agent_settled")({}, ctx);
    await handlers.get("input")(
      { text: "update shared context", source: "extension" },
      ctx,
    );
    await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    await assert.rejects(
      tool.execute("extension-tool-call", args, undefined, undefined, ctx),
      /direct interactive or RPC user authorization/,
    );
  });
});

test("requires confirmation when message wording contains negative intent", async () => {
  await withExtension(async ({ store, handlers, tool, confirmations, ctx }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    const userMessage = "Do not update shared context; just explain the current plan.";
    await handlers.get("input")(
      { text: userMessage, source: "interactive" },
      ctx,
    );
    await handlers.get("before_agent_start")(
      { prompt: userMessage, systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    const snapshot = await store.readContext(group.id);

    await assert.rejects(
      tool.execute(
        "negative-intent",
        {
          groupId: group.id,
          expectedRevision: snapshot.revision,
          expectedSha256: snapshot.sha256,
          userRequestQuote: "update shared context",
          edits: [
            {
              oldText: "## Notes\n",
              newText: "## Notes\n\n- This must not be written.\n",
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      ),
      /did not approve/,
    );
    assert.equal(confirmations.length, 1);
    assert.equal((await store.readContext(group.id)).revision, snapshot.revision);
    assert.doesNotMatch(
      (await store.readContext(group.id)).content,
      /This must not be written/,
    );
  });
});

test("associates streaming authorization only when its user message is delivered", async () => {
  await withExtension(async ({ store, handlers, tool, confirmationAnswers, ctx }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    await handlers.get("input")(
      { text: "Continue normally.", source: "interactive" },
      ctx,
    );
    await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    await handlers.get("input")(
      {
        text: "Add a steering note to shared context.",
        source: "interactive",
        streamingBehavior: "steer",
      },
      ctx,
    );
    const snapshot = await store.readContext(group.id);
    const args = {
      groupId: group.id,
      expectedRevision: snapshot.revision,
      expectedSha256: snapshot.sha256,
      userRequestQuote: "Add a steering note",
      edits: [{ oldText: "## Notes\n", newText: "## Notes\n\n- Steering note.\n" }],
    };
    await assert.rejects(
      tool.execute("early", args, undefined, undefined, ctx),
      /exact substring/,
    );

    await handlers.get("message_start")(
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "Add a steering note to shared context." }],
          timestamp: Date.now(),
        },
      },
      ctx,
    );
    confirmationAnswers.push(true);
    await tool.execute("delivered", args, undefined, undefined, ctx);
    assert.match((await store.readContext(group.id)).content, /Steering note/);
  });
});

test("fails closed on ambiguous streaming authorization sources", async () => {
  await withExtension(async ({ store, handlers, tool, ctx }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    await handlers.get("input")(
      { text: "Continue normally.", source: "interactive" },
      ctx,
    );
    await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    const text = "Add the same note to shared context.";
    await handlers.get("input")(
      { text, source: "interactive", streamingBehavior: "steer" },
      ctx,
    );
    await handlers.get("input")(
      { text, source: "extension", streamingBehavior: "steer" },
      ctx,
    );
    await handlers.get("message_start")(
      {
        message: {
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
        },
      },
      ctx,
    );
    const snapshot = await store.readContext(group.id);
    await assert.rejects(
      tool.execute(
        "ambiguous",
        {
          groupId: group.id,
          expectedRevision: snapshot.revision,
          expectedSha256: snapshot.sha256,
          userRequestQuote: "Add the same note",
          edits: [{ oldText: "## Notes\n", newText: "## Notes\n\n- note\n" }],
        },
        undefined,
        undefined,
        ctx,
      ),
      /does not contain direct interactive or RPC user authorization/,
    );
  });
});

test("detaches lazily when a group is deleted between turns", async () => {
  await withExtension(async ({ store, entries, handlers, emitted, notifications, ctx }) => {
    const group = await store.createGroup("partitioning");
    await store.setActiveGroup(group.id);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    await store.deleteGroup(group.id);

    const result = await handlers.get("before_agent_start")(
      { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
      ctx,
    );
    assert.equal(result, undefined);
    assert.equal(readSessionGroupMembership(entries).groupId, null);
    assert.equal(emitted.at(-1).data.group, null);
    assert.equal(
      notifications.some(({ message }) => message.includes("now ungrouped")),
      true,
    );
  });
});

test("startup restores membership and reports unavailable metadata consistently", async () => {
  await withExtension(
    async ({ store, entries, handlers, command, emitted, notifications, ctx }) => {
      const group = await store.createGroup("partitioning");
      entries.push({
        type: "custom",
        id: "membership",
        parentId: null,
        timestamp: "2026-08-13T20:47:59.123Z",
        customType: "ventris-session-group-membership",
        data: { version: 1, groupId: group.id },
      });

      await handlers.get("session_start")({ reason: "resume" }, ctx);
      assert.equal(emitted.at(-1).data.group.name, "partitioning");
      assert.equal(
        notifications.some(({ message }) => message.includes("Restored session group")),
        true,
      );
      const primed = await handlers.get("before_agent_start")(
        { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
        ctx,
      );
      assert.match(primed.systemPrompt, /# partitioning/);

      await writeFile(store.metadataPath(group.id), "{}\n", "utf8");
      await handlers.get("session_start")({ reason: "reload" }, ctx);
      assert.deepEqual(emitted.at(-1).data.group, {
        id: group.id,
        name: "unavailable",
      });
      assert.equal(
        notifications.some(({ message }) => message.includes("membership is preserved")),
        true,
      );
      const unavailable = await handlers.get("before_agent_start")(
        { prompt: "continue", systemPrompt: "base", systemPromptOptions: {} },
        ctx,
      );
      assert.match(unavailable.systemPrompt, /metadata must be repaired/);
      assert.doesNotMatch(unavailable.systemPrompt, /# partitioning/);

      await command.handler("leave", ctx);
      assert.equal(readSessionGroupMembership(entries).groupId, null);
    },
  );
});
