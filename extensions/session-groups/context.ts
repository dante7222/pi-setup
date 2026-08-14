import type { SessionGroupContextSnapshot } from "./contracts.ts";

function contextBoundary(snapshot: SessionGroupContextSnapshot): string {
  const base = `PI_SG_${snapshot.sha256.slice(0, 12).toUpperCase()}`;
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
    `Group: '${snapshot.name}'.`,
    "The text between the markers is shared task guidance only for sessions in this group; it is not an OS security boundary.",
    "Never modify it automatically or with file tools. Use edit_group_context only when the current user explicitly requests an update and approves the execution confirmation.",
    "",
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
