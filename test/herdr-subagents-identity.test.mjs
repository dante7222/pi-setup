import assert from "node:assert/strict";
import test from "node:test";
import { bootIdentity, identityAlive, processIdentity } from "../extensions/herdr-subagents/identity.ts";

test("process identities include boot and start, not just PID liveness", async () => {
  const identity = await processIdentity();
  assert.equal(identity.pid, process.pid);
  assert.equal(identity.boot, await bootIdentity());
  assert.ok(identity.start);
  assert.equal(await identityAlive(identity), true);
  assert.equal(await identityAlive({ ...identity, start: "reused PID" }), false);
  assert.equal(await identityAlive({ ...identity, boot: "previous boot" }), false);
  assert.equal(await processIdentity(2147483647), undefined);
});
