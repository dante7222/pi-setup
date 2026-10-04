import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { agentDirectory, assertAuthority, json, locked, type Scope } from "../core.ts";
import { ownershipLockScope } from "../ownership.ts";
import { identityAlive, processIdentity, type ProcessIdentity } from "../identity.ts";

export const MAX_FRAME_BYTES = 512 * 1024;
export const REQUEST_TIMEOUT_MS = 70_000;
export interface DurableLease {
  version: 1;
  token: string;
  identity: ProcessIdentity;
  state: "booting" | "opening" | "ready" | "closing";
  socket: string;
  parent: NonNullable<Scope["authority"]>;
  cwd: string;
  agentDir: string;
}
export interface ParentStop { requestId: string; generation: number; completed?: true }
export interface Envelope { token: string; authority: NonNullable<Scope["authority"]>; generation: number; request: unknown }

export function durableDirectory(scope: Scope): string { return join(scope.root, "durable"); }

export function requireAuthority(scope: Scope): NonNullable<Scope["authority"]> {
  if (process.env.PI_HERDR_WORKER === "1" || scope.env.PI_HERDR_WORKER === "1") throw new Error("Subagents cannot control durable workers.");
  if (!scope.authority) throw new Error("Claim the parent scope before controlling durable workers.");
  return scope.authority;
}

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error(`Durable directory must be private and owned by this user: ${directory}`);
  }
  await syncDirectory(dirname(directory));
}

/** Metadata participates in crash recovery too, especially the offline Stop intent. */
export async function durableAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}

export async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME_BYTES) throw new Error("Durable transport frame is too large.");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Exactly one length-prefixed JSON frame, followed by EOF. Never dispatch a prefix. */
export function readFrame(socket: Socket, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const header = Buffer.alloc(4);
    let headerBytes = 0;
    const chunks: Buffer[] = [];
    let finished = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeListener("data", data);
      socket.removeListener("end", end);
      socket.removeListener("error", fail);
      socket.removeListener("close", close);
      if (error) { socket.destroy(); reject(error); } else resolve(value);
    };
    const fail = (error: Error) => finish(error);
    const abort = () => finish(new Error("Durable request aborted; admitted work is not cancelled."));
    const close = () => finish(new Error("Durable transport closed before a complete frame."));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES + 4) { finish(new Error("Durable transport frame is too large.")); return; }
      if (headerBytes < 4) headerBytes += chunk.copy(header, headerBytes, 0, Math.min(chunk.length, 4 - headerBytes));
      if (headerBytes === 4 && header.readUInt32BE(0) > MAX_FRAME_BYTES) { finish(new Error("Durable transport frame is too large.")); return; }
      if (headerBytes === 4 && bytes > header.readUInt32BE(0) + 4) { finish(new Error("Invalid durable transport framing.")); return; }
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const frame = Buffer.concat(chunks, bytes);
        if (bytes < 4 || frame.readUInt32BE(0) !== bytes - 4) throw new Error("Invalid durable transport framing.");
        finish(undefined, JSON.parse(frame.subarray(4).toString("utf8")) as unknown);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    };
    const timer = setTimeout(() => finish(new Error("Durable transport timed out.")), timeoutMs);
    socket.on("data", data).once("end", end).once("error", fail).once("close", close);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function socketRequest(lease: DurableLease, authority: NonNullable<Scope["authority"]>, request: unknown, generation: number, signal?: AbortSignal): Promise<JsonValue> {
  signal?.throwIfAborted();
  const frame = encodeFrame({ token: lease.token, authority, generation, request });
  const socket = createConnection({ path: lease.socket, allowHalfOpen: true });
  // Keep a listener through teardown: a write may fail after the reader settles.
  socket.on("error", () => {});
  const response = readFrame(socket, REQUEST_TIMEOUT_MS, signal);
  socket.once("connect", () => socket.end(frame));
  try {
    const value = await response;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid durable response.");
    const reply = value as { ok?: unknown; value?: JsonValue; error?: unknown };
    if (reply.ok !== true) throw new Error(typeof reply.error === "string" ? reply.error : "Durable request failed.");
    if (reply.value === undefined) throw new Error("Missing durable response data.");
    return reply.value;
  } finally { socket.destroy(); }
}

export async function durableRequest(scope: Scope, request: unknown, signal?: AbortSignal): Promise<JsonValue> {
  const authority = requireAuthority(scope);
  // Capture before queuing for ordinary admission. A completed Stop must fence
  // these callers too, not just requests already received on the server socket.
  const generation = (await json<ParentStop>(join(durableDirectory(scope), "parent-stop.json")))?.generation ?? 0;
  const lease = await locked(scope, async () => {
    const current = await json<DurableLease>(join(durableDirectory(scope), "lease.json"));
    if (!current || current.state !== "ready" || !await identityAlive(current.identity)) throw new Error("Durable coordinator is offline; use start --experimental (then explicit resume if desired).");
    return current;
  }, signal);
  return socketRequest(lease, authority, request, generation, signal);
}

export async function startDurable(scope: Scope, experimental: boolean, signal?: AbortSignal): Promise<JsonValue> {
  signal?.throwIfAborted();
  if (experimental !== true) throw new Error("Durable workers require explicit --experimental opt-in.");
  const authority = requireAuthority(scope);
  const directory = durableDirectory(scope);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const lease = await locked(scope, async () => {
      await privateDirectory(directory);
      const path = join(directory, "lease.json");
      const current = await json<DurableLease>(path);
      if (current && await identityAlive(current.identity)) return current;
      if (current && /^\/tmp\/pi-hd-[A-Za-z0-9]+\/ipc$/.test(current.socket)) await rm(dirname(current.socket), { recursive: true, force: true });
      const identity = await processIdentity();
      if (!identity) throw new Error("Cannot establish durable launcher identity.");
      // A short absolute pathname avoids Darwin's 104-byte sockaddr_un limit,
      // even when agentDirectory lives under a long macOS home/temp path.
      const socketDirectory = await mkdtemp("/tmp/pi-hd-");
      const next: DurableLease = {
        version: 1, token: randomUUID(), identity, state: "booting", socket: join(socketDirectory, "ipc"),
        parent: authority, cwd: process.cwd(), agentDir: agentDirectory(scope.env),
      };
      await durableAtomic(path, next);
      if (signal?.aborted) {
        await rm(path, { force: true });
        await rm(socketDirectory, { recursive: true, force: true });
        signal.throwIfAborted();
      }
      const launcher = fileURLToPath(new URL("../../../skills/herdr-subagents/durable.mjs", import.meta.url));
      const child = spawn(process.execPath, [launcher, "serve", directory], {
        detached: true, stdio: "ignore", cwd: next.cwd,
        env: { ...scope.env, PI_HERDR_DURABLE_BOOT: next.token },
      });
      try {
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        const childIdentity = child.pid ? await processIdentity(child.pid) : undefined;
        if (!childIdentity) throw new Error("Durable server exited before boot admission.");
        // Publish the exact child identity while it is still blocked on this
        // lock. A child that dies before opening no longer leaves a boot lease
        // pointing at a live, long-lived launcher. Late/duplicate launches are
        // fenced by BOTH this identity and the one-shot nonce/state transition.
        const boot = { ...next, identity: childIdentity };
        await durableAtomic(path, boot);
        child.unref();
        return boot;
      } catch (error) {
        child.kill("SIGTERM");
        await rm(path, { force: true });
        await rm(socketDirectory, { recursive: true, force: true });
        throw error;
      }
    }, signal);
    if (lease.state === "ready" && lease.parent.token === authority.token) {
      try { return await socketRequest(lease, authority, { action: "status" }, 0, signal); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (await identityAlive(lease.identity) && code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      }
    }
    await delay(100, undefined, { signal });
  }
  throw new Error("Durable coordinator did not become ready; a live lease is never stolen. Retry after its owner exits.");
}

/** Explicit parent Stop: persist first, even if IPC is unavailable. Never starts a server. */
export async function stopDurable(scope: Scope): Promise<void> {
  const authority = requireAuthority(scope);
  const directory = durableDirectory(scope);
  // Separate from potentially minute-long Herdr cleanup. Ownership transfer takes
  // this same short lock before replacing owner.json, fencing stale publishers.
  const lease = await locked(ownershipLockScope(scope), async () => {
    await assertAuthority(scope);
    await privateDirectory(directory);
    const previous = await json<ParentStop>(join(directory, "parent-stop.json"));
    const generation = (previous?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("Invalid durable Stop generation; admission remains fenced.");
    // Intent and admission generation commit together; completion retains the
    // generation so deleting a pending intent cannot reauthorize old requests.
    await durableAtomic(join(directory, "parent-stop.json"), { requestId: `parent-stop:${randomUUID()}`, generation } satisfies ParentStop);
    return json<DurableLease>(join(directory, "lease.json"));
  });
  if (!lease || lease.state !== "ready" || !await identityAlive(lease.identity)) return;
  // A connection failure leaves the intent for the server's watchdog/startup.
  await socketRequest(lease, authority, { action: "parent_stop" }, 0);
}

/** Pause and release storage; unlike Stop, pending submissions are preserved. */
export async function shutdownDurable(scope: Scope, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const authority = requireAuthority(scope);
  const lease = await locked(scope, () => json<DurableLease>(join(durableDirectory(scope), "lease.json")), signal);
  if (!lease || !await identityAlive(lease.identity)) return;
  await socketRequest(lease, authority, { action: "shutdown" }, 0, signal);
}
