import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseSessionGroupPresentation,
  SESSION_GROUP_PRESENTATION_EVENT,
  SESSION_GROUPS_VERSION,
  SessionGroupValidationError,
  type SessionGroupPresentation,
  type SessionGroupReference,
} from "./contracts.ts";

export function publishSessionGroupPresentation(
  pi: ExtensionAPI,
  sessionId: string,
  group: SessionGroupReference | null,
): void {
  const presentation = parseSessionGroupPresentation({
    version: SESSION_GROUPS_VERSION,
    sessionId,
    group,
  });
  if (!presentation) {
    throw new SessionGroupValidationError("Invalid session-group presentation event.");
  }
  pi.events.emit(SESSION_GROUP_PRESENTATION_EVENT, presentation);
}

export function subscribeToSessionGroupPresentation(
  pi: ExtensionAPI,
  handler: (presentation: SessionGroupPresentation) => void,
): () => void {
  return pi.events.on(SESSION_GROUP_PRESENTATION_EVENT, (value) => {
    const presentation = parseSessionGroupPresentation(value);
    if (presentation) handler(presentation);
  });
}
