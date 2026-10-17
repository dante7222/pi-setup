import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";
import footer, {
  contextLevel,
  findBottomBorderIndex,
  formatTokens,
  sanitizeStatusText,
  styleCaret,
  truncatePath,
} from "../extensions/tokyo-night-footer/index.ts";
import { isCodexFastModeRequested, resetCodexFastModeCache } from "../extensions/tokyo-night-footer/codex-fast-mode.ts";
import { createGitStatusTracker, ensureGitStatus, invalidateGitStatus } from "../extensions/tokyo-night-footer/git-status.ts";
import { estimateProjectedContext, estimateRequestContextTokens } from "../extensions/tokyo-night-footer/context-usage.ts";

const physical = { api: "test", provider: "test", id: "physical", name: "Physical", contextWindow: 100_000, reasoning: false };
const other = { ...physical, id: "other", name: "Other", contextWindow: 50_000 };
const virtual = { api: "pi-virtual", provider: "router", id: "auto", name: "Auto", contextWindow: 64_000, reasoning: false };

function assistant(input, output, overrides = {}) {
  return { role: "assistant", api: "test", provider: "test", model: "physical", content: [{ type: "text", text: "ok" }],
    stopReason: "stop", timestamp: 1, usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
    ...overrides };
}

function harness({ model = physical, branch = "main", title = "Test", session = SessionManager.inMemory("/work"),
  settings, registry, prime = false, statuses = new Map() } = {}) {
  const mode = prime ? undefined : "tui";
  const handlers = new Map();
  const widgets = [];
  let editor, sessionName = title, execCalls = 0;
  const theme = { name: "test", fg: (_color, text) => text, bold: (text) => text, getColorMode: () => "none", getFgAnsi: () => "" };
  const tui = { terminal: { rows: 20, columns: 220 }, requestRender() {} };
  const ctx = { mode, hasUI: true, cwd: "/work", model, sessionManager: session,
    modelRegistry: { find: registry ?? ((_provider, id) => id === "physical" ? physical : id === "other" ? other : undefined) },
    getContextUsage: () => undefined, getSystemPrompt: () => "12345678",
    ui: { theme, setStatus() {},
      setWidget: (_key, lines) => { if (lines) widgets.push(lines.join("\n")); },
      setFooter(create) { create(tui, theme, { getGitBranch: () => branch, getExtensionStatuses: () => statuses, onBranchChange: () => () => {} }); },
      setEditorComponent(create) {
        editor = create(tui, { borderColor: (text) => text, selectList: {} }, { matches: () => false });
      } } };
  const pi = { on: (name, fn) => handlers.set(name, fn), getSessionName: () => sessionName,
    setSessionName: (value) => { sessionName = value; }, getThinkingLevel: () => "off",
    getActiveTools: () => [], getAllTools: () => [], ...(settings ? { getSettings: () => settings } : {}),
    exec: async () => { execCalls++; return { code: 0, stdout: "", killed: false }; } };
  footer(pi);
  const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  return { ctx, pi, session, emit, widgets, theme,
    get editor() { return editor; }, get execCalls() { return execCalls; }, get title() { return sessionName; },
    text: (width = 220) => stripVTControlCharacters(editor.render(width)[0]) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("F1: bottom border is located structurally, including every ellipsized scroll form", () => {
  for (const border of [`${"─".repeat(30)} ↓ 18 more ${"─".repeat(30)}`, "─── ↓ 18 more ──", "─── ↓ 1...", "..", "─...", "─── ..."]) {
    assert.equal(findBottomBorderIndex(["top", "a", border, "autocomplete"], border), 2, border);
  }
  assert.equal(findBottomBorderIndex(["top", "a"], undefined), -1);
  const h = harness(); h.emit("session_start");
  h.editor.setText(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  // Move the cursor to the top so lines are hidden below it.
  for (let i = 0; i < 40; i++) h.editor.handleInput("\x1b[A");
  // Widths 8-12 give 2-6 inner columns: pi-tui emits "..", "─...", "─── ..." forms.
  for (const width of [80, 30, 12, 11, 10, 9, 8]) {
    const lines = h.editor.render(width);
    if (width >= 30) assert.match(stripVTControlCharacters(lines[0]), /^╭──.*↓ \d+ more/, `${width} cols`);
    else assert.match(stripVTControlCharacters(lines[0]), /^╭/, `${width} cols`);
    assert.ok(lines.some((line) => stripVTControlCharacters(line).startsWith("╰─ ")), `${width} cols`);
    // The top border may carry the "↓ N more" indicator; no other row may be a base border.
    assert.ok(!lines.slice(1).some((line) => /^[─.↓\d\s more]+$/.test(stripVTControlCharacters(line))), `${width} cols: base border leaked`);
    for (const line of lines) assert.equal(visibleWidth(line), width);
  }
  h.emit("session_shutdown");
});

test("F2: caret styling targets fake-cursor markers and keeps them for the TUI", () => {
  const theme = { name: "tokyo-night", getColorMode: () => "truecolor", getFgAnsi: () => "" };
  const line = `ab${renderFakeCursor("c")}d`;
  const styled = styleCaret(line, theme);
  assert.notEqual(styled, line);
  assert.ok(styled.includes(renderFakeCursor("c")));
  assert.ok(styled.includes("\x1b[38;2;187;154;247m"));
  assert.equal(stripVTControlCharacters(styled).replace(/\x1b_pi:\/?fc\x07/g, ""), "abcd");
  const semantic = styleCaret(line, { name: "x", getColorMode: () => "256color", getFgAnsi: () => "\x1b[35m" });
  assert.ok(semantic.includes(`\x1b[35m${renderFakeCursor("c")}\x1b[39m`));
  assert.equal(styleCaret("plain\x1b[7mx\x1b[0m", theme), "plain\x1b[7mx\x1b[0m");
});

test("F2: focused caret keeps CURSOR_MARKER adjacent to the fake cursor for hardware-cursor mode", () => {
  // Mirrors pi-tui tui.js FOCUSED_FAKE_CURSOR / resolveFakeCursors().
  const focused = /(\x1b_pi:c\x07)\x1b_pi:fc\x07(.*?)(?:\x1b_pi:\/fc\x07|$)/s;
  const resolve = (line, hardware) => (hardware ? line.replace(focused, "$1$2") : line)
    .replaceAll("\x1b_pi:fc\x07", "\x1b[7m").replaceAll("\x1b_pi:/fc\x07", "\x1b[27m");
  for (const theme of [{ name: "tokyo-night", getColorMode: () => "truecolor", getFgAnsi: () => "" },
    { name: "x", getColorMode: () => "256color", getFgAnsi: () => "\x1b[35m" }]) {
    for (const line of [`ab${CURSOR_MARKER}${renderFakeCursor("c")}d`, `ab${CURSOR_MARKER}${renderFakeCursor(" ")}`]) {
      const styled = styleCaret(line, theme);
      assert.notEqual(styled, line);
      assert.ok(styled.includes(`${CURSOR_MARKER}\x1b_pi:fc\x07`));
      assert.match(styled, focused);
      const hardware = resolve(styled, true);
      assert.ok(!hardware.includes("\x1b[7m"), "no fake cursor next to the hardware cursor");
      assert.ok(hardware.includes(CURSOR_MARKER));
      assert.ok(resolve(styled, false).includes("\x1b[7m"));
    }
  }
  // The real editor's focused output keeps the same shape.
  const h = harness(); h.emit("session_start");
  h.editor.focused = true; h.editor.setText("abc");
  const line = h.editor.render(40).find((candidate) => candidate.includes(CURSOR_MARKER));
  assert.match(line, focused);
  h.emit("session_shutdown");
});

test("F3: fast-mode state is read at most once per interval and re-read on change", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-fast-cache-"));
  const file = join(directory, "state.json");
  try {
    resetCodexFastModeCache();
    writeFileSync(file, '{"enabled":true}');
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-6-sol", file, 1_000), true);
    writeFileSync(file, '{"enabled":false}');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    // Within the interval: cached, no filesystem access.
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-6-sol", file, 1_500), true);
    // After the interval: mtime changed, so the file is re-read.
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-6-sol", file, 2_100), false);
    rmSync(file);
    assert.equal(isCodexFastModeRequested("openai-codex", "gpt-6-sol", file, 3_200), false);
  } finally {
    resetCodexFastModeCache();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("F4: renders and events never spawn git status outside a repository; renders reuse snapshots", async () => {
  const outside = harness({ branch: null }); outside.emit("session_start");
  for (let i = 0; i < 20; i++) outside.text();
  outside.emit("tool_result", { toolName: "edit" }); outside.emit("turn_end");
  await flush();
  assert.equal(outside.execCalls, 0);
  outside.emit("session_shutdown");

  const inside = harness(); inside.emit("session_start");
  inside.text(); await flush();
  const calls = inside.execCalls;
  assert.equal(calls, 1);
  for (let i = 0; i < 20; i++) inside.text();
  await flush();
  assert.equal(inside.execCalls, calls, "render path reuses the snapshot");
  inside.emit("tool_result", { toolName: "edit" }); await flush();
  assert.equal(inside.execCalls, calls + 1, "events still refresh immediately");
  inside.emit("session_shutdown");
});

test("F5: failed git reads back off exponentially; explicit invalidation retries", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const tracker = createGitStatusTracker("/repo");
  let calls = 0;
  const pi = { exec: async () => { calls++; return { code: 0, stdout: "", killed: true }; } };
  ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
  assert.equal(calls, 1);
  now += 1_500; ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
  assert.equal(calls, 1, "within the 2s backoff");
  now += 1_000; ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
  assert.equal(calls, 2);
  now += 3_000; ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
  assert.equal(calls, 2, "backoff doubled to 4s");
  // Routine invalidations (tool_result, turn_end, user_bash) respect the backoff.
  invalidateGitStatus(tracker); ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
  assert.equal(calls, 2, "routine invalidation keeps backoff");
  // Branch changes bypass it.
  invalidateGitStatus(tracker, true); ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
  assert.equal(calls, 3);
  pi.exec = async () => { calls++; return { code: 0, stdout: "", killed: false }; };
  now += 60_000; ensureGitStatus(pi, tracker, () => {}); await tracker.pending;
  assert.equal(tracker.failures, 0); assert.equal(tracker.retryAt, 0);
});

test("F6: title generation stops after a bounded number of attempts per session", async () => {
  const h = harness({ title: "" });
  let calls = 0;
  h.ctx.modelRegistry.streamSimple = () => {
    calls++;
    return { result: async () => assistant(0, 0, { content: [{ type: "text", text: "<title/>" }] }) };
  };
  h.session.appendMessage({ role: "user", content: "Title me", timestamp: 0 });
  h.emit("session_start"); await flush();
  for (let i = 0; i < 10; i++) { h.emit("agent_settled"); await flush(); }
  assert.equal(calls, 3);
  assert.equal(h.title, "");
  h.emit("session_start"); await flush();
  assert.equal(calls, 4, "a new session resets the budget");
  h.emit("session_shutdown");
});

test("F7: top border fits exactly at every width with wide statuses and dropped segments", () => {
  const statuses = new Map([["example-status", "read-only"], ["wide", "日本語日本語日本語"], ["more", "status"]]);
  const h = harness({ statuses, title: "Some long title 日本語" });
  h.emit("session_start");
  const previous = process.env.POWERLINE_NERD_FONTS;
  try {
    for (const icons of ["0", "1"]) {
      process.env.POWERLINE_NERD_FONTS = icons;
      for (let width = 8; width <= 160; width++) {
        const lines = h.editor.render(width);
        assert.equal(visibleWidth(lines[0]), width, `${width} cols icons=${icons}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.POWERLINE_NERD_FONTS;
    else process.env.POWERLINE_NERD_FONTS = previous;
  }
  h.emit("session_shutdown");
});

test("F8: Prime Agent widget is clipped to the terminal width when known", (t) => {
  const descriptors = ["isTTY", "columns"].map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]);
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else delete process.stdout[key];
    }
  });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
  Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true, writable: true });
  const h = harness({ prime: true, title: "A rather long session title for clipping" });
  h.emit("session_start");
  assert.ok(h.widgets.length > 0, "no widget");
  assert.ok(visibleWidth(h.widgets.at(-1)) <= 38, JSON.stringify(h.widgets));
  h.emit("session_shutdown");
});

test("F10: status text keeps SGR styling but strips other control sequences", () => {
  assert.equal(sanitizeStatusText("\x1b[33mok\x1b[39m"), "\x1b[33mok\x1b[39m");
  assert.equal(sanitizeStatusText("a\x1b[2Kb\x1b[10;5Hc"), "abc");
  assert.equal(sanitizeStatusText("\x1b]8;;https://x\x07link\x1b]8;;\x07"), "link");
  assert.equal(sanitizeStatusText("\x1b]0;title\x1b\\x\x1b7y\ttab\nline\x07"), "xy tab line");
  assert.equal(sanitizeStatusText("ok \x1b]8;;https://evil/payload unterminated"), "ok");
  assert.equal(sanitizeStatusText("ok \x1b_pi:c never ends"), "ok");
});

test("F11: truncatePath keeps the widest fitting grapheme suffix", () => {
  assert.equal(truncatePath("~/short", 20), "~/short");
  assert.equal(truncatePath("~/a/very/long/path", 8), "…ng/path");
  assert.equal(truncatePath("~/日本語/日本語", 6), "…本語");
  assert.ok(visibleWidth(truncatePath("~/日本語/日本語", 6)) <= 6);
  assert.equal(truncatePath("~/e\u0301e\u0301", 3), "…e\u0301e\u0301");
  assert.equal(truncatePath("abc", 1), "…");
  const long = "x/".repeat(5_000);
  assert.equal(visibleWidth(truncatePath(long, 40)), 40);
});

test("C1: unknown routed model window falls back to the virtual selection window", () => {
  const h = harness({ model: virtual, registry: () => undefined });
  h.emit("session_start");
  h.emit("context", { messages: [] });
  h.emit("message_end", { message: assistant(1_000, 100, { provider: "test", model: "unregistered" }) });
  assert.match(h.text(), /→ unregistered/);
  assert.match(h.text(), /1\.1k\/64k/);
  assert.doesNotMatch(h.text(), /\?\/\?/);
  h.emit("session_shutdown");
});

test("C2: model switch shows an estimate immediately and A -> B -> A restores A's usage", () => {
  const h = harness();
  h.session.appendMessage({ role: "user", content: "hello", timestamp: 0 });
  h.session.appendMessage(assistant(20_000, 1_000));
  h.emit("session_start");
  assert.match(h.text(), /~21k\/100k/);
  h.ctx.model = other; h.emit("model_select");
  assert.match(h.text(), /~\d+\/50k/);
  assert.doesNotMatch(h.text(), /\?\/|21k/);
  h.ctx.model = physical; h.emit("model_select");
  assert.match(h.text(), /~21k\/100k/);
  h.emit("session_shutdown");
});

test("C3/C4: cloned request anchors match by response identity; projection baseline uses tracked index", () => {
  const session = SessionManager.inMemory("/work");
  session.appendMessage({ role: "system", content: "x".repeat(400), timestamp: 0 });
  session.appendMessage({ role: "user", content: "abcd", timestamp: 1 });
  session.appendMessage(assistant(5_000, 100, { responseId: "r1", timestamp: 2 }));
  const projection = session.buildSessionProjection();
  const result = estimateProjectedContext(projection, session.getBranch(), 0, physical);
  assert.equal(result.usageLoadedContextTokens, 100);
  assert.equal(result.estimate.tokens, 5_100);
  const cloned = structuredClone(projection.messages);
  assert.equal(estimateRequestContextTokens(cloned, 100, physical, undefined, true, result.provenUsage).tokens, 5_100);
  // A different response with the same timestamp is not the proven anchor.
  const replaced = cloned.map((message) => message.role === "assistant" ? { ...message, responseId: "r2" } : message);
  assert.notEqual(estimateRequestContextTokens(replaced, 100, physical, undefined, true, result.provenUsage).tokens, 5_100);
  // Transformed anchor: same metadata/usage but replaced content is not the anchor.
  const big = SessionManager.inMemory("/work");
  big.appendMessage({ role: "user", content: "abcd", timestamp: 1 });
  big.appendMessage(assistant(5_000, 100, { responseId: "r1", timestamp: 2, content: [{ type: "text", text: "x".repeat(40_000) }] }));
  const bigProjection = big.buildSessionProjection();
  const proven = estimateProjectedContext(bigProjection, big.getBranch(), 0, physical).provenUsage;
  const same = structuredClone(bigProjection.messages);
  assert.equal(estimateRequestContextTokens(same, 0, physical, undefined, true, proven).tokens, 5_100);
  const shrunk = same.map((message) => message.role === "assistant" ? { ...message, content: [{ type: "text", text: "tiny" }] } : message);
  assert.notEqual(estimateRequestContextTokens(shrunk, 0, physical, undefined, true, proven).tokens, 5_100);
  const toolSwap = same.map((message) => message.role === "assistant"
    ? { ...message, content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }] } : message);
  assert.notEqual(estimateRequestContextTokens(toolSwap, 0, physical, undefined, true, proven).tokens, 5_100);
  // Projection messages need not share references with entry messages.
  const copied = { ...projection, messages: structuredClone(projection.messages) };
  assert.equal(estimateProjectedContext(copied, session.getBranch(), 0, physical).usageLoadedContextTokens, 100);
});

test("C6: formatTokens promotes units after rounding", () => {
  const cases = [[999, "999"], [1_000, "1.0k"], [9_949, "9.9k"], [9_960, "10k"], [9_999, "10k"],
    [999_499, "999k"], [999_500, "1.0M"], [1_250_000, "1.3M"], [9_949_999, "9.9M"],
    [9_960_000, "10M"], [9_999_999, "10M"], [12_400_000, "12M"]];
  for (const [count, expected] of cases) assert.equal(formatTokens(count), expected, String(count));
});

test("C7: color thresholds follow the effective compaction threshold", () => {
  assert.equal(contextLevel(150_000, 200_000, undefined), "warning");
  assert.equal(contextLevel(150_000, 200_000, 16_384), "warning");
  assert.equal(contextLevel(170_000, 200_000, 16_384), "error");
  assert.equal(contextLevel(170_000, 200_000, undefined), "warning");
  assert.equal(contextLevel(10, 0, 16_384), "normal");
  // Pi's shouldCompact: tokens > window - reserve. A reserve >= window is always at threshold.
  assert.equal(contextLevel(1, 10_000, 20_000), "error");
  assert.equal(contextLevel(1, 10_000, 10_000), "error");
  assert.equal(contextLevel(null, 10_000, 20_000), "normal");

  const colors = [];
  const h = harness({ settings: { compaction: { reserveTokens: 50_000 } } });
  h.ctx.ui.theme.fg = (color, text) => { colors.push(color); return text; };
  h.emit("session_start");
  h.emit("context", { messages: [] });
  h.emit("message_end", { message: assistant(46_000, 0) });
  colors.length = 0; h.text();
  assert.ok(colors.includes("error"), `46k of a 50k effective threshold is red: ${h.text()} ${colors}`);
  h.emit("session_shutdown");
  const disabled = harness({ settings: { compaction: { enabled: false, reserveTokens: 50_000 } } });
  disabled.ctx.ui.theme.fg = (color, text) => { colors.push(color); return text; };
  disabled.emit("session_start");
  disabled.emit("context", { messages: [] });
  // 85k of 100k: red against a 50k compaction threshold, but compaction is off,
  // so only the raw window applies (warning, not error).
  disabled.emit("message_end", { message: assistant(85_000, 0) });
  colors.length = 0; disabled.text();
  assert.ok(!colors.includes("error"), String(colors));
  disabled.emit("session_shutdown");
});

test("round 3: follow-up reads after a failure honor backoff; branch change bypasses it", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  for (const bypass of [false, true]) {
    const tracker = createGitStatusTracker("/repo");
    let calls = 0, release;
    const pi = { exec: () => { calls++; return new Promise((done) => { release = done; }); } };
    ensureGitStatus(pi, tracker, () => {});
    const pending = tracker.pending;
    await Promise.resolve(); await Promise.resolve();
    assert.equal(calls, 1);
    invalidateGitStatus(tracker, bypass); // arrives while the read is in flight
    release({ code: 0, stdout: "", killed: true }); // timeout
    for (let i = 0; i < 8; i++) await Promise.resolve();
    if (bypass) {
      assert.equal(calls, 2, "branch change re-reads immediately");
      release({ code: 0, stdout: "" }); await pending;
      assert.equal(tracker.status, "fresh");
    } else {
      await pending;
      assert.equal(calls, 1, "no immediate re-spawn after a failure");
      ensureGitStatus(pi, tracker, () => {});
      assert.equal(tracker.pending, undefined, "still backing off");
      now += 3_000;
      ensureGitStatus(pi, tracker, () => {}); await Promise.resolve(); await Promise.resolve();
      assert.equal(calls, 2, "expired snapshot refreshes once backoff ends");
      release({ code: 0, stdout: "" }); await tracker.pending;
    }
  }
});

test("round 3: request clones mutated after a comparison are re-measured, not cached", () => {
  const session = SessionManager.inMemory("/work");
  session.appendMessage({ role: "user", content: "abcd", timestamp: 1 });
  session.appendMessage(assistant(5_000, 100, { responseId: "r1", timestamp: 2, content: [{ type: "text", text: "x".repeat(40_000) }] }));
  const projection = session.buildSessionProjection();
  const proven = estimateProjectedContext(projection, session.getBranch(), 0, physical).provenUsage;
  // Pi passes the same message objects to context and context_with_system handlers.
  const shared = structuredClone(projection.messages);
  assert.equal(estimateRequestContextTokens(shared, 0, physical, undefined, true, proven).tokens, 5_100);
  shared.find((message) => message.role === "assistant").content[0].text = "tiny"; // in-place transform
  assert.notEqual(estimateRequestContextTokens(shared, 0, physical, undefined, true, proven).tokens, 5_100);
});

test("round 3: invalid compaction reserveTokens fall back to Pi's default", () => {
  for (const reserveTokens of [-1, 1.5, "50000", Number.NaN, 2 ** 60]) {
    const colors = [];
    const h = harness({ settings: { compaction: { reserveTokens } } });
    h.ctx.ui.theme.fg = (color, text) => { colors.push(color); return text; };
    h.emit("session_start");
    h.emit("context", { messages: [] });
    // 80k of 100k is 95.7% of the default 83.6k threshold -> error; against the
    // raw window (80%) or a broken threshold it would not be red.
    h.emit("message_end", { message: assistant(80_000, 0) });
    colors.length = 0; h.text();
    assert.ok(colors.includes("error"), `${String(reserveTokens)}: ${colors}`);
    h.emit("session_shutdown");
  }
  const override = harness({ settings: { compaction: { reserveTokens: 50_000,
    modelOverrides: { "test/physical": { reserveTokens: -5 } } } } });
  const colors = [];
  override.ctx.ui.theme.fg = (color, text) => { colors.push(color); return text; };
  override.emit("session_start");
  override.emit("context", { messages: [] });
  override.emit("message_end", { message: assistant(60_000, 0) });
  colors.length = 0; override.text();
  // Invalid override -> default 16384 (60k/83.6k = 72% warning), not the 50k ordinary value (error).
  assert.ok(colors.includes("warning") && !colors.includes("error"), String(colors));
  override.emit("session_shutdown");
});
