import { join } from "node:path";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { atomic, completion, jobs, json, locked, save, type Scope, type ShutdownAck, type WorkerClaim } from "./core.ts";
import { bootIdentity, identityAlive } from "./identity.ts";
import { ProcessTree, type ProcessEvidence, type ProcessSnapshot } from "./process-tree.ts";

export interface ExecutionEvidence { boot: string; tree: ProcessEvidence }

/** Reap only proven orphan execution. This never resumes Pi or replays a prompt. */
export async function recoverTask(scope: Scope, id: string, signal?: AbortSignal): Promise<{ id: string; recovered: true }> {
  // Cancellation fences lock admission, never interrupts admitted process cleanup.
  return locked(scope, async () => {
    const job = (await jobs(scope)).find((job) => job.id === id);
    if (!job) throw new Error(`Unknown subagent: ${id}`);
    const directory = join(scope.root, id);
    if ((await json<ShutdownAck>(join(directory, "shutdown.json")))?.verified) return { id, recovered: true };
    const claim = await json<WorkerClaim>(join(directory, "worker.json"));
    if (!claim?.identity || await identityAlive(claim.identity)) throw new Error("Recovery requires a proven dead supervisor. Use stop for a live worker or reattach after a handoff.");
    const boot = await bootIdentity();
    if (claim.identity.boot === boot) {
      const evidence = await json<ExecutionEvidence>(join(directory, "execution.json"));
      if (!evidence || evidence.boot !== boot) throw new Error("No trustworthy execution checkpoint; cleanup is unknown. Inspect processes manually; no automatic relaunch or closure is permitted.");
      const tree = ProcessTree.restore(evidence.tree);
      const signalOwned = async (signal: NodeJS.Signals) => {
        // Pi may have captured children after the supervisor's last checkpoint.
        // Match the historical root and merge before EVERY cleanup pass, just as
        // the live worker does. Missing/mismatched evidence must never verify.
        const snapshot = await json<ProcessSnapshot>(join(directory, "processes.json"));
        if (snapshot) await tree.refresh(snapshot);
        await tree.refresh();
        await atomic(join(directory, "execution.json"), { boot, tree: await tree.evidence() });
        return tree.signal(signal);
      };
      if (await signalOwned("SIGTERM")) {
        await delay(750);
        await signalOwned("SIGKILL");
      }
      const deadline = Date.now() + 2000;
      while (await signalOwned("SIGKILL")) {
        if (Date.now() >= deadline) throw new Error("Orphan cleanup could not be verified; pane and execution slot retained.");
        await delay(100);
      }
    }
    // A different boot is also proof the old process tree cannot execute. Do not
    // replace its immutable failure/report or receipts with a synthetic success.
    await atomic(join(directory, "recovery.json"), { verified: true, recoveredAt: Date.now() });
    await atomic(join(directory, "shutdown.json"), { verified: true }, true);
    // Recovery holds admission's scope lock and proved the supervisor dead.
    // Attempt IDs are immutable; no successor can own this job's marker.
    await rm(join(directory, "active.json"), { force: true });
    job.endedAt ??= Date.now() - 5001;
    await save(scope, job);
    await completion(scope, job);
    return { id, recovered: true };
  }, signal);
}
