import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionGroupStore } from "../extensions/session-groups/store.ts";

async function withOpenRace(run, replaceAfterOpen) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-session-groups-read-race-"));
  const originalOpen = fs.open;
  try {
    const store = new SessionGroupStore({ rootDirectory: root });
    const group = await store.createGroup("read race");
    const target = store.metadataPath(group.id);
    let intercepted = false;
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (path === target && !intercepted) {
        intercepted = true;
        try {
          await replaceAfterOpen({ root, target, handle, group });
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      return handle;
    };
    syncBuiltinESMExports();
    await run({ store, group, target });
    assert.equal(intercepted, true);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("catalog reads a complete opened snapshot after atomic metadata replacement", async () => {
  await withOpenRace(async ({ store, group }) => {
    const groups = await store.listGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, group.id);
    assert.equal(groups[0].contextRevision, 0);
    assert.equal((await store.readMetadata(group.id)).contextRevision, 1);
  }, async ({ root, target, handle, group }) => {
    const replacement = join(root, "replacement.json");
    await fs.writeFile(replacement, JSON.stringify({ ...group, contextRevision: 1 }), { mode: 0o600 });
    await fs.rename(replacement, target);
    assert.equal((await handle.stat()).nlink, 0);
  });
});

test("opened-file validation still rejects a hardlink created after pathname validation", async () => {
  await withOpenRace(async ({ store }) => {
    await assert.rejects(store.listGroups(), /not a private regular file/);
  }, async ({ root, target, handle }) => {
    await fs.link(target, join(root, "linked-metadata.json"));
    assert.equal((await handle.stat()).nlink, 2);
  });
});
