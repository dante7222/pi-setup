import { stripVTControlCharacters } from "node:util";

export const SESSION_GROUPS_VERSION = 1 as const;
export const SESSION_GROUPS_DIRECTORY_NAME = "session-groups";
export const SESSION_GROUP_MEMBERSHIP_ENTRY = "ventris-session-group-membership";
export const SESSION_GROUP_TOOL_STATE_ENTRY = "ventris-session-group-tool-state";
export const SESSION_GROUP_CHANGELOG_TOOL_STATE_ENTRY =
  "ventris-session-group-changelog-tool-state";
export const SESSION_GROUP_PRESENTATION_EVENT = "ventris:session-groups:presentation";
export const SESSION_GROUP_CONTEXT_MAX_BYTES = 64 * 1024;
export const SESSION_GROUP_CHANGELOG_MAX_BYTES = 256 * 1024;
export const SESSION_GROUP_CHANGELOG_TAIL_MAX_BYTES = 16 * 1024;
export const SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES = 8 * 1024;
export const SESSION_GROUP_NAME_MAX_LENGTH = 80;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

export interface SessionGroupsState {
  version: typeof SESSION_GROUPS_VERSION;
  revision: number;
  activeGroupId: string | null;
  updatedAt: string;
}

export interface SessionGroupMetadata {
  version: typeof SESSION_GROUPS_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  contextRevision: number;
  contextSha256: string;
}

export interface SessionGroupMembership {
  version: typeof SESSION_GROUPS_VERSION;
  groupId: string | null;
}

export interface SessionGroupToolState {
  version: typeof SESSION_GROUPS_VERSION;
  active: boolean;
}

export interface SessionGroupReference {
  id: string;
  name: string;
}

export interface SessionGroupSummary extends SessionGroupReference {
  contextRevision: number;
  contextBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionGroupContextSnapshot extends SessionGroupReference {
  path: string;
  content: string;
  bytes: number;
  revision: number;
  sha256: string;
}

export interface SessionGroupPresentation {
  version: typeof SESSION_GROUPS_VERSION;
  sessionId: string;
  group: SessionGroupReference | null;
}

export class SessionGroupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGroupValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function isSessionGroupId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function normalizeGroupName(input: string): string {
  const name = stripVTControlCharacters(input)
    .normalize("NFKC")
    .replace(/[\t ]+/g, " ")
    .trim();

  if (!name) throw new SessionGroupValidationError("Group name cannot be empty.");
  if (name.length > SESSION_GROUP_NAME_MAX_LENGTH) {
    throw new SessionGroupValidationError(
      `Group name cannot exceed ${SESSION_GROUP_NAME_MAX_LENGTH} characters.`,
    );
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new SessionGroupValidationError("Group name must be a single printable line.");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new SessionGroupValidationError("Group name cannot contain path separators.");
  }
  if (name === "." || name === "..") {
    throw new SessionGroupValidationError("Group name cannot be '.' or '..'.");
  }
  const controlName = name.toLocaleLowerCase("en-US");
  if (controlName === "off" || controlName === "status") {
    throw new SessionGroupValidationError(`Group name '${controlName}' is reserved.`);
  }
  if (isSessionGroupId(name.toLocaleLowerCase("en-US"))) {
    throw new SessionGroupValidationError("Group names cannot be UUIDs.");
  }
  return name;
}

export function groupNameKey(name: string): string {
  return normalizeGroupName(name).toLocaleLowerCase("en-US");
}

export function createGroupContextTemplate(name: string): string {
  return `# ${normalizeGroupName(name)}\n`;
}

export function parseSessionGroupsState(value: unknown): SessionGroupsState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "revision", "activeGroupId", "updatedAt"]) ||
    value.version !== SESSION_GROUPS_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    (value.activeGroupId !== null && !isSessionGroupId(value.activeGroupId)) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    throw new SessionGroupValidationError("Invalid session-groups state file.");
  }

  return {
    version: SESSION_GROUPS_VERSION,
    revision: value.revision as number,
    activeGroupId: value.activeGroupId,
    updatedAt: value.updatedAt,
  };
}

export function parseSessionGroupMetadata(value: unknown): SessionGroupMetadata {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "id",
      "name",
      "createdAt",
      "updatedAt",
      "contextRevision",
      "contextSha256",
    ]) ||
    value.version !== SESSION_GROUPS_VERSION ||
    !isSessionGroupId(value.id) ||
    typeof value.name !== "string" ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !Number.isSafeInteger(value.contextRevision) ||
    (value.contextRevision as number) < 0 ||
    typeof value.contextSha256 !== "string" ||
    !SHA256_PATTERN.test(value.contextSha256)
  ) {
    throw new SessionGroupValidationError("Invalid session-group metadata file.");
  }

  const name = normalizeGroupName(value.name);
  if (name !== value.name) {
    throw new SessionGroupValidationError("Session-group metadata name is not canonical.");
  }
  return {
    version: SESSION_GROUPS_VERSION,
    id: value.id,
    name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    contextRevision: value.contextRevision as number,
    contextSha256: value.contextSha256,
  };
}

export function parseSessionGroupMembership(
  value: unknown,
): SessionGroupMembership | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "groupId"]) ||
    value.version !== SESSION_GROUPS_VERSION ||
    (value.groupId !== null && !isSessionGroupId(value.groupId))
  ) {
    return undefined;
  }
  return { version: SESSION_GROUPS_VERSION, groupId: value.groupId };
}

export function parseSessionGroupToolState(
  value: unknown,
): SessionGroupToolState | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "active"]) ||
    value.version !== SESSION_GROUPS_VERSION ||
    typeof value.active !== "boolean"
  ) {
    return undefined;
  }
  return { version: SESSION_GROUPS_VERSION, active: value.active };
}

export function parseSessionGroupPresentation(
  value: unknown,
): SessionGroupPresentation | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "sessionId", "group"]) ||
    value.version !== SESSION_GROUPS_VERSION ||
    typeof value.sessionId !== "string" ||
    !value.sessionId
  ) {
    return undefined;
  }

  if (value.group === null) {
    return { version: SESSION_GROUPS_VERSION, sessionId: value.sessionId, group: null };
  }
  if (
    !isRecord(value.group) ||
    !hasExactKeys(value.group, ["id", "name"]) ||
    !isSessionGroupId(value.group.id) ||
    typeof value.group.name !== "string"
  ) {
    return undefined;
  }

  try {
    return {
      version: SESSION_GROUPS_VERSION,
      sessionId: value.sessionId,
      group: { id: value.group.id, name: normalizeGroupName(value.group.name) },
    };
  } catch {
    return undefined;
  }
}
