import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { actionHelp } from "../extensions/herdr-subagents/discovery.ts";
import { parameters, publicParameters } from "../extensions/herdr-subagents/input-schema.ts";
import { outputSchema } from "../extensions/herdr-subagents/output-schema.ts";

const actions = parameters.anyOf.map((branch) => branch.properties.action.const);

test("strict inputs, public action discovery and success outputs enumerate the same actions", () => {
  assert.deepEqual([...actions].sort(), publicParameters.properties.action.anyOf.map((branch) => branch.const).sort());
  assert.deepEqual([...actions].sort(), outputSchema.anyOf.filter((branch) => branch.properties.ok.const).map((branch) => branch.properties.action.const).sort());
  for (const action of actions) {
    const { declaration } = actionHelp([action]);
    assert.ok(declaration.includes(`action: "${action}"`));
    assert.ok(declaration.includes("ok: false"));
    assert.ok(declaration.includes("REQUEST_ID_CONFLICT"));
    assert.doesNotMatch(declaration, /args: unknown|data\??: unknown/);
  }
});

test("all supported narrow selections fit the response budget without truncation", () => {
  for (let a = 0; a < actions.length; a++) for (let b = a + 1; b < actions.length; b++) for (let c = b + 1; c < actions.length; c++) {
    const selected = [actions[a], actions[b], actions[c]];
    const data = actionHelp(selected);
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, action: "help", data })) <= 12000, selected.join(","));
    assert.doesNotMatch(data.declaration, /args: unknown|data\??: unknown/);
  }
  for (const selected of [[], ["bogus"], ["next", "next"], actions, null, "spawn"]) assert.throws(() => actionHelp(selected));
});

test("narrow help renders executable strict TypeScript for required inputs and discriminated outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-help-types-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "fixture.ts");
  await writeFile(file, `declare const tools: { ${actionHelp(["prepare", "spawn", "next"]).declaration} };
declare const configuration: { ${actionHelp(["configure"]).declaration} };
async function exercise() {
  const config = await configuration.subagents({action:"configure"});
  if (config.ok) {
    const model: string = config.data.presets.review.model;
    const thinking: string | undefined = config.data.presets.review.thinking;
    const maxCost: number | undefined = config.data.presets.review.maxCost;
    const maxTokens: number | undefined = config.data.presets.review.maxTokens;
    // @ts-expect-error preset values are typed, not unknown or any
    const invalid: number = config.data.presets.review.model;
  }
  const prepared = await tools.subagents({action:"prepare",tasks:[{name:"review",prompt:"test"}]});
  if (prepared.ok && prepared.action === "prepare") await tools.subagents({action:"spawn",requestId:prepared.data.requestId});
  // @ts-expect-error preparation requires tasks
  await tools.subagents({action:"prepare"});
  await tools.subagents({action:"spawn",requestId:"test",tasks:[{name:"review",prompt:"test"}]});
  // @ts-expect-error spawn needs a requestId
  await tools.subagents({action:"spawn",tasks:[{name:"review",prompt:"test"}]});
  // @ts-expect-error narrow discovery excludes unrelated actions
  await tools.subagents({action:"configure"});
  const result = await tools.subagents({action:"next",acknowledge:[],seconds:0});
  if (result.ok && result.action === "next") {
    const finished: boolean = result.data.finished;
    const needsAck: boolean = result.data.acknowledgementRequired;
    const receipt: string | undefined = result.data.reports[0]?.receipt;
  } else if (!result.ok && "code" in result) {
    const inspect: "request_status" = result.inspection.action;
    const found: boolean = result.diagnostic.found;
  }
}
`);
  const program = ts.createProgram([file], { noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, types: [], skipLibCheck: true });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
});

test("runtime renderer loads through Pi without project development dependencies", async (t) => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies["@earendil-works/pi-codemode"], "1.0.0", "Pi managed installs omit dev/peer packages and do not alias codemode");
  const root = await mkdtemp(join(tmpdir(), "herdr-renderer-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "node_modules", "@earendil-works", "pi-codemode");
  await mkdir(dirname(target), { recursive: true });
  const source = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-codemode/declarations"))));
  await cp(source, target, { recursive: true });
  const extension = join(root, "probe.ts");
  await writeFile(extension, `import {renderToolSignature} from "@earendil-works/pi-codemode/declarations";
import {Type} from "typebox";
export default function () {
  const value=renderToolSignature({name:"probe",inputSchema:Type.Object({name:Type.String()}),outputSchema:Type.String()});
  if(!value.includes("name: string")) throw Error("Renderer failed");
}`);
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [extension],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
});

test("help uses live schemas and refuses oversized declarations rather than truncating them", () => {
  const branch = parameters.anyOf.find((entry) => entry.properties.action.const === "close");
  try {
    branch.properties.discoveryProbe = { type: "string", description: "schema-generated probe" };
    assert.match(actionHelp(["close"]).declaration, /discoveryProbe\?: string/);
    branch.properties.discoveryProbe.description = "x".repeat(20000);
    assert.throws(() => actionHelp(["close"]), /exceeds 12 KB/);
  } finally { delete branch.properties.discoveryProbe; }
});
