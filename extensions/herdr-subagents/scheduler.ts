import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomic, json, locked, type Job, type Scope, type ShutdownAck } from "./core.ts";
import { identityAlive, processIdentity, type ProcessIdentity } from "./identity.ts";

interface Settings { concurrency: number }
interface Slot { token: string; identity: ProcessIdentity }
interface Waiter extends Slot { created: number; id: string }
const owned = new Map<string, string>();

function validate(concurrency: unknown): number {
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("concurrency must be an integer in 1..16.");
  }
  return concurrency;
}

/** Scope-local settings are independent of the 16-open-job/pane cap. */
export async function settings(scope: Scope): Promise<Settings> {
  const value = await json<Settings | null>(join(scope.root, "settings.json"));
  return { concurrency: value === undefined ? 4 : validate(value?.concurrency) };
}

export async function configure(scope: Scope, concurrency: number, signal?: AbortSignal): Promise<Settings> {
  const value = { concurrency: validate(concurrency) };
  return locked(scope, async () => {
    await atomic(join(scope.root, "settings.json"), value);
    return value;
  }, signal);
}

async function removeOwned(path: string, token: string): Promise<void> {
  if ((await json<Slot>(path))?.token === token) await rm(path, { force: true });
}

/** Admit one Pi child, never retaining the scope lock while waiting for capacity. */
export async function acquireSlot(directory: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  directory = resolve(directory);
  const scope: Scope = { root: dirname(directory), pane: "", workspace: "", env: process.env };
  const identity = await processIdentity();
  if (!identity) throw new Error("Cannot establish scheduler process identity.");
  const job = await json<Job>(join(directory, "job.json"));
  if (!job) throw new Error("Scheduler job is missing.");
  const waiter: Waiter = { token: randomUUID(), identity, created: job.created, id: job.id };
  const waitingPath = join(directory, "waiting.json");
  const activePath = join(directory, "active.json");
  let registered = false;
  let admitted = false;
  try {
    while (true) {
      const ready = await locked(scope, async () => {
        signal.throwIfAborted();
        if (await json(join(directory, "cancel.json")) !== undefined) throw new Error("Cancelled while queued.");
        if (await json(join(directory, "shutdown.json")) !== undefined) throw new Error("Cannot admit a shut down job.");
        if (!registered) {
          if (await json(activePath) !== undefined) throw new Error("Job already owns an active slot.");
          if (!await atomic(waitingPath, waiter, true)) throw new Error("Job already has a scheduler waiter.");
          registered = true;
        }
        const { concurrency } = await settings(scope);
        let active = 0;
        const waiting: Waiter[] = [];
        // Count markers even if job metadata vanished. Dead supervisors can leave
        // unknown detached descendants: only verified shutdown releases capacity.
        for (const entry of await readdir(scope.root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          signal.throwIfAborted();
          const path = join(scope.root, entry.name);
          const marker = await json<Slot>(join(path, "active.json"));
          const stopped = (await json<ShutdownAck>(join(path, "shutdown.json")))?.verified === true;
          if (marker !== undefined && !stopped) active++;
          if (marker !== undefined || stopped) continue;
          const queued = await json<Waiter>(join(path, "waiting.json"));
          if (!queued || await json(join(path, "cancel.json")) !== undefined) continue;
          if (!queued.identity || !await identityAlive(queued.identity)) continue;
          waiting.push(queued);
        }
        waiting.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
        const position = waiting.findIndex((entry) => entry.token === waiter.token);
        if (active >= concurrency || position < 0 || position >= concurrency - active) return false;
        signal.throwIfAborted();
        if (!await atomic(activePath, { token: waiter.token, identity }, true)) throw new Error("Job already owns an active slot.");
        admitted = true;
        signal.throwIfAborted();
        return true;
      }, signal);
      if (ready) {
        owned.set(directory, waiter.token);
        return;
      }
      await delay(100, undefined, { signal });
    }
  } catch (error) {
    // No child can have started before acquireSlot returns. Undo an admission
    // raced by abort here, without needing the parent's possibly-held lock.
    if (admitted) await removeOwned(activePath, waiter.token);
    throw error;
  } finally {
    if (registered) await removeOwned(waitingPath, waiter.token);
  }
}

/** Caller publishes verified shutdown only after all child cleanup has finished. */
export async function releaseSlot(directory: string): Promise<void> {
  directory = resolve(directory);
  const token = owned.get(directory);
  if (!token || (await json<ShutdownAck>(join(directory, "shutdown.json")))?.verified !== true) return;
  // Do NOT take the scope lock: parent cancellation holds it while waiting for
  // this worker's acknowledgement. Job IDs/markers are never reused in place.
  await removeOwned(join(directory, "active.json"), token);
  owned.delete(directory);
}
