import assert from "node:assert/strict";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import bashTimeout from "../extensions/bash-timeout/index.ts";

function loadHook() {
  let handler;
  // No other APIs: registering tools/messages/prompt hooks would fail this test.
  bashTimeout({ on(name, callback) {
    assert.equal(name, "tool_call");
    assert.equal(handler, undefined);
    handler = callback;
  } });
  return handler;
}

function bashEvent(input) {
  return { type: "tool_call", toolName: "bash", toolCallId: "test", input };
}

test("supplies 120 seconds in place without changing the command or returning context", () => {
  const input = { command: "fd .", extra: "preserved" };
  assert.equal(loadHook()(bashEvent(input)), undefined);
  assert.deepEqual(input, { command: "fd .", extra: "preserved", timeout: 120 });
});

test("preserves explicit deadlines, including invalid values for backend validation", () => {
  const hook = loadHook();
  for (const timeout of [0.1, 1, 600, 3600, 0, -1, NaN, Infinity, null, "600"]) {
    const input = { command: "sleep 1", timeout };
    hook(bashEvent(input));
    assert.equal(input.timeout, timeout);
  }
});

test("does not change other tool calls", () => {
  const event = { type: "tool_call", toolName: "find", input: { pattern: "*" } };
  loadHook()(event);
  assert.deepEqual(event.input, { pattern: "*" });
});

test("is included in the package manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/bash-timeout/index.ts"));
});

test("injected default reaches real Bash and preserves output on timeout", { timeout: 10000 }, async (t) => {
  const hook = loadHook();
  const event = bashEvent({ command: "printf 'ready\\n'; sleep 30" });
  hook(event);
  const ready = new EventEmitter();
  const readyPromise = once(ready, "ready");
  const abort = new AbortController();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = createBashTool(process.cwd()).execute("test", event.input, abort.signal, (update) => {
    if (update.content.some((part) => part.type === "text" && part.text.includes("ready"))) {
      ready.emit("ready");
    }
  });
  const rejected = assert.rejects(running, /ready[\s\S]*Command timed out after 120 seconds/);
  try {
    await readyPromise;
    // Advance the real backend's deadline, not a mocked execute implementation.
    t.mock.timers.tick(120000);
    // Pi arms a short stdio-drain timer asynchronously after child exit. The
    // deadline already fired; leave subsequent process cleanup on real timers
    // rather than freezing it after the single mock-clock advance under load.
    t.mock.timers.reset();
    await rejected;
  } finally {
    abort.abort();
    t.mock.timers.reset();
    await running.catch(() => {});
  }
});

test("explicit real deadline kills a shell waiting on a same-group child", { timeout: 10000 }, async () => {
  const event = bashEvent({ command: "printf 'before\\n'; sleep 30 & wait", timeout: 0.2 });
  loadHook()(event);
  await assert.rejects(
    createBashTool(process.cwd()).execute("test", event.input),
    /before[\s\S]*Command timed out after 0.2 seconds/,
  );
});

test("normal results and exit failures retain built-in behavior", async () => {
  const tool = createBashTool(process.cwd());
  const success = bashEvent({ command: "printf ok" });
  loadHook()(success);
  const result = await tool.execute("test", success.input);
  assert.equal(result.content[0].text, "ok");
  const failure = bashEvent({ command: "printf problem >&2; exit 7" });
  loadHook()(failure);
  const failed = await tool.execute("test", failure.input);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /problem[\s\S]*Command exited with code 7/);
  assert.equal(failed.structuredContent.exit_code, 7);
  assert.equal(failed.structuredContent.output, "problem");
});
