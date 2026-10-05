import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomic, jobs, json, locked, spawnTasks, type Job, type Scope, type WorkerClaim } from "./core.ts";
import { identityAlive } from "./identity.ts";

export interface ControlReply { state: "accepted" | "rejected" | "uncertain"; error?: string; disposition?: string }

export async function continueTask(scope: Scope, id: string, prompt: string, requestId: string, signal?: AbortSignal): Promise<Job[]> {
  if (!prompt.trim() || prompt.length > 100_000) throw new Error("A new nonempty prompt (up to 100000 characters) is required.");
  const previous = (await jobs(scope)).find((job) => job.id === id);
  if (!previous?.task.persistent) throw new Error("Continuation requires a persistent job ID.");
  // spawnTasks serializes latest-attempt admission and idempotent request replay.
  return spawnTasks(scope, [{ ...previous.task, prompt }], requestId, signal, id);
}

export async function sendTask(scope: Scope, id: string, message: string, kind: "steer" | "follow_up", requestId: string, signal?: AbortSignal): Promise<ControlReply> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) throw new Error("Invalid control requestId.");
  if (!message.trim() || message.length > 100_000) throw new Error("A nonempty message (up to 100000 characters) is required.");
  const key = createHash("sha256").update(requestId).digest("hex");
  const directory = join(scope.root, id, "control");
  const command = { id: requestId, kind, message };
  await locked(scope, async () => {
    const job = (await jobs(scope)).find((job) => job.id === id);
    if (!job?.task.persistent) throw new Error("Messaging requires a persistent job ID.");
    const path = join(directory, `${key}.json`);
    const existing = await json<typeof command>(path);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(command)) throw new Error("Control requestId already belongs to a different message.");
      return;
    }
    const closed = await json<{ error?: string }>(join(directory, "closed.json"));
    if (closed) {
      await atomic(path, command, true);
      await atomic(join(directory, `${key}.reply.json`), { state: "rejected", error: closed.error || "RPC mailbox is closed." }, true);
      return;
    }
    if (job.closed || await json(join(scope.root, id, "done.json"))) throw new Error("Attempt has settled; use continue with a new prompt instead.");
    const claim = await json<WorkerClaim>(join(scope.root, id, "worker.json"));
    if (!claim?.identity || !await identityAlive(claim.identity)) throw new Error("Worker supervisor is not live; inspect status before messaging.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomic(path, command, true);
  }, signal);
  // Aborting this wait cannot retract a command already delivered. Retrying the
  // SAME requestId reads its receipt; an uncertain command must never be resent.
  const deadline = Date.now() + 5000;
  do {
    signal?.throwIfAborted();
    const reply = await json<ControlReply>(join(directory, `${key}.reply.json`));
    if (reply) return reply;
    const closed = await json<{ error?: string }>(join(directory, "closed.json"));
    if (closed && !await json(join(directory, `${key}.attempted.json`))) {
      // Publication raced the worker's last scan/exit. With closed admission and
      // no attempted marker this message definitely was not sent, not uncertain.
      const rejected: ControlReply = { state: "rejected", error: closed.error || "RPC mailbox is closed." };
      await atomic(join(directory, `${key}.reply.json`), rejected, true);
      return await json<ControlReply>(join(directory, `${key}.reply.json`)) ?? rejected;
    }
    await delay(100, undefined, { signal });
  } while (Date.now() < deadline);
  return { state: "uncertain", error: "No RPC acknowledgement yet. Retry this requestId to inspect delivery; do not resend with a new ID." };
}

/** Stop execution without discarding its report or closing its inspection pane. */
export async function stopTask(scope: Scope, id: string, signal?: AbortSignal): Promise<{ stopped: string; settled: boolean }> {
  return locked(scope, async () => {
    const job = (await jobs(scope)).find((job) => job.id === id);
    if (!job) throw new Error(`Unknown subagent: ${id}`);
    const settled = !!await json(join(scope.root, id, "done.json"));
    if (!settled) await atomic(join(scope.root, id, "cancel.json"), {});
    return { stopped: id, settled };
  }, signal);
}
