import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerSessionGroupCommands } from "../extensions/session-groups/commands.ts";
import { SessionGroupLockBusyError } from "../extensions/session-groups/lock.ts";
import {
  appendSessionGroupMembership,
  readSessionGroupMembership,
  SessionGroupMembershipError,
} from "../extensions/session-groups/membership.ts";
import { SessionGroupStore } from "../extensions/session-groups/store.ts";

async function withHarness(run, exec, editor) {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-groups-commands-"));
  const store = new SessionGroupStore({ rootDirectory: join(directory, "session groups") });
  const commands = new Map();
  const calls = [];
  const pi = {
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    exec: exec ?? (async (command, args) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0, killed: false };
    }),
  };
  let current = null;
  const controller = {
    getCurrentGroupId: () => current?.id ?? null,
    setCurrentGroup(_ctx, group) {
      current = group;
    },
    presentCurrentGroup(_ctx, group) {
      current = group;
    },
  };
  registerSessionGroupCommands(pi, store, controller, {
    editContextInZed: editor ?? (async (runtimePi, path, onEditorPid) => {
      await onEditorPid?.(process.pid);
      try {
        const result = await runtimePi.exec("zed", ["--wait", path]);
        if (result.code !== 0) {
          throw new Error(
            `Zed exited with code ${result.code}: ${(result.stderr || result.stdout).trim()}`,
          );
        }
      } finally {
        await onEditorPid?.(null);
      }
    }),
  });

  const notifications = [];
  const confirmations = [];
  const confirmationAnswers = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => undefined,
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

  try {
    await run({
      store,
      command: commands.get("group"),
      calls,
      ctx,
      notifications,
      confirmations,
      confirmationAnswers,
      current: () => current,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("creates, edits, activates, renames, leaves, rejoins, and deletes groups", async () => {
  let zedPath;
  await withHarness(
    async ({
      store,
      command,
      ctx,
      confirmationAnswers,
      current,
      notifications,
    }) => {
      confirmationAnswers.push(true);
      await command.handler("create Table partitioning", ctx);
      const created = current();
      assert.equal(created.name, "Table partitioning");
      assert.equal((await store.getActiveGroup()).id, created.id);
      assert.equal((await store.readContext(created.id)).revision, 1);
      assert.match(await readFile(zedPath, "utf8"), /Edited in Zed/);

      await command.handler("changelog", ctx);
      assert.equal(zedPath, store.changelogPath(created.id));
      assert.match(await readFile(zedPath, "utf8"), /# Changelog/);
      assert.match(await readFile(zedPath, "utf8"), /Edited in Zed/);

      await command.handler("rename Orders partitioning", ctx);
      assert.equal(current().id, created.id);
      assert.equal(current().name, "Orders partitioning");

      await command.handler("active status", ctx);
      assert.equal(
        notifications.some(({ message }) => message.includes("global active group is")),
        true,
      );
      await command.handler("active off", ctx);
      assert.equal(await store.getActiveGroup(), null);
      assert.equal(current().id, created.id);

      await command.handler("show", ctx);
      await command.handler("list", ctx);
      await command.handler("leave", ctx);
      assert.equal(current(), null);

      await command.handler("join Orders partitioning", ctx);
      assert.equal(current().id, created.id);

      confirmationAnswers.push(true);
      await command.handler("delete", ctx);
      assert.equal(current(), null);
      assert.deepEqual(await store.listGroups(), []);
      assert.equal(
        notifications.some(({ message }) => message.includes("Deleted session group")),
        true,
      );
    },
    async (command, args) => {
      assert.equal(command, "zed");
      assert.equal(args[0], "--wait");
      zedPath = args[1];
      await writeFile(zedPath, `${await readFile(zedPath, "utf8")}\nEdited in Zed\n`);
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  );
});

test("keeps a created group when Zed fails and never falls back to another editor", async () => {
  const executions = [];
  await withHarness(
    async ({ store, command, ctx, current, notifications }) => {
      await command.handler("create partitioning", ctx);
      assert.equal(current().name, "partitioning");
      assert.equal((await store.listGroups()).length, 1);
      assert.deepEqual(executions.map(({ command }) => command), ["zed"]);
      assert.equal(
        notifications.some(
          ({ message, type }) =>
            type === "error" &&
            message.includes("remains created and joined") &&
            message.includes("/group edit"),
        ),
        true,
      );
    },
    async (command, args) => {
      executions.push({ command, args });
      return { stdout: "", stderr: "zed unavailable", code: 127, killed: false };
    },
  );
});

test("requires confirmation before replacing membership or deleting context", async () => {
  await withHarness(async ({ store, command, ctx, current, confirmationAnswers }) => {
    const first = await store.createGroup("first");
    const second = await store.createGroup("second");
    await command.handler("join first", ctx);
    assert.equal(current().id, first.id);

    confirmationAnswers.push(false);
    await command.handler("join second", ctx);
    assert.equal(current().id, first.id);

    confirmationAnswers.push(false);
    await command.handler("delete second", ctx);
    assert.equal((await store.readMetadata(second.id)).id, second.id);
  });
});

test("rejects editor commands outside TUI before creating a group", async () => {
  await withHarness(async ({ store, command, ctx, notifications }) => {
    ctx.mode = "rpc";
    await command.handler("create partitioning", ctx);
    assert.deepEqual(await store.listGroups(), []);
    assert.equal(
      notifications.some(({ message }) => message.includes("requires Pi's interactive TUI")),
      true,
    );
  });
});

test("autocompletes subcommands and existing group names", async () => {
  await withHarness(async ({ store, command }) => {
    await store.createGroup("Table partitioning");
    assert.deepEqual(await command.getArgumentCompletions("cr"), [
      { value: "create", label: "create" },
    ]);
    assert.deepEqual(await command.getArgumentCompletions("ch"), [
      { value: "changelog", label: "changelog" },
    ]);
    assert.deepEqual(await command.getArgumentCompletions("join Ta"), [
      { value: "join Table partitioning", label: "Table partitioning" },
    ]);
    assert.equal(
      (await command.getArgumentCompletions("active ")).some(
        ({ value }) => value === "active off",
      ),
      true,
    );
    assert.equal(
      (await command.getArgumentCompletions("active ")).some(
        ({ value }) => value === "active status",
      ),
      true,
    );
  });
});

test("holds the group lock for the complete Zed wait lifetime", async () => {
  let editorStartedResolve;
  const editorStarted = new Promise((resolve) => {
    editorStartedResolve = resolve;
  });
  let releaseEditorResolve;
  const releaseEditor = new Promise((resolve) => {
    releaseEditorResolve = resolve;
  });

  await withHarness(
    async ({ store, command, ctx }) => {
      const group = await store.createGroup("partitioning");
      await command.handler("join partitioning", ctx);
      const contender = new SessionGroupStore({ rootDirectory: store.rootDirectory });
      await contender.initialize();

      const editing = command.handler("edit", ctx);
      await editorStarted;
      await assert.rejects(
        contender.withGroupLock(
          group.id,
          "agent-edit",
          async () => undefined,
          { waitMs: 0 },
        ),
        SessionGroupLockBusyError,
      );
      releaseEditorResolve();
      await editing;
    },
    undefined,
    async (_pi, _path, onEditorPid) => {
      await onEditorPid?.(process.pid);
      editorStartedResolve();
      try {
        await releaseEditor;
      } finally {
        await onEditorPid?.(null);
      }
    },
  );
});

test("persists strict latest membership markers", () => {
  const entries = [];
  const pi = {
    appendEntry(customType, data) {
      entries.push({
        type: "custom",
        id: String(entries.length),
        parentId: null,
        timestamp: "2026-08-13T20:47:59.123Z",
        customType,
        data,
      });
    },
  };
  const groupId = "019cda47-9baf-7000-8000-000000000001";
  appendSessionGroupMembership(pi, groupId);
  appendSessionGroupMembership(pi, null);
  assert.deepEqual(readSessionGroupMembership(entries), { version: 1, groupId: null });

  entries.push({
    type: "custom",
    id: "bad",
    parentId: null,
    timestamp: "2026-08-13T20:47:59.123Z",
    customType: "ventris-session-group-membership",
    data: { version: 1, groupId: "bad" },
  });
  assert.throws(() => readSessionGroupMembership(entries), SessionGroupMembershipError);
});
