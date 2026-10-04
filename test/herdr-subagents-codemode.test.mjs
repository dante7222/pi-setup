import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { atomic, jobs, save, scopeFor, validateTasks } from "../extensions/herdr-subagents/core.ts";
import { readReport } from "../extensions/herdr-subagents/reports.ts";
import { emptyUsage } from "../extensions/herdr-subagents/progress.ts";
import { registerSubagentTools } from "../extensions/herdr-subagents/tools.ts";
import { registerDurableTools } from "../extensions/herdr-subagents/durable-tools.ts";
import { isolateHerdrEnvironment } from "./helpers/herdr-test-environment.mjs";

async function fixture(t, factory = registerSubagentTools) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-codemode-"));
  let session;
  isolateHerdrEnvironment(t, {
    PI_HERDR_WORKER: "0", PI_HERDR_OWNER_PID: String(process.pid), PI_CODING_AGENT_DIR: directory,
    HERDR_ENV: "1", HERDR_SOCKET_PATH: join(directory, "unused.sock"), HERDR_PANE_ID: "parent", HERDR_WORKSPACE_ID: "test",
    HERDR_BIN_PATH: join(directory, "no-herdr"), PI_HERDR_PI_BIN: join(directory, "no-pi"),
  }, async () => {
    try { session?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "on" }, compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only");
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5");
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createCodemodeExtension({ models: false }), factory, registerDurableTools],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, modelRuntime, model, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory) }));
  await session.bindExtensions({ mode: "json" });
  const active = session.getActiveToolNames();
  for (const name of ["read", "bash", "edit", "write", "codemode"]) assert.ok(active.includes(name), `${name} remains active in codemode on mode`);
  assert.ok(!active.includes("subagents"));
  assert.ok(!active.includes("durable_subagents"));
  const scope = scopeFor(session.sessionManager.getSessionId());
  let code;
  let count = 0;
  const contexts = [];
  session.agent.streamFunction = (_model, context) => {
    contexts.push(JSON.stringify(context));
    const script = code;
    code = undefined;
    const message = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), timestamp: Date.now(),
      content: script ? [{ type: "toolCall", id: `script-${++count}`, name: "codemode", arguments: { code: script } }] : [{ type: "text", text: "Done" }],
      stopReason: script ? "toolUse" : "stop",
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
    return stream;
  };
  const run = async (script) => {
    code = script;
    await session.prompt("Exercise report protocol");
    return session.messages.findLast((message) => message.role === "toolResult");
  };
  return { directory, model, session, scope, run, contexts };
}

const outputText = (result) => result.content.map((part) => part.text).join("\n");

async function completedJob(scope, directory, name, report) {
  const job = { id: "abcdef123456", task: validateTasks([{ name, prompt: "test" }], {}, directory)[0], cursor: 0, created: 1 };
  await mkdir(join(scope.root, job.id), { recursive: true });
  await save(scope, job);
  await atomic(join(scope.root, job.id, "done.json"), { state: "done", report }, true);
  return job;
}

test("real Pi codemode reaches deferred reports, preserves unacked output on script failure, and returns structured errors", { timeout: 30000 }, async (t) => {
  const { directory, model, scope, run, contexts } = await fixture(t);
  await run(undefined);
  assert.doesNotMatch(contexts[0], /subagents|read_many|pendingWorkers|herdr\.receipts/, "Fresh model context contains neither deferred schemas/namespaces nor the on-demand guide");
  let nativeTool;
  registerSubagentTools({ registerTool: (tool) => { nativeTool = tool; } });
  let payload;
  await anthropicStream(model, { messages: [
    { role: "system", content: "Test", timestamp: 1, toolsAdded: [nativeTool] },
    { role: "user", content: "test", timestamp: 2 },
  ] }, { client: {}, onPayload(value) { payload = value; throw new Error("Network intentionally blocked after payload capture"); } }).result();
  assert.ok(payload.tools[0].input_schema.properties.action, "Direct Anthropic activation must retain actionable parameters");
  assert.ok(payload.tools[0].input_schema.properties.tasks);
  assert.ok(payload.tools[0].input_schema.properties.details);
  const job = await completedJob(scope, directory, "review", "Critical finding");
  const failed = await run(`const r=await tools.subagents({action:'read',id:'${job.id}'}); if(!r.ok)throw Error(r.error); store('receipt',r.data.receipt); throw Error('script failed after read');`);
  assert.equal(failed.isError, true);
  assert.equal((await jobs(scope))[0].cursor, 0);
  assert.match(outputText(await run("text({receipt:load('receipt')??null});")), /"receipt":null/);
  const delivered = await run(`const r=await tools.subagents({action:'read',id:'${job.id}'}); text(r);`);
  assert.match(outputText(delivered), /Critical finding/);
  assert.equal(delivered.nestedCalls.calls[0].name, "subagents");
  const page = await readReport(scope, job.id);
  const ack = await run(`text(await tools.subagents({action:'ack',receipt:${JSON.stringify(page.receipt)}}));`);
  assert.equal(ack.isError, false);
  assert.equal((await jobs(scope))[0].collected, true);
  const error = await run("const r=await tools.subagents({action:'read',id:'000000000000'});text({ok:r.ok,error:r.error});");
  assert.equal(error.isError, false, "structured subagent errors resolve as data in scripts");
  assert.match(outputText(error), /\"ok\":false/);
});

test("canonical next recipe executes verbatim with typed discovery, later acknowledgements and lost-response retry", { timeout: 30000 }, async (t) => {
  const guide = await readFile(new URL("../skills/herdr-subagents/orchestration.md", import.meta.url), "utf8");
  const scripts = [...guide.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.equal(scripts.length, 4, "Execute actual discovery/prepare/spawn/cycle snippets");
  let loseResponse = false;
  let loseSpawnResponse = true;
  let admitted;
  let admissions = 0;
  const content = "Finding\n\"Unicode: 界😀\"\n".repeat(1000);
  const { directory, session, scope, run } = await fixture(t, (pi) => {
    registerSubagentTools({ registerTool(definition) {
      pi.registerTool({ ...definition, async execute(...args) {
        // Real preparation/admission/report operations; only Herdr execution is fake.
        const result = await definition.execute(...args);
        if (args[1].action === "spawn" && result.structuredContent.ok) {
          if (!admitted) {
            const [job] = await jobs(scope);
            await atomic(join(scope.root, job.id, "done.json"), { state: "done", report: content }, true);
            await atomic(join(scope.root, job.id, "shutdown.json"), { verified: true }, true);
            admitted = { input: args[1], id: job.id };
            admissions++;
          } else {
            assert.deepEqual(args[1], admitted.input, "Retry preserves the committed ID");
            assert.equal(result.structuredContent.data.jobs[0].id, admitted.id, "Actual admission replay returns the original job");
          }
          if (loseSpawnResponse) { loseSpawnResponse = false; throw Error("Fixture lost spawn response"); }
        }
        // Real native operations commit, but this response never reaches the VM.
        if (args[1].action === "next" && loseResponse) {
          loseResponse = false;
          throw Error("Fixture lost response after native next");
        }
        return result;
      } });
    } });
  });
  const backend = join(directory, "fake-herdr.mjs");
  const calls = join(directory, "calls.jsonl");
  await writeFile(backend, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
const action=process.argv[3], pane={pane_id:'worker',terminal_id:'terminal'};
const result=action==='list'?{panes:[pane]}:action==='layout'?{layout:{panes:[{pane_id:'parent',rect:{width:100,height:40}}]}}:{pane:action==='current'?{pane_id:'parent'}:pane};
if(action!=='run')console.log(JSON.stringify({result}));
`);
  await chmod(backend, 0o700);
  process.env.HERDR_BIN_PATH = backend;
  process.env.PI_HERDR_PI_BIN = process.execPath;
  const discovery = await run(scripts[0]);
  assert.equal(discovery.isError, false);
  const declaration = outputText(discovery);
  for (const field of ["reports:", "errors:", "pending:", "closed:", "receipt:", "acknowledgementRequired:", "finished:", "ok: false", 'action: "next"']) assert.ok(declaration.includes(field), field);
  assert.doesNotMatch(declaration, /data\??: unknown/);
  assert.doesNotMatch(declaration, /truncated output/i);
  assert.ok(declaration.length < 20000, "Deferred discovery must stay bounded and usable");
  const fullDeclaration = outputText(await run('text(await describeTool("subagents"));'));
  assert.ok(declaration.length < fullDeclaration.length * 0.7, "Narrow discovery should be materially smaller than the complete interface");
  assert.ok(fullDeclaration.includes('action: "configure"'));
  assert.ok(!declaration.includes('action: "configure"'));
  assert.ok(declaration.includes("tasks:"), "Preparation requires tasks; ID-only spawn does not");
  assert.ok(declaration.includes('action: "prepare"'));
  t.diagnostic(`Discovery including wrappers: narrow ${declaration.length}, full ${fullDeclaration.length} characters`);
  assert.ok(!session.getActiveToolNames().includes("subagents"));
  const prepared = await run(scripts[1]);
  assert.equal(prepared.isError, false, outputText(prepared));
  assert.equal(prepared.nestedCalls.calls.length, 1, "One native preparation call");
  assert.deepEqual(await jobs(scope), [], "Preparation has no launch side effects");
  await assert.rejects(readFile(calls), { code: "ENOENT" }, "Preparation must not contact Herdr");
  const stored = outputText(await run('text(load("herdr.operation"));'));
  assert.match(stored, /"requestId":"[A-Za-z0-9_.:-]+"/);
  assert.ok(stored.length < 200);
  assert.doesNotMatch(stored, /tasks|prompt|Review src/);
  assert.equal((await run(scripts[1])).isError, true, "Preparation cannot overwrite an existing retry identity");
  assert.equal((await run(scripts[2])).isError, true, "Host admission survived a lost spawn response");
  assert.equal(outputText(await run('text(load("herdr.operation"));')), stored, "Separate preparation remains committed after spawn failure");
  assert.equal((await run(scripts[2])).isError, false);
  assert.equal(admissions, 1);
  const received = [];
  let expectedCursor = 0;
  let iterations = 0;
  while (true) {
    if (iterations === 1) {
      loseResponse = true;
      assert.equal((await run(scripts[3])).isError, true);
      assert.equal((await jobs(scope))[0].cursor, expectedCursor, "Prior ack survived lost response; newly issued pages did not advance it");
    }
    const delivered = await run(scripts[3]);
    assert.equal(delivered.isError, false, outputText(delivered));
    assert.equal(delivered.nestedCalls.calls.length, 1, "One host call per cycle");
    assert.equal(delivered.nestedCalls.calls[0].name, "subagents");
    assert.ok(Buffer.byteLength(outputText(delivered)) < 12000);
    const batch = JSON.parse(outputText(delivered).split("\n").find((line) => line.startsWith('{"reports":')));
    assert.deepEqual(batch.errors, []);
    assert.equal(batch.acknowledgementRequired, batch.reports.length > 0);
    assert.equal(batch.finished, batch.reports.length === 0 && batch.pending === 0);
    const current = (await jobs(scope))[0];
    assert.equal(current.cursor, expectedCursor);
    assert.equal(current.closed === true, current.collected === true, "Only previously acknowledged complete jobs close");
    if (!batch.reports.length) {
      assert.equal(batch.pending, 0);
      assert.deepEqual(batch.closed, [current.task.name]);
      break;
    }
    assert.equal(batch.reports.length, 1);
    const page = batch.reports[0];
    assert.equal(page.offset, expectedCursor);
    received.push(page.text); // Consumption precedes the next model call.
    expectedCursor += page.text.length;
    assert.ok(++iterations < 10);
  }
  assert.ok(iterations > 1);
  assert.equal(received.join(""), content);
  assert.equal(expectedCursor, content.length);
  assert.match(outputText(await run('text(load("herdr.receipts"));')), /\[\]/);
  await run('store("herdr.operation",undefined);');
  assert.equal((await run(scripts[1])).isError, false);
  assert.notEqual(outputText(await run('text(load("herdr.operation"));')), stored, "Genuinely new work gets a fresh ID");
  assert.equal(admissions, 1, "Preparing new work cannot spawn");
  const hostCalls = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(hostCalls.filter((args) => args[1] === "split").length, 1);
  assert.equal(hostCalls.filter((args) => args[1] === "run").length, 1, "A lost spawn response never launches a duplicate worker");
});

test("native preparation survives lost replies without launch and stores only IDs for large payloads", { timeout: 30000 }, async (t) => {
  const guide = await readFile(new URL("../skills/herdr-subagents/orchestration.md", import.meta.url), "utf8");
  const prepare = [...guide.matchAll(/```js\n([\s\S]*?)\n```/g)][1][1];
  let loseReply = true;
  const { scope, run } = await fixture(t, (pi) => {
    registerSubagentTools({ registerTool(definition) {
      pi.registerTool({ ...definition, async execute(...args) {
        const result = await definition.execute(...args);
        if (args[1].action === "prepare" && result.structuredContent.ok && loseReply) {
          loseReply = false;
          throw Error("Lost preparation reply after private commit");
        }
        return result;
      } });
    } });
  });
  assert.equal((await run(prepare)).isError, true);
  assert.deepEqual(await jobs(scope), []);
  assert.match(outputText(await run('text(load("herdr.operation")??null);')), /null/);
  assert.equal((await readdir(join(scope.root, "requests"))).length, 1, "An unused draft may survive a lost reply");
  assert.equal((await run(prepare)).isError, false, "Fresh preparation is safe here because no spawn was attempted");
  assert.equal((await readdir(join(scope.root, "requests"))).length, 2);
  const large = await run(`const r=await tools.subagents({action:"prepare",tasks:Array.from({length:3},(_,i)=>({name:"large"+i,prompt:"x".repeat(100000)}))});
if(!r.ok)throw Error(JSON.stringify(r));store("large.operation",r.data);text(r.data);`);
  assert.equal(large.isError, false, outputText(large));
  const stored = outputText(await run('text(load("large.operation"));'));
  assert.ok(stored.length < 200);
  assert.doesNotMatch(stored, /tasks|prompt/);
  const records = await Promise.all((await readdir(join(scope.root, "requests"))).map(async (name) => JSON.parse(await readFile(join(scope.root, "requests", name), "utf8"))));
  assert.ok(records.some((record) => JSON.stringify(record.intent).length > 262144));
  assert.ok(records.every((record) => record.state === "prepared"));
  assert.deepEqual(await jobs(scope), []);
});

test("documented opt-in progress arguments execute without changing the default cycle", { timeout: 30000 }, async (t) => {
  const guide = await readFile(new URL("../skills/herdr-subagents/orchestration.md", import.meta.url), "utf8");
  const args = guide.match(/`(\{action:"next",[^`]+details:true\})`/)[1];
  const { run } = await fixture(t);
  const result = await run(`text(await tools.subagents(${args}));`);
  assert.equal(result.isError, false, outputText(result));
  const value = JSON.parse(outputText(result).split("\n").find((line) => line.startsWith('{"ok":')));
  assert.equal(value.ok, true);
  assert.equal(value.data.finished, true);
  assert.deepEqual(value.data.pendingWorkers, []);
});

test("advanced manual recipe retains separate acknowledgement and unread-store guard", { timeout: 30000 }, async (t) => {
  const guide = await readFile(new URL("../skills/herdr-subagents/manual.md", import.meta.url), "utf8");
  const scripts = [...guide.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.equal(scripts.length, 2);
  const { directory, scope, run } = await fixture(t);
  await completedJob(scope, directory, "manual", "Manual report");
  assert.equal((await run(scripts[0])).isError, false);
  assert.equal((await jobs(scope))[0].cursor, 0);
  assert.equal((await run(scripts[0])).isError, true);
  assert.equal((await run(scripts[1])).isError, false);
  assert.equal((await jobs(scope))[0].collected, true);
  assert.equal((await jobs(scope))[0].closed, true);
  assert.equal((await run(scripts[1])).isError, true);
});
