import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor, SessionManager, estimateTokens } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { estimateProjectedContext, estimateRequestContextTokens } from "../extensions/tokyo-night-footer/context-usage.ts";
import { CombinedAutocompleteProvider, CURSOR_MARKER } from "@earendil-works/pi-tui";
import footer from "../extensions/tokyo-night-footer/index.ts";

const physical = { api: "test", provider: "test", id: "physical", name: "Physical", contextWindow: 100_000, reasoning: true };
const virtual = { api: "pi-virtual", provider: "router", id: "auto", name: "Auto", contextWindow: 0, reasoning: true };
function assistant(input = 1_000, output = 100, overrides = {}) {
  return { role: "assistant", api: "test", provider: "test", model: "physical", thinkingLevel: "low",
    content: [{ type: "text", text: "abcd" }], stopReason: "stop", timestamp: 1,
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output }, ...overrides };
}
function harness(model = physical, session = SessionManager.inMemory("/work"), initialTitle = "Test") {
  const handlers = new Map();
  let editor, title = initialTitle, footerComponent;
  let reads = 0, branchReads = 0;
  const branch = session.getBranch.bind(session);
  session.getBranch = (...args) => { branchReads++; return branch(...args); };
  const projection = session.buildSessionProjection.bind(session);
  session.buildSessionProjection = () => { reads++; return projection(); };
  const color = (text) => text;
  const theme = { name: "test", fg: (_color, text) => text, bold: color, getColorMode: () => "none", getFgAnsi: () => "" };
  const editorTheme = { borderColor: color, selectList: { selectedText: color, description: color, scrollInfo: color, noMatch: color } };
  const keybindings = { matches: (data, action) => data === "CUSTOM" && action === "app.interrupt" };
  const tui = { terminal: { rows: 20, columns: 220 }, requestRender() {} };
  const ctx = { mode: "tui", hasUI: true, cwd: "/work", model, thinkingLevel: "high", sessionManager: session,
    modelRegistry: { find: (_provider, id) => id === "physical" ? physical : id === "small" ? { ...physical, id: "small", name: "Small", contextWindow: 10_000 } : undefined },
    getContextUsage: () => { throw Error("canonical projection should be used"); }, getSystemPrompt: () => "12345678",
    ui: { theme, setStatus() {}, setFooter(create) { footerComponent = create(tui, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} }); },
      setEditorComponent(create) { editor = create(tui, editorTheme, keybindings); } } };
  const pi = { on: (name, fn) => handlers.set(name, fn), getSessionName: () => title, setSessionName: (value) => { title = value; },
    getThinkingLevel: () => ctx.thinkingLevel, getActiveTools: () => [], getAllTools: () => [],
    exec: async () => ({ code: 0, stdout: "", killed: false }) };
  footer(pi);
  const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  const render = (width = 220) => editor.render(width);
  const h = { pi, ctx, session, emit, render, tui, editorTheme, keybindings,
    start: () => emit("session_start"), get editor() { return editor; }, get reads() { return reads; },
    get branchReads() { return branchReads; },
    get text() { return stripVTControlCharacters(render()[0]); }, get title() { return title; },
    request(transform = (messages) => messages) {
      const messages = session.buildSessionProjection().messages;
      emit("context", { messages: structuredClone(messages.filter((m) => m.role !== "system")) });
      if (messages.some((m) => m.role === "system")) {
        emit("context_with_system", { messages: transform(structuredClone(messages)) });
      }
      emit("before_provider_request");
    },
    finish(message) { emit("message_end", { message }); session.appendMessage(message); },
    stop() { emit("session_shutdown"); footerComponent?.dispose(); } };
  return h;
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function mouse(x, y, width, height, extra = {}) {
  return { type: "click", button: "left", x, y, width, height, screenX: x + 20, screenY: y + 5,
    shift: false, alt: false, ctrl: false, ...extra };
}

test("real editor translates clicks, wrapped Unicode, scrolling, focus, resize and base keybindings", () => {
  const h = harness(); h.start();
  const base = new CustomEditor(h.tui, h.editorTheme, h.keybindings, { paddingX: 0 });
  for (const width of [80, 18, 7, 40]) {
    for (const text of ["abc日本語éZ", "abcdefghij".repeat(30), Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")]) {
      h.editor.setText(text); base.setText(text);
      h.editor.focused = base.focused = true;
      const lines = h.render(width); base.render(width < 8 ? width : width - 6);
      assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
      for (const x of [3, 5, width - 4]) {
        const event = mouse(x, 1, width, lines.length);
        const expected = base.handleMouse({ ...event, x: width < 8 ? x : x - 3, width: width < 8 ? width : width - 6, height: width < 8 ? lines.length : lines.length + 1 });
        assert.deepEqual(h.editor.handleMouse(event), expected);
        assert.deepEqual(h.editor.getCursor(), base.getCursor(), `${width} cols at ${x}`);
      }
      for (const type of ["press", "drag", "release", "wheel"]) {
        assert.equal(h.editor.handleMouse(mouse(5, 1, width, lines.length, { type, wheelDelta: 1 })), undefined);
      }
    }
  }
  let escapes = 0; h.editor.onEscape = () => escapes++;
  h.editor.handleInput("CUSTOM"); assert.equal(escapes, 1);
  h.editor.setText("abc"); h.editor.handleInput("\x1b[D"); h.editor.handleInput("X");
  assert.equal(h.editor.getText(), "abXc");
  h.stop();
});

test("real autocomplete first/last rows and wheel use shifted hit regions", async () => {
  const h = harness(); h.start();
  h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
    { name: "alpha" }, { name: "beta" }, { name: "gamma" },
  ], "/work"));
  for (const [row, selected] of [[2, "/alpha"], [4, "/gamma"]]) {
    h.editor.setText(""); h.editor.handleInput("/"); await flush();
    assert.equal(h.editor.isShowingAutocomplete(), true);
    const lines = h.render(80);
    assert.match(stripVTControlCharacters(lines[2]), /alpha/);
    assert.equal(h.editor.handleMouse(mouse(1, row, 80, lines.length)), undefined);
    assert.equal(h.editor.handleMouse(mouse(79, row, 80, lines.length)), undefined);
    const result = h.editor.handleMouse(mouse(5, row, 80, lines.length));
    assert.equal(result.focus, true);
    assert.equal(h.editor.getText().trim(), selected);
  }
  h.editor.setText(""); h.editor.handleInput("/"); await flush();
  const lines = h.render(80);
  assert.equal(h.editor.handleMouse(mouse(5, 2, 80, lines.length, { type: "wheel", wheelDelta: 1 })).handled, true);
  h.editor.handleInput("\t");
  assert.equal(h.editor.getText().trim(), "/beta");
  // Autocomplete below a scrolled multiline editor uses the same row mapping.
  h.editor.setAutocompleteProvider({
    triggerCharacters: ["@"],
    getSuggestions: async () => ({ prefix: "@", items: ["alpha", "beta", "gamma"].map((value) => ({ value, label: value })) }),
    applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
      lines: lines.map((line, index) => index === cursorLine ? item.value : line), cursorLine, cursorCol: item.value.length,
    }),
  });
  h.editor.setText("line\n".repeat(20)); h.editor.handleInput("@"); h.editor.handleInput("\t"); await flush();
  const scrolled = h.render(80);
  const first = scrolled.findIndex((line) => stripVTControlCharacters(line).includes("alpha"));
  assert.ok(first > 2);
  h.editor.handleMouse(mouse(5, first + 2, 80, scrolled.length));
  assert.ok(h.editor.getText().trimEnd().endsWith("gamma"));
  h.stop();
});

test("canonical context edits replace/omit old usage, survive reload/tree and do not walk history on paints", async () => {
  const h = harness();
  const user = h.session.appendMessage({ role: "user", content: "x".repeat(40_000), timestamp: 0 });
  const response = h.session.appendMessage(assistant(49_000, 1_000));
  h.start(); assert.match(h.text, /~50k\/100k/);
  const reads = h.reads;
  for (let i = 0; i < 100; i++) h.render();
  assert.equal(h.reads, reads);
  h.session.appendContextEdit(user, { content: "12345678" });
  h.render(); await flush();
  assert.match(h.text, /~5\/100k/); // 2 loaded + 2 user + 1 assistant
  h.request(); assert.match(h.text, /~5\/100k/); // stale usage cannot return at the next request
  h.finish(assistant(200, 10)); assert.match(h.text, /[◫] 210\/100k/);
  h.session.appendContextEdit(response, null);
  h.emit("agent_settled"); await flush(); assert.doesNotMatch(h.text, /210\/100k|50k\/100k/);
  h.emit("session_start"); assert.match(h.text, /~5\/100k/);
  h.session.branch(response); h.emit("session_tree"); assert.match(h.text, /~50k\/100k/);
  h.stop();
});

test("canonical compaction and hidden !! never restore retained pre-edit/pre-compaction usage", async () => {
  const h = harness();
  const old = h.session.appendMessage(assistant(49_000, 1_000));
  h.session.appendCompaction("12345678", old, 50_000);
  h.start(); assert.match(h.text, /~5\/100k/);
  h.session.appendMessage({ role: "bashExecution", command: "echo", output: "x".repeat(40_000), excludeFromContext: true, timestamp: 5 });
  h.render(); await flush(); assert.match(h.text, /~5\/100k/);
  h.request(); assert.match(h.text, /~5\/100k/);
  h.finish(assistant(200, 10, { timestamp: Date.now() + 1 }));
  h.request(); assert.match(h.text, /~210\/100k/);
  h.stop();
});

test("virtual selection retains physical limits/usage and distinguishes routed thinking from selection", (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const h = harness(virtual); h.start();
  assert.match(h.text, /Auto.*high/); assert.match(h.text, /\?\/\?/); assert.doesNotMatch(h.text, /→/);
  h.request(); now = 100;
  h.emit("message_update", { message: assistant(), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } });
  now = 1_000; h.finish(assistant());
  assert.match(h.text, /Auto.*high.*→ Physical ● low/);
  assert.match(h.text, /[◫] 1\.1k\/100k/); assert.doesNotMatch(h.text, /~1\.1k/);
  assert.match(h.text, /100\.0 tps.*100ms/);
  h.request(); assert.match(h.text, /~1\.1k\/100k/);
  h.finish(assistant(200, 10, { model: "small", thinkingLevel: "off" }));
  assert.match(h.text, /→ Small ● off.*210\/10k/);
  h.ctx.model = physical; h.emit("model_select"); assert.match(h.text, /\?\/100k/); assert.doesNotMatch(h.text, /→/);
  h.ctx.model = virtual; h.emit("model_select"); assert.match(h.text, /→ Small.*~210\/10k/);
  h.emit("session_start"); assert.match(h.text, /→ Small.*~210\/10k/);
  h.request(); h.finish(assistant(99_000, 1_000, { api: "pi-virtual", model: "auto", stopReason: "error" }));
  assert.match(h.text, /→ Small.*\/10k/); assert.doesNotMatch(h.text, /100k\/10k/);
  h.stop();
});

test("switching to virtual uses a response before selection; unknown windows stay unknown", () => {
  const h = harness(); h.session.appendMessage(assistant()); h.start();
  h.ctx.model = virtual; h.emit("model_select"); assert.match(h.text, /→ Physical.*~1\.1k\/100k/);
  h.stop();
  for (const window of [0, 50_000]) {
    const empty = harness({ ...virtual, contextWindow: window }); empty.start();
    assert.match(empty.text, window ? /~2\/50k/ : /\?\/\?/);
    empty.stop();
  }
});

test("title generation dispatches virtual selection through neutral streamSimple and respects names/shutdown", async () => {
  const h = harness(virtual, undefined, undefined);
  // Explicit undefined invokes the default title; clear through the public name API simulation.
  const unnamed = harness(virtual, SessionManager.inMemory("/work"), "");
  let resolve, signal, calls = 0;
  unnamed.ctx.modelRegistry.streamSimple = (model, _context, options) => {
    calls++; assert.equal(model.api, "pi-virtual"); signal = options.signal;
    return { result: () => new Promise((done) => { resolve = done; }) };
  };
  unnamed.session.appendMessage({ role: "user", content: "Build a title", timestamp: 0 });
  unnamed.start(); assert.equal(calls, 1);
  unnamed.emit("before_agent_start", { prompt: "second" }); assert.equal(calls, 1);
  unnamed.stop(); assert.equal(signal.aborted, true);
  resolve(assistant(0, 0, { content: [{ type: "text", text: "<title>Wrong late title</title>" }] }));
  await flush(); assert.equal(unnamed.title, "");
  h.start(); assert.equal(calls, 1); h.stop();
});

test("an explicit name wins an in-flight generated title, and next session can generate afresh", async () => {
  const h = harness(virtual, SessionManager.inMemory("/work"), "");
  let resolve;
  h.ctx.modelRegistry.streamSimple = () => ({ result: () => new Promise((done) => { resolve = done; }) });
  h.start(); h.emit("before_agent_start", { prompt: "Title this task" });
  h.pi.setSessionName("User chosen name");
  resolve(assistant(0, 0, { content: [{ type: "text", text: "<title>Generated title</title>" }] }));
  await flush(); assert.equal(h.title, "User chosen name");
  h.stop(); h.pi.setSessionName(""); h.start();
  h.emit("before_agent_start", { prompt: "New task" });
  resolve(assistant(0, 0, { content: [{ type: "text", text: "<title>New generated title</title>" }] }));
  await flush(); assert.equal(h.title, "New generated title"); h.stop();
});

test("request boundaries see edits even before a paint; streaming grows without projection walks", async () => {
  const h = harness();
  const id = h.session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
  h.session.appendMessage(assistant(49_000, 1_000)); h.start();
  h.session.appendContextEdit(id, { content: "abcd" });
  h.request(); assert.match(h.text, /~4\/100k/);
  const reads = h.reads;
  for (let i = 0; i < 100; i++) h.emit("message_update", { message: assistant(0, 0),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } });
  assert.match(h.text, /~104\/100k/); assert.equal(h.reads, reads);
  h.finish(assistant(200, 10)); assert.match(h.text, /[◫] 210\/100k/);
  h.stop();
});

test("projected requests retain the loaded-tool baseline across normal persisted messages", () => {
  const h = harness(); h.start(); h.request();
  h.pi.getAllTools = () => [{ name: "new", description: "x".repeat(40_000), parameters: {} }];
  h.pi.getActiveTools = () => ["new"];
  h.emit("resources_discover"); h.finish(assistant());
  h.request(); assert.match(h.text, /~11k\/100k/);
  h.stop();
});

test("append-only boundary compaction resets context and timing without session_compact", async (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  for (const notification of ["agent_settled", "request"]) {
    const h = harness(); h.start(); h.request();
    now += 100;
    h.emit("message_update", { message: assistant(0, 0),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } });
    now += 900; h.finish(assistant(49_000, 1_000));
    assert.match(h.text, /50k\/100k.*1000\.0 tps.*100ms/);
    const compact = h.session.appendCompaction("abcd", null, 50_000);
    assert.equal(h.session.getEntry(compact).firstKeptEntryId, compact);
    if (notification === "request") h.request();
    else h.emit(notification);
    await flush();
    assert.match(h.text, /~3\/100k/);
    assert.doesNotMatch(h.text, / tps|[◷]/);
    const reads = h.reads, branchReads = h.branchReads;
    for (let i = 0; i < 100; i++) h.render();
    await flush();
    assert.equal(h.reads, reads); assert.equal(h.branchReads, branchReads);
    h.emit("session_compact"); // an optional later notification is idempotent
    assert.match(h.text, /~3\/100k/);
    h.request(); now += 50;
    h.emit("message_update", { message: assistant(0, 0),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } });
    now += 950; h.finish(assistant(200, 10));
    assert.match(h.text, /210\/100k.*10\.0 tps.*50ms/);
    h.stop();
  }
});

test("canonical source order accepts equal/backwards timestamps after compaction, not retained usage", async () => {
  for (const timestampDelta of [0, -10_000]) {
    const h = harness();
    const old = h.session.appendMessage(assistant(49_000, 1_000, { timestamp: Date.now() + 100_000 }));
    const compact = h.session.appendCompaction("abcd", old, 50_000);
    const timestamp = Date.parse(h.session.getEntry(compact).timestamp) + timestampDelta;
    h.start(); assert.match(h.text, /~4\/100k/); // even future-dated retained usage is invalid
    h.request(); h.finish(assistant(200, 10, { timestamp }));
    h.render(); await flush(); // scanner has seen the new leaf, projection must still refresh
    h.request(); assert.match(h.text, /~210\/100k/);
    h.emit("session_start"); assert.match(h.text, /~210\/100k/);
    h.emit("session_tree"); assert.match(h.text, /~210\/100k/);
    const projection = h.session.buildSessionProjection();
    const projected = estimateProjectedContext(projection, h.session.getBranch(), 2, physical);
    assert.equal(projected.estimate.tokens, 210);
    // A request-local transform dropping the fresh anchor cannot resurrect the
    // future-dated retained response or use the fresh response's baseline.
    assert.equal(estimateRequestContextTokens(
      projection.messages.filter((message) => message !== projected.provenUsage),
      2, physical, undefined, true, projected.provenUsage,
    ).tokens, 4);
    // Unproven message arrays still use the conservative timestamp heuristic.
    assert.notEqual(estimateRequestContextTokens(projection.messages, 2, physical, undefined).tokens, 210);
    h.stop();
  }
});

test("canonical prepared descriptions survive edits, reload, delta replay and compaction checkpoints", async () => {
  const h = harness();
  const registration = { name: "orchestrator", description: "short", parameters: {} };
  const prepared = { ...registration, description: "x".repeat(40_000) };
  h.pi.getAllTools = () => [registration]; h.pi.getActiveTools = () => [registration.name];
  h.session.appendMessage({ role: "system", content: "12345678", toolsAdded: [prepared], timestamp: 0 });
  const user = h.session.appendMessage({ role: "user", content: "old", timestamp: 1 });
  h.session.appendMessage(assistant(49_000, 1_000));
  h.session.appendContextEdit(user, { content: "abcd" });
  const check = () => {
    const projection = h.session.buildSessionProjection();
    const system = getCurrentSystemMessage(projection.messages);
    const expected = estimateTokens(system) + projection.messages.filter((m) => m.role !== "system")
      .reduce((total, message) => total + estimateTokens(message), 0);
    const result = estimateProjectedContext(projection, h.session.getBranch(), 19, physical);
    assert.equal(result.estimate.tokens, expected);
    assert.equal(result.loadedContextTokens, estimateTokens(system));
    return expected;
  };
  assert.ok(check() > 10_000);
  h.start(); assert.match(h.text, /~10k\/100k/);
  h.request(); assert.match(h.text, /~10k\/100k/);
  h.emit("resources_discover"); assert.match(h.text, /~10k\/100k/);
  const replacement = { ...prepared, description: "y".repeat(8_000) };
  h.session.appendMessage({ role: "system", content: "", toolsRemoved: [{ name: prepared.name }],
    toolsAdded: [replacement], sections: { task: "abcd", removed: null }, timestamp: 2 });
  h.ctx.getSystemPrompt = () => "12345678\n\nabcd";
  h.emit("agent_settled"); await flush();
  assert.ok(check() > 2_000 && check() < 2_100);
  assert.match(h.text, /~2\.0k\/100k/);
  h.session.appendCompaction("abcd", user, 10_000);
  h.emit("agent_settled"); await flush();
  assert.ok(check() > 2_000 && check() < 2_100);
  h.emit("session_start"); h.request(); assert.match(h.text, /~2\.0k\/100k/);
  h.stop();
});

test("complete request-local system state replaces canonical tools without double counting and keeps forced prompts", () => {
  const h = harness();
  const tool = { name: "orchestrator", description: "x".repeat(40_000), parameters: {} };
  h.session.appendMessage({ role: "system", content: "12345678", toolsAdded: [tool], timestamp: 0 });
  h.session.appendMessage({ role: "user", content: "abcd", timestamp: 1 });
  h.start();
  // An earlier context_with_system transform hides a declaration and replaces
  // its prepared orchestrator text. Registration metadata cannot express this.
  const transform = (messages) => [{ role: "system", content: "y".repeat(8_000), timestamp: 0 },
    ...messages.filter((m) => m.role !== "system")];
  const options = { forceSystemPrompt: "forced" };
  h.emit("before_agent_start", { prompt: "test", systemPromptOptions: options });
  h.emit("agent_start");
  h.ctx.getSystemPrompt = () => "forced";
  h.request(transform); assert.match(h.text, /~3\/100k/); // forced text wins after the local transform
  options.forceSystemPrompt = undefined;
  h.ctx.getSystemPrompt = () => "12345678";
  h.request(transform); assert.match(h.text, /~2\.0k\/100k/);
  const reads = h.reads, branchReads = h.branchReads;
  for (let i = 0; i < 100; i++) {
    h.emit("message_update", { message: assistant(0, 0),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } });
    h.render();
  }
  assert.equal(h.reads, reads); assert.equal(h.branchReads, branchReads);
  assert.match(h.text, /~2\.1k\/100k/);
  h.finish(assistant(12_000, 100));
  // The next canonical request adds back its actual system footprint, not the
  // registered tool description or historical full-plus-delta declarations.
  h.request(); assert.match(h.text, /~20k\/100k/);
  options.forceSystemPrompt = "forced";
  h.ctx.getSystemPrompt = () => "forced";
  h.request(transform); assert.match(h.text, /~10k\/100k/);
  h.stop();
});

test("explicit equal-text and empty forced prompts observe later handlers and reset between runs", () => {
  for (const forced of ["12345678", ""]) {
    const h = harness();
    h.session.appendMessage({ role: "system", content: "12345678", timestamp: 0 });
    h.session.appendMessage({ role: "user", content: "abcd", timestamp: 1 });
    h.start();
    const transform = (messages) => [{ role: "system", content: "x".repeat(40_000), timestamp: 0 },
      ...messages.filter((message) => message.role !== "system")];
    const options = {};
    h.emit("before_agent_start", { prompt: "test", systemPromptOptions: options });
    // The real runner mutates this same object for handlers registered later,
    // including when such a handler returns { systemPrompt: forced }.
    options.forceSystemPrompt = forced;
    h.ctx.getSystemPrompt = () => forced;
    h.emit("agent_start");
    h.request(transform);
    assert.match(h.text, forced ? /~3\/100k/ : /~1\/100k/);

    const nextOptions = { forceSystemPrompt: forced };
    h.emit("before_agent_start", { prompt: "next", systemPromptOptions: nextOptions });
    delete nextOptions.forceSystemPrompt; // a later handler can also remove it
    h.ctx.getSystemPrompt = () => "12345678";
    h.emit("agent_start");
    h.request(transform);
    assert.match(h.text, /~10k\/100k/);
    h.stop();
  }
});

test("system changes after historical usage use replayed deltas once, including section removal", () => {
  const session = SessionManager.inMemory("/work");
  session.appendMessage({ role: "system", content: "", sections: { base: "a".repeat(4_000) }, timestamp: 0 });
  session.appendMessage(assistant(20_000, 100));
  session.appendMessage({ role: "system", content: "", sections: { task: "b".repeat(8_000) }, timestamp: 2 });
  let projection = session.buildSessionProjection();
  assert.equal(estimateProjectedContext(projection, session.getBranch(), 19, physical).estimate.tokens, 22_100);
  session.appendMessage({ role: "system", content: "", sections: { base: "abcd", task: null }, timestamp: 3 });
  projection = session.buildSessionProjection();
  assert.equal(estimateProjectedContext(projection, session.getBranch(), 19, physical).estimate.tokens, 19_101);
});

test("Git UI labels unknown and stale without presenting failed reads as clean", async () => {
  const h = harness(); h.pi.exec = async () => ({ code: 1, stdout: "" }); h.start();
  h.render(); await flush(); assert.match(h.text, /main unknown/);
  h.pi.exec = async () => ({ code: 0, stdout: " M dirty\n?? new\n" });
  h.emit("tool_result", { toolName: "edit" }); await flush();
  assert.match(h.text, /main \*1 \?1/); assert.doesNotMatch(h.text, /stale|unknown/);
  h.pi.exec = async () => { throw Error("Git failed"); };
  h.emit("tool_result", { toolName: "write" }); await flush();
  assert.match(h.text, /main \*1 \?1 stale/);
  h.stop();
});
