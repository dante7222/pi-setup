import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, json, locked, type Scope } from "./core.ts";
import { identityAlive, processIdentity, type ProcessIdentity } from "./identity.ts";

interface Owner { identity: ProcessIdentity; token: string; pane: string; workspace: string }

/** Shared only by ownership transfer and emergency Stop publication, never I/O cleanup. */
export function ownershipLockScope(scope: Scope): Scope {
  return { ...scope, root: join(scope.root, "ownership-lock"), authority: undefined };
}

/** A session survives pane/server changes, but two live parents cannot control it. */
export async function claimScope(scope: Scope, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const identity = await processIdentity(scope.ownerPid ?? process.pid);
  if (!identity) throw new Error("Parent process identity is unavailable; reload Pi before controlling workers.");
  const path = join(scope.root, "owner.json");
  const existing = await json<Owner>(path);
  signal?.throwIfAborted();
  if (existing?.token && JSON.stringify(existing.identity) === JSON.stringify(identity)) {
    // This live parent already owns it. No mutation/transfer, and no waiting
    // behind a long pane cleanup just to obtain an emergency Stop capability.
    scope.authority = { token: existing.token, identity };
    return;
  }
  scope.authority = await locked({ ...scope, authority: undefined }, async () => locked(ownershipLockScope(scope), async () => {
    const current = await processIdentity(scope.ownerPid ?? process.pid);
    if (!current || JSON.stringify(current) !== JSON.stringify(identity)) throw new Error("Parent process identity changed during admission.");
    const owner = await json<Owner>(path);
    if (owner && JSON.stringify(owner.identity) !== JSON.stringify(identity) && await identityAlive(owner.identity)) {
      throw new Error("Another live Pi process owns this session's subagents. Fork the session or stop its other parent first.");
    }
    const token = owner && JSON.stringify(owner.identity) === JSON.stringify(identity) ? owner.token || randomUUID() : randomUUID();
    await atomic(path, { identity, token, pane: scope.pane, workspace: scope.workspace });
    return { token, identity };
  }, signal), signal);
}
