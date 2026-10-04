import { chmod, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { JsonValue } from "@earendil-works/chord";
import { assertAuthority, json, locked, type Scope } from "../core.ts";
import { ownershipLockScope } from "../ownership.ts";
import { identityAlive, processIdentity } from "../identity.ts";
import { openCoordinator, type Coordinator } from "./engine.ts";
import { durableModels } from "./runtime.ts";
import {
  durableAtomic, encodeFrame, privateDirectory, readFrame, REQUEST_TIMEOUT_MS,
  type DurableLease, type Envelope, type ParentStop,
} from "./transport.ts";

/** Internal entry point. Only a nonce published by startDurable can admit a server. */
export async function runDurableServer(input: string): Promise<void> {
  process.umask(0o077);
  const token = process.env.PI_HERDR_DURABLE_BOOT;
  if (!token || process.env.PI_HERDR_WORKER === "1") throw new Error("Durable serve requires an admitted parent launch.");
  const directory = resolve(input);
  await privateDirectory(directory);
  const root = dirname(directory);
  const base: Scope = { root, pane: "", workspace: "", env: process.env };
  const path = join(directory, "lease.json");
  const lease = await locked(base, async () => {
    const current = await json<DurableLease>(path);
    if (!current || current.token !== token || current.state !== "booting") throw new Error("Durable startup lease was fenced.");
    const identity = await processIdentity();
    if (!identity || JSON.stringify(identity) !== JSON.stringify(current.identity)) throw new Error("Durable boot process identity was fenced.");
    if (!await identityAlive(current.parent.identity)) throw new Error("Durable parent is no longer alive.");
    const owner = await json<Scope["authority"]>(join(root, "owner.json"));
    if (JSON.stringify(owner?.identity) !== JSON.stringify(current.parent.identity) || owner?.token !== current.parent.token) throw new Error("Durable parent ownership changed.");
    // The one-shot booting -> opening transition also fences duplicate internal
    // launches carrying the same nonce, even before a socket has been bound.
    const next: DurableLease = { ...current, identity, state: "opening" };
    await durableAtomic(path, next);
    return next;
  });
  const scope: Scope = { ...base, authority: lease.parent };
  let coordinator: Coordinator | undefined;
  let opening: Promise<Coordinator> | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true });
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      // Never remove a lease before storage is closed. If shutdown hangs, exit
      // with pending work intact and let boot/start identity fencing recover it.
      const deadline = setTimeout(() => process.exit(1), 15_000);
      try {
        server.close();
        const opened = coordinator ?? await opening;
        await opened?.close();
      } finally { clearTimeout(deadline); resolveStopped(); }
    })();
    return closePromise;
  };
  const finishStop = async (): Promise<boolean> => {
    const intent = await json<ParentStop>(join(directory, "parent-stop.json"));
    if (!intent || intent.completed) return true;
    if (!coordinator) throw new Error("Coordinator is not open.");
    await coordinator.dispatch({ action: "cancel", id: "all", requestId: intent.requestId });
    // A cancel acknowledgement can mean only "marked for cancellation". Never
    // complete the crash-safe intent or permit model work until the engine confirms
    // every job is terminal. In particular, do NOT resume a paused scheduler to
    // make abort cleanup progress: that could also revive unrelated model work.
    const status = await coordinator.dispatch({ action: "status" });
    if (!status || typeof status !== "object" || Array.isArray(status) || status.liveJobs !== 0) return false;
    const graph = status.taskGraph;
    if (!graph || typeof graph !== "object" || Array.isArray(graph) || graph.total !== 0) return false;
    return locked(ownershipLockScope(scope), async () => {
      await assertAuthority(scope);
      // Stop publication is intentionally independent of the ordinary scope lock.
      // Do not complete a newer Stop which arrived while cancellation drained.
      // Retain its generation forever: earlier queued requests stay fenced even
      // after this intent completes and after coordinator restarts.
      if ((await json<ParentStop>(join(directory, "parent-stop.json")))?.requestId !== intent.requestId) return false;
      await durableAtomic(join(directory, "parent-stop.json"), { ...intent, completed: true });
      return true;
    });
  };
  const dispatch = async (input: unknown): Promise<JsonValue> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid durable envelope.");
    const envelope = input as Partial<Envelope>;
    if (envelope.token !== token || !envelope.authority ||
      envelope.authority.token !== lease.parent.token ||
      JSON.stringify(envelope.authority.identity) !== JSON.stringify(lease.parent.identity)) throw new Error("Durable client ownership is fenced.");
    const request = envelope.request;
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Expected a durable action object.");
    const action = (request as { action?: unknown }).action;
    if (action === "parent_stop") {
      await locked(ownershipLockScope(scope), async () => {
        await assertAuthority(scope);
        if (closing || !coordinator) throw new Error("Durable coordinator is closing.");
      });
      // No long cleanup under the ownership lock. This process still exclusively
      // owns storage; a successor cannot submit work until this owner exits.
      return { cancelled: await finishStop() };
    }
    const result = await locked({ ...scope, authority: envelope.authority }, async () => {
      if (closing || !coordinator) throw new Error("Durable coordinator is closing.");
      const current = await json<DurableLease>(path);
      if (current?.token !== token || current.identity.pid !== process.pid) throw new Error("Durable server lease was fenced.");
      const cancellationComplete = await finishStop();
      if (!cancellationComplete && (action === "resume" || action === "spawn" || action === "send")) {
        throw new Error("Parent Stop cancellation is still pending; resume and new work are fenced until engine cancellation completes.");
      }
      if (action === "spawn" || action === "send" || action === "resume") {
        const admission = await locked(ownershipLockScope(scope), async () => {
          await assertAuthority(scope);
          const stop = await json<ParentStop>(join(directory, "parent-stop.json"));
          if (!Number.isSafeInteger(envelope.generation) || envelope.generation !== (stop?.generation ?? 0) || (stop && !stop.completed)) {
            throw new Error("Durable admission was fenced by Parent Stop; explicitly request new work after cancellation completes.");
          }
          // Enqueue synchronously under the SAME short lock as Stop publication.
          // Do not await engine I/O here: an admitted action precedes cancellation
          // in the engine's serial queue; a later action must see the new generation.
          const pending = coordinator!.dispatch(request);
          void pending.catch(() => {}); // Observe early validation failure while the lock releases.
          return { pending };
        });
        return { value: await admission.pending };
      }
      if (action === "shutdown") { closing = true; return { value: { paused: true } as JsonValue }; }
      // Long polling does not monopolize admission or delay parent Stop.
      if (action === "wait") {
        const pending = coordinator.dispatch(request);
        void pending.catch(() => {}); // Validation can reject before lock-file cleanup finishes.
        return { pending };
      }
      return { value: await coordinator.dispatch(request) };
    });
    if (action === "shutdown") await close();
    return "pending" in result ? await result.pending! : result.value!;
  };
  const signalClose = () => { void close().catch(() => { process.exitCode = 1; }); };
  process.on("SIGTERM", signalClose);
  process.on("SIGINT", signalClose);
  let checking = false;
  // Monitor ownership during initialization as well as after socket admission.
  const watchdog = setInterval(() => {
    if (checking || closing) return;
    checking = true;
    void locked(ownershipLockScope(scope), () => assertAuthority(scope))
      .then(() => coordinator && !closing ? finishStop() : true)
      .catch(signalClose).finally(() => { checking = false; });
  }, 1000);
  try {
    // The lease is now owned by this process. No client/viewer opens JSONL.
    opening = (async () => openCoordinator(directory, await durableModels(lease.agentDir), lease.cwd))();
    coordinator = await opening;
    if (closing) { await close(); return; }
    const recoveredStop = await locked(scope, async () => {
      const pending = await json<ParentStop>(join(directory, "parent-stop.json"));
      return await finishStop() && pending !== undefined && !pending.completed;
    });
    if (recoveredStop) {
      // Cancellation may have started the engine's abort scheduler. There is no
      // pause API, so close this owner before publishing readiness. startDurable
      // observes its dead identity and reopens cleanly, now with no Stop intent,
      // ensuring every successful restart is paused rather than implicitly live.
      await close();
      return;
    }
    server.on("connection", (socket) => {
      socket.on("error", () => {});
      if (closing || sockets.size >= 32) { socket.destroy(); return; }
      sockets.add(socket);
      const timeout = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
      socket.once("close", () => { clearTimeout(timeout); sockets.delete(socket); });
      void (async () => {
        try {
          const value = await dispatch(await readFrame(socket, 5000));
          socket.end(encodeFrame({ ok: true, value }));
        } catch (error) {
          if (!socket.destroyed) socket.end(encodeFrame({ ok: false, error: String(error).slice(0, 2000) }));
        }
      })();
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(lease.socket, resolve); });
    server.on("error", signalClose);
    await chmod(lease.socket, 0o600);
    await locked(scope, async () => {
      if (closing) throw new Error("Durable coordinator closed during startup.");
      await durableAtomic(path, { ...lease, state: "ready" });
    });
    await stopped;
  } finally {
    clearInterval(watchdog);
    try { await close(); }
    finally {
      // Give the shutdown response a chance to flush before destroying idle peers.
      await delay(50);
      for (const socket of sockets) socket.destroy();
      process.off("SIGTERM", signalClose);
      process.off("SIGINT", signalClose);
      await rm(dirname(lease.socket), { recursive: true, force: true });
    }
    // Keep the identity-fenced lease until process exit; never advertise storage
    // as free while library cleanup could still be executing in this process.
  }
}
