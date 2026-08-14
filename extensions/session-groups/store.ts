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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createGroupContextTemplate,
  groupNameKey,
  isSessionGroupId,
  normalizeGroupName,
  parseSessionGroupMetadata,
  parseSessionGroupsState,
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
  SessionGroupLockBusyError,
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
const CONTEXT_EDIT_TRANSACTION_FILE_NAME = ".context-edit-transaction.json";
const ARTIFACT_STALE_MS = 5 * 60 * 1_000;
const JSON_FILE_MAX_BYTES = 64 * 1024;
const TRANSACTION_FILE_MAX_BYTES = 128 * 1024;

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

  let updated = content;
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index]!;
    updated = `${updated.slice(0, match.index)}${match.newText}${updated.slice(match.end)}`;
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
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error(`Session-groups path is not a private regular file: ${path}`);
    }
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
    content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
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
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withGroupLock(
      groupId,
      kind,
      async (handle) => {
        const groupDirectory = this.groupDirectory(groupId);
        try {
          await assertDirectory(groupDirectory);
          await recoverArtifacts(groupDirectory, false);
          await recoverContextEditTransaction(groupDirectory, groupId);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
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

      const groupEntries = await readdir(this.groupsDirectory, { withFileTypes: true });
      for (const entry of groupEntries) {
        if (!isSessionGroupId(entry.name)) continue;
        const path = join(this.groupsDirectory, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error(`Session-group entry is not a real directory: ${path}`);
        }
        try {
          await this.lockManager.withGroupLock(entry.name, "context-read", async () => {
            await chmod(path, DIRECTORY_MODE);
            await recoverArtifacts(path, false);
            await recoverContextEditTransaction(path, entry.name);
            const metadataPath = join(path, METADATA_FILE_NAME);
            const contextPath = join(path, CONTEXT_FILE_NAME);
            await assertRegularFile(metadataPath);
            await chmod(metadataPath, FILE_MODE);
            try {
              await assertRegularFile(contextPath);
              await chmod(contextPath, FILE_MODE);
            } catch (error) {
              if (!isNotFound(error)) throw error;
            }
          }, { waitMs: 0 });
        } catch (error) {
          // A long-running Zed edit in another Pi owns this group. The owning
          // operation already validated it, and the next operation here will
          // perform the deferred recovery while holding the same group lock.
          if (!(error instanceof SessionGroupLockBusyError)) throw error;
        }
      }

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
    const groups = await this.listGroups();
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
      await assertDirectory(this.groupDirectory(groupId));
      value = await readJson(path);
    } catch (error) {
      if (isNotFound(error)) throw new SessionGroupNotFoundError(groupId);
      throw error;
    }
    const metadata = parseSessionGroupMetadata(value);
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

  async listGroups(): Promise<SessionGroupSummary[]> {
    await this.initialize();
    await this.assertBaseHierarchy();
    return this.lockManager.withCatalogLock("catalog", async () => {
    const entries = await readdir(this.groupsDirectory, { withFileTypes: true });
    const groupIds = entries
      .filter((entry) => entry.isDirectory() && isSessionGroupId(entry.name))
      .map((entry) => entry.name);
    const groups = await Promise.all(
      groupIds.map(async (groupId): Promise<SessionGroupSummary> => {
        const metadata = await this.readMetadata(groupId);
        const contextPath = this.contextPath(groupId);
        await assertRegularFile(contextPath);
        const contextStats = await lstat(contextPath);
        return {
          id: metadata.id,
          name: metadata.name,
          contextRevision: metadata.contextRevision,
          contextBytes: contextStats.size,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
        };
      }),
    );
    return groups.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  async resolveGroup(nameOrId: string): Promise<SessionGroupMetadata> {
    const candidate = nameOrId.trim();
    if (isSessionGroupId(candidate)) return this.readMetadata(candidate);

    const key = groupNameKey(candidate);
    const groups = await this.listGroups();
    const group = groups.find((item) => groupNameKey(item.name) === key);
    if (!group) throw new SessionGroupNotFoundError(candidate);
    return this.readMetadata(group.id);
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
  ): Promise<SessionGroupContextEditResult> {
    return this.withGroupLock(groupId, "agent-edit", async () => {
    const before = await this.readContext(groupId);
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
    if (beforeRaw.sha256 !== before.sha256) {
      throw new SessionGroupContextConflictError(
        before.path,
        expectedRevision,
        before.revision,
        expectedSha256,
        beforeRaw.sha256,
      );
    }
    const updatedContent = applyExactSessionGroupContextEdits(before.content, edits);
    const updatedBytes = Buffer.from(updatedContent, "utf8");
    if (updatedBytes.byteLength > SESSION_GROUP_CONTEXT_MAX_BYTES) {
      throw new SessionGroupContextTooLargeError(before.path, updatedBytes.byteLength);
    }
    const updatedSha256 = sha256(updatedBytes);
    const metadata = await this.readMetadata(groupId);
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
      // the next store initialization. The data commit is already durable.
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
    });
  }

  async prepareContextForManualEdit(groupId: string): Promise<string> {
    return this.withGroupLock(groupId, "zed-edit", async () => {
    const metadata = await this.readMetadata(groupId);
    const path = this.contextPath(groupId);
    try {
      await assertRegularFile(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await atomicWritePrivateFile(path, createGroupContextTemplate(metadata.name));
      await this.reconcileContext(groupId);
    }
    return path;
    });
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
      const groups = await this.listGroups();
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
