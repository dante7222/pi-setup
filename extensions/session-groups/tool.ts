import type { InputSource } from "@earendil-works/pi-coding-agent";
import {
  generateDiffString,
  generateUnifiedPatch,
  renderDiff,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { SessionGroupContextSnapshot } from "./contracts.ts";
import type { SessionGroupStore } from "./store.ts";

export const EDIT_GROUP_CONTEXT_TOOL_NAME = "edit_group_context";

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

export type EditGroupContextInput = Static<typeof editGroupContextSchema>;

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
  pi.registerTool({
    name: EDIT_GROUP_CONTEXT_TOOL_NAME,
    label: "Edit Group Context",
    description:
      "Edit the current session group's shared context after the current user explicitly requests that shared-context update. Requires the injected revision/hash and exact unique replacements; stale writes fail instead of overwriting newer context.",
    parameters: editGroupContextSchema,
    async execute(_toolCallId, params) {
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
