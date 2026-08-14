import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { SessionGroupMetadata } from "./contracts.ts";
import {
  editSessionGroupContextInZed,
  type SessionGroupEditorPidHandler,
} from "./editor.ts";
import {
  SessionGroupContextEncodingError,
  SessionGroupContextMissingError,
  SessionGroupContextRevisionError,
  SessionGroupContextTooLargeError,
  SessionGroupStore,
} from "./store.ts";

const SUBCOMMANDS = [
  "create",
  "join",
  "leave",
  "edit",
  "changelog",
  "show",
  "list",
  "rename",
  "delete",
  "active",
] as const;

const ACTION_CREATE = "Create a group";
const ACTION_JOIN = "Join a group";
const ACTION_LEAVE = "Leave the current group";
const ACTION_EDIT = "Edit the current context in Zed";
const ACTION_CHANGELOG = "Edit the current changelog in Zed";
const ACTION_SHOW = "Show the current context";
const ACTION_LIST = "List groups";
const ACTION_RENAME = "Rename the current group";
const ACTION_DELETE = "Delete a group";
const ACTION_ACTIVE = "Set the global active group";
const ACTIVE_OFF = "Off — do not assign an active group";

export interface SessionGroupCommandDependencies {
  editContextInZed?: (
    pi: ExtensionAPI,
    path: string,
    onEditorPid?: SessionGroupEditorPidHandler,
  ) => Promise<void>;
}

export interface SessionGroupCommandController {
  getCurrentGroupId(): string | null;
  setCurrentGroup(
    ctx: ExtensionCommandContext,
    group: SessionGroupMetadata | null,
  ): void;
  presentCurrentGroup(
    ctx: ExtensionCommandContext,
    group: SessionGroupMetadata | null,
  ): void;
}

function report(
  ctx: ExtensionCommandContext,
  message: string,
  type: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  process.stderr.write(`${message}\n`);
}

function requireTui(ctx: ExtensionCommandContext, operation: string): boolean {
  if (ctx.mode === "tui") return true;
  report(ctx, `${operation} requires Pi's interactive TUI.`, "error");
  return false;
}

async function confirm(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx.hasUI) {
    report(ctx, `${title} requires interactive confirmation.`, "error");
    return false;
  }
  return ctx.ui.confirm(title, message);
}

async function showMarkdown(
  ctx: ExtensionCommandContext,
  title: string,
  markdown: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    report(ctx, `${title}\n\n${markdown}`, "info");
    return;
  }

  await ctx.ui.custom((_tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Markdown(markdown, 1, 1, getMarkdownTheme()));
    container.addChild(
      new Text(theme.fg("dim", "Use the configured confirm or cancel key to close"), 1, 0),
    );
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (
          keybindings.matches(data, "tui.select.confirm") ||
          keybindings.matches(data, "tui.select.cancel")
        ) {
          done(undefined);
        }
      },
    };
  });
}

async function currentGroup(
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
): Promise<SessionGroupMetadata> {
  const groupId = controller.getCurrentGroupId();
  if (groupId === null) throw new Error("This session does not belong to a group.");
  return store.readMetadata(groupId);
}

async function replaceMembershipIfAllowed(
  ctx: ExtensionCommandContext,
  controller: SessionGroupCommandController,
  nextName: string,
): Promise<boolean> {
  if (controller.getCurrentGroupId() === null) return true;
  return confirm(
    ctx,
    "Replace session group?",
    `This session already belongs to another group. Join '${nextName}' instead?`,
  );
}

async function createGroup(
  pi: ExtensionAPI,
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  editContextInZed: NonNullable<SessionGroupCommandDependencies["editContextInZed"]>,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!requireTui(ctx, "/group create")) return;
  if (!name.trim()) throw new Error("Usage: /group create <name>");
  if (!(await replaceMembershipIfAllowed(ctx, controller, name.trim()))) return;

  const group = await store.createGroup(name);
  controller.setCurrentGroup(ctx, group);
  report(ctx, `Created and joined session group '${group.name}'.`, "info");

  let editError: Error | undefined;
  try {
    await store.withGroupLock(group.id, "zed-edit", async (lock) => {
      await editContextInZed(
        pi,
        store.contextPath(group.id),
        (pid) => lock.setEditorPid(pid),
      );
      await store.reconcileContext(group.id);
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    editError = new Error(
      `${detail} The group remains created and joined; run /group edit to try again.`,
    );
  }

  if (
    await ctx.ui.confirm(
      "Set active group?",
      `Automatically assign new sessions to '${group.name}'?`,
    )
  ) {
    await store.setActiveGroup(group.id);
    report(ctx, `'${group.name}' is now the global active group.`, "info");
  }
  if (editError) throw editError;
}

async function joinGroup(
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!name.trim()) throw new Error("Usage: /group join <name>");
  const group = await store.resolveGroup(name);
  if (controller.getCurrentGroupId() === group.id) {
    report(ctx, `This session already belongs to '${group.name}'.`, "info");
    return;
  }
  if (!(await replaceMembershipIfAllowed(ctx, controller, group.name))) return;

  controller.setCurrentGroup(ctx, group);
  report(ctx, `Joined session group '${group.name}'.`, "info");
}

async function leaveGroup(
  controller: SessionGroupCommandController,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (controller.getCurrentGroupId() === null) {
    report(ctx, "This session is already ungrouped.", "info");
    return;
  }
  controller.setCurrentGroup(ctx, null);
  report(ctx, "Left the session group. The global active group was not changed.", "info");
}

async function editGroup(
  pi: ExtensionAPI,
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  editContextInZed: NonNullable<SessionGroupCommandDependencies["editContextInZed"]>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!requireTui(ctx, "/group edit")) return;
  const group = await currentGroup(store, controller);
  const snapshot = await store.withGroupLock(group.id, "zed-edit", async (lock) => {
    const contextPath = await store.prepareContextForManualEdit(group.id);
    try {
      await store.readContext(group.id);
    } catch (error) {
      if (
        error instanceof SessionGroupContextRevisionError ||
        error instanceof SessionGroupContextTooLargeError ||
        error instanceof SessionGroupContextEncodingError ||
        error instanceof SessionGroupContextMissingError
      ) {
        report(
          ctx,
          `${error.message} Opening Zed so the manual edit can review and repair it.`,
          "warning",
        );
      } else {
        throw error;
      }
    }
    await editContextInZed(pi, contextPath, (pid) => lock.setEditorPid(pid));
    return store.reconcileContext(group.id);
  });
  report(
    ctx,
    `Updated '${snapshot.name}' context at revision ${snapshot.revision}.`,
    "info",
  );
}

async function editChangelog(
  pi: ExtensionAPI,
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  editContextInZed: NonNullable<SessionGroupCommandDependencies["editContextInZed"]>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!requireTui(ctx, "/group changelog")) return;
  const group = await currentGroup(store, controller);
  const bytes = await store.withGroupLock(group.id, "changelog-edit", async (lock) => {
    const path = await store.prepareChangelogForManualEdit(group.id);
    await editContextInZed(pi, path, (pid) => lock.setEditorPid(pid));
    return store.validateChangelogAfterManualEdit(group.id);
  });
  report(ctx, `Updated '${group.name}' changelog (${bytes} bytes).`, "info");
}

async function showGroup(
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const group = await currentGroup(store, controller);
  const snapshot = await store.readContext(group.id);
  await showMarkdown(
    ctx,
    `${group.name} — revision ${snapshot.revision}, ${snapshot.bytes} bytes`,
    snapshot.content,
  );
}

async function listGroups(
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const [groups, active] = await Promise.all([store.listGroups(), store.getActiveGroup()]);
  if (groups.length === 0) {
    report(ctx, "No session groups exist.", "info");
    return;
  }

  const currentGroupId = controller.getCurrentGroupId();
  const lines = groups.map((group) => {
    const markers = [
      group.id === currentGroupId ? "current" : undefined,
      group.id === active?.id ? "active" : undefined,
    ].filter((marker): marker is string => marker !== undefined);
    const suffix = markers.length > 0 ? ` — ${markers.join(", ")}` : "";
    return `- **${group.name}**${suffix}\n  - ID: \`${group.id}\`\n  - Context: revision ${group.contextRevision}, ${group.contextBytes} bytes`;
  });
  await showMarkdown(ctx, "Session groups", lines.join("\n"));
}

async function renameGroup(
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!name.trim()) throw new Error("Usage: /group rename <new-name>");
  const current = await currentGroup(store, controller);
  const renamed = await store.renameGroup(current.id, name);
  controller.presentCurrentGroup(ctx, renamed);
  report(ctx, `Renamed session group to '${renamed.name}'.`, "info");
}

async function deleteGroup(
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const group = name.trim()
    ? await store.resolveGroup(name)
    : await currentGroup(store, controller);
  if (
    !(await confirm(
      ctx,
      "Permanently delete session group?",
      `Delete '${group.name}', its context.md, and its optional changelog.md permanently? Session JSONL files will remain.`,
    ))
  ) {
    return;
  }

  await store.deleteGroup(group.id);
  if (controller.getCurrentGroupId() === group.id) controller.setCurrentGroup(ctx, null);
  report(ctx, `Deleted session group '${group.name}'.`, "info");
}

async function activeGroup(
  store: SessionGroupStore,
  value: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const candidate = value.trim();
  if (!candidate || candidate.toLocaleLowerCase("en-US") === "status") {
    const active = await store.getActiveGroup();
    report(
      ctx,
      active
        ? `The global active group is '${active.name}'.`
        : "No global active group is set.",
      "info",
    );
    return;
  }

  if (candidate.toLocaleLowerCase("en-US") === "off") {
    await store.setActiveGroup(null);
    report(
      ctx,
      "Disabled the global active group. Existing session memberships were not changed.",
      "info",
    );
    return;
  }

  const group = await store.resolveGroup(candidate);
  await store.setActiveGroup(group.id);
  report(ctx, `'${group.name}' is now the global active group.`, "info");
}

async function executeOperation(
  operation: string,
  value: string,
  pi: ExtensionAPI,
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  editContextInZed: NonNullable<SessionGroupCommandDependencies["editContextInZed"]>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  switch (operation) {
    case "create":
      await createGroup(pi, store, controller, editContextInZed, value, ctx);
      return;
    case "join":
      await joinGroup(store, controller, value, ctx);
      return;
    case "leave":
      if (value) throw new Error("Usage: /group leave");
      await leaveGroup(controller, ctx);
      return;
    case "edit":
      if (value) throw new Error("Usage: /group edit");
      await editGroup(pi, store, controller, editContextInZed, ctx);
      return;
    case "changelog":
      if (value) throw new Error("Usage: /group changelog");
      await editChangelog(pi, store, controller, editContextInZed, ctx);
      return;
    case "show":
      if (value) throw new Error("Usage: /group show");
      await showGroup(store, controller, ctx);
      return;
    case "list":
      if (value) throw new Error("Usage: /group list");
      await listGroups(store, controller, ctx);
      return;
    case "rename":
      await renameGroup(store, controller, value, ctx);
      return;
    case "delete":
      await deleteGroup(store, controller, value, ctx);
      return;
    case "active":
      await activeGroup(store, value, ctx);
      return;
    default:
      throw new Error(
        "Usage: /group [create|join|leave|edit|changelog|show|list|rename|delete|active]",
      );
  }
}

async function chooseGroup(
  store: SessionGroupStore,
  ctx: ExtensionCommandContext,
  title: string,
): Promise<string | undefined> {
  const groups = await store.listGroups();
  if (groups.length === 0) {
    report(ctx, "No session groups exist.", "warning");
    return undefined;
  }
  return ctx.ui.select(title, groups.map((group) => group.name));
}

async function actionMenu(
  pi: ExtensionAPI,
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  editContextInZed: NonNullable<SessionGroupCommandDependencies["editContextInZed"]>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    report(
      ctx,
      "Usage: /group [create|join|leave|edit|changelog|show|list|rename|delete|active]",
      "info",
    );
    return;
  }

  const action = await ctx.ui.select("Session groups", [
    ACTION_CREATE,
    ACTION_JOIN,
    ACTION_LEAVE,
    ACTION_EDIT,
    ACTION_CHANGELOG,
    ACTION_SHOW,
    ACTION_LIST,
    ACTION_RENAME,
    ACTION_DELETE,
    ACTION_ACTIVE,
  ]);
  if (action === undefined) return;

  if (action === ACTION_CREATE) {
    const name = await ctx.ui.input("Create session group", "Group name");
    if (name !== undefined) {
      await createGroup(pi, store, controller, editContextInZed, name, ctx);
    }
    return;
  }
  if (action === ACTION_JOIN) {
    const name = await chooseGroup(store, ctx, "Join session group");
    if (name !== undefined) await joinGroup(store, controller, name, ctx);
    return;
  }
  if (action === ACTION_LEAVE) {
    await leaveGroup(controller, ctx);
    return;
  }
  if (action === ACTION_EDIT) {
    await editGroup(pi, store, controller, editContextInZed, ctx);
    return;
  }
  if (action === ACTION_CHANGELOG) {
    await editChangelog(pi, store, controller, editContextInZed, ctx);
    return;
  }
  if (action === ACTION_SHOW) {
    await showGroup(store, controller, ctx);
    return;
  }
  if (action === ACTION_LIST) {
    await listGroups(store, controller, ctx);
    return;
  }
  if (action === ACTION_RENAME) {
    const name = await ctx.ui.input("Rename current session group", "New name");
    if (name !== undefined) await renameGroup(store, controller, name, ctx);
    return;
  }
  if (action === ACTION_DELETE) {
    const name = await chooseGroup(store, ctx, "Delete session group");
    if (name !== undefined) await deleteGroup(store, controller, name, ctx);
    return;
  }

  const groups = await store.listGroups();
  const groupChoices = groups.map((group) => ({
    label: `Group — ${group.name}`,
    name: group.name,
  }));
  const choice = await ctx.ui.select("Global active group", [
    ACTIVE_OFF,
    ...groupChoices.map((group) => group.label),
  ]);
  if (choice === undefined) return;
  if (choice === ACTIVE_OFF) {
    await activeGroup(store, "off", ctx);
    return;
  }
  const selectedGroup = groupChoices.find((group) => group.label === choice);
  if (selectedGroup) await activeGroup(store, selectedGroup.name, ctx);
}

function parseArguments(args: string): { operation: string; value: string } {
  const trimmed = args.trim();
  if (!trimmed) return { operation: "", value: "" };
  const separator = trimmed.search(/\s/);
  if (separator === -1) return { operation: trimmed.toLocaleLowerCase("en-US"), value: "" };
  return {
    operation: trimmed.slice(0, separator).toLocaleLowerCase("en-US"),
    value: trimmed.slice(separator).trim(),
  };
}

export function registerSessionGroupCommands(
  pi: ExtensionAPI,
  store: SessionGroupStore,
  controller: SessionGroupCommandController,
  dependencies: SessionGroupCommandDependencies = {},
): void {
  const editContextInZed =
    dependencies.editContextInZed ?? editSessionGroupContextInZed;
  pi.registerCommand("group", {
    description: "Create, join, edit, and manage shared session groups and changelogs",
    getArgumentCompletions: async (prefix) => {
      const leading = prefix.trimStart();
      const separator = leading.indexOf(" ");
      if (separator === -1) {
        const matches = SUBCOMMANDS.filter((command) => command.startsWith(leading));
        return matches.length > 0
          ? matches.map((command) => ({ value: command, label: command }))
          : null;
      }

      const operation = leading.slice(0, separator).toLocaleLowerCase("en-US");
      const namePrefix = leading.slice(separator + 1).toLocaleLowerCase("en-US");
      if (!(["join", "delete", "active"] as const).includes(
        operation as "join" | "delete" | "active",
      )) {
        return null;
      }
      try {
        const groups = await store.listGroups();
        const values = [
          ...(operation === "active" ? ["status", "off"] : []),
          ...groups.map((group) => group.name),
        ].filter((name) => name.toLocaleLowerCase("en-US").startsWith(namePrefix));
        return values.length > 0
          ? values.map((name) => ({
              value: `${operation} ${name}`,
              label: name,
            }))
          : null;
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        const { operation, value } = parseArguments(args);
        if (!operation) {
          await actionMenu(pi, store, controller, editContextInZed, ctx);
          return;
        }
        await executeOperation(
          operation,
          value,
          pi,
          store,
          controller,
          editContextInZed,
          ctx,
        );
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
