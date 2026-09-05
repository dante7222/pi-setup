import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createGroupContextTemplate,
  groupNameKey,
  isSessionGroupId,
  normalizeGroupName,
  parseSessionGroupMetadata,
  parseSessionGroupsState,
  SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES,
  SESSION_GROUP_CHANGELOG_MAX_BYTES,
  SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_BYTES,
  SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_LINES,
  SESSION_GROUP_CHANGELOG_PAGE_MAX_BYTES,
  SESSION_GROUP_CHANGELOG_PAGE_MAX_LINES,
  SESSION_GROUP_CHANGELOG_QUERY_MAX_LENGTH,
  SESSION_GROUP_CHANGELOG_CURSOR_MAX_LENGTH,
  SESSION_GROUP_CHANGELOG_TAIL_MAX_BYTES,
  SESSION_GROUP_CONTEXT_MAX_BYTES,
  SESSION_GROUPS_DIRECTORY_NAME,
  SESSION_GROUPS_VERSION,
  type SessionGroupContextSnapshot,
  type SessionGroupMetadata,
  type SessionGroupReference,
  type SessionGroupsState,
  type SessionGroupSummary,
} from "./contracts.ts";
import {
  getProcessIncarnation,
  processMatchesIncarnation,
  SessionGroupLockManager,
  type SessionGroupLockHandle,
  type SessionGroupLockKind,
  type SessionGroupLockOptions,
} from "./lock.ts";

export interface SessionGroupContextEdit {
  oldText: string;
  newText: string;
}

export interface SessionGroupContextEditResult {
  before: SessionGroupContextSnapshot;
  after: SessionGroupContextSnapshot;
}

export interface SessionGroupChangelogTail {
  path: string;
  exists: boolean;
  content: string;
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
}

export interface SessionGroupChangelogPageOptions {
  maxBytes?: number;
  maxLines?: number;
  cursor?: string;
  query?: string;
  signal?: AbortSignal;
}

export interface SessionGroupChangelogPage extends SessionGroupChangelogTail {
  nextCursor?: string;
  /** Total matching records, not just those on this page. */
  matchedRecords?: number;
}

export interface SessionGroupChangelogAppendResult {
  path: string;
  timestamp: string;
  sessionName: string;
  entryBytes: number;
  totalBytes: number;
}

interface SessionGroupContextEditTransactionBase {
  version: 1;
  ownerPid: number;
  ownerIncarnation: string;
  token: string;
  groupId: string;
  createdAt: string;
}

interface EditingSessionGroupContextTransaction
  extends SessionGroupContextEditTransactionBase {
  phase: "editing";
  beforeMetadata: SessionGroupMetadata;
  beforeContentBase64: string;
}

interface CommittedSessionGroupContextTransaction
  extends SessionGroupContextEditTransactionBase {
  phase: "committed";
}

type SessionGroupContextEditTransaction =
  | EditingSessionGroupContextTransaction
  | CommittedSessionGroupContextTransaction;

interface SessionGroupStoreGlobalState {
  __ventrisActiveContextEditTransactions?: Set<string>;
}

function activeContextEditTransactions(): Set<string> {
  const globalState = globalThis as typeof globalThis & SessionGroupStoreGlobalState;
  globalState.__ventrisActiveContextEditTransactions ??= new Set<string>();
  return globalState.__ventrisActiveContextEditTransactions;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STATE_FILE_NAME = "state.json";
const GROUPS_DIRECTORY_NAME = "groups";
const LOCKS_DIRECTORY_NAME = "locks";
const METADATA_FILE_NAME = "metadata.json";
const CONTEXT_FILE_NAME = "context.md";
const CHANGELOG_FILE_NAME = "changelog.md";
const CHANGELOG_TEMPLATE = "# Changelog\n\n";
const CONTEXT_EDIT_TRANSACTION_FILE_NAME = ".context-edit-transaction.json";
const ARTIFACT_STALE_MS = 5 * 60 * 1_000;
const JSON_FILE_MAX_BYTES = 64 * 1024;
const TRANSACTION_FILE_MAX_BYTES = 128 * 1024;
const CATALOG_CONCURRENCY = 16;

// Bounded workers also drain on error: no detached reads survive a catalog lock.
async function mapCatalog<T, R>(items: readonly T[], visit: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(CATALOG_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await visit(items[index]!);
      }
    }),
  );
  for (const worker of workers) {
    if (worker.status === "rejected") throw worker.reason;
  }
  return results;
}

export class SessionGroupNotFoundError extends Error {
  readonly group: string;

  constructor(group: string) {
    super(`Session group not found: ${group}`);
    this.name = "SessionGroupNotFoundError";
    this.group = group;
  }
}

export class SessionGroupAlreadyExistsError extends Error {
  readonly groupName: string;

  constructor(groupName: string) {
    super(`A session group named '${groupName}' already exists.`);
    this.name = "SessionGroupAlreadyExistsError";
    this.groupName = groupName;
  }
}

export class SessionGroupDuplicateNameError extends Error {
  constructor(name: string, ids: readonly string[]) {
    super(`Duplicate session-group name '${name}' in catalog (${ids.join(", ")}); repair metadata before using names.`);
    this.name = "SessionGroupDuplicateNameError";
  }
}

export class SessionGroupChangelogCursorError extends Error {
  constructor() {
    super("Changelog cursor is invalid or stale. Restart without cursor (using the same query on subsequent pages).");
    this.name = "SessionGroupChangelogCursorError";
  }
}

export class SessionGroupContextTooLargeError extends Error {
  readonly path: string;
  readonly bytes: number;

  constructor(path: string, bytes: number) {
    super(
      `Session-group context is ${bytes} bytes; the limit is ${SESSION_GROUP_CONTEXT_MAX_BYTES} bytes: ${path}`,
    );
    this.name = "SessionGroupContextTooLargeError";
    this.path = path;
    this.bytes = bytes;
  }
}

export class SessionGroupContextMissingError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Session-group context file is missing: ${path}`);
    this.name = "SessionGroupContextMissingError";
    this.path = path;
  }
}

export class SessionGroupContextEncodingError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Session-group context is not valid UTF-8: ${path}`);
    this.name = "SessionGroupContextEncodingError";
    this.path = path;
  }
}

export class SessionGroupChangelogTooLargeError extends Error {
  readonly path: string;
  readonly bytes: number;

  constructor(path: string, bytes: number) {
    super(
      `Session-group changelog is ${bytes} bytes; the limit is ${SESSION_GROUP_CHANGELOG_MAX_BYTES} bytes: ${path}`,
    );
    this.name = "SessionGroupChangelogTooLargeError";
    this.path = path;
    this.bytes = bytes;
  }
}

export class SessionGroupChangelogEncodingError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Session-group changelog is not valid UTF-8: ${path}`);
    this.name = "SessionGroupChangelogEncodingError";
    this.path = path;
  }
}

export class SessionGroupChangelogEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGroupChangelogEntryError";
  }
}

export class SessionGroupContextConflictError extends Error {
  readonly path: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(
    path: string,
    expectedRevision: number,
    actualRevision: number,
    expectedSha256: string,
    actualSha256: string,
  ) {
    super(
      `Session-group context changed: expected revision ${expectedRevision} (${expectedSha256}), found revision ${actualRevision} (${actualSha256}).`,
    );
    this.name = "SessionGroupContextConflictError";
    this.path = path;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

export class SessionGroupContextTransactionActiveError extends Error {
  readonly path: string;
  readonly ownerPid: number;

  constructor(path: string, ownerPid: number) {
    super(`Session-group context edit is still active in process ${ownerPid}: ${path}`);
    this.name = "SessionGroupContextTransactionActiveError";
    this.path = path;
    this.ownerPid = ownerPid;
  }
}

export class SessionGroupContextEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGroupContextEditError";
  }
}

export class SessionGroupContextRevisionError extends Error {
  readonly path: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(path: string, expectedSha256: string, actualSha256: string) {
    super(`Session-group context changed outside coordinated storage: ${path}`);
    this.name = "SessionGroupContextRevisionError";
    this.path = path;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseContextEditTransaction(value: unknown): SessionGroupContextEditTransaction {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.ownerPid) ||
    (value.ownerPid as number) <= 0 ||
    typeof value.ownerIncarnation !== "string" ||
    typeof value.token !== "string" ||
    !isSessionGroupId(value.token) ||
    !isSessionGroupId(value.groupId) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    (value.phase !== "editing" && value.phase !== "committed")
  ) {
    throw new Error("Invalid session-group context-edit transaction.");
  }

  const base = {
    version: 1 as const,
    ownerPid: value.ownerPid as number,
    ownerIncarnation: value.ownerIncarnation,
    token: value.token,
    groupId: value.groupId,
    createdAt: value.createdAt,
  };
  if (value.phase === "committed") {
    if (!hasExactKeys(value, [
      "version",
      "ownerPid",
      "ownerIncarnation",
      "token",
      "groupId",
      "createdAt",
      "phase",
    ])) {
      throw new Error("Invalid committed session-group context-edit transaction.");
    }
    return { ...base, phase: "committed" };
  }
  if (
    !hasExactKeys(value, [
      "version",
      "ownerPid",
      "ownerIncarnation",
      "token",
      "groupId",
      "createdAt",
      "phase",
      "beforeMetadata",
      "beforeContentBase64",
    ]) ||
    typeof value.beforeContentBase64 !== "string"
  ) {
    throw new Error("Invalid editing session-group context-edit transaction.");
  }
  const beforeMetadata = parseSessionGroupMetadata(value.beforeMetadata);
  if (beforeMetadata.id !== value.groupId) {
    throw new Error("Session-group context-edit transaction ID mismatch.");
  }
  const beforeBytes = Buffer.from(value.beforeContentBase64, "base64");
  if (
    beforeBytes.byteLength > SESSION_GROUP_CONTEXT_MAX_BYTES ||
    beforeBytes.toString("base64") !== value.beforeContentBase64 ||
    sha256(beforeBytes) !== beforeMetadata.contextSha256
  ) {
    throw new Error("Invalid session-group context-edit transaction content.");
  }
  return {
    ...base,
    phase: "editing",
    beforeMetadata,
    beforeContentBase64: value.beforeContentBase64,
  };
}

export function applyExactSessionGroupContextEdits(
  content: string,
  edits: readonly SessionGroupContextEdit[],
  path = "context.md",
): string {
  if (edits.length === 0) {
    throw new SessionGroupContextEditError("At least one context edit is required.");
  }

  const matches = edits.map((edit, editIndex) => {
    if (!edit.oldText) {
      throw new SessionGroupContextEditError(
        `Context edit ${editIndex + 1} has empty oldText.`,
      );
    }
    if (edit.oldText === edit.newText) {
      throw new SessionGroupContextEditError(
        `Context edit ${editIndex + 1} does not change the context.`,
      );
    }
    const index = content.indexOf(edit.oldText);
    if (index === -1) {
      throw new SessionGroupContextEditError(
        `Context edit ${editIndex + 1} oldText was not found.`,
      );
    }
    if (content.indexOf(edit.oldText, index + 1) !== -1) {
      throw new SessionGroupContextEditError(
        `Context edit ${editIndex + 1} oldText is not unique.`,
      );
    }
    return {
      index,
      end: index + edit.oldText.length,
      newText: edit.newText,
      editIndex,
    };
  });
  matches.sort((left, right) => left.index - right.index);
  for (let index = 1; index < matches.length; index++) {
    if (matches[index]!.index < matches[index - 1]!.end) {
      throw new SessionGroupContextEditError(
        `Context edits ${matches[index - 1]!.editIndex + 1} and ${matches[index]!.editIndex + 1} overlap.`,
      );
    }
  }

  // Check the output length before allocating it. Build once, rather than
  // repeatedly copying a potentially large intermediate string per edit.
  const pieces: string[] = [];
  let offset = 0;
  let characters = 0;
  for (const match of matches) {
    const unchanged = content.slice(offset, match.index);
    pieces.push(unchanged, match.newText);
    characters += unchanged.length + match.newText.length;
    offset = match.end;
  }
  pieces.push(content.slice(offset));
  characters += content.length - offset;
  if (characters > SESSION_GROUP_CONTEXT_MAX_BYTES) {
    throw new SessionGroupContextTooLargeError(path, pieces.reduce((sum, piece) => sum + Buffer.byteLength(piece), 0));
  }
  const updated = pieces.join("");
  const bytes = Buffer.byteLength(updated, "utf8");
  if (bytes > SESSION_GROUP_CONTEXT_MAX_BYTES) {
    throw new SessionGroupContextTooLargeError(path, bytes);
  }
  if (updated === content) {
    throw new SessionGroupContextEditError(
      "The combined context edits do not change the context.",
    );
  }
  return updated;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function assertDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Session-groups path is not a real directory: ${path}`);
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error(`Session-groups path is not a private regular file: ${path}`);
  }
}

async function readPrivateFile(
  path: string,
  maxBytes: number,
  tooLargeError: (bytes: number) => Error,
): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const entry = await handle.stat();
    // An atomic writer may have replaced the pathname after open(), unlinking
    // this complete snapshot (nlink=0). Reject shared hardlinks, not that race.
    if (!entry.isFile() || entry.nlink > 1) {
      throw new Error(`Session-groups path is not a private regular file: ${path}`);
    }
    // Repair via the opened inode, never a pathname that an editor can replace.
    if ((entry.mode & 0o777) !== FILE_MODE) await handle.chmod(FILE_MODE);
    if (entry.size > maxBytes) throw tooLargeError(entry.size);
    const content = await handle.readFile();
    if (content.byteLength > maxBytes) throw tooLargeError(content.byteLength);
    return content;
  } finally {
    await handle.close();
  }
}

async function makePrivateDirectory(path: string): Promise<void> {
  const missingDirectories: string[] = [];
  let cursor = path;
  while (true) {
    try {
      await assertDirectory(cursor);
      break;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      missingDirectories.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }

  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  await assertDirectory(path);
  await chmod(path, DIRECTORY_MODE);
  for (const createdDirectory of missingDirectories) {
    await fsyncDirectory(dirname(createdDirectory));
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EISDIR")
  );
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  }

  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

function artifactOwnerPid(name: string): number | undefined {
  const temporaryMatch = /^\.[0-9a-f-]{36}\.(\d+)\.tmp$/.exec(name);
  const directoryMatch =
    /^\.(?:create|delete)-[0-9a-f-]{36}-(\d+)-[0-9a-f-]{36}$/.exec(name);
  const value = temporaryMatch?.[1] ?? directoryMatch?.[1];
  if (value === undefined) return undefined;
  const pid = Number.parseInt(value, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function shouldRecoverArtifact(path: string, name: string): Promise<boolean> {
  const entry = await lstat(path);
  const ageMs = Date.now() - entry.mtimeMs;
  const pid = artifactOwnerPid(name);
  return ageMs >= ARTIFACT_STALE_MS || pid === undefined || !processIsAlive(pid);
}

async function recoverArtifacts(directory: string, includeGroupDirectories: boolean): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  let removed = false;
  for (const entry of entries) {
    const isTemporaryFile = /^\.[0-9a-f-]{36}\.\d+\.tmp$/.test(entry.name);
    const isTransientDirectory =
      includeGroupDirectories &&
      /^\.(?:create|delete)-[0-9a-f-]{36}-\d+-[0-9a-f-]{36}$/.test(entry.name);
    if (!isTemporaryFile && !isTransientDirectory) continue;

    const path = join(directory, entry.name);
    if (!(await shouldRecoverArtifact(path, entry.name))) continue;
    await rm(path, { recursive: isTransientDirectory, force: true });
    removed = true;
  }
  if (removed) await fsyncDirectory(directory);
}

export async function atomicWritePrivateFile(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${randomUUID()}.${process.pid}.tmp`,
  );
  let handle;

  try {
    await assertDirectory(directory);
    handle = await open(temporaryPath, "wx", FILE_MODE);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, FILE_MODE);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface RawContextFile {
  path: string;
  content: string;
  contentBytes: Buffer;
  bytes: number;
  sha256: string;
}

async function readContextFile(path: string): Promise<RawContextFile> {
  try {
    await assertRegularFile(path);
  } catch (error) {
    if (isNotFound(error)) throw new SessionGroupContextMissingError(path);
    throw error;
  }
  const contentBytes = await readPrivateFile(
    path,
    SESSION_GROUP_CONTEXT_MAX_BYTES,
    (size) => new SessionGroupContextTooLargeError(path, size),
  );
  let content: string;
  try {
    // Keep BOM bytes in the editable snapshot so the approved patch describes
    // exactly what will be written, including an explicitly requested removal.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contentBytes);
  } catch {
    throw new SessionGroupContextEncodingError(path);
  }
  return {
    path,
    content,
    contentBytes,
    bytes: contentBytes.byteLength,
    sha256: sha256(contentBytes),
  };
}

interface RawChangelogFile {
  path: string;
  content: string;
  contentBytes: Buffer;
}

async function readChangelogFile(path: string): Promise<RawChangelogFile> {
  await assertRegularFile(path);
  const contentBytes = await readPrivateFile(
    path,
    SESSION_GROUP_CHANGELOG_MAX_BYTES,
    (size) => new SessionGroupChangelogTooLargeError(path, size),
  );
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contentBytes);
  } catch {
    throw new SessionGroupChangelogEncodingError(path);
  }
  return { path, content, contentBytes };
}

function normalizeChangelogSessionName(value: string | undefined): string {
  const normalized = stripVTControlCharacters(value ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Unnamed session";
  const characters = Array.from(normalized);
  return characters.length <= 120
    ? normalized
    : `${characters.slice(0, 119).join("")}…`;
}

async function readJson(
  path: string,
  maxBytes = JSON_FILE_MAX_BYTES,
): Promise<unknown> {
  await assertRegularFile(path);
  const bytes = await readPrivateFile(
    path,
    maxBytes,
    (size) => new Error(`Session-groups JSON exceeds ${maxBytes} bytes (${size}): ${path}`),
  );
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Session-groups JSON is not valid UTF-8: ${path}`);
  }
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`);
  }
}

async function rollbackContextEditTransaction(
  groupDirectory: string,
  transactionPath: string,
  transaction: EditingSessionGroupContextTransaction,
): Promise<void> {
  await atomicWritePrivateFile(
    join(groupDirectory, CONTEXT_FILE_NAME),
    Buffer.from(transaction.beforeContentBase64, "base64"),
  );
  await atomicWritePrivateFile(
    join(groupDirectory, METADATA_FILE_NAME),
    serializeJson(transaction.beforeMetadata),
  );
  await rm(transactionPath, { force: true });
  await fsyncDirectory(groupDirectory);
}

async function recoverContextEditTransaction(
  groupDirectory: string,
  groupId: string,
): Promise<void> {
  const transactionPath = join(groupDirectory, CONTEXT_EDIT_TRANSACTION_FILE_NAME);
  let transaction: SessionGroupContextEditTransaction;
  try {
    transaction = parseContextEditTransaction(
      await readJson(transactionPath, TRANSACTION_FILE_MAX_BYTES),
    );
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (transaction.groupId !== groupId) {
    throw new Error(`Session-group context-edit transaction belongs to another group: ${transactionPath}`);
  }
  if (transaction.phase === "committed") {
    await rm(transactionPath, { force: true });
    await fsyncDirectory(groupDirectory);
    return;
  }
  if (
    processMatchesIncarnation(
      transaction.ownerPid,
      transaction.ownerIncarnation,
    ) &&
    (transaction.ownerPid !== process.pid ||
      activeContextEditTransactions().has(transaction.token))
  ) {
    throw new SessionGroupContextTransactionActiveError(
      transactionPath,
      transaction.ownerPid,
    );
  }
  await rollbackContextEditTransaction(
    groupDirectory,
    transactionPath,
    transaction,
  );
}

interface ChangelogCursor {
  version: 1;
  groupId: string;
  hash: string;
  queryHash: string;
  record: number;
  offset: number;
}

function parseChangelogCursor(cursor: string): ChangelogCursor {
  try {
    if (cursor.length > SESSION_GROUP_CHANGELOG_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new SessionGroupChangelogCursorError();
    }
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new SessionGroupChangelogCursorError();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ["version", "groupId", "hash", "queryHash", "record", "offset"]) ||
      value.version !== 1 || !isSessionGroupId(value.groupId) ||
      typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash) ||
      typeof value.queryHash !== "string" || !/^[a-f0-9]{64}$/.test(value.queryHash) ||
      !Number.isSafeInteger(value.record) || (value.record as number) < 0 ||
      !Number.isSafeInteger(value.offset) || (value.offset as number) < 0
    ) throw new SessionGroupChangelogCursorError();
    return {
      version: 1, groupId: value.groupId, hash: value.hash, queryHash: value.queryHash,
      record: value.record as number, offset: value.offset as number,
    };
  } catch {
    throw new SessionGroupChangelogCursorError();
  }
}

/**
 * Timestamp headings delimit appended records, not arbitrary headings inside
 * their Markdown bodies. For entirely manual logs, use level-two headings; a
 * heading-free file is one record. Fenced headings never delimit records.
 * Preamble bytes are retained as the oldest record, so pagination loses nothing.
 */
function changelogRecords(changelog: RawChangelogFile): Buffer[] {
  const headings: number[] = [];
  const timestamps: number[] = [];
  let offset = 0;
  let fence: { character: string; length: number } | undefined;
  for (const line of changelog.content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        fence = undefined;
      }
    } else if (marker) {
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
    } else if (/^##\s+\S/.test(line)) {
      headings.push(offset);
      if (/^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z — /.test(line)) timestamps.push(offset);
    }
    offset += Buffer.byteLength(line, "utf8");
  }
  if (!offset) return [];
  const starts = timestamps.length ? timestamps : headings;
  if (starts[0] !== 0) starts.unshift(0);
  return starts.map((start, index) =>
    changelog.contentBytes.subarray(start, starts[index + 1] ?? offset),
  ).reverse();
}

// Physical lines: a terminal newline ends a line, rather than adding an empty
// one. This permits lossless one-line pages, including runs of blank lines.
function changelogLineCount(content: string): number {
  return (content.match(/\n/g)?.length ?? 0) + (content && !content.endsWith("\n") ? 1 : 0);
}

function paginateChangelog(
  records: readonly Buffer[],
  record: number,
  offset: number,
  maxBytes: number,
  maxLines: number,
): { content: string; record: number; offset: number } {
  let content = "";
  while (record < records.length) {
    const remaining = records[record]!.subarray(offset);
    const prefix = offset ? "[Record continued] " : "";
    const whole = prefix + remaining.toString("utf8");
    if (Buffer.byteLength(content) + Buffer.byteLength(whole) <= maxBytes && changelogLineCount(content + whole) <= maxLines) {
      content += whole;
      record++;
      offset = 0;
      // Don't join an unterminated manual record with an older heading.
      if (!content.endsWith("\n")) break;
      continue;
    }
    // Keep records intact when they can fit on a fresh page. Oversized records
    // get their own byte-exact fragments, always in original within-record order.
    if (content) break;
    const fragmentPrefix = offset ? "[Record continued] " : "[Record fragment] ";
    let end = Math.min(remaining.length, maxBytes - Buffer.byteLength(fragmentPrefix));
    if (end > 0) {
      while (end < remaining.length && (remaining[end]! & 0xc0) === 0x80) end--;
      let lines = 0;
      for (let index = 0; index < end; index++) {
        if (remaining[index] === 0x0a && ++lines === maxLines) {
          end = index + 1;
          break;
        }
      }
    }
    if (end <= 0) {
      throw new Error("Changelog page maxBytes is too small for a continuation marker and one UTF-8 character; increase maxBytes to at least 24.");
    }
    content = fragmentPrefix + remaining.subarray(0, end).toString("utf8");
    offset += end;
    if (offset === records[record]!.length) {
      record++;
      offset = 0;
    }
    break;
  }
  return { content, record, offset };
}

export interface SessionGroupStoreOptions {
  rootDirectory?: string;
}

export class SessionGroupStore {
  readonly rootDirectory: string;
  readonly groupsDirectory: string;
  readonly locksDirectory: string;
  readonly statePath: string;
  private readonly lockManager: SessionGroupLockManager;
  private initialization: Promise<void> | undefined;

  constructor(options: SessionGroupStoreOptions = {}) {
    this.rootDirectory = resolve(
      options.rootDirectory ?? join(getAgentDir(), SESSION_GROUPS_DIRECTORY_NAME),
    );
    this.groupsDirectory = join(this.rootDirectory, GROUPS_DIRECTORY_NAME);
    this.locksDirectory = join(this.rootDirectory, LOCKS_DIRECTORY_NAME);
    this.statePath = join(this.rootDirectory, STATE_FILE_NAME);
    this.lockManager = new SessionGroupLockManager(this.locksDirectory);
  }

  groupDirectory(groupId: string): string {
    if (!isSessionGroupId(groupId)) throw new SessionGroupNotFoundError(groupId);
    return join(this.groupsDirectory, groupId);
  }

  metadataPath(groupId: string): string {
    return join(this.groupDirectory(groupId), METADATA_FILE_NAME);
  }

  contextPath(groupId: string): string {
    return join(this.groupDirectory(groupId), CONTEXT_FILE_NAME);
  }

  changelogPath(groupId: string): string {
    return join(this.groupDirectory(groupId), CHANGELOG_FILE_NAME);
  }

  private async assertBaseHierarchy(): Promise<void> {
    await assertDirectory(this.rootDirectory);
    await assertDirectory(this.groupsDirectory);
    await assertDirectory(this.locksDirectory);
  }

  async withGroupLock<T>(
    groupId: string,
    kind: SessionGroupLockKind,
    operation: (handle: SessionGroupLockHandle) => Promise<T>,
    options?: SessionGroupLockOptions,
  ): Promise<T> {
    options?.signal?.throwIfAborted();
    await this.initialize();
    await this.assertBaseHierarchy();
    options?.signal?.throwIfAborted();
    return this.lockManager.withGroupLock(
      groupId,
      kind,
      async (handle) => {
        const groupDirectory = this.groupDirectory(groupId);
        try {
          await assertDirectory(groupDirectory);
          await chmod(groupDirectory, DIRECTORY_MODE);
          // Recovery is targeted, under this group's lock. Catalog reads never
          // need context recovery, process-incarnation checks, or editor locks.
          await recoverArtifacts(groupDirectory, false);
          await recoverContextEditTransaction(groupDirectory, groupId);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        options?.signal?.throwIfAborted();
        return operation(handle);
      },
      options,
    );
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    await makePrivateDirectory(this.rootDirectory);
    await makePrivateDirectory(this.groupsDirectory);
    await makePrivateDirectory(this.locksDirectory);
    await this.lockManager.withCatalogLock("catalog", async () => {
      await recoverArtifacts(this.rootDirectory, false);
      await recoverArtifacts(this.groupsDirectory, true);

      // The private root protects all descendants immediately. File modes and
      // interrupted context transactions are repaired lazily on target access;
      // startup must not acquire locks for unrelated groups (including Zed).

      try {
        await assertRegularFile(this.statePath);
        await chmod(this.statePath, FILE_MODE);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        const now = new Date().toISOString();
        const initialState: SessionGroupsState = {
          version: SESSION_GROUPS_VERSION,
          revision: 0,
          activeGroupId: null,
          updatedAt: now,
        };
        await atomicWritePrivateFile(this.statePath, serializeJson(initialState));
      }
    });
  }

  async readState(): Promise<SessionGroupsState> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("catalog", async () =>
      parseSessionGroupsState(await readJson(this.statePath)),
    );
  }

  private async writeState(
    previous: SessionGroupsState,
    activeGroupId: string | null,
  ): Promise<SessionGroupsState> {
    const next: SessionGroupsState = {
      version: SESSION_GROUPS_VERSION,
      revision: previous.revision + 1,
      activeGroupId,
      updatedAt: new Date().toISOString(),
    };
    await atomicWritePrivateFile(this.statePath, serializeJson(next));
    return next;
  }

  async createGroup(nameInput: string): Promise<SessionGroupMetadata> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("catalog", async () => {
    const name = normalizeGroupName(nameInput);
    const nameKey = groupNameKey(name);
    const groups = await this.readCatalogMetadata();
    if (groups.some((group) => groupNameKey(group.name) === nameKey)) {
      throw new SessionGroupAlreadyExistsError(name);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const context = createGroupContextTemplate(name);
    const contextBytes = Buffer.from(context, "utf8");
    const metadata: SessionGroupMetadata = {
      version: SESSION_GROUPS_VERSION,
      id,
      name,
      createdAt: now,
      updatedAt: now,
      contextRevision: 0,
      contextSha256: sha256(contextBytes),
    };
    const stagingDirectory = join(
      this.groupsDirectory,
      `.create-${id}-${process.pid}-${randomUUID()}`,
    );

    await mkdir(stagingDirectory, { mode: DIRECTORY_MODE });
    await assertDirectory(stagingDirectory);
    try {
      await atomicWritePrivateFile(
        join(stagingDirectory, METADATA_FILE_NAME),
        serializeJson(metadata),
      );
      await atomicWritePrivateFile(
        join(stagingDirectory, CONTEXT_FILE_NAME),
        contextBytes,
      );
      await rename(stagingDirectory, this.groupDirectory(id));
      await assertDirectory(this.groupDirectory(id));
      await chmod(this.groupDirectory(id), DIRECTORY_MODE);
      await fsyncDirectory(this.groupsDirectory);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    return metadata;
    });
  }

  private async readMetadataFile(groupId: string): Promise<SessionGroupMetadata> {
    const path = this.metadataPath(groupId);
    let value: unknown;
    try {
      const directory = this.groupDirectory(groupId);
      await assertDirectory(directory);
      await chmod(directory, DIRECTORY_MODE);
      value = await readJson(path);
    } catch (error) {
      if (isNotFound(error)) throw new SessionGroupNotFoundError(groupId);
      throw error;
    }
    let metadata: SessionGroupMetadata;
    try {
      metadata = parseSessionGroupMetadata(value);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Path: ${path}`, { cause: error });
    }
    if (metadata.id !== groupId) {
      throw new Error(`Session-group metadata ID does not match its directory: ${path}`);
    }
    return metadata;
  }

  async readMetadata(groupId: string): Promise<SessionGroupMetadata> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.withGroupLock(groupId, "context-read", async () =>
      this.readMetadataFile(groupId),
    );
  }

  async readMembershipMetadata(groupId: string): Promise<SessionGroupMetadata> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.readMetadataFile(groupId);
  }

  /** Caller holds the catalog lock. Names are always read fresh across processes. */
  private async readCatalogMetadata(): Promise<SessionGroupMetadata[]> {
    const entries = await readdir(this.groupsDirectory, { withFileTypes: true });
    const groupIds: string[] = [];
    for (const entry of entries) {
      if (!isSessionGroupId(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Session-group entry is not a real directory: ${join(this.groupsDirectory, entry.name)}`);
      }
      groupIds.push(entry.name);
    }
    const groups = await mapCatalog(groupIds, (id) => this.readMetadataFile(id));
    const names = new Map<string, string>();
    for (const group of groups) {
      const key = groupNameKey(group.name);
      const duplicate = names.get(key);
      if (duplicate) throw new SessionGroupDuplicateNameError(group.name, [duplicate, group.id]);
      names.set(key, group.id);
    }
    return groups;
  }

  async listGroups(): Promise<SessionGroupSummary[]> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("catalog", async () => {
      const metadata = await this.readCatalogMetadata();
      const groups = await mapCatalog(metadata, async (group): Promise<SessionGroupSummary> => {
        let contextBytes: number | null = null;
        let contextError: string | undefined;
        const path = this.contextPath(group.id);
        try {
          // No content read, recovery, or group lock: an editor may be active.
          const entry = await lstat(path);
          if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
            throw new Error(`Session-groups path is not a private regular file: ${path}`);
          }
          contextBytes = entry.size;
        } catch (error) {
          contextError = isNotFound(error)
            ? `Session-group context file is missing: ${path}`
            : error instanceof Error ? error.message : String(error);
        }
        return {
          id: group.id,
          name: group.name,
          contextRevision: group.contextRevision,
          contextBytes,
          ...(contextError === undefined ? {} : { contextError }),
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        };
      });
      return groups.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  async resolveGroup(nameOrId: string): Promise<SessionGroupMetadata> {
    const candidate = nameOrId.trim();
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("catalog", async () => {
      if (isSessionGroupId(candidate)) return this.readMetadataFile(candidate);
      const key = groupNameKey(candidate);
      const groups = await this.readCatalogMetadata();
      const group = groups.find((item) => groupNameKey(item.name) === key);
      if (!group) throw new SessionGroupNotFoundError(candidate);
      return group;
    });
  }

  async readContext(groupId: string): Promise<SessionGroupContextSnapshot> {
    return this.withGroupLock(groupId, "context-read", async () => {
    const metadata = await this.readMetadata(groupId);
    const context = await readContextFile(this.contextPath(groupId));
    if (context.sha256 !== metadata.contextSha256) {
      throw new SessionGroupContextRevisionError(
        context.path,
        metadata.contextSha256,
        context.sha256,
      );
    }

    return {
      id: metadata.id,
      name: metadata.name,
      path: context.path,
      content: context.content,
      bytes: context.bytes,
      revision: metadata.contextRevision,
      sha256: context.sha256,
    };
    });
  }

  async reconcileContext(groupId: string): Promise<SessionGroupContextSnapshot> {
    return this.withGroupLock(groupId, "agent-edit", async () => {
    const metadata = await this.readMetadata(groupId);
    const context = await readContextFile(this.contextPath(groupId));
    if (context.sha256 === metadata.contextSha256) {
      return {
        id: metadata.id,
        name: metadata.name,
        path: context.path,
        content: context.content,
        bytes: context.bytes,
        revision: metadata.contextRevision,
        sha256: context.sha256,
      };
    }

    const updated: SessionGroupMetadata = {
      ...metadata,
      contextRevision: metadata.contextRevision + 1,
      contextSha256: context.sha256,
      updatedAt: new Date().toISOString(),
    };
    await atomicWritePrivateFile(this.metadataPath(groupId), serializeJson(updated));
    return {
      id: updated.id,
      name: updated.name,
      path: context.path,
      content: context.content,
      bytes: context.bytes,
      revision: updated.contextRevision,
      sha256: context.sha256,
    };
    });
  }

  async editContext(
    groupId: string,
    expectedRevision: number,
    expectedSha256: string,
    edits: readonly SessionGroupContextEdit[],
    options?: SessionGroupLockOptions,
  ): Promise<SessionGroupContextEditResult> {
    options?.signal?.throwIfAborted();
    // A single replacement larger than the entire context can never fit.
    // Reject before filesystem/lock work or constructing intermediate output.
    for (const edit of edits) {
      const bytes = Buffer.byteLength(edit.newText);
      // A lone surrogate at either boundary can combine with retained context,
      // reducing the encoded size by two bytes. Keep exact-edit semantics even
      // for these unusual strings; validate the final encoding after matching.
      const boundaryReduction = (/^[\uDC00-\uDFFF]/.test(edit.newText) ? 2 : 0) +
        (/[\uD800-\uDBFF]$/.test(edit.newText) ? 2 : 0);
      if (bytes - boundaryReduction > SESSION_GROUP_CONTEXT_MAX_BYTES) {
        throw new SessionGroupContextTooLargeError(this.contextPath(groupId), bytes);
      }
    }
    return this.withGroupLock(groupId, "agent-edit", async () => {
    const before = await this.readContext(groupId);
    options?.signal?.throwIfAborted();
    if (
      before.revision !== expectedRevision ||
      before.sha256 !== expectedSha256
    ) {
      throw new SessionGroupContextConflictError(
        before.path,
        expectedRevision,
        before.revision,
        expectedSha256,
        before.sha256,
      );
    }

    const beforeRaw = await readContextFile(before.path);
    options?.signal?.throwIfAborted();
    if (beforeRaw.sha256 !== before.sha256) {
      throw new SessionGroupContextConflictError(
        before.path,
        expectedRevision,
        before.revision,
        expectedSha256,
        beforeRaw.sha256,
      );
    }
    const updatedContent = applyExactSessionGroupContextEdits(before.content, edits, before.path);
    const updatedBytes = Buffer.from(updatedContent, "utf8");
    if (updatedBytes.byteLength > SESSION_GROUP_CONTEXT_MAX_BYTES) {
      throw new SessionGroupContextTooLargeError(before.path, updatedBytes.byteLength);
    }
    const updatedSha256 = sha256(updatedBytes);
    const metadata = await this.readMetadata(groupId);
    options?.signal?.throwIfAborted();
    if (
      metadata.contextRevision !== expectedRevision ||
      metadata.contextSha256 !== expectedSha256
    ) {
      throw new SessionGroupContextConflictError(
        before.path,
        expectedRevision,
        metadata.contextRevision,
        expectedSha256,
        metadata.contextSha256,
      );
    }

    const groupDirectory = this.groupDirectory(groupId);
    const transactionPath = join(
      groupDirectory,
      CONTEXT_EDIT_TRANSACTION_FILE_NAME,
    );
    const ownerIncarnation = getProcessIncarnation(process.pid);
    if (ownerIncarnation === undefined) {
      throw new Error(
        `Could not identify the context-edit process incarnation: ${process.pid}`,
      );
    }
    const transaction: EditingSessionGroupContextTransaction = {
      version: 1,
      phase: "editing",
      ownerPid: process.pid,
      ownerIncarnation,
      token: randomUUID(),
      groupId,
      createdAt: new Date().toISOString(),
      beforeMetadata: metadata,
      beforeContentBase64: beforeRaw.contentBytes.toString("base64"),
    };
    // Last cancellation point. Once the journal starts, always finish the
    // durable commit or rollback; cancellation must never strand a transaction.
    options?.signal?.throwIfAborted();
    const activeTransactions = activeContextEditTransactions();
    activeTransactions.add(transaction.token);
    try {
      await atomicWritePrivateFile(transactionPath, serializeJson(transaction));
    } catch (error) {
      activeTransactions.delete(transaction.token);
      try {
        await rm(transactionPath, { force: true });
        await fsyncDirectory(groupDirectory);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Could not publish or clean up context-edit transaction ${transactionPath}.`,
        );
      }
      throw error;
    }

    const updatedMetadata: SessionGroupMetadata = {
      ...metadata,
      contextRevision: metadata.contextRevision + 1,
      contextSha256: updatedSha256,
      updatedAt: new Date().toISOString(),
    };
    try {
      await atomicWritePrivateFile(before.path, updatedBytes);
      await atomicWritePrivateFile(
        this.metadataPath(groupId),
        serializeJson(updatedMetadata),
      );
      const committedTransaction: CommittedSessionGroupContextTransaction = {
        version: 1,
        phase: "committed",
        ownerPid: transaction.ownerPid,
        ownerIncarnation: transaction.ownerIncarnation,
        token: transaction.token,
        groupId: transaction.groupId,
        createdAt: transaction.createdAt,
      };
      try {
        await atomicWritePrivateFile(
          transactionPath,
          serializeJson(committedTransaction),
        );
      } catch (commitError) {
        try {
          const published = parseContextEditTransaction(
            await readJson(transactionPath, TRANSACTION_FILE_MAX_BYTES),
          );
          if (published.phase !== "committed" || published.token !== transaction.token) {
            throw commitError;
          }
        } catch {
          throw commitError;
        }
      }
    } catch (error) {
      try {
        await rollbackContextEditTransaction(
          groupDirectory,
          transactionPath,
          transaction,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Session-group context edit failed and rollback is pending in ${transactionPath}.`,
        );
      } finally {
        activeTransactions.delete(transaction.token);
      }
      throw error;
    }
    activeTransactions.delete(transaction.token);
    try {
      await rm(transactionPath, { force: true });
      await fsyncDirectory(groupDirectory);
    } catch {
      // A committed marker contains no previous context and is safe to clean on
      // the next targeted group access. The data commit is already durable.
    }

    return {
      before,
      after: {
        id: updatedMetadata.id,
        name: updatedMetadata.name,
        path: before.path,
        content: updatedContent,
        bytes: updatedBytes.byteLength,
        revision: updatedMetadata.contextRevision,
        sha256: updatedSha256,
      },
    };
    }, options);
  }

  async prepareContextForManualEdit(groupId: string): Promise<string> {
    return this.withGroupLock(groupId, "zed-edit", async () => {
    const metadata = await this.readMetadata(groupId);
    const path = this.contextPath(groupId);
    try {
      await assertRegularFile(path);
      await chmod(path, FILE_MODE);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await atomicWritePrivateFile(path, createGroupContextTemplate(metadata.name));
      await this.reconcileContext(groupId);
    }
    return path;
    });
  }

  /**
   * Newest records first, preserving their internal order. Limits include inline
   * fragment/continuation markers. Cursors bind the file hash, group and literal
   * case-insensitive query; repeat that query with each cursor. An unusually
   * small byte budget may need increasing to fit a marker plus one character.
   */
  async readChangelogPage(
    groupId: string,
    options: SessionGroupChangelogPageOptions = {},
  ): Promise<SessionGroupChangelogPage> {
    options.signal?.throwIfAborted();
    const maxBytes = options.maxBytes ?? SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_BYTES;
    const maxLines = options.maxLines ?? SESSION_GROUP_CHANGELOG_PAGE_DEFAULT_LINES;
    for (const [name, value, maximum] of [
      ["maxBytes", maxBytes, SESSION_GROUP_CHANGELOG_PAGE_MAX_BYTES],
      ["maxLines", maxLines, SESSION_GROUP_CHANGELOG_PAGE_MAX_LINES],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`Changelog ${name} must be an integer between 1 and ${maximum}.`);
      }
    }
    if (options.query !== undefined && (typeof options.query !== "string" || options.query.length > SESSION_GROUP_CHANGELOG_QUERY_MAX_LENGTH)) {
      throw new Error(`Changelog query must be at most ${SESSION_GROUP_CHANGELOG_QUERY_MAX_LENGTH} characters.`);
    }
    const query = (options.query ?? "").toLowerCase();
    const queryHash = sha256(Buffer.from(query));
    const cursor = options.cursor === undefined ? undefined : parseChangelogCursor(options.cursor);
    if (cursor && (cursor.groupId !== groupId || cursor.queryHash !== queryHash)) {
      throw new SessionGroupChangelogCursorError();
    }
    return this.withGroupLock(groupId, "changelog-read", async () => {
      await this.readMetadata(groupId);
      const path = this.changelogPath(groupId);
      let changelog: RawChangelogFile;
      try {
        changelog = await readChangelogFile(path);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        options.signal?.throwIfAborted();
        if (cursor) throw new SessionGroupChangelogCursorError();
        return {
          path, exists: false, content: "", totalBytes: 0, returnedBytes: 0, truncated: false,
          ...(options.query === undefined ? {} : { matchedRecords: 0 }),
        };
      }
      options.signal?.throwIfAborted();
      const hash = sha256(changelog.contentBytes);
      if (cursor && cursor.hash !== hash) throw new SessionGroupChangelogCursorError();
      const records = changelogRecords(changelog).filter((record) =>
        !query || record.toString("utf8").toLowerCase().includes(query),
      );
      if (cursor && (
        cursor.record >= records.length || cursor.offset >= records[cursor.record]!.length ||
        (records[cursor.record]![cursor.offset]! & 0xc0) === 0x80
      )) throw new SessionGroupChangelogCursorError();
      const page = paginateChangelog(records, cursor?.record ?? 0, cursor?.offset ?? 0, maxBytes, maxLines);
      const truncated = page.record < records.length;
      const next: ChangelogCursor = {
        version: 1, groupId, hash, queryHash, record: page.record, offset: page.offset,
      };
      return {
        path, exists: true, content: page.content,
        totalBytes: changelog.contentBytes.byteLength,
        returnedBytes: Buffer.byteLength(page.content), truncated,
        ...(truncated ? { nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}),
        ...(options.query === undefined ? {} : { matchedRecords: records.length }),
      };
    }, { signal: options.signal });
  }

  async readChangelogTail(groupId: string): Promise<SessionGroupChangelogTail> {
    return this.withGroupLock(groupId, "changelog-read", async () => {
      await this.readMetadata(groupId);
      const path = this.changelogPath(groupId);
      let changelog: RawChangelogFile;
      try {
        changelog = await readChangelogFile(path);
      } catch (error) {
        if (isNotFound(error)) {
          return {
            path,
            exists: false,
            content: "",
            totalBytes: 0,
            returnedBytes: 0,
            truncated: false,
          };
        }
        throw error;
      }

      const truncated =
        changelog.contentBytes.byteLength > SESSION_GROUP_CHANGELOG_TAIL_MAX_BYTES;
      let start = truncated
        ? changelog.contentBytes.byteLength - SESSION_GROUP_CHANGELOG_TAIL_MAX_BYTES
        : 0;
      while (
        start < changelog.contentBytes.byteLength &&
        (changelog.contentBytes[start]! & 0xc0) === 0x80
      ) {
        start++;
      }
      const returned = changelog.contentBytes.subarray(start);
      return {
        path,
        exists: true,
        content: new TextDecoder("utf-8", { fatal: true }).decode(returned),
        totalBytes: changelog.contentBytes.byteLength,
        returnedBytes: returned.byteLength,
        truncated,
      };
    });
  }

  async prepareChangelogForManualEdit(groupId: string): Promise<string> {
    return this.withGroupLock(groupId, "changelog-edit", async () => {
      await this.readMetadata(groupId);
      const path = this.changelogPath(groupId);
      try {
        await assertRegularFile(path);
        await chmod(path, FILE_MODE);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await atomicWritePrivateFile(path, CHANGELOG_TEMPLATE);
      }
      return path;
    });
  }

  async validateChangelogAfterManualEdit(groupId: string): Promise<number> {
    return this.withGroupLock(groupId, "changelog-edit", async () => {
      await this.readMetadata(groupId);
      const changelog = await readChangelogFile(this.changelogPath(groupId));
      await chmod(changelog.path, FILE_MODE);
      return changelog.contentBytes.byteLength;
    });
  }

  async appendChangelog(
    groupId: string,
    entryInput: string,
    sessionNameInput: string | undefined,
    options?: SessionGroupLockOptions,
  ): Promise<SessionGroupChangelogAppendResult> {
    options?.signal?.throwIfAborted();
    const entry = entryInput.trim();
    if (!entry) {
      throw new SessionGroupChangelogEntryError(
        "A non-empty changelog entry is required.",
      );
    }
    const entryBytes = Buffer.byteLength(entry, "utf8");
    if (entryBytes > SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES) {
      throw new SessionGroupChangelogEntryError(
        `Changelog entry is ${entryBytes} bytes; the limit is ${SESSION_GROUP_CHANGELOG_ENTRY_MAX_BYTES} bytes.`,
      );
    }

    return this.withGroupLock(groupId, "changelog-append", async () => {
      await this.readMetadata(groupId);
      options?.signal?.throwIfAborted();
      const path = this.changelogPath(groupId);
      let existing = CHANGELOG_TEMPLATE;
      try {
        existing = (await readChangelogFile(path)).content;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      options?.signal?.throwIfAborted();
      const timestamp = new Date().toISOString();
      const sessionName = normalizeChangelogSessionName(sessionNameInput);
      const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
      const separator = prefix.endsWith("\n\n") ? "" : "\n";
      const record = `## ${timestamp} — ${sessionName}\n\n${entry}\n`;
      const updated = `${prefix}${separator}${record}`;
      const updatedBytes = Buffer.from(updated, "utf8");
      if (updatedBytes.byteLength > SESSION_GROUP_CHANGELOG_MAX_BYTES) {
        throw new SessionGroupChangelogTooLargeError(path, updatedBytes.byteLength);
      }
      options?.signal?.throwIfAborted();
      await atomicWritePrivateFile(path, updatedBytes);
      return {
        path,
        timestamp,
        sessionName,
        entryBytes,
        totalBytes: updatedBytes.byteLength,
      };
    }, options);
  }

  async getActiveGroup(): Promise<SessionGroupMetadata | null> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("catalog", async () => {
    const state = await this.readState();
    if (state.activeGroupId === null) return null;

    try {
      return await this.readMetadataFile(state.activeGroupId);
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof SessionGroupNotFoundError)) throw error;
      await this.writeState(state, null);
      return null;
    }
    });
  }

  async setActiveGroup(groupId: string | null): Promise<SessionGroupsState> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("catalog", async () => {
    if (groupId !== null) await this.readMetadata(groupId);
    const state = await this.readState();
    if (state.activeGroupId === groupId) return state;
    return this.writeState(state, groupId);
    });
  }

  async renameGroup(groupId: string, nameInput: string): Promise<SessionGroupMetadata> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("rename", async () => {
      const name = normalizeGroupName(nameInput);
      const nameKey = groupNameKey(name);
      const groups = await this.readCatalogMetadata();
      if (
        groups.some(
          (group) => group.id !== groupId && groupNameKey(group.name) === nameKey,
        )
      ) {
        throw new SessionGroupAlreadyExistsError(name);
      }

      return this.withGroupLock(groupId, "rename", async () => {
        const current = await this.readMetadata(groupId);
        if (current.name === name) return current;
        const updated: SessionGroupMetadata = {
          ...current,
          name,
          updatedAt: new Date().toISOString(),
        };
        await atomicWritePrivateFile(
          this.metadataPath(groupId),
          serializeJson(updated),
        );
        return updated;
      });
    });
  }

  async deleteGroup(groupId: string): Promise<SessionGroupReference> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("delete", async () =>
      this.withGroupLock(groupId, "delete", async () => {
    const metadata = await this.readMetadata(groupId);
    const state = await this.readState();
    const tombstoneDirectory = join(
      this.groupsDirectory,
      `.delete-${groupId}-${process.pid}-${randomUUID()}`,
    );

    await rename(this.groupDirectory(groupId), tombstoneDirectory);
    await fsyncDirectory(this.groupsDirectory);
    if (state.activeGroupId === groupId) await this.writeState(state, null);
    await rm(tombstoneDirectory, { recursive: true, force: true });
    await fsyncDirectory(this.groupsDirectory);
    return { id: metadata.id, name: metadata.name };
      }),
    );
  }
}
