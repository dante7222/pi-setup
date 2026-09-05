import type { InputSource } from "@earendil-works/pi-coding-agent";
import {
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
import { createSessionGroupContextDiff } from "./diff.ts";
import { escapeSessionGroupDisplay, previewSessionGroupDiff } from "./display.ts";

export const EDIT_GROUP_CONTEXT_TOOL_NAME = "edit_group_context";
export const GROUP_CHANGELOG_TOOL_NAME = "group_changelog";

const editGroupContextSchema = Type.Object({
  userRequestQuote: Type.String({
    minLength: 1,
    description: "Exact quote authorizing this shared-context update",
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
  limit: Type.Optional(Type.Integer({ minimum: 1024, maximum: 16384 })),
  cursor: Type.Optional(Type.String({ maxLength: 1024 })),
  query: Type.Optional(Type.String({ maxLength: 256 })),
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
  coarseDiff?: boolean;
}

export interface GroupChangelogDetails {
  action: "read" | "append";
  path: string;
  totalBytes: number;
  returnedBytes?: number;
  truncated?: boolean;
  timestamp?: string;
  sessionName?: string;
  nextCursor?: string;
  matchedRecords?: number;
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
      "Edit shared group context only on explicit user request and confirmation. Batch minimal unique, non-overlapping replacements against the original; one successful batch per run. Updates appear next user turn; stale writes fail.",
    parameters: editGroupContextSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const groupId = controller.getCurrentGroupId();
      const snapshot = controller.getCurrentContextSnapshot();
      const authorization = controller.getCurrentUserAuthorization();
      if (groupId === null || !snapshot || snapshot.id !== groupId) {
        throw new Error(
          "Shared group context is unavailable for this agent run. Wait for the next user turn after repairing it.",
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

      // The shared exact-edit validator checks the final byte budget before
      // allocating a large replacement or starting diff computation.
      const proposedContent = applyExactSessionGroupContextEdits(snapshot.content, params.edits, snapshot.path);
      if (Buffer.from(proposedContent, "utf8").toString("utf8") !== proposedContent) {
        throw new Error("Shared-context replacements must contain valid Unicode text.");
      }
      const preview = await createSessionGroupContextDiff(snapshot.path, snapshot.content, proposedContent, signal);
      const diffPreview = previewSessionGroupDiff(preview.diff, 4_000, 100);
      const approved = await ctx.ui.confirm(
        "Update shared session-group context?",
        [
          `Allow this agent to update '${snapshot.name}' for every attached session?`,
          `Revision: ${snapshot.revision}`,
          `User request: ${JSON.stringify(params.userRequestQuote)}`,
          `Exact replacements: ${params.edits.length}`,
          ...(preview.coarse ? ["Large change: showing a whole-file replacement diff."] : []),
          "",
          diffPreview,
        ].join("\n"),
        { signal },
      );
      signal?.throwIfAborted();
      if (!approved) {
        throw new Error("The user did not approve the shared-context update.");
      }

      const contextPath = store.contextPath(groupId);
      const result = await withFileMutationQueue(contextPath, () => {
        signal?.throwIfAborted();
        return store.editContext(groupId, snapshot.revision, snapshot.sha256, params.edits, { signal });
      });
      // The store's revision/hash check guarantees this is the approved diff.
      // Do not interrupt a committed write or recompute a quadratic diff here.
      const details: EditGroupContextDetails = {
        path: result.after.path,
        diff: preview.diff,
        patch: preview.patch,
        coarseDiff: preview.coarse,
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
      const count = Array.isArray(args.edits) ? args.edits.length : 0;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit_group_context"))} ${theme.fg("muted", `${count} replacement${count === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Updating group context…"), 0, 0);
      const details = result.details;
      if (!details) {
        const text = result.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return new Text(escapeSessionGroupDisplay(text), 0, 0);
      }
      const summary = theme.fg("success", `Updated group context to revision ${details.newRevision}`);
      if (!expanded) return new Text(summary, 0, 0);
      const visible = previewSessionGroupDiff(details.diff, 32_768, 2_000);
      // Pi's intra-line word diff is unbounded too. Keep it for small edits;
      // color large lines without another expensive similarity search.
      const lines = visible.split("\n");
      const rendered = lines.every((line) => line.length <= 500)
        ? renderDiff(visible, { filePath: details.path })
        : lines.map((line) => theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line)).join("\n");
      return new Text(`${summary}\n${rendered}`, 0, 0);
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
      "Read newest group history first (4 KiB default, limit up to 16 KiB/2000 lines); continue with cursor, optionally filter records by literal query. Append completed work only when the user asks and confirms.",
    parameters: groupChangelogSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const groupId = controller.getCurrentGroupId();
      if (groupId === null) {
        throw new Error("This session does not belong to a group.");
      }

      if (params.action === "read") {
        if (params.entry !== undefined) {
          throw new Error("group_changelog read does not accept an entry.");
        }
        const limit = params.limit ?? 4096;
        if (!Number.isInteger(limit) || limit < 1024 || limit > 16384) {
          throw new Error("group_changelog limit must be 1024–16384 bytes.");
        }
        // Reserve space for the cursor/footer so the complete model-visible
        // result, not merely the stored text, stays within the advertised cap.
        const page = await store.readChangelogPage(groupId, {
          maxBytes: limit - 768,
          maxLines: 1_988,
          cursor: params.cursor,
          query: params.query,
          signal,
        });
        const details: GroupChangelogDetails = {
          action: "read",
          path: page.path,
          totalBytes: page.totalBytes,
          returnedBytes: page.returnedBytes,
          truncated: page.truncated,
          nextCursor: page.nextCursor,
          matchedRecords: page.matchedRecords,
        };
        if (!page.exists) {
          return {
            content: [{ type: "text", text: "No changelog exists for this group." }],
            details,
          };
        }
        const continuation = page.nextCursor
          ? `Continue with group_changelog action=read cursor=${JSON.stringify(page.nextCursor)}${params.query ? " and the same query" : ""}.`
          : "End of matching history.";
        const text = `${page.content || (params.query ? "No matching changelog records." : "The group changelog is empty.")}\n\n[Newest records first; ${page.returnedBytes}/${page.totalBytes} bytes. ${continuation}]`;
        if (Buffer.byteLength(text, "utf8") > limit || text.split("\n").length > 2000) {
          throw new Error("Changelog pagination metadata exceeded the output budget; retry with a larger limit.");
        }
        return { content: [{ type: "text", text }], details };
      }
      if (params.action !== "append") throw new Error("Unknown group_changelog action.");
      if (params.limit !== undefined || params.cursor !== undefined || params.query !== undefined) {
        throw new Error("group_changelog append does not accept read options.");
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
          `Session: ${escapeSessionGroupDisplay(sessionName ?? "Unnamed session")}`,
          "",
          escapeSessionGroupDisplay(entry),
        ].join("\n"),
        { signal },
      );
      signal?.throwIfAborted();
      if (!approved) {
        throw new Error("The user did not approve the changelog entry.");
      }

      const path = store.changelogPath(groupId);
      const appended = await withFileMutationQueue(path, () => {
        signal?.throwIfAborted();
        return store.appendChangelog(groupId, entry, sessionName, { signal });
      });
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
        `${theme.fg("toolTitle", theme.bold("group_changelog"))} ${theme.fg("muted", args.action ?? "…")}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Using group changelog…"), 0, 0);
      const details = result.details;
      if (!details) {
        const text = result.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        return new Text(escapeSessionGroupDisplay(text), 0, 0);
      }
      const summary = theme.fg(
        details.action === "append" ? "success" : "accent",
        details.action === "append"
          ? `Appended group changelog (${details.totalBytes} bytes total)`
          : `Read group changelog (${details.returnedBytes ?? 0}/${details.totalBytes} bytes)${details.nextCursor ? " — more available" : ""}`,
      );
      const content = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      return new Text(expanded || details.returnedBytes === 0 ? `${summary}\n${escapeSessionGroupDisplay(content)}` : summary, 0, 0);
    },
  });
}
