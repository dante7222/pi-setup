import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import tokyoNightFooter from "../extensions/tokyo-night-footer/index.ts";

function usage(input = 0, output = 0) {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistant(counts = usage(), stopReason = "pending") {
  return { role: "assistant", provider: "test", model: "test-model", api: "test",
    content: [], usage: counts, stopReason, timestamp: 200 };
}

function harness(mode) {
  const handlers = new Map();
  const widgets = [];
  let usageReads = 0;
  let reportedTokens = 0;
  let branch = [];
  const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }];
  let active = ["read"];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    events: { on: () => () => {} },
    getSessionName: () => "Metrics test",
    getThinkingLevel: () => "off",
    getAllTools: () => tools,
    getActiveTools: () => active,
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  };
  const ctx = {
    mode, hasUI: mode !== "json", cwd: process.cwd(),
    model: { provider: "test", id: "test-model", name: "Test", contextWindow: 230_000 },
    getContextUsage: () => { usageReads++; return { tokens: reportedTokens, contextWindow: 230_000 }; },
    getSystemPrompt: () => "system",
    sessionManager: {
      getSessionId: () => "metrics", getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
      getLeafEntry: () => branch.at(-1),
      getEntry: (id) => branch.find((entry) => entry.id === id),
    },
    ui: {
      theme: { name: "test", fg: (_color, text) => text, bold: (text) => text, getColorMode: () => "none" },
      setStatus: () => {},
      setWidget: (_name, lines) => { if (lines) widgets.push(stripVTControlCharacters(lines.join("\n"))); },
    },
  };
  tokyoNightFooter(pi);
  const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  const start = () => { emit("session_start", { reason: "startup" }); emit("resources_discover"); };
  const request = (messages = []) => { emit("context", { messages }); emit("before_provider_request", { payload: {} }); };
  const delta = (message, text, type = "text_delta") => emit("message_update", { message,
    assistantMessageEvent: { type, contentIndex: 0, delta: text } });
  return { ctx, tools, emit, start, request, delta, widgets,
    append(message) {
      branch.push({ type: "message", id: String(branch.length + 1), parentId: branch.at(-1)?.id ?? null, message });
    },
    get usageReads() { return usageReads; },
    get text() { return widgets.at(-1); },
    set active(value) { active = value; },
    set reportedTokens(value) { reportedTokens = value; },
    set branch(value) {
      branch = value.map((entry, index) => ({ ...entry, id: String(index + 1), parentId: index ? String(index) : null }));
    },
  };
}

test("streaming stays estimated until final usage and never reads session usage on updates/renders", () => {
  const h = harness();
  h.start();
  h.request();
  const message = assistant(usage(1_000, 1));
  h.emit("message_start", { message });
  h.delta(message, "x".repeat(4_000));
  assert.match(h.text, /~2\.0k\/230k/);
  h.delta(message, "x".repeat(4_000));
  assert.match(h.text, /~3\.0k\/230k/);
  const reads = h.usageReads;
  for (let index = 0; index < 1_000; index++) h.delta(message, "abcd");
  assert.equal(h.usageReads, reads);
  h.emit("message_end", { message: assistant(usage(1_000, 2_500), "stop") });
  assert.match(h.text, /3\.5k\/230k/);
  assert.doesNotMatch(h.text, /~3\.5k/);
});

test("TPS starts at the provider request, excludes tools/previous turns, and clears on missing usage/model switches", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.start();
  h.emit("turn_start");
  h.emit("context", { messages: [] });
  now = 5_000; // slow pre-request extension work
  h.emit("before_provider_request");
  now = 6_000;
  h.emit("message_start", { message: assistant() });
  now = 7_000;
  h.emit("message_end", { message: assistant(usage(1_000, 100), "toolUse") });
  assert.match(h.text, /50\.0 tps/);
  assert.doesNotMatch(h.text, /tok\/s/);

  now = 100_000; // tools do not count toward the next response
  h.emit("turn_end");
  h.request();
  h.emit("message_start", { message: assistant() });
  now += 50;
  h.emit("message_end", { message: assistant(usage(1_000, 5), "stop") });
  assert.match(h.text, /100\.0 tps/);

  h.request();
  now += 1_000;
  h.emit("message_end", { message: assistant(usage(), "stop") });
  assert.doesNotMatch(h.text, / tps/);
  h.request();
  now += 1_000;
  h.emit("message_end", { message: assistant(usage(1_000, 5), "stop") });
  assert.match(h.text, /5\.0 tps/);
  h.ctx.model = { ...h.ctx.model, id: "custom", contextWindow: 100_000 };
  h.emit("model_select");
  assert.doesNotMatch(h.text, / tps/);
  assert.match(h.text, /\?\/100k/);
});

test("custom providers without the request hook use context time, never message_start time", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.start();
  h.emit("context", { messages: [] });
  now = 9_000;
  h.emit("message_start", { message: assistant() });
  now = 10_000;
  h.emit("message_end", { message: assistant(usage(1_000, 100), "stop") });
  assert.match(h.text, /10\.0 tps/);
});

test("headers improve custom-provider fallback after auth; a payload hook can refine it once", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.start();
  for (const hasPayloadHook of [false, true]) {
    const start = now;
    h.emit("context", { messages: [] });
    now = start + 8_000; // auth and context conversion, not inference time
    h.emit("before_provider_headers", { headers: {} });
    now = start + 8_500;
    h.emit("before_provider_headers", { headers: {} }); // must not reset
    now = start + 9_000;
    if (hasPayloadHook) h.emit("before_provider_request");
    h.emit("message_start", { message: assistant() });
    h.delta(assistant(), "first");
    now = start + 10_000;
    h.emit("before_provider_headers", { headers: {} }); // late hook ignored
    h.emit("message_end", { message: assistant(usage(1_000, 100), "stop") });
    assert.match(h.text, hasPayloadHook
      ? /100\.0 tps.*[◷] 0\.0ms/
      : /50\.0 tps.*[◷] 1\.00s/);
  }
});

test("TTFT ignores headers, empty deltas and mutable future content, and samples only the first output", (t) => {
  let now = 0;
  const clock = t.mock.method(performance, "now", () => now);
  const h = harness();
  h.start();
  h.emit("context", { messages: [] });
  now = 5_000;
  h.emit("before_provider_request");
  const message = assistant(usage(1_000, 100));
  // Pi shares content/usage objects between queued events. A start event may
  // expose future completed content, which is not evidence of first-token time.
  message.content = [{ type: "text", text: "future output" }];
  now = 5_100;
  h.emit("message_start", { message });
  for (const type of ["text_start", "thinking_start", "toolcall_start"]) {
    h.emit("message_update", { message, assistantMessageEvent: { type, contentIndex: 0, partial: message } });
  }
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) h.delta(message, "", type);
  const reads = clock.mock.callCount();
  now = 5_250;
  h.delta(message, " "); // whitespace is real output, unlike an empty delta
  assert.equal(clock.mock.callCount(), reads + 1);
  assert.doesNotMatch(h.text, /[◷]/); // publish the paired sample only on completion
  now = 6_000;
  for (let index = 0; index < 1_000; index++) h.delta(message, "x");
  assert.equal(clock.mock.callCount(), reads + 1); // no per-chunk clock calls
  h.emit("message_end", { message: assistant(usage(1_000, 100), "stop") });
  assert.match(h.text, /100\.0 tps.*[◷] 250ms/);
});

test("first thinking and tool-argument deltas count even before visible text and without token usage", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const type of ["thinking_delta", "toolcall_delta"]) {
    const h = harness();
    h.start();
    h.request();
    const message = assistant();
    h.emit("message_start", { message });
    now += 1_234;
    h.delta(message, type === "thinking_delta" ? "thinking" : "{", type);
    now += 9_000;
    h.delta(message, "visible answer");
    h.emit("message_end", { message: assistant(usage(), type === "toolcall_delta" ? "toolUse" : "stop") });
    assert.match(h.text, /[◷] 1\.23s/);
    assert.doesNotMatch(h.text, / tps/);
  }
});

test("repeated or late provider hooks cannot shorten either response clock", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.start();
  h.emit("context", { messages: [] });
  now = 1_000;
  h.emit("before_provider_request");
  now = 2_000;
  h.emit("before_provider_request"); // same response, e.g. transport fallback
  h.emit("message_start", { message: assistant() });
  now = 3_000;
  h.delta(assistant(), "first");
  now = 4_000;
  h.emit("before_provider_request");
  now = 5_000;
  h.emit("message_end", { message: assistant(usage(1_000, 100), "stop") });
  assert.match(h.text, /25\.0 tps.*[◷] 2\.00s/);

  // A custom provider without onPayload must use the context fallback even if
  // it eventually invokes the hook too late, after announcing its response.
  now = 10_000;
  h.emit("context", { messages: [] });
  now = 11_000;
  h.emit("message_start", { message: assistant() });
  now = 12_000;
  h.emit("before_provider_request");
  now = 13_000;
  h.delta(assistant(), "first");
  now = 14_000;
  h.emit("message_end", { message: assistant(usage(1_000, 100), "stop") });
  assert.match(h.text, /25\.0 tps.*[◷] 3\.00s/);
});

test("TTFT-only changes repaint the completed sample; no-delta responses clear it rather than inventing timing", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.start();
  for (const latency of [100, 200]) {
    const start = now;
    h.request();
    now = start + latency;
    h.delta(assistant(), "a");
    now = start + 1_000;
    h.emit("message_end", { message: assistant(usage(1_000, 100), "stop") });
    assert.match(h.text, new RegExp(`100\\.0 tps.*[◷] ${latency}ms`));
  }
  h.request();
  now += 1_000;
  const completed = assistant(usage(1_000, 100), "stop");
  completed.content = [{ type: "text", text: "buffered final response" }];
  h.emit("message_start", { message: completed });
  h.emit("message_update", { message: completed,
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "buffered final response", partial: completed } });
  h.emit("message_end", { message: completed });
  assert.match(h.text, /100\.0 tps/);
  assert.doesNotMatch(h.text, /[◷]/);
});

test("failures retain the last successful timing pair; each new request and session boundary resets sampling", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  h.start();
  for (const boundary of ["model_select", "session_tree", "session_compact", "session_start"]) {
    h.request();
    now += 250;
    h.delta(assistant(), "ok");
    now += 750;
    h.emit("message_end", { message: assistant(usage(1_000, 100), "stop") });
    assert.match(h.text, /100\.0 tps.*[◷] 250ms/);
    for (const reason of ["error", "aborted", "pending", "deferred"]) {
      h.request();
      now += 500;
      h.delta(assistant(), "failed");
      now += 500;
      h.emit("message_end", { message: assistant(usage(1_000, 50), reason) });
      assert.match(h.text, /100\.0 tps.*[◷] 250ms/);
    }
    h.emit(boundary);
    assert.doesNotMatch(h.text, / tps|[◷]/);
  }
});

test("tool activation between requests updates the loaded context", () => {
  const h = harness();
  h.start();
  h.request();
  assert.doesNotMatch(h.text, /~10k/);
  h.tools.push({ name: "dynamic", description: "x".repeat(40_000), parameters: {} });
  h.active = ["read", "dynamic"];
  h.request();
  assert.match(h.text, /~10k\/230k/);
});

test("loaded-context changes while streaming are applied to the next request's anchor", () => {
  const h = harness();
  h.start();
  h.request();
  h.tools.push({ name: "dynamic", description: "x".repeat(40_000), parameters: {} });
  h.active = ["read", "dynamic"];
  h.emit("resources_discover");
  const completed = assistant(usage(1_000, 100), "stop");
  h.emit("message_end", { message: completed });
  assert.match(h.text, /1\.1k\/230k/);
  h.request([completed]);
  assert.match(h.text, /~11k\/230k/);
});

test("compaction drops the old anchor even when an old assistant is retained", () => {
  const h = harness();
  h.start();
  h.request();
  const old = { ...assistant(usage(49_000, 1_000), "stop"), timestamp: 1 };
  h.emit("message_end", { message: old });
  assert.match(h.text, /50k\/230k/);
  h.reportedTokens = null;
  h.emit("session_compact");
  assert.match(h.text, /\?\/230k/);
  h.request([{ role: "compactionSummary", summary: "summary", timestamp: 100 }, old]);
  assert.doesNotMatch(h.text, /50k\/230k/);
  assert.match(h.text, /~\d+\/230k/);
});

test("restored fallback is estimated and rejects another model's usage", () => {
  const h = harness();
  h.reportedTokens = 12_000;
  h.branch = [{ type: "message", message: assistant(usage(11_000, 1_000), "stop") }];
  h.start();
  assert.match(h.text, /~12k\/230k/);
  h.branch = [{ type: "message", message: { ...assistant(usage(11_000, 1_000), "stop"), provider: "other" } }];
  h.emit("session_tree");
  assert.match(h.text, /\?\/230k/);
});

test("output-only final usage keeps input estimated and includes reported output", () => {
  const h = harness();
  h.start();
  h.request([{ role: "user", content: "x".repeat(4_000), timestamp: 1 }]);
  h.emit("message_end", { message: assistant(usage(0, 8_000), "stop") });
  assert.match(h.text, /~9\.0k\/230k/);
});

test("idle ! results update outside rendering, while !! results and repeated paints add nothing", async () => {
  const h = harness();
  h.start();
  const initial = h.text;
  const reads = h.usageReads;
  const shell = { role: "bashExecution", command: "echo hi", output: "x".repeat(40_000), timestamp: 1 };
  h.append(shell);
  h.emit("session_info_changed");
  assert.equal(h.text, initial); // only leaf lookup/scheduling occurs during paint
  await Promise.resolve();
  assert.match(h.text, /~10k\/230k/);
  const updated = h.text;
  h.append({ ...shell, excludeFromContext: true });
  h.emit("session_info_changed");
  await Promise.resolve();
  assert.equal(h.text, updated);
  for (let index = 0; index < 100; index++) h.emit("session_info_changed");
  await Promise.resolve();
  assert.equal(h.text, updated);
  assert.equal(h.usageReads, reads);
});

test("restoring a session removes excluded trailing !! usage from Pi's fallback", () => {
  const h = harness();
  const shell = { role: "bashExecution", command: "echo hi", output: "x".repeat(40_000), timestamp: 1 };
  const shellTokens = Math.ceil((shell.command.length + shell.output.length) / 4);
  h.branch = [
    { type: "message", message: assistant(usage(1_000, 100), "stop") },
    { type: "message", message: shell },
    { type: "message", message: { ...shell, excludeFromContext: true } },
  ];
  h.reportedTokens = 1_100 + shellTokens * 2;
  h.start();
  assert.match(h.text, /~11k\/230k/);
});

test("a request absorbs pending shell entries before their scheduled refresh", async () => {
  const h = harness();
  h.start();
  const shell = { role: "bashExecution", command: "echo hi", output: "x".repeat(40_000), timestamp: 1 };
  h.append(shell);
  h.emit("session_info_changed");
  h.request([shell]);
  const requested = h.text;
  await Promise.resolve();
  assert.equal(h.text, requested);
  assert.match(h.text, /~10k\/230k/);
});

test("non-TUI metrics handlers do no counting or rendering", () => {
  for (const mode of ["json", "print", "rpc"]) {
    const h = harness(mode);
    h.start();
    h.ctx.getSystemPrompt = () => { throw new Error("must not measure"); };
    h.request();
    h.emit("before_provider_headers", { headers: {} });
    const message = assistant(usage(1_000, 100));
    Object.defineProperty(message, "content", { get() { throw new Error("must not count"); } });
    h.emit("message_start", { message });
    h.delta(message, "abcd");
    h.emit("message_end", { message });
    assert.equal(h.usageReads, 0);
    assert.equal(h.widgets.length, 0);
  }
});
