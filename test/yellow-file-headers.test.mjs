import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { loadThemeFromPath, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import yellowFileHeaders from "../extensions/yellow-file-headers/index.ts";

const themePath = fileURLToPath(new URL("../themes/tokyo-night.json", import.meta.url));

function resolver() {
  let resolve;
  yellowFileHeaders({
    registerTool() { assert.fail("Presentation must not replace executable tools"); },
    registerToolRenderer(value) { assert.equal(resolve, undefined); resolve = value; },
  });
  return resolve;
}

function context(args) {
  return { args, cwd: process.cwd(), state: {}, argsComplete: false, expanded: false,
    isPartial: true, isError: false, invalidate() {}, lastComponent: undefined };
}

test("registers only a renderer, preserves resolver composition and optional renderers", () => {
  const resolve = resolver();
  const original = { renderShell: "self", renderCall: () => new Text("Other", 0, 0) };
  assert.equal(resolve("read", () => original), original);
  assert.equal(resolve("unknown", () => undefined), undefined);
  assert.equal(resolve("edit", () => undefined), undefined);
  const wrapped = resolve("write", () => original);
  assert.equal(wrapped.renderShell, "self");
  assert.equal(wrapped.renderResult, undefined);
  assert.deepEqual(wrapped.renderCall({}, loadThemeFromPath(themePath), context({})).render(30), ["Other".padEnd(30)]);
});

test("native edit and write headers remain yellow through partial, successful and error results", () => {
  const resolve = resolver();
  for (const mode of ["truecolor", "256color"]) {
    const theme = loadThemeFromPath(themePath, mode);
    setThemeInstance(theme);
    for (const create of [createEditToolDefinition, createWriteToolDefinition]) {
      const native = create(process.cwd());
      const wrapped = resolve(native.name, () => native);
      assert.equal(wrapped.execute, native.execute, "Resolver never changes an existing execution property");
      assert.equal(wrapped.renderShell, native.renderShell);
      for (const isError of [false, true]) {
        const args = { path: "日本語-é-file.txt", content: "hello\n", oldText: "old", newText: "new" };
        const callContext = context(args);
        const nativeContext = context(args);
        const call = wrapped.renderCall(args, theme, callContext);
        const nativeCall = native.renderCall(args, theme, nativeContext);
        const result = { content: [{ type: "text", text: isError ? "Fixture error" : "Done" }],
          details: isError ? undefined : { diff: "-1 old\n+1 new", firstChangedLine: 1 } };
        for (const isPartial of [true, false]) {
          const options = { expanded: false, isPartial };
          const renderedResult = wrapped.renderResult(result, options, theme, { ...callContext, isError });
          const nativeResult = native.renderResult(result, options, theme, { ...nativeContext, isError });
          for (const width of [12, 40, 80]) {
            const lines = call.render(width);
            const header = lines.find((line) => stripVTControlCharacters(line).includes(native.name));
            assert.ok(header.includes(theme.getFgAnsi("warning")), `${native.name}, ${mode}, error=${isError}`);
            assert.ok(!header.includes(theme.getFgAnsi("toolTitle")), "Completion must not restore blue");
            assert.deepEqual(lines.map(stripVTControlCharacters), nativeCall.render(width).map(stripVTControlCharacters));
            assert.deepEqual(renderedResult.render(width).map(stripVTControlCharacters), nativeResult.render(width).map(stripVTControlCharacters));
            for (const line of [...lines, ...renderedResult.render(width)]) assert.ok(visibleWidth(line) <= width);
          }
          if (isError) assert.ok(renderedResult.render(80).join("\n").includes(theme.getFgAnsi("error")));
        }
      }
    }
  }
});

test("theme.style headers preserve attributes and background and use the supplied theme on each render", () => {
  const resolve = resolver();
  const wrapped = resolve("edit", () => ({
    renderCall(_args, theme) {
      return new Text(theme.style("edit", { fg: "toolTitle", bg: "toolPendingBg", bold: true }) +
        " " + theme.fg("accent", "file.txt") + " " + theme.fg("error", "error"), 0, 0);
    },
  }));
  for (const path of [themePath, fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json", import.meta.url))]) {
    const theme = loadThemeFromPath(path, "truecolor");
    const text = wrapped.renderCall({}, theme, context({})).render(80).join("\n");
    assert.ok(text.includes(theme.style("edit", { fg: "warning", bg: "toolPendingBg", bold: true })));
    assert.ok(text.includes(theme.fg("warning", "file.txt")));
    assert.ok(text.includes(theme.fg("error", "error")));
  }
});
