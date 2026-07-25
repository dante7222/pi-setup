import assert from "node:assert/strict";
import test from "node:test";
import {
  observeSupacodeSurface,
  observeSupacodeTab,
  observeSupacodeWorktree,
} from "../extensions/supacode-subagents/resource-state.ts";

const WORKTREE_ID = encodeURIComponent("/worktree");
const TAB_ID = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
const SURFACE_ID = "cccccccc-1111-4222-8333-dddddddddddd";
const WORKTREE_LIST = ["worktree", "list"];
const TAB_LIST = ["tab", "list", "-w", WORKTREE_ID];
const SURFACE_LIST = ["surface", "list", "-w", WORKTREE_ID, "-t", TAB_ID];

function result(stdout = "", code = 0, stderr = "") {
  return { stdout, stderr, code, killed: false };
}

function recordingPi(handler) {
  const calls = [];
  return {
    calls,
    pi: {
      exec: async (command, args) => {
        assert.equal(command, "supacode");
        calls.push(args);
        return handler(args);
      },
    },
  };
}

test("worktree observation distinguishes present, absent, and unavailable state", async () => {
  for (const [output, code, expected] of [
    [`${WORKTREE_ID}\n`, 0, "present"],
    [`${encodeURIComponent("/other")}\n`, 0, "absent"],
    ["", 1, "unknown"],
  ]) {
    const fixture = recordingPi((args) => {
      assert.deepEqual(args, WORKTREE_LIST);
      return result(output, code, code === 0 ? "" : "server unavailable");
    });
    assert.equal(await observeSupacodeWorktree(fixture.pi, WORKTREE_ID), expected);
    assert.deepEqual(fixture.calls, [WORKTREE_LIST]);
  }
});

test("tab observation distinguishes present, absent, and unavailable state", async () => {
  for (const [output, code, expected, expectedCalls] of [
    [`${TAB_ID.toUpperCase()}\n`, 0, "present", [TAB_LIST]],
    ["eeeeeeee-1111-4222-8333-ffffffffffff\n", 0, "absent", [TAB_LIST]],
    ["", 1, "unknown", [TAB_LIST, WORKTREE_LIST]],
  ]) {
    const fixture = recordingPi((args) => {
      if (args[0] === "tab") {
        assert.deepEqual(args, TAB_LIST);
        return result(output, code, code === 0 ? "" : "server unavailable");
      }
      assert.deepEqual(args, WORKTREE_LIST);
      return result("", 1, "server unavailable");
    });
    assert.equal(await observeSupacodeTab(fixture.pi, WORKTREE_ID, TAB_ID), expected);
    assert.deepEqual(fixture.calls, expectedCalls);
  }
});

test("surface observation uses only a non-destructive surface listing when it succeeds", async () => {
  const fixture = recordingPi((args) => {
    assert.deepEqual(args, SURFACE_LIST);
    return result("");
  });
  const presence = await observeSupacodeSurface(fixture.pi, WORKTREE_ID, TAB_ID, SURFACE_ID);

  assert.equal(presence, "absent");
  assert.deepEqual(fixture.calls, [SURFACE_LIST]);
});

test("surface observation distinguishes a listed and missing surface", async () => {
  for (const [surfaceOutput, expected] of [
    [`${SURFACE_ID.toUpperCase()}\n`, "present"],
    ["eeeeeeee-1111-4222-8333-ffffffffffff\n", "absent"],
  ]) {
    const fixture = recordingPi((args) => {
      assert.deepEqual(args, SURFACE_LIST);
      return result(surfaceOutput);
    });
    assert.equal(
      await observeSupacodeSurface(fixture.pi, WORKTREE_ID, TAB_ID, SURFACE_ID),
      expected,
    );
    assert.deepEqual(fixture.calls, [SURFACE_LIST]);
  }
});

test("failed nested listings classify a missing worktree as resource absence", async () => {
  const fixture = recordingPi((args) => {
    if (args[0] === "worktree") {
      assert.deepEqual(args, WORKTREE_LIST);
      return result("");
    }
    if (args[0] === "tab") assert.deepEqual(args, TAB_LIST);
    else assert.deepEqual(args, SURFACE_LIST);
    return result("", 1, "parent resource disappeared");
  });
  const absent = await observeSupacodeSurface(fixture.pi, WORKTREE_ID, TAB_ID, SURFACE_ID);

  assert.equal(absent, "absent");
  assert.deepEqual(fixture.calls, [SURFACE_LIST, TAB_LIST, WORKTREE_LIST]);
});

test("surface observation remains unknown when failed listings cannot prove absence", async () => {
  const fixture = recordingPi((args) => {
    if (args[0] === "worktree") {
      assert.deepEqual(args, WORKTREE_LIST);
      return result(`${WORKTREE_ID}\n`);
    }
    if (args[0] === "tab") assert.deepEqual(args, TAB_LIST);
    else assert.deepEqual(args, SURFACE_LIST);
    return result("", 1, "server unavailable");
  });
  const unknown = await observeSupacodeSurface(fixture.pi, WORKTREE_ID, TAB_ID, SURFACE_ID);

  assert.equal(unknown, "unknown");
  assert.deepEqual(fixture.calls, [SURFACE_LIST, TAB_LIST, WORKTREE_LIST]);
});
