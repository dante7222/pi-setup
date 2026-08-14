import type { SessionGroupContextSnapshot } from "./contracts.ts";

function contextBoundary(snapshot: SessionGroupContextSnapshot): string {
  const base = `PI_SESSION_GROUP_CONTEXT_${snapshot.sha256.slice(0, 16).toUpperCase()}`;
  let boundary = base;
  let suffix = 1;
  while (snapshot.content.includes(boundary)) {
    boundary = `${base}_${suffix}`;
    suffix++;
  }
  return boundary;
}

export function appendSessionGroupContext(
  systemPrompt: string,
  snapshot: SessionGroupContextSnapshot,
): string {
  const boundary = contextBoundary(snapshot);
  return `${systemPrompt}\n\n${[
    "# Shared session-group context",
    "",
    `This session belongs to the global session group '${snapshot.name}' (${snapshot.id}).`,
    `The shared context snapshot is revision ${snapshot.revision} with SHA-256 ${snapshot.sha256}.`,
    "Use the shared context as task guidance available only to sessions attached to this group.",
    "This is contextual scoping, not an operating-system security boundary.",
    "Never modify shared context automatically. Modify it only after the current user explicitly asks to update the shared group context, only through edit_group_context, and only after the user approves its execution-time confirmation.",
    "Do not use built-in file-write tools to modify the group context file.",
    "",
    `Group ID: ${snapshot.id}`,
    `Context boundary: ${boundary}`,
    `-----BEGIN ${boundary}-----`,
    snapshot.content,
    `-----END ${boundary}-----`,
  ].join("\n")}`;
}

export function appendUnavailableSessionGroupContext(
  systemPrompt: string,
  groupName: string,
  reason: string,
  repairWithGroupEdit: boolean,
): string {
  const remedy = repairWithGroupEdit
    ? "Tell the user to run /group edit to repair or reduce context.md before relying on it."
    : "Tell the user that the session-group storage or metadata must be repaired before relying on shared context.";
  return `${systemPrompt}\n\n${[
    "# Shared session-group context unavailable",
    "",
    `This session belongs to '${groupName}', but its shared context was not injected: ${reason}`,
    "Do not infer or reconstruct the missing shared context.",
    remedy,
  ].join("\n")}`;
}
