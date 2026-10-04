import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openCoordinator } from "../extensions/herdr-subagents/durable/engine.ts";
import { AgentDoc, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

// Never discover real providers or inspect credentials, even on authenticated hosts.
const model = { provider: "faux", modelId: "faux-1" };
function scripted(responses, options = {}) {
	const faux = fauxProvider(options);
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return { models, faux };
}
const spawn = (requestId = "first", extra = {}) => ({ action: "spawn", requestId, name: requestId, prompt: "Complete this task", model, ...extra });
async function until(check, timeout = 10000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await delay(20);
	}
	throw new Error("Timed out");
}
async function fixture(t, script) {
	const directory = await mkdtemp(join(tmpdir(), "durable-engine-"));
	let engine = await openCoordinator(directory, script.models, directory);
	t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
	return { directory, get engine() { return engine; }, async reopen(next = script, cwd = directory) {
		await engine.close();
		engine = await openCoordinator(directory, next.models, cwd);
		return engine;
	} };
}
async function report(engine, id) {
	return until(async () => { const page = await engine.dispatch({ action: "read", id }); return page.ready ? page : undefined; });
}

test("successful turn, strict requests, idempotency, persistent conversation and explicit report delivery", async (t) => {
	const seen = [];
	const script = scripted([
		(context) => {
			seen.push(context);
			return fauxAssistantMessage([fauxThinking("private reasoning"), { type: "text", text: "First answer" }]);
		},
		(context) => { seen.push(context); return fauxAssistantMessage("Second answer"); },
	]);
	const f = await fixture(t, script);
	const request = spawn();
	const first = await f.engine.dispatch(request);
	assert.equal(first.id, first.reportId);
	assert.deepEqual(await f.engine.dispatch(request), first);
	assert.deepEqual(await Promise.all([f.engine.dispatch(request), f.engine.dispatch(request)]), [first, first]);
	for (const field of ["thinking", "tools", "cwd"]) await assert.rejects(f.engine.dispatch({ ...request, [field]: null }), /Invalid/);
	await assert.rejects(f.engine.dispatch({ action: "wait", seconds: null }), /seconds/);
	await assert.rejects(f.engine.dispatch({ ...request, prompt: "changed" }), /collision/);
	await assert.rejects(f.engine.dispatch({ ...request, surprise: true }), /Unknown field/);
	await assert.rejects(f.engine.dispatch({ action: "wait", seconds: 61 }), /seconds/);
	await assert.rejects(f.engine.dispatch({ action: "status", offset: 0.5 }), /offset/);
	await assert.rejects(f.engine.dispatch({ action: "resume", model }), /Unknown field/);
	await assert.rejects(f.engine.dispatch({ action: "spawn", requestId: "bad", name: "bad", prompt: "x", model: { ...model, extra: 1 } }), /Unknown field/);
	await until(async () => (await f.engine.dispatch({ action: "status" })).jobs[0].reportReady);
	let status = await f.engine.dispatch({ action: "status" });
	assert.equal(status.jobs[0].visible, false);
	assert.equal(status.unread, 1);
	assert.ok(!JSON.stringify(status).includes("First answer"));
	assert.ok(!JSON.stringify(status).includes("private reasoning"));
	assert.ok(status.taskGraph);
	assert.ok(status.usage.models.length > 0);
	const page = await report(f.engine, first.id);
	assert.equal(page.text, "First answer");
	assert.deepEqual(await f.engine.dispatch({ action: "read", id: first.id }), page);
	assert.equal(script.faux.state.callCount, 1, "no report-triggered parent turn");
	const offered = seen[0].messages.filter((message) => message.role === "system").flatMap((message) => message.toolsAdded ?? []);
	assert.deepEqual(offered.map((tool) => tool.name), ["read"]);
	const send = { action: "send", id: first.id, requestId: "send-1", message: "Continue", kind: "follow_up" };
	const second = await f.engine.dispatch(send);
	assert.notEqual(second.id, first.id);
	assert.equal(second.conversationId, first.conversationId);
	assert.deepEqual(await f.engine.dispatch(send), second);
	await assert.rejects(f.engine.dispatch({ ...send, kind: "steer" }), /collision/);
	assert.equal((await report(f.engine, second.id)).text, "Second answer");
	assert.ok(JSON.stringify(seen[1]).includes("First answer"));
	await f.reopen();
	assert.deepEqual(await f.engine.dispatch(request), first);
	assert.deepEqual(await f.engine.dispatch({ action: "read", id: first.id }), page);
	const acknowledged = await f.engine.dispatch({ action: "ack", receipt: page.receipt });
	assert.equal(acknowledged.acknowledged, true);
	assert.deepEqual(await f.engine.dispatch({ action: "ack", receipt: page.receipt }), acknowledged);
	await f.reopen();
	status = await f.engine.dispatch({ action: "status" });
	assert.equal(status.jobs[0].acknowledged, true);
	assert.equal(status.jobs[0].visible, true);
	assert.equal(script.faux.state.callCount, 2);
});

test("durable admission stores explicit intent and first settings across concurrent retries and changed defaults", async (t) => {
	const script = scripted([fauxAssistantMessage("Original settings")]);
	const originalOpen = Harness.open;
	let captured;
	Harness.open = async (...args) => { captured = await originalOpen(...args); return captured; };
	t.after(() => { Harness.open = originalOpen; });
	const f = await fixture(t, script);
	const intent = { action: "spawn", requestId: "stable", name: "stable", prompt: "Inspect" };
	const defaults = { model, thinking: "high", cwd: f.directory };
	const changed = { model: { provider: "unavailable", modelId: "deleted" }, thinking: "off", cwd: "/missing/changed" };
	const [first, duplicate] = await Promise.all([
		f.engine.dispatch({ ...intent, defaults }),
		f.engine.dispatch({ ...intent, defaults: changed }),
	]);
	assert.deepEqual(duplicate, first);
	assert.equal((await report(f.engine, first.id)).text, "Original settings");
	const saved = await captured.snapshot(AgentDoc, first.conversationId, BACKGROUND_CONTEXT);
	assert.deepEqual(saved.model, model);
	assert.equal(saved.thinkingLevel, "high");
	assert.equal(saved.cwd, f.directory);
	assert.deepEqual(saved.tools, ["read"]);
	for (const extra of [{ defaults: changed }, {}, { defaults: {} }]) assert.deepEqual(await f.engine.dispatch({ ...intent, ...extra }), first);
	for (const explicit of [{ prompt: "different" }, { name: "different" }, { model }, { thinking: "high" }, { cwd: f.directory }, { tools: "read-only" }]) {
		await assert.rejects(f.engine.dispatch({ ...intent, ...explicit, defaults }), /collision/);
	}
	for (const defaults of [{ prompt: "hidden payload" }, { tools: "coding" }, { fingerprint: "forged" }]) {
		await assert.rejects(f.engine.dispatch({ ...intent, defaults }), /Unknown field/);
	}
	await f.reopen(script, "/missing/new-coordinator-cwd");
	assert.deepEqual(await f.engine.dispatch({ ...intent, defaults: changed }), first);
	assert.deepEqual(await captured.snapshot(AgentDoc, first.conversationId, BACKGROUND_CONTEXT), saved);
	assert.equal(script.faux.state.callCount, 1);
	assert.equal((await f.engine.dispatch({ action: "status" })).total, 1);
});

test("direct durable callers retain omitted cwd/thinking identity when the coordinator cwd changes", async (t) => {
	const script = scripted([fauxAssistantMessage("Direct request")]);
	const f = await fixture(t, script);
	const request = spawn("direct");
	const first = await f.engine.dispatch(request);
	await report(f.engine, first.id);
	await f.reopen(script, "/changed-coordinator");
	assert.deepEqual(await f.engine.dispatch(request), first);
	await assert.rejects(f.engine.dispatch({ ...request, cwd: f.directory }), /collision/);
	await assert.rejects(f.engine.dispatch({ ...request, thinking: "off" }), /collision/);
	assert.equal(script.faux.state.callCount, 1);
});

test("immutable UTF-16 pages, read replay and contiguous idempotent receipts survive restart", async (t) => {
	const answer = "a".repeat(8191) + "\u{1f680}" + "b".repeat(9000);
	const f = await fixture(t, scripted([fauxAssistantMessage(answer)]));
	const job = await f.engine.dispatch(spawn());
	const first = await report(f.engine, job.id);
	assert.equal(first.text.length, 8191);
	assert.equal(first.nextOffset, 8191);
	const second = await f.engine.dispatch({ action: "read", id: job.id, offset: first.nextOffset });
	assert.ok(second.text.startsWith("\u{1f680}"));
	await assert.rejects(f.engine.dispatch({ action: "ack", receipt: second.receipt }), /contiguously/);
	await assert.rejects(f.engine.dispatch({ action: "read", id: job.id, offset: 8192 }), /boundary/);
	await assert.rejects(f.engine.dispatch({ action: "ack", receipt: "forged" }), /Unknown receipt/);
	await f.reopen();
	assert.deepEqual(await f.engine.dispatch({ action: "read", id: job.id }), first);
	assert.deepEqual(await f.engine.dispatch({ action: "read", id: job.id, offset: first.nextOffset }), second);
	assert.equal((await f.engine.dispatch({ action: "ack", receipt: first.receipt })).acknowledged, false);
	await f.engine.dispatch({ action: "ack", receipt: second.receipt });
	const third = await f.engine.dispatch({ action: "read", id: job.id, offset: second.nextOffset });
	assert.equal(first.text + second.text + third.text, answer);
	assert.equal((await f.engine.dispatch({ action: "ack", receipt: third.receipt })).acknowledged, true);
	assert.equal((await f.engine.dispatch({ action: "ack", receipt: first.receipt })).acknowledged, true);
});

test("restart mid-generation stays paused on open/status/read/wait/retry until explicit resume", async (t) => {
	const slow = scripted([fauxAssistantMessage("slow answer ".repeat(1000))], { tokensPerSecond: 10 });
	const f = await fixture(t, slow);
	const request = { action: "spawn", requestId: "paused", name: "paused", prompt: "Inspect", defaults: { model, thinking: "high", cwd: f.directory } };
	const job = await f.engine.dispatch(request);
	await until(() => slow.faux.state.callCount === 1);
	const next = scripted([fauxAssistantMessage("Recovered")]);
	await f.reopen(next);
	assert.equal((await f.engine.dispatch({ action: "status" })).recoveryRequired, true);
	assert.equal((await f.engine.dispatch({ action: "read", id: job.id })).ready, false);
	await f.engine.dispatch({ action: "wait", seconds: 0.1 });
	assert.deepEqual(await f.engine.dispatch({ ...request, defaults: {} }), job);
	await assert.rejects(f.engine.dispatch({ ...request, prompt: "changed", defaults: {} }), /collision/);
	await assert.rejects(f.engine.dispatch(spawn("new")), /explicit resume/);
	await delay(150);
	assert.equal(next.faux.state.callCount, 0);
	await f.engine.dispatch({ action: "resume" });
	assert.equal((await report(f.engine, job.id)).text, "Recovered");
	assert.equal(next.faux.state.callCount, 1);
	await f.reopen(next);
	assert.equal((await f.engine.dispatch({ action: "read", id: job.id })).text, "Recovered");
	assert.equal(next.faux.state.callCount, 1);
});

test("cancel intent and abort marks survive a second restart before scheduler recovery", async (t) => {
	const slow = scripted([fauxAssistantMessage("never finish ".repeat(1000))], { tokensPerSecond: 10 });
	const f = await fixture(t, slow);
	const request = { action: "spawn", requestId: "cancelled", name: "cancelled", prompt: "Inspect", defaults: { model, cwd: f.directory } };
	const job = await f.engine.dispatch(request);
	await until(() => slow.faux.state.callCount === 1);
	const noCalls = scripted([]);
	await f.reopen(noCalls);
	const cancellation = { action: "cancel", requestId: "cancel-1", id: job.id };
	const receipt = await f.engine.dispatch(cancellation);
	assert.deepEqual(await f.engine.dispatch(cancellation), receipt);
	await assert.rejects(f.engine.dispatch({ ...cancellation, id: "all" }), /collision/);
	await f.reopen(noCalls);
	assert.equal((await f.engine.dispatch({ action: "status" })).scheduling, "paused");
	assert.equal(noCalls.faux.state.callCount, 0);
	await f.engine.dispatch({ action: "resume" });
	assert.equal((await report(f.engine, job.id)).outcome, "cancelled");
	assert.deepEqual(await f.engine.dispatch({ ...request, defaults: {} }), job);
	assert.equal(noCalls.faux.state.callCount, 0);
	await f.reopen(noCalls);
	await f.engine.dispatch({ action: "resume" });
	assert.equal((await report(f.engine, job.id)).outcome, "cancelled");
	assert.equal(noCalls.faux.state.callCount, 0);
});

test("provider failure produces durable replayable failure report", async (t) => {
	const script = scripted([fauxAssistantMessage("", { stopReason: "error", errorMessage: "scripted provider failure" })]);
	const f = await fixture(t, script);
	const job = await f.engine.dispatch(spawn());
	const page = await report(f.engine, job.id);
	assert.equal(page.outcome, "failed");
	assert.match(page.text, /model_error/);
	assert.match(page.text, /scripted provider failure/);
	await f.reopen();
	assert.deepEqual(await f.engine.dispatch({ action: "read", id: job.id }), page);
	await f.engine.dispatch({ action: "ack", receipt: page.receipt });
});

test("coding tools execute a failed script through the real durable tool task", async (t) => {
	let result;
	const script = scripted([
		fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'failure evidence'; exit 7" }), { stopReason: "toolUse" }),
		(context) => {
			result = context.messages.findLast((message) => message.role === "toolResult");
			return fauxAssistantMessage("The script failed with exit 7.");
		},
	]);
	const f = await fixture(t, script);
	const job = await f.engine.dispatch(spawn("script", { tools: "coding" }));
	assert.equal((await report(f.engine, job.id)).text, "The script failed with exit 7.");
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /failure evidence/);
	assert.match(JSON.stringify(result.content), /7/);
});

test("unsafe bash interruption is not replayed: actual durable intent boundary returns interrupted", async (t) => {
	const initial = scripted([
		fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'once\\n' >> effects.txt; sleep 30" }), { stopReason: "toolUse" }),
	]);
	const f = await fixture(t, initial);
	const job = await f.engine.dispatch(spawn("unsafe", { tools: "coding" }));
	await until(async () => { try { return (await readFile(join(f.directory, "effects.txt"), "utf8")) === "once\n"; } catch { return false; } });
	let result;
	const recovered = scripted([(context) => {
		result = context.messages.findLast((message) => message.role === "toolResult");
		return fauxAssistantMessage("Interrupted side effect requires inspection.");
	}]);
	await f.reopen(recovered);
	await f.engine.dispatch({ action: "status" });
	await f.engine.dispatch({ action: "read", id: job.id });
	await delay(100);
	assert.equal(recovered.faux.state.callCount, 0);
	await f.engine.dispatch({ action: "resume" });
	assert.equal((await report(f.engine, job.id)).text, "Interrupted side effect requires inspection.");
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result.content), /interrupt/i);
	assert.equal(await readFile(join(f.directory, "effects.txt"), "utf8"), "once\n");
});

test("read tool and default read-only enforcement use real durable core", async (t) => {
	const results = [];
	const script = scripted([
		fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
		(context) => { results.push(context.messages.findLast((message) => message.role === "toolResult")); return fauxAssistantMessage(fauxToolCall("bash", { command: "touch forbidden" }), { stopReason: "toolUse" }); },
		(context) => { results.push(context.messages.findLast((message) => message.role === "toolResult")); return fauxAssistantMessage("Read without shell access."); },
	]);
	const f = await fixture(t, script);
	await writeFile(join(f.directory, "input.txt"), "durable file evidence");
	const job = await f.engine.dispatch(spawn());
	await report(f.engine, job.id);
	assert.match(JSON.stringify(results[0].content), /durable file evidence/);
	assert.equal(results[1].isError, true);
	await assert.rejects(readFile(join(f.directory, "forbidden")), /ENOENT/);
});

test("steers have independent reports even when one final answer settles both inputs", async (t) => {
	let finalContext;
	const script = scripted([
		fauxAssistantMessage(fauxToolCall("bash", { command: "touch steering-ready; sleep 0.3" }), { stopReason: "toolUse" }),
		(context) => { finalContext = context; return fauxAssistantMessage("Shared final answer"); },
	]);
	const f = await fixture(t, script);
	const first = await f.engine.dispatch(spawn("steering", { tools: "coding" }));
	await until(async () => { try { await readFile(join(f.directory, "steering-ready")); return true; } catch { return false; } });
	const second = await f.engine.dispatch({ action: "send", id: first.id, requestId: "steer", message: "Include this steering message", kind: "steer" });
	const a = await report(f.engine, first.id);
	const b = await report(f.engine, second.id);
	assert.notEqual(a.id, b.id);
	assert.equal(a.conversationId, b.conversationId);
	assert.equal(a.text, b.text);
	assert.notEqual(a.receipt, b.receipt);
	assert.match(JSON.stringify(finalContext), /Include this steering message/);
	assert.equal(script.faux.state.callCount, 2);
});

test("large reports remain lossless through byte-bounded pages; empty answers have receipts", async (t) => {
	const answer = "x".repeat(300000) + "\u0000\n😀中文".repeat(3000);
	const script = scripted([fauxAssistantMessage(answer), fauxAssistantMessage("")]);
	const f = await fixture(t, script);
	const large = await f.engine.dispatch(spawn("large"));
	let page = await report(f.engine, large.id);
	assert.equal(page.text.length, 8192);
	assert.equal(page.totalUnits, answer.length);
	assert.equal(page.truncated, false);
	let received = "";
	while (true) {
		assert.ok(Buffer.byteLength(JSON.stringify(page)) < 12000);
		received += page.text;
		const ack = await f.engine.dispatch({ action: "ack", receipt: page.receipt });
		assert.equal(ack.acknowledged, page.nextOffset === null);
		if (page.nextOffset === null) break;
		page = await f.engine.dispatch({ action: "read", id: large.id, offset: page.nextOffset });
	}
	assert.equal(received, answer);
	const empty = await f.engine.dispatch(spawn("empty"));
	const emptyPage = await report(f.engine, empty.id);
	assert.equal(emptyPage.text, "");
	assert.equal(emptyPage.nextOffset, null);
	assert.equal((await f.engine.dispatch({ action: "ack", receipt: emptyPage.receipt })).acknowledged, true);
});

test("cancellation cannot miss a generation-to-tool handoff behind a stale task inspection", async (t) => {
	let release;
	const response = new Promise((resolve) => { release = resolve; });
	const script = scripted([
		async () => { await response; return fauxAssistantMessage(fauxToolCall("bash", { command: "echo escaped > cancellation-escaped" }), { stopReason: "toolUse" }); },
		fauxAssistantMessage("Must not run a successor turn"),
	]);
	const originalOpen = Harness.open;
	let captured, originalInspect, fallback, f, job;
	let armed = true;
	try {
		Harness.open = async (...args) => { captured = await originalOpen(...args); return captured; };
		f = await fixture(t, script);
		Harness.open = originalOpen;
		job = await f.engine.dispatch(spawn("handoff", { tools: "coding" }));
		await until(() => script.faux.state.callCount === 1);
		originalInspect = captured.inspect;
		captured.inspect = async function (...args) {
			const snapshot = await originalInspect.apply(this, args);
			if (armed) { release(); await delay(750); }
			return snapshot;
		};
		fallback = setTimeout(release, 100);
		await f.engine.dispatch({ action: "cancel", id: job.id, requestId: "stop-handoff" });
	} finally {
		armed = false; clearTimeout(fallback); release(); Harness.open = originalOpen;
		if (captured && originalInspect) captured.inspect = originalInspect;
	}
	assert.equal((await report(f.engine, job.id)).outcome, "cancelled");
	await assert.rejects(readFile(join(f.directory, "cancellation-escaped")), /ENOENT/);
	assert.equal(script.faux.state.callCount, 1);
});

test("durable coding shells inherit the recursive-delegation fence", async (t) => {
	let result;
	const script = scripted([
		fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'worker=%s' \"$PI_HERDR_WORKER\"" }), { stopReason: "toolUse" }),
		(context) => { result = context.messages.findLast((message) => message.role === "toolResult"); return fauxAssistantMessage("Checked fence"); },
	]);
	const f = await fixture(t, script);
	const job = await f.engine.dispatch(spawn("fence", { tools: "coding" }));
	await report(f.engine, job.id);
	assert.match(JSON.stringify(result.content), /worker=1/);
});

test("wait does not block cancellation; cancel all stops active and queued intents durably", async (t) => {
	const script = scripted(Array.from({ length: 5 }, () => fauxAssistantMessage("slow ".repeat(1000))), { tokensPerSecond: 10 });
	const f = await fixture(t, script);
	for (let index = 0; index < 5; index++) await f.engine.dispatch(spawn(`cancel-${index}`));
	await until(() => script.faux.state.callCount === 4);
	const waiting = f.engine.dispatch({ action: "wait", seconds: 60 });
	await f.engine.dispatch({ action: "cancel", id: "all", requestId: "stop-all" });
	const status = await waiting;
	assert.ok(status.unread > 0);
	assert.equal((await f.engine.dispatch({ action: "status" })).liveJobs, 0);
	const next = scripted([]);
	await f.reopen(next);
	await f.engine.dispatch({ action: "resume" });
	assert.equal(next.faux.state.callCount, 0);
	assert.ok((await f.engine.dispatch({ action: "status" })).jobs.every((job) => job.status === "cancelled"));
});

test("four concurrent children, sixteen live jobs, queued submission intents and cancel all", async (t) => {
	const slow = scripted(Array.from({ length: 20 }, () => fauxAssistantMessage("long response ".repeat(1000))), { tokensPerSecond: 10 });
	const f = await fixture(t, slow);
	const jobs = [];
	for (let index = 0; index < 16; index++) jobs.push(await f.engine.dispatch(spawn(`job-${index}`)));
	await until(() => slow.faux.state.callCount === 4);
	assert.equal(slow.faux.state.callCount, 4);
	await assert.rejects(f.engine.dispatch(spawn("overflow")), /16 live/);
	const status = await f.engine.dispatch({ action: "status" });
	assert.equal(status.jobs.filter((job) => job.status === "queued").length, 12);
	const fresh = scripted(Array.from({ length: 20 }, () => fauxAssistantMessage("Recovered queued intent")));
	await f.reopen(fresh);
	assert.equal(fresh.faux.state.callCount, 0);
	// Cancel the four already-submitted children while paused. The remaining 12
	// have only application intents; explicit resume must submit each exactly once.
	for (const job of jobs.slice(0, 4)) await f.engine.dispatch({ action: "cancel", id: job.id, requestId: `stop-${job.id}` });
	await f.engine.dispatch({ action: "resume" });
	await until(async () => (await f.engine.dispatch({ action: "status" })).jobs.every((job) => job.reportReady));
	assert.equal(fresh.faux.state.callCount, 12);
	assert.equal((await report(f.engine, jobs[4].id)).text, "Recovered queued intent");
	await f.engine.dispatch({ action: "cancel", id: "all", requestId: "all-done" });
	await f.reopen(fresh);
	await f.engine.dispatch({ action: "resume" });
	assert.equal(fresh.faux.state.callCount, 12);
});
