import type { InputSource } from "@earendil-works/pi-coding-agent";
import {
  generateDiffString,
  generateUnifiedPatch,
  renderDiff,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES,
  type SessionGroupContextSnapshot,
} from "./contracts.ts";
import {
  applyExactSessionGroupContextEdits,
  type SessionGroupStore,
} from "./store.ts";

export const EDIT_GROUP_CONTEXT_TOOL_NAME = "edit_group_context";
export const GROUP_CHANGELOG_TOOL_NAME = "group_changelog";

const editGroupContextSchema = Type.Object({
  groupId: Type.String({ description: "Stable ID from the injected group snapshot" }),
  expectedRevision: Type.Integer({
    minimum: 0,
    description: "Revision from the injected group snapshot",
  }),
  expectedSha256: Type.String({
    pattern: "^[0-9a-f]{64}$",
    description: "SHA-256 from the injected group snapshot",
  }),
  userRequestQuote: Type.String({
    minLength: 1,
    description:
      "Exact quote from the current raw user message explicitly requesting this shared-context update",
  }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ minLength: 1 }),
      newText: Type.String(),
    }),
    { minItems: 1, maxItems: 50 },
  ),
});

const groupChangelogSchema = Type.Object({
  action: StringEnum(["read", "append"] as const),
  entry: Type.Optional(Type.String()),
});

export type EditGroupContextInput = Static<typeof editGroupContextSchema>;
export type GroupChangelogInput = Static<typeof groupChangelogSchema>;

export interface SessionGroupUserAuthorization {
  text: string;
  source: InputSource;
}

export interface EditGroupContextDetails {
  path: string;
  diff: string;
  patch: string;
  oldRevision: number;
  newRevision: number;
  oldSha256: string;
  newSha256: string;
}

export interface GroupChangelogDetails {
  action: "read" | "append";
  path: string;
  totalBytes: number;
  returnedBytes?: number;
  truncated?: boolean;
  timestamp?: string;
  sessionName?: string;
}

export interface SessionGroupToolController {
  getCurrentGroupId(): string | null;
  getCurrentContextSnapshot(): SessionGroupContextSnapshot | undefined;
  getCurrentUserAuthorization(): SessionGroupUserAuthorization | undefined;
}

export function registerSessionGroupTool(
  pi: ExtensionAPI,
  store: SessionGroupStore,
  controller: SessionGroupToolController,
): void {
  pi.registerTool<typeof editGroupContextSchema, EditGroupContextDetails>({
    name: EDIT_GROUP_CONTEXT_TOOL_NAME,
    label: "Edit Group Context",
    description:
      "Edit the current session group's shared context after the current user explicitly requests that shared-context update and approves the execution-time confirmation. Requires the injected revision/hash and exact unique replacements; stale writes fail instead of overwriting newer context.",
    parameters: editGroupContextSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const groupId = controller.getCurrentGroupId();
      const snapshot = controller.getCurrentContextSnapshot();
      const authorization = controller.getCurrentUserAuthorization();
      if (groupId === null || !snapshot || snapshot.id !== groupId) {
        throw new Error(
          "Shared group context is unavailable for this agent run. Wait for the next user turn after repairing it.",
        );
      }
      if (params.groupId !== groupId) {
        throw new Error("edit_group_context can modify only the current session's group.");
      }
      if (
        params.expectedRevision !== snapshot.revision ||
        params.expectedSha256 !== snapshot.sha256
      ) {
        throw new Error(
          "edit_group_context arguments do not match the context snapshot injected for this run.",
        );
      }
      if (!authorization || authorization.source === "extension") {
        throw new Error(
          "The current turn does not contain direct interactive or RPC user authorization to edit shared context.",
        );
      }
      if (
        !params.userRequestQuote.trim() ||
        !authorization.text.includes(params.userRequestQuote)
      ) {
        throw new Error(
          "userRequestQuote must be a non-empty exact substring of the current raw user message that explicitly requests the shared-context update.",
        );
      }
      if (!ctx.hasUI) {
        throw new Error(
          "Updating shared group context requires interactive user confirmation.",
        );
      }

      const proposedContent = applyExactSessionGroupContextEdits(
        snapshot.content,
        params.edits,
      );
      const { diff: proposedDiff } = generateDiffString(
        snapshot.content,
        proposedContent,
      );
      const diffPreview =
        proposedDiff.length <= 4_000
          ? proposedDiff
          : `${proposedDiff.slice(0, 4_000)}\n… diff preview truncated`;
      const approved = await ctx.ui.confirm(
        "Update shared session-group context?",
        [
          `Allow this agent to update '${snapshot.name}' for every attached session?`,
          `Revision: ${snapshot.revision}`,
          `User request: ${JSON.stringify(params.userRequestQuote)}`,
          `Exact replacements: ${params.edits.length}`,
          "",
          diffPreview,
        ].join("\n"),
      );
      if (!approved) {
        throw new Error("The user did not approve the shared-context update.");
      }

      const contextPath = store.contextPath(groupId);
      const result = await withFileMutationQueue(contextPath, () =>
        store.editContext(
          groupId,
          snapshot.revision,
          snapshot.sha256,
          params.edits,
        ),
      );
      const { diff } = generateDiffString(
        result.before.content,
        result.after.content,
      );
      const patch = generateUnifiedPatch(
        result.after.path,
        result.before.content,
        result.after.content,
      );
      const details: EditGroupContextDetails = {
        path: result.after.path,
        diff,
        patch,
        oldRevision: result.before.revision,
        newRevision: result.after.revision,
        oldSha256: result.before.sha256,
        newSha256: result.after.sha256,
      };

      return {
        content: [
          {
            type: "text",
            text: `Updated shared context for '${result.after.name}' from revision ${result.before.revision} to ${result.after.revision}.`,
          },
        ],
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit_group_context"))} ${theme.fg("muted", `revision ${args.expectedRevision}`)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Updating group context…"), 0, 0);
      const details = result.details;
      if (!details) {
        const text = result.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return new Text(text, 0, 0);
      }
      return new Text(
        `${theme.fg("success", `Updated group context to revision ${details.newRevision}`)}\n${renderDiff(details.diff, { filePath: details.path })}`,
        0,
        0,
      );
    },
  });
}

export function registerSessionGroupChangelogTool(
  pi: ExtensionAPI,
  store: SessionGroupStore,
  controller: SessionGroupToolController,
): void {
  pi.registerTool<typeof groupChangelogSchema, GroupChangelogDetails>({
    name: GROUP_CHANGELOG_TOOL_NAME,
    label: "Group Changelog",
    description:
      "Read recent entries or append completed work to the current session group's optional changelog. Use only when the current user asks about group history or asks to record completed work.",
    parameters: groupChangelogSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const groupId = controller.getCurrentGroupId();
      if (groupId === null) {
        throw new Error("This session does not belong to a group.");
      }

      if (params.action === "read") {
        if (params.entry !== undefined) {
          throw new Error("group_changelog read does not accept an entry.");
        }
        const tail = await store.readChangelogTail(groupId);
        const details: GroupChangelogDetails = {
          action: "read",
          path: tail.path,
          totalBytes: tail.totalBytes,
          returnedBytes: tail.returnedBytes,
          truncated: tail.truncated,
        };
        if (!tail.exists) {
          return {
            content: [{ type: "text", text: "No changelog exists for this group." }],
            details,
          };
        }
        const omission = tail.truncated
          ? `[Older changelog content omitted; showing the latest ${tail.returnedBytes} of ${tail.totalBytes} bytes.]\n\n`
          : "";
        return {
          content: [{ type: "text", text: `${omission}${tail.content}` }],
          details,
        };
      }

      if (params.entry === undefined || !params.entry.trim()) {
        throw new Error("group_changelog append requires a non-empty entry.");
      }
      const entry = params.entry;
      const entryBytes = Buffer.byteLength(entry.trim(), "utf8");
      if (entryBytes > SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES) {
        throw new Error(
          `group_changelog entry is ${entryBytes} bytes; the limit is ${SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES} bytes.`,
        );
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry)) {
        throw new Error("group_changelog entry contains terminal control characters.");
      }
      const authorization = controller.getCurrentUserAuthorization();
      if (!authorization || authorization.source === "extension") {
        throw new Error(
          "The current turn does not contain direct interactive or RPC user authorization to append the group changelog.",
        );
      }
      if (!ctx.hasUI) {
        throw new Error("Appending the group changelog requires interactive user confirmation.");
      }
      const sessionName = pi.getSessionName();
      const approved = await ctx.ui.confirm(
        "Append to shared group changelog?",
        [
          "Append this entry for every session attached to the current group?",
          `Session: ${sessionName ?? "Unnamed session"}`,
          "",
          entry,
        ].join("\n"),
      );
      if (!approved) {
        throw new Error("The user did not approve the changelog entry.");
      }

      const path = store.changelogPath(groupId);
      const appended = await withFileMutationQueue(path, () =>
        store.appendChangelog(groupId, entry, sessionName),
      );
      const details: GroupChangelogDetails = {
        action: "append",
        path: appended.path,
        totalBytes: appended.totalBytes,
        timestamp: appended.timestamp,
        sessionName: appended.sessionName,
      };
      return {
        content: [
          {
            type: "text",
            text: `Appended ${appended.entryBytes} bytes to the group changelog at ${appended.timestamp}.`,
          },
        ],
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("group_changelog"))} ${theme.fg("muted", args.action)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Using group changelog…"), 0, 0);
      const details = result.details;
      if (!details) {
        const text = result.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return new Text(text, 0, 0);
      }
      return new Text(
        theme.fg(
          details.action === "append" ? "success" : "accent",
          details.action === "append"
            ? `Appended group changelog (${details.totalBytes} bytes total)`
            : `Read group changelog (${details.returnedBytes ?? 0}/${details.totalBytes} bytes)`,
        ),
        0,
        0,
      );
    },
  });
}
