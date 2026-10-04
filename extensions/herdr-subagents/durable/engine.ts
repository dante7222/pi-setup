/**
 * EXPERIMENTAL pi-durable backend, deliberately separate from ordinary Pi workers.
 * Only durable's built-in read/write/edit/bash are installed. There is NO automatic
 * ordinary extension, skill, prompt, AGENTS.md, MCP, or permissions discovery.
 * `read-only` offers only read; it is a tool selection, not a filesystem sandbox.
 * Unsafe tool intents use durable's default interrupted-result policy, not an
 * exactly-once external-effects promise. JSONL fsync flushes sidecars; upstream
 * does not fsync every main marker, so this is not a power-loss durability claim.
 *
 * The server MUST exclusively hold its process lease before opening this engine,
 * and retain it until close resolves. Never open this storage in another process.
 * Reopened unfinished work requires explicit resume (including before new work).
 * cancel is conversation-wide, including queued sends; close is NOT cancellation.
 * Report IDs identify submissions, not conversations. No reports enter a parent
 * model automatically. Pages use UTF-16 offsets, fixed boundaries and persisted
 * receipts; only a contiguous read prefix may be acknowledged. This prototype
 * retains request IDs, conversations and reports indefinitely (no pruning), and
 * disables automatic retries/compaction. Status responses are bounded, but the
 * session archive and the cost of whole-session usage aggregation grow over time.
 * Upstream inbox semantics apply: follow-ups queued behind a failed run remain
 * queued until a new send triggers an idle boundary (resume alone is not a retry).
 */
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AssistantEntry, configure, createRegistry, defineDoc, defineExtension,
	GenerationTask, Harness, hook, type ConversationId, type SubmissionId,
} from "@earendil-works/pi-durable";
import { createDurableEnvironment, recoverExecutions } from "./environment.ts";
import { requestFingerprint } from "../core.ts";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools, createReadTool } from "@earendil-works/pi-durable/tools";

export type ThinkingLevel = ModelThinkingLevel;
export type { Models, JsonValue };
export interface Coordinator {
	dispatch(request: unknown): Promise<JsonValue>;
	close(): Promise<void>;
}

const context = BACKGROUND_CONTEXT;
const PAGE_UNITS = 8192;
const PAGE_BYTES = 12_000;
const MAX_LIVE = 16;
const MAX_CHILDREN = 4;
const readTool = createReadTool();
type Receipt = { token: string; offset: number; nextOffset: number };
type Report = { text: string; truncated: boolean; outcome: string; visible: boolean; ackedThrough: number; acknowledged: boolean; receipts: Receipt[] };
type Job = {
	id: string; name: string; conversationId: ConversationId; message: string;
	kind: "steer" | "follow_up"; submissionId: SubmissionId | null;
	cancelled: boolean; report: Report | null;
};
type RequestRecord = { requestId: string; fingerprint: string; result: JsonValue; intent?: JsonValue; execution?: JsonValue };
type Cancellation = { requestId: string; conversations: ConversationId[]; done: boolean };
type State = { jobs: Job[]; requests: RequestRecord[]; cancellations: Cancellation[] };
const App = defineDoc<State>({
	kind: "herdr.durable.coordinator", version: 1, scope: "session",
	initial: () => ({ jobs: [], requests: [], cancellations: [] }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
});

type Spawn = { action: "spawn"; requestId: string; name: string; prompt: string; model: { provider: string; modelId: string }; thinking: ThinkingLevel; cwd: string; tools: "read-only" | "coding" };
type SpawnSettings = Partial<Pick<Spawn, "model" | "thinking" | "cwd">>;
type SpawnIntent = Pick<Spawn, "action" | "requestId" | "name" | "prompt"> & SpawnSettings & { tools?: Spawn["tools"] };
type SpawnRequest = SpawnIntent & { defaults?: SpawnSettings };
type Send = { action: "send"; id: string; requestId: string; message: string; kind: "steer" | "follow_up" };
type Request = SpawnRequest | Send | { action: "status"; offset: number } | { action: "wait"; seconds: number }
	| { action: "read"; id: string; offset: number } | { action: "ack"; receipt: string }
	| { action: "cancel"; id: string; requestId: string } | { action: "resume" };

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an action object");
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) if (!keys.includes(key)) throw new Error(`Unknown field: ${key}`);
	return record;
}
function text(value: unknown, field: string, max = 256): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) throw new Error(`Invalid field: ${field}`);
	return value;
}
function offset(value: unknown): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid offset");
	return value;
}
function spawnSettings(record: Record<string, unknown>): SpawnSettings {
	const settings: SpawnSettings = {};
	if (record.model !== undefined) {
		const model = object(record.model, ["provider", "modelId"]);
		settings.model = { provider: text(model.provider, "provider"), modelId: text(model.modelId, "modelId") };
	}
	if (record.thinking !== undefined) {
		if (typeof record.thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(record.thinking)) throw new Error("Invalid thinking");
		settings.thinking = record.thinking as ThinkingLevel;
	}
	if (record.cwd !== undefined) settings.cwd = text(record.cwd, "cwd", 4096);
	return settings;
}
function parse(value: unknown): Request {
	// Strict JSON copying rejects accessors, symbols, undefined properties and cycles.
	const record = object(copyJson(value), ["action", "requestId", "name", "prompt", "model", "thinking", "cwd", "tools", "defaults", "id", "message", "kind", "offset", "seconds", "receipt"]);
	switch (record.action) {
		case "spawn": {
			object(record, ["action", "requestId", "name", "prompt", "model", "thinking", "cwd", "tools", "defaults"]);
			const tools = record.tools;
			if (tools !== undefined && tools !== "read-only" && tools !== "coding") throw new Error("Invalid tools");
			return { action: "spawn", requestId: text(record.requestId, "requestId"), name: text(record.name, "name", 128), prompt: text(record.prompt, "prompt", 65536),
				...spawnSettings(record), ...(tools === undefined ? {} : { tools }),
				...(record.defaults === undefined ? {} : { defaults: spawnSettings(object(record.defaults, ["model", "thinking", "cwd"])) }) };
		}
		case "send":
			object(record, ["action", "id", "requestId", "message", "kind"]);
			if (record.kind !== "steer" && record.kind !== "follow_up") throw new Error("Invalid send kind");
			return { action: "send", id: text(record.id, "id"), requestId: text(record.requestId, "requestId"), message: text(record.message, "message", 65536), kind: record.kind };
		case "status": object(record, ["action", "offset"]); return { action: "status", offset: offset(record.offset) };
		case "read": object(record, ["action", "id", "offset"]); return { action: "read", id: text(record.id, "id"), offset: offset(record.offset) };
		case "wait": {
			object(record, ["action", "seconds"]);
			const seconds = record.seconds === undefined ? 1 : record.seconds;
			if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error("seconds must be between 0 and 60");
			return { action: "wait", seconds };
		}
		case "ack": object(record, ["action", "receipt"]); return { action: "ack", receipt: text(record.receipt, "receipt") };
		case "cancel": object(record, ["action", "id", "requestId"]); return { action: "cancel", id: text(record.id, "id"), requestId: text(record.requestId, "requestId") };
		case "resume": object(record, ["action"]); return { action: "resume" };
		default: throw new Error("Unknown durable action");
	}
}
function endOfPage(value: string, start: number, units: number): number {
	let end = start;
	let bytes = 0;
	// Bound serialized bytes as well as UTF-16 units, reserving the envelope.
	// Code-point iteration never splits a surrogate pair or loses report text.
	for (const character of value.slice(start, start + units + 1)) {
		const size = Buffer.byteLength(JSON.stringify(character)) - 2;
		if (end + character.length > start + units || bytes + size > PAGE_BYTES - 1024) break;
		end += character.length;
		bytes += size;
	}
	return end;
}
function reportOf(value: string, outcome: string): Report {
	// Bound each delivery, not the stored report: acknowledgement must never
	// discard an undisclosed tail. Archives grow until explicitly retired.
	return { text: value, truncated: false, outcome, visible: false, ackedThrough: 0, acknowledged: false, receipts: [] };
}

export async function openCoordinator(directory: string, models: Models, cwd: string): Promise<Coordinator> {
	cwd = resolve(cwd);
	// No lease here: the server is the sole lease authority.
	let releaseGeneration: (() => void) | undefined;
	let generationGate: Promise<void> | undefined;
	const gateRecovery = () => { generationGate ??= new Promise<void>((resolveGate) => { releaseGeneration = resolveGate; }); };
	const awaitRecovery = async (signal?: AbortSignal): Promise<void> => {
		if (generationGate === undefined) return;
		const gate = generationGate;
		await new Promise<void>((resolveGate, reject) => {
			const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Aborted")); };
			const cleanup = () => signal?.removeEventListener("abort", abort);
			if (signal?.aborted) { abort(); return; }
			signal?.addEventListener("abort", abort, { once: true });
			void gate.then(() => { cleanup(); resolveGate(); }, reject);
		});
	};
	const registry = createRegistry();
	registry.install(CodingTools);
	const recoveryGuard = defineExtension({ name: "herdr-durable-recovery", hooks: [hook(GenerationTask, {
		beforeRequest: async (_request, _api, callContext) => { await awaitRecovery(callContext.abortSignal); },
	})] });
	// Deferred polls bypass beforeRequest. Forward Models without copying away
	// class/prototype methods; cancellation itself must never wait on this gate.
	const guardedModels = new Proxy(models, {
		get(target, property) {
			if (property === "fetchDeferred") return async (...args: Parameters<Models["fetchDeferred"]>) => {
				await awaitRecovery(args[2]?.signal);
				return target.fetchDeferred(...args);
			};
			const member: unknown = Reflect.get(target, property, target);
			return typeof member === "function" ? member.bind(target) : member;
		},
	});
	registry.install(recoveryGuard);
	const openHarness = async () => {
		// Storage recovery cannot label old tool calls cancelled while their old
		// operating-system processes still execute. Reap before opening any tasks.
		await recoverExecutions(directory);
		return Harness.open(await openNodeJsonlStorage(join(directory, "storage"), context, { fsync: true }), {
		models: guardedModels, registry,
		env: async ({ cwd: childCwd, conversationId }, callContext) => {
			await awaitRecovery(callContext.abortSignal);
			const environment = createDurableEnvironment(directory, String(conversationId), childCwd ?? cwd);
			const execute = environment.exec.bind(environment);
			environment.exec = async (command, options, executionContext) => {
				try {
					const result = await execute(command, options, executionContext);
					if (!result.ok && result.error.code === "unknown") throw result.error;
					return result;
				} catch (error) {
					// Never allow a model/report to claim completion after unknown OS
					// cleanup. Seal synchronously, but do not await our own invocation.
					fault ??= error; enabled = false;
					void harness.close(context).catch(() => {});
					throw error;
				}
			};
			return environment;
		},
		settings: { retry: { enabled: false }, compaction: { enabled: false }, toolExecution: "sequential" },
	}, context);
	};
	let harness = await openHarness();
	let closed = false;
	let enabled = false;
	let fault: unknown;
	let serial: Promise<unknown> = Promise.resolve();
	let closing: Promise<void> | undefined;
	const state = async () => (await harness.snapshot(App, context)) ?? App.definition.initial();
	let recoveryRequired = false;
	try {
		const persisted = await state();
		const inspection = await harness.inspect(context);
		recoveryRequired = persisted.jobs.some((job) => job.report === null) || persisted.cancellations.some((item) => !item.done) || inspection.tasks.length > 0;
	} catch (error) { await harness.close(context); throw error; }

	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = serial.then(() => { if (closed) throw new Error("Coordinator closed"); if (fault !== undefined) throw fault; return operation(); });
		serial = next.catch(() => {});
		return next;
	};
	const find = (data: Readonly<State>, id: string): Job => {
		const job = data.jobs.find((item) => item.id === id);
		if (job === undefined) throw new Error(`Unknown report/job: ${id}`);
		return job;
	};
	const refresh = async (): Promise<void> => {
		for (const job of (await state()).jobs) {
			if (job.report !== null) continue;
			const submission = await harness.commit((tx) => tx.submissionByRequest(job.conversationId, `herdr:${job.id}`), context);
			let report: Report | undefined;
			if (submission?.status === "done" && submission.type === "input") {
				const entry = await harness.commit((tx) => tx.entry(AssistantEntry, submission.answer), context);
				const answer = entry?.model?.[0];
				report = reportOf(answer?.role === "assistant" ? answer.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") : "", "done");
			} else if (submission?.status === "unanswered") {
				report = reportOf(`Unanswered: ${submission.reason}${submission.detail === undefined ? "" : `\n${JSON.stringify(submission.detail)}`}`, submission.reason === "aborted" ? "cancelled" : "failed");
			} else if (job.cancelled && submission === undefined) report = reportOf("Cancelled before submission.", "cancelled");
			if (report !== undefined || (submission !== undefined && job.submissionId === null)) {
				await harness.commit(async (tx) => {
					const target = (await tx.doc(App)).jobs.find((item) => item.id === job.id)!;
					if (submission !== undefined) target.submissionId = submission.id;
					if (report !== undefined && target.report === null) target.report = report;
				}, context);
			}
		}
	};
	const cancelPending = async (): Promise<void> => {
		const pending = (await state()).cancellations.filter((item) => !item.done);
		if (pending.length === 0) return;
		const targets = new Set(pending.flatMap((item) => item.conversations));
		// Gate BEFORE invoking the core's atomic conversation-wide abort. Sampling
		// task IDs is unsafe: a generation can hand over to a successor between
		// inspection and marking. Core abort fences the whole current ownership
		// scope and withdraws its queued inputs in one commit, then joins cleanup.
		gateRecovery();
		try {
			await Promise.all([...targets].map(async (id) => {
				const child = await harness.conversation(id, context);
				if (!child) throw new Error("Missing cancellation conversation");
				await child.abort(context, { background: true });
			}));
			await harness.commit(async (tx) => {
				for (const item of (await tx.doc(App)).cancellations) if (pending.some((each) => each.requestId === item.requestId)) item.done = true;
			}, context);
			if (!enabled) {
				await refresh();
				// Harness has no pause method. Release its closed owner completely,
				// then reopen idle under the same exclusive coordinator lease.
				await harness.close(context);
				if (closed) throw new Error("Coordinator closed");
				const reopened = await openHarness();
				if (closed) { await reopened.close(context); throw new Error("Coordinator closed"); }
				harness = reopened;
			}
		} catch (error) {
			// Never release uncancelled work after an incomplete cancellation fence.
			enabled = false;
			fault = error;
			await harness.close(context);
			throw error;
		} finally { releaseGeneration?.(); releaseGeneration = undefined; generationGate = undefined; }
		await refresh();
	};
	const pump = async (): Promise<void> => {
		await refresh();
		if (!enabled) return;
		await cancelPending();
		const data = await state();
		const active = new Set(data.jobs.filter((job) => job.submissionId !== null && job.report === null).map((job) => job.conversationId));
		for (const job of data.jobs) {
			if (job.submissionId !== null || job.report !== null || job.cancelled) continue;
			if (!active.has(job.conversationId) && active.size >= MAX_CHILDREN) continue;
			const child = await harness.conversation(job.conversationId, context);
			if (child === undefined) throw new Error("Missing child conversation");
			// Intent + conversation + fingerprint already committed atomically.
			const submission = await child.submit({ type: "input", content: job.message, requestId: `herdr:${job.id}`, whenBusy: job.kind === "steer" ? "steer" : "followUp" }, context);
			await harness.commit(async (tx) => { (await tx.doc(App)).jobs.find((item) => item.id === job.id)!.submissionId = submission.id; }, context);
			active.add(job.conversationId);
		}
	};
	const status = async (start: number): Promise<JsonValue> => {
		await refresh();
		const data = await state();
		const inspection = await harness.inspect(context);
		const graph = await harness.taskGraph(context);
		try {
			const nodes = Object.values(graph.value.tasks);
			const usage = await harness.usage(context);
			return copyJson({ experimental: true, backend: "pi-durable", scheduling: inspection.scheduling, recoveryRequired,
				limits: { liveJobs: MAX_LIVE, concurrentChildren: MAX_CHILDREN, pageUnits: PAGE_UNITS, pageBytes: PAGE_BYTES },
				jobs: data.jobs.slice(start, start + 16).map((job) => ({ id: job.id, reportId: job.id, conversationId: job.conversationId, name: job.name,
					status: job.report?.outcome ?? (job.cancelled ? "cancelling" : recoveryRequired ? "interrupted" : job.submissionId === null || inspection.submissions.some((item) => item.id === job.submissionId && item.status === "queued") ? "queued" : "working"),
					reportReady: job.report !== null, visible: job.report?.visible ?? false, acknowledged: job.report?.acknowledged ?? false })),
				total: data.jobs.length, offset: start, nextOffset: start + 16 < data.jobs.length ? start + 16 : null,
				liveJobs: data.jobs.filter((job) => job.report === null).length,
				unread: data.jobs.filter((job) => job.report !== null && !job.report.acknowledged).length,
				taskGraph: { total: nodes.length, truncated: nodes.length > 64, tasks: nodes.slice(0, 64).map((node) => ({
					id: node.id, kind: node.kind, conversationId: node.conversationId, owner: node.owner ?? null, background: node.background, abortRequested: node.abortRequested,
					status: node.state.status, phase: "phase" in node.state ? node.state.phase : null,
					on: node.state.status === "waiting" ? node.state.on.slice(0, 32) : [],
				})) },
				usage: { models: Object.entries(usage.models).slice(0, 16), tools: Object.entries(usage.tools).slice(0, 4), truncated: Object.keys(usage.models).length > 16 || Object.keys(usage.tools).length > 4 },
			});
		} finally { graph.dispose(); }
	};
	const act = async (request: Request): Promise<JsonValue> => {
		if (request.action === "status") return status(request.offset);
		if (request.action === "resume") {
			if (!enabled) await recoverExecutions(directory);
			enabled = true; await cancelPending(); recoveryRequired = false; await pump(); harness.resume(); return status(0);
		}
		if (request.action === "read") {
			await refresh();
			const job = find(await state(), request.id);
			if (job.report === null) return { id: job.id, conversationId: job.conversationId, ready: false };
			const report = job.report;
			let boundary = 0;
			while (boundary < request.offset && boundary < report.text.length) boundary = endOfPage(report.text, boundary, PAGE_UNITS);
			if (boundary !== request.offset || (boundary === report.text.length && boundary !== 0)) throw new Error("Offset must name a report page boundary");
			const end = endOfPage(report.text, boundary, PAGE_UNITS);
			const receipt = report.receipts.find((item) => item.offset === boundary) ?? { token: randomUUID(), offset: boundary, nextOffset: end };
			await harness.commit(async (tx) => {
				const target = (await tx.doc(App)).jobs.find((item) => item.id === job.id)!.report!;
				target.visible = true;
				if (!target.receipts.some((item) => item.offset === boundary)) target.receipts.push(receipt);
			}, context);
			return { id: job.id, reportId: job.id, conversationId: job.conversationId, ready: true, outcome: report.outcome,
				text: report.text.slice(boundary, end), offset: boundary, nextOffset: end < report.text.length ? end : null,
				totalUnits: report.text.length, truncated: report.truncated, receipt: receipt.token };
		}
		if (request.action === "ack") {
			return harness.commit(async (tx) => {
				const data = await tx.doc(App);
				for (const job of data.jobs) {
					const report = job.report;
					const receipt = report?.receipts.find((item) => item.token === request.receipt);
					if (report === null || receipt === undefined) continue;
					if (receipt.offset > report.ackedThrough) throw new Error("Acknowledge pages contiguously");
					report.ackedThrough = Math.max(report.ackedThrough, receipt.nextOffset);
					report.acknowledged = report.ackedThrough === report.text.length;
					return { id: job.id, acknowledged: report.acknowledged, ackedThrough: report.ackedThrough };
				}
				throw new Error("Unknown receipt");
			}, context);
		}
		if (request.action === "wait") throw new Error("Internal wait routing error");
		// Defaults are transport-supplied fallbacks, not an arbitrary identity
		// override. Every explicit field remains in the engine-owned fingerprint.
		const intent = { ...request };
		if (intent.action === "spawn") delete intent.defaults;
		const fingerprint = requestFingerprint(intent);
		const existing = (await state()).requests.find((item) => item.requestId === request.requestId);
		if (existing !== undefined) {
			if (existing.fingerprint !== fingerprint) throw new Error("requestId collision: payload changed");
			if (request.action === "cancel") await cancelPending();
			return copyJson(existing.result);
		}
		if (request.action === "cancel") {
			const data = await state();
			const targets = request.id === "all" ? [...new Set(data.jobs.filter((job) => job.report === null).map((job) => job.conversationId))] : [find(data, request.id).conversationId];
			const result = { cancelled: request.id, conversationIds: targets };
			gateRecovery();
			try { await harness.commit(async (tx) => {
				const draft = await tx.doc(App);
				draft.cancellations.push({ requestId: request.requestId, conversations: targets, done: false });
				for (const job of draft.jobs) if (targets.includes(job.conversationId) && job.report === null) job.cancelled = true;
				draft.requests.push({ requestId: request.requestId, fingerprint, result });
			}, context);
			await cancelPending();
			return result;
			} catch (error) {
				fault = error; enabled = false;
				await harness.close(context);
				releaseGeneration?.(); releaseGeneration = undefined; generationGate = undefined;
				throw error;
			}
		}
		await refresh();
		if (recoveryRequired) throw new Error("Interrupted work requires explicit resume before new submissions");
		const data = await state();
		if (data.jobs.filter((job) => job.report === null).length >= MAX_LIVE) throw new Error("At most 16 live jobs are admitted");
		const id = randomUUID();
		const source = request.action === "send" ? find(data, request.id) : undefined;
		if (request.action === "spawn" && data.jobs.some((job) => job.name === request.name)) throw new Error("Name already exists; use send");
		let execution: Spawn | undefined;
		if (request.action === "spawn") {
			const model = request.model ?? request.defaults?.model;
			if (!model) throw new Error("A model is required for durable workers.");
			execution = { action: "spawn", requestId: request.requestId, name: request.name, prompt: request.prompt, model,
				// An explicit model must not inherit a different model's reasoning.
				thinking: request.thinking ?? (request.model ? undefined : request.defaults?.thinking) ?? "off",
				cwd: resolve(cwd, request.defaults?.cwd ?? ".", request.cwd ?? "."), tools: request.tools ?? "read-only" };
		}
		const result = await harness.commit(async (tx) => {
			const draft = await tx.doc(App);
			let conversationId = source?.conversationId;
			if (execution) {
				const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
				conversationId = child.id;
				await configure(tx, child.id, { model: execution.model, thinkingLevel: execution.thinking, cwd: execution.cwd,
					extensions: [CodingTools, recoveryGuard], ...(execution.tools === "read-only" ? { tools: [readTool] } : {}),
					instructions: `You are the isolated durable subagent ${execution.name}. Complete only the assigned task and return a concise report. Do not spawn subagents, control Herdr, coordinate with peers, or commit. Follow AGENTS.md when present. Only the explicitly offered durable tools are available; ordinary Pi resources are not discovered.` });
			}
			if (conversationId === undefined) throw new Error("Missing conversation");
			const accepted = { id, reportId: id, conversationId };
			draft.jobs.push({ id, conversationId, name: request.action === "spawn" ? request.name : source!.name,
				message: request.action === "spawn" ? request.prompt : request.message, kind: request.action === "spawn" ? "follow_up" : request.kind,
				submissionId: null, cancelled: false, report: null });
			// Intent, first resolved settings, conversation and job share one commit.
			draft.requests.push({ requestId: request.requestId, fingerprint, intent: copyJson(intent),
				...(execution ? { execution: copyJson(execution) } : {}), result: accepted });
			return accepted;
		}, context);
		enabled = true;
		await pump();
		return result;
	};
	// A bounded host admission queue feeds at most four child conversations. Core
	// owns all generation/tool scheduling and replay, not this timer.
	let tickPending = false;
	const timer = setInterval(() => {
		if (!enabled || closed || tickPending || fault !== undefined) return;
		tickPending = true;
		void enqueue(pump).catch((error: unknown) => { if (!closed) fault = error; }).finally(() => { tickPending = false; });
	}, 100);
	timer.unref();
	return {
		async dispatch(value) {
			const request = parse(value);
			if (request.action !== "wait") return copyJson(await enqueue(() => act(request)));
			// Poll only committed state; never call Submission.wait (it auto-resumes).
			// Do not hold the dispatcher mutex during a long wait: cancel stays usable.
			const deadline = Date.now() + request.seconds * 1000;
			do {
				const result = await enqueue(() => status(0));
				const snapshot = result as { unread: number; liveJobs: number; recoveryRequired: boolean };
				if (snapshot.unread > 0 || snapshot.recoveryRequired || snapshot.liveJobs === 0 || Date.now() >= deadline) return result;
				await delay(Math.min(50, Math.max(0, deadline - Date.now())));
			} while (!closed);
			throw new Error("Coordinator closed");
		},
		close() {
			if (closing !== undefined) return closing;
			closed = true;
			clearInterval(timer);
			// Seal immediately, rather than waiting behind a provider or cancellation.
			// Core joins invocations without writing aborted outcomes.
			closing = (async () => {
				try { await harness.close(context); }
				finally { await recoverExecutions(directory); }
				await serial;
			})();
			return closing;
		},
	};
}
