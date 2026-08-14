import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync, lstatSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { DatabaseSync } from "node:sqlite";

const LOCK_DIRECTORY_MODE = 0o700;
const DEFAULT_WAIT_MS = 2_000;
const RETRY_MS = 40;
const DATABASE_MODE = 0o600;
const SQLITE_TIMEOUT_MS = 100;
const SQLITE_BUSY_PATTERN = /database is locked|SQLITE_BUSY/i;
const GROUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SessionGroupLockKind =
  | "catalog"
  | "context-read"
  | "agent-edit"
  | "zed-edit"
  | "rename"
  | "delete";

interface LockOwner {
  lockKey: string;
  token: string;
  processPid: number;
  processIncarnation: string;
  editorPid: number | null;
  editorIncarnation: string | null;
  kind: SessionGroupLockKind;
  createdAt: string;
}

interface LockDatabaseIdentity {
  version: 1;
  namespace: string;
  device: string;
  inode: string;
}

export interface SessionGroupLockHandle {
  readonly path: string;
  readonly kind: SessionGroupLockKind;
  setEditorPid(pid: number | null): Promise<void>;
}

export class SessionGroupLockBusyError extends Error {
  readonly path: string;
  readonly owner: LockOwner | undefined;

  constructor(path: string, owner?: LockOwner) {
    const detail = owner
      ? ` held by process ${owner.processPid}${owner.editorPid ? ` / editor ${owner.editorPid}` : ""} for ${owner.kind}`
      : "";
    super(`Session-group storage is busy${detail}: ${path}`);
    this.name = "SessionGroupLockBusyError";
    this.path = path;
    this.owner = owner;
  }
}

export class SessionGroupLockOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionGroupLockOrderError";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && SQLITE_BUSY_PATTERN.test(error.message);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

export function getProcessIncarnation(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform() === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd === -1) return undefined;
      const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      if (!startTicks) return undefined;
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return `linux:${bootId}:${startTicks}`;
    }
    if (platform() === "darwin") {
      const startedAt = execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(pid)],
        {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1_000,
        },
      ).trim();
      return startedAt ? `darwin:${startedAt}` : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function processMatchesIncarnation(
  pid: number,
  expectedIncarnation: string | null,
): boolean {
  if (!processIsAlive(pid)) return false;
  if (expectedIncarnation === null) return true;
  const actualIncarnation = getProcessIncarnation(pid);
  return actualIncarnation === undefined || actualIncarnation === expectedIncarnation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDatabaseIdentity(value: unknown): LockDatabaseIdentity {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value.version !== 1 ||
    typeof value.namespace !== "string" ||
    !GROUP_ID_PATTERN.test(value.namespace) ||
    typeof value.device !== "string" ||
    !/^\d+$/.test(value.device) ||
    typeof value.inode !== "string" ||
    !/^\d+$/.test(value.inode)
  ) {
    throw new Error("Invalid session-group lock database identity.");
  }
  return {
    version: 1,
    namespace: value.namespace,
    device: value.device,
    inode: value.inode,
  };
}

function lockOwnerFromRow(value: unknown): LockOwner | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.lock_key !== "string" ||
    typeof value.token !== "string" ||
    typeof value.process_pid !== "number" ||
    typeof value.process_incarnation !== "string" ||
    (value.editor_pid !== null && typeof value.editor_pid !== "number") ||
    (value.editor_incarnation !== null && typeof value.editor_incarnation !== "string") ||
    typeof value.kind !== "string" ||
    typeof value.created_at !== "string"
  ) {
    return undefined;
  }
  return {
    lockKey: value.lock_key,
    token: value.token,
    processPid: value.process_pid,
    processIncarnation: value.process_incarnation,
    editorPid: value.editor_pid,
    editorIncarnation: value.editor_incarnation,
    kind: value.kind as SessionGroupLockKind,
    createdAt: value.created_at,
  };
}

function databaseIdentityFromStat(path: string): LockDatabaseIdentity {
  const entry = lstatSync(path, { bigint: true });
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1n) {
    throw new Error(`Session-group lock database is not a private regular file: ${path}`);
  }
  return {
    version: 1,
    namespace: "",
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
  };
}

function sameDatabaseFile(
  expected: Pick<LockDatabaseIdentity, "device" | "inode">,
  actual: Pick<LockDatabaseIdentity, "device" | "inode">,
): boolean {
  return expected.device === actual.device && expected.inode === actual.inode;
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class LockDatabase {
  readonly path: string;
  readonly identityPath: string;
  private database: DatabaseSync | undefined;
  private identity: LockDatabaseIdentity | undefined;
  private initialization: Promise<void> | undefined;

  constructor(path: string) {
    this.path = path;
    this.identityPath = `${path}.identity.json`;
  }

  async initialize(_timeout: number): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
    this.assertBoundDatabase();
  }

  private async initializeOnce(): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: LOCK_DIRECTORY_MODE });

    try {
      await this.assertPrivateDatabaseFile();
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try {
        const handle = await open(this.path, "wx", DATABASE_MODE);
        await handle.sync();
        await handle.close();
        await fsyncDirectory(directory);
      } catch (createError) {
        if (!isNodeError(createError) || createError.code !== "EEXIST") {
          throw createError;
        }
      }
    }
    await chmod(this.path, DATABASE_MODE);

    let identity: LockDatabaseIdentity;
    try {
      identity = await this.readIdentity();
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      identity = await this.recoverBootstrapIdentity();
    }

    await this.assertPrivateDatabaseFile();
    const beforeOpen = databaseIdentityFromStat(this.path);
    if (!sameDatabaseFile(identity, beforeOpen)) {
      throw new Error(`Session-group lock database identity changed: ${this.path}`);
    }

    const database = new DatabaseSync(this.path, { timeout: SQLITE_TIMEOUT_MS });
    try {
      const metadataRows = database
        .prepare(
          "SELECT key, value FROM lock_metadata WHERE key IN ('namespace', 'bootstrap_complete')",
        )
        .all();
      const metadata = new Map<string, string>();
      for (const row of metadataRows) {
        if (isRecord(row) && typeof row.key === "string" && typeof row.value === "string") {
          metadata.set(row.key, row.value);
        }
      }
      if (metadata.get("namespace") !== identity.namespace) {
        throw new Error(`Session-group lock database namespace mismatch: ${this.path}`);
      }
      const bootstrapComplete = metadata.get("bootstrap_complete");
      if (bootstrapComplete !== "0" && bootstrapComplete !== "1") {
        throw new Error(`Session-group lock database bootstrap state is invalid: ${this.path}`);
      }
      const afterOpen = databaseIdentityFromStat(this.path);
      if (!sameDatabaseFile(identity, afterOpen)) {
        throw new Error(`Session-group lock database changed while opening: ${this.path}`);
      }
      database.exec("PRAGMA synchronous = FULL;");
      if (bootstrapComplete === "0") {
        database
          .prepare(
            "UPDATE lock_metadata SET value = '1' WHERE key = 'bootstrap_complete' AND value = '0'",
          )
          .run();
      }
      this.identity = identity;
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private async readIdentity(): Promise<LockDatabaseIdentity> {
    const handle = await open(
      this.identityPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink > 1) {
        throw new Error(
          `Session-group lock identity is not a private regular file: ${this.identityPath}`,
        );
      }
      if (entry.size > 4 * 1024) {
        throw new Error(`Session-group lock identity is too large: ${this.identityPath}`);
      }
      return parseDatabaseIdentity(
        JSON.parse((await handle.readFile()).toString("utf8")) as unknown,
      );
    } finally {
      await handle.close();
    }
  }

  private async recoverBootstrapIdentity(): Promise<LockDatabaseIdentity> {
    const deadline = Date.now() + DEFAULT_WAIT_MS;
    while (true) {
      let database: DatabaseSync | undefined;
      try {
        await this.assertPrivateDatabaseFile();
        database = new DatabaseSync(this.path, { timeout: SQLITE_TIMEOUT_MS });
        database.exec("PRAGMA synchronous = FULL;");
        database.exec("BEGIN IMMEDIATE");
        let namespace: string;
        try {
          database.exec(`
            CREATE TABLE IF NOT EXISTS lock_metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS locks (
              lock_key TEXT PRIMARY KEY,
              token TEXT NOT NULL,
              process_pid INTEGER NOT NULL,
              process_incarnation TEXT NOT NULL,
              editor_pid INTEGER,
              editor_incarnation TEXT,
              kind TEXT NOT NULL,
              created_at TEXT NOT NULL
            ) STRICT;
          `);
          database
            .prepare(
              "INSERT OR IGNORE INTO lock_metadata(key, value) VALUES ('namespace', ?)",
            )
            .run(randomUUID());
          database
            .prepare(
              "INSERT OR IGNORE INTO lock_metadata(key, value) VALUES ('bootstrap_complete', '0')",
            )
            .run();
          const rows = database
            .prepare(
              "SELECT key, value FROM lock_metadata WHERE key IN ('namespace', 'bootstrap_complete')",
            )
            .all();
          const metadata = new Map<string, string>();
          for (const row of rows) {
            if (isRecord(row) && typeof row.key === "string" && typeof row.value === "string") {
              metadata.set(row.key, row.value);
            }
          }
          const storedNamespace = metadata.get("namespace");
          if (!storedNamespace || !GROUP_ID_PATTERN.test(storedNamespace)) {
            throw new Error(`Session-group lock database namespace is invalid: ${this.path}`);
          }
          if (metadata.get("bootstrap_complete") !== "0") {
            throw new Error(
              `Session-group lock identity is missing after completed bootstrap: ${this.identityPath}`,
            );
          }
          namespace = storedNamespace;
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        database.close();
        database = undefined;

        const identity: LockDatabaseIdentity = {
          ...databaseIdentityFromStat(this.path),
          namespace,
        };
        await this.publishIdentity(identity);
        return identity;
      } catch (error) {
        database?.close();
        try {
          return await this.readIdentity();
        } catch (identityError) {
          if (!isNodeError(identityError) || identityError.code !== "ENOENT") {
            throw identityError;
          }
        }
        if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_MS));
      }
    }
  }

  private async publishIdentity(identity: LockDatabaseIdentity): Promise<void> {
    const directory = dirname(this.identityPath);
    const temporaryPath = join(
      directory,
      `.locks-identity-${randomUUID()}.${process.pid}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporaryPath, "wx", DATABASE_MODE);
      await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.identityPath);
      await chmod(this.identityPath, DATABASE_MODE);
      await fsyncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async assertPrivateDatabaseFile(): Promise<void> {
    const entry = await lstat(this.path);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      throw new Error(`Session-group lock database is not a private regular file: ${this.path}`);
    }
  }

  private assertBoundDatabase(): DatabaseSync {
    if (!this.database || !this.identity) {
      throw new Error(`Session-group lock database is not initialized: ${this.path}`);
    }
    const currentIdentity = databaseIdentityFromStat(this.path);
    if (!sameDatabaseFile(this.identity, currentIdentity)) {
      throw new Error(`Session-group lock database was replaced: ${this.path}`);
    }
    return this.database;
  }

  private finishDatabaseOperation(): void {
    this.assertBoundDatabase();
  }

  tryAcquire(owner: LockOwner): { acquired: boolean; owner: LockOwner | undefined } {
    const database = this.assertBoundDatabase();
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = lockOwnerFromRow(
          database
            .prepare(
              `SELECT lock_key, token, process_pid, process_incarnation,
                      editor_pid, editor_incarnation, kind, created_at
                 FROM locks WHERE lock_key = ?`,
            )
            .get(owner.lockKey),
        );
        const processOwnsLock =
          current !== undefined &&
          processMatchesIncarnation(current.processPid, current.processIncarnation);
        const editorOwnsLock =
          current?.editorPid !== null &&
          current?.editorPid !== undefined &&
          processMatchesIncarnation(current.editorPid, current.editorIncarnation);
        if (current && (processOwnsLock || editorOwnsLock)) {
          database.exec("COMMIT");
          return { acquired: false, owner: current };
        }
        if (current) {
          database
            .prepare("DELETE FROM locks WHERE lock_key = ? AND token = ?")
            .run(current.lockKey, current.token);
        }
        database
          .prepare(
            `INSERT INTO locks(
               lock_key, token, process_pid, process_incarnation,
               editor_pid, editor_incarnation, kind, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            owner.lockKey,
            owner.token,
            owner.processPid,
            owner.processIncarnation,
            owner.editorPid,
            owner.editorIncarnation,
            owner.kind,
            owner.createdAt,
          );
        database.exec("COMMIT");
        return { acquired: true, owner };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.finishDatabaseOperation();
    }
  }

  updateEditorPid(
    owner: LockOwner,
    editorPid: number | null,
    editorIncarnation: string | null,
  ): void {
    const database = this.assertBoundDatabase();
    try {
      const result = database
        .prepare(
          `UPDATE locks SET editor_pid = ?, editor_incarnation = ?
            WHERE lock_key = ? AND token = ?`,
        )
        .run(editorPid, editorIncarnation, owner.lockKey, owner.token);
      if (Number(result.changes) !== 1) {
        throw new Error(`Session-group lock ownership changed: ${owner.lockKey}`);
      }
    } finally {
      this.finishDatabaseOperation();
    }
  }

  release(owner: LockOwner): void {
    const database = this.assertBoundDatabase();
    try {
      const result = database
        .prepare("DELETE FROM locks WHERE lock_key = ? AND token = ?")
        .run(owner.lockKey, owner.token);
      if (Number(result.changes) !== 1) {
        throw new Error(`Session-group lock ownership changed before release: ${owner.lockKey}`);
      }
    } finally {
      this.finishDatabaseOperation();
    }
  }
}

class LockHandle implements SessionGroupLockHandle {
  readonly path: string;
  readonly kind: SessionGroupLockKind;
  readonly owner: LockOwner;
  private readonly database: LockDatabase;
  active = true;
  currentFrame: symbol;
  private pendingReentrant = 0;
  private pendingWaiters: Array<() => void> = [];

  constructor(
    path: string,
    owner: LockOwner,
    database: LockDatabase,
    rootFrame: symbol,
  ) {
    this.path = path;
    this.kind = owner.kind;
    this.owner = owner;
    this.database = database;
    this.currentFrame = rootFrame;
  }

  beginReentrant(): void {
    this.pendingReentrant++;
  }

  endReentrant(): void {
    this.pendingReentrant--;
    if (this.pendingReentrant === 0) {
      for (const resolveWaiter of this.pendingWaiters.splice(0)) resolveWaiter();
    }
  }

  async waitForReentrantOperations(): Promise<void> {
    if (this.pendingReentrant === 0) return;
    await new Promise<void>((resolveWaiter) => this.pendingWaiters.push(resolveWaiter));
  }

  async setEditorPid(pid: number | null): Promise<void> {
    if (!this.active) throw new Error(`Session-group lock is no longer active: ${this.path}`);
    let editorIncarnation: string | null = null;
    if (pid !== null) {
      const detectedIncarnation = getProcessIncarnation(pid);
      if (detectedIncarnation === undefined) {
        throw new Error(`Could not identify the Zed process incarnation: ${pid}`);
      }
      editorIncarnation = detectedIncarnation;
    }
    const deadline = Date.now() + DEFAULT_WAIT_MS;
    while (true) {
      try {
        this.database.updateEditorPid(this.owner, pid, editorIncarnation);
        this.owner.editorPid = pid;
        this.owner.editorIncarnation = editorIncarnation;
        return;
      } catch (error) {
        if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_MS));
      }
    }
  }
}

interface HeldLock {
  handle: LockHandle;
  frame: symbol;
}

export interface SessionGroupLockOptions {
  waitMs?: number;
}

export class SessionGroupLockManager {
  readonly locksDirectory: string;
  readonly databasePath: string;
  private readonly database: LockDatabase;
  private readonly heldLocks = new AsyncLocalStorage<Map<string, HeldLock>>();

  constructor(locksDirectory: string) {
    this.locksDirectory = locksDirectory;
    this.databasePath = join(locksDirectory, "locks.sqlite");
    this.database = new LockDatabase(this.databasePath);
  }

  catalogLockPath(): string {
    return "catalog";
  }

  groupLockPath(groupId: string): string {
    if (!GROUP_ID_PATTERN.test(groupId)) {
      throw new Error(`Invalid session-group ID for locking: ${groupId}`);
    }
    return `group:${groupId}`;
  }

  async withCatalogLock<T>(
    kind: SessionGroupLockKind,
    operation: (handle: SessionGroupLockHandle) => Promise<T>,
    options?: SessionGroupLockOptions,
  ): Promise<T> {
    const inherited = this.heldLocks.getStore();
    const catalogPath = this.catalogLockPath();
    const activeCatalog = inherited?.get(catalogPath)?.handle.active === true;
    const activeGroupHeld = [...(inherited?.entries() ?? [])].some(
      ([heldPath, held]) => heldPath !== catalogPath && held.handle.active,
    );
    if (!activeCatalog && activeGroupHeld) {
      throw new SessionGroupLockOrderError(
        "Cannot acquire the session-group catalog lock while holding a group lock.",
      );
    }
    return this.withLock(catalogPath, kind, operation, options);
  }

  async withGroupLock<T>(
    groupId: string,
    kind: SessionGroupLockKind,
    operation: (handle: SessionGroupLockHandle) => Promise<T>,
    options?: SessionGroupLockOptions,
  ): Promise<T> {
    const path = this.groupLockPath(groupId);
    const inherited = this.heldLocks.getStore();
    const activeTarget = inherited?.get(path)?.handle.active === true;
    const otherActiveGroupHeld = [...(inherited?.entries() ?? [])].some(
      ([heldPath, held]) =>
        heldPath !== this.catalogLockPath() && heldPath !== path && held.handle.active,
    );
    if (!activeTarget && otherActiveGroupHeld) {
      throw new SessionGroupLockOrderError(
        "Cannot acquire a second session-group lock while another group lock is held.",
      );
    }
    return this.withLock(path, kind, operation, options);
  }

  private async withLock<T>(
    path: string,
    kind: SessionGroupLockKind,
    operation: (handle: SessionGroupLockHandle) => Promise<T>,
    options?: SessionGroupLockOptions,
  ): Promise<T> {
    await mkdir(this.locksDirectory, { recursive: true, mode: LOCK_DIRECTORY_MODE });
    await this.database.initialize(options?.waitMs ?? DEFAULT_WAIT_MS);
    const inherited = this.heldLocks.getStore();
    const existing = inherited?.get(path);
    if (existing?.handle.active) {
      if (existing.frame !== existing.handle.currentFrame) {
        throw new SessionGroupLockOrderError(
          `Parallel or detached reentrant use of a session-group lock is not allowed: ${path}`,
        );
      }
      const childFrame = Symbol("session-group-lock-frame");
      existing.handle.beginReentrant();
      existing.handle.currentFrame = childFrame;
      const held = new Map(inherited);
      held.set(path, { handle: existing.handle, frame: childFrame });
      try {
        return await this.heldLocks.run(held, () => operation(existing.handle));
      } finally {
        if (existing.handle.currentFrame === childFrame) {
          existing.handle.currentFrame = existing.frame;
        }
        existing.handle.endReentrant();
      }
    }

    const rootFrame = Symbol("session-group-lock-root");
    const handle = await this.acquire(
      path,
      kind,
      rootFrame,
      options?.waitMs ?? DEFAULT_WAIT_MS,
    );
    const held = new Map(inherited);
    held.set(path, { handle, frame: rootFrame });
    try {
      return await this.heldLocks.run(held, () => operation(handle));
    } finally {
      await handle.waitForReentrantOperations();
      handle.active = false;
      await this.release(handle.owner);
    }
  }

  private async acquire(
    path: string,
    kind: SessionGroupLockKind,
    rootFrame: symbol,
    waitMs: number,
  ): Promise<LockHandle> {
    const deadline = Date.now() + Math.max(0, waitMs);
    let lastOwner: LockOwner | undefined;
    const processIncarnation = getProcessIncarnation(process.pid);
    if (processIncarnation === undefined) {
      throw new Error(`Could not identify the current process incarnation: ${process.pid}`);
    }
    while (true) {
      const owner: LockOwner = {
        lockKey: path,
        token: randomUUID(),
        processPid: process.pid,
        processIncarnation,
        editorPid: null,
        editorIncarnation: null,
        kind,
        createdAt: new Date().toISOString(),
      };
      let result: { acquired: boolean; owner: LockOwner | undefined };
      try {
        result = this.database.tryAcquire(owner);
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        result = { acquired: false, owner: lastOwner };
      }
      if (result.acquired) {
        return new LockHandle(path, owner, this.database, rootFrame);
      }
      lastOwner = result.owner;
      if (Date.now() >= deadline) throw new SessionGroupLockBusyError(path, lastOwner);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_MS));
    }
  }

  private async release(owner: LockOwner): Promise<void> {
    const deadline = Date.now() + DEFAULT_WAIT_MS;
    while (true) {
      try {
        this.database.release(owner);
        return;
      } catch (error) {
        if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, RETRY_MS));
      }
    }
  }
}
