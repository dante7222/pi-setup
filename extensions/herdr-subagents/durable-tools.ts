import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { scopeFor } from "./core.ts";
import { claimScope } from "./ownership.ts";
import { durableRequest, shutdownDurable, startDurable } from "./durable/transport.ts";

const text = Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" });
const promptText = Type.String({ minLength: 1, maxLength: 65_536, pattern: "\\S" });
const directory = Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" });
const requestId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" });
const thinking = Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
const model = Type.Object({ provider: text, modelId: text }, { additionalProperties: false });
const offset = Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const actions = ["start", "spawn", "send", "status", "wait", "read", "ack", "cancel", "resume", "shutdown"] as const;
const strict = Type.Union([
  Type.Object({ action: Type.Literal("start"), experimental: Type.Literal(true) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("spawn"), requestId, name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }), prompt: promptText, model: Type.Optional(model), thinking: Type.Optional(thinking), cwd: Type.Optional(directory), tools: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("coding")])) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("send"), id: text, requestId, message: promptText, kind: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("status"), offset }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("wait"), seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("read"), id: text, offset }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("ack"), receipt: text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cancel"), id: text, requestId }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("resume") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("shutdown") }, { additionalProperties: false }),
]);
const parameters = Type.Object({
  action: Type.Union(actions.map((action) => Type.Literal(action))),
  experimental: Type.Optional(Type.Literal(true)), requestId: Type.Optional(requestId),
  name: Type.Optional(text), prompt: Type.Optional(promptText), model: Type.Optional(model), thinking: Type.Optional(thinking),
  cwd: Type.Optional(directory), tools: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("coding")])),
  id: Type.Optional(text), message: Type.Optional(promptText), kind: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("follow_up")])),
  offset, seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })), receipt: Type.Optional(text),
}, { additionalProperties: false });

export function registerDurableTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "durable_subagents", label: "Durable subagents (experimental)", exposure: "deferred", executionMode: "parallel",
    description: "Explicit opt-in experimental pi-durable coordinator; separate from ordinary Herdr workers. Check ok; no automatic parent follow-up.",
    namespace: {
      name: "durable_subagents", description: "Experimental durable subagent orchestration",
      instructions: "durable_subagents is a separate experimental backend. Read skills/herdr-subagents/durable.md before use. Start requires experimental:true. Default tools are read-only; coding must be explicit. It does not discover normal Pi extensions/skills. Spawn/send/cancel require stable request IDs. Read reports before acknowledging receipts. Restart opens paused; resume explicitly restarts pending work, never intentionally cancelled work. Shutdown pauses the coordinator; parent Stop cancels work, including offline cancellation intent. Arbitrary tool effects are not exactly once. Never use this merely to bypass ordinary worker policy.",
    },
    parameters,
    outputSchema: Type.Object({ ok: Type.Boolean(), action: Type.String(), data: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_callId, input, signal, _onUpdate, ctx) {
      let envelope: JsonValue;
      let failed = false;
      try {
        signal?.throwIfAborted();
        if (!Check(strict, input)) throw new Error("Invalid durable_subagents action or arguments.");
        const session = ctx.sessionManager.getSessionId();
        if (!session) throw new Error("A current Pi session ID is required.");
        const scope = scopeFor(session);
        await claimScope(scope, signal);
        signal?.throwIfAborted();
        let data: unknown;
        if (input.action === "start") data = await startDurable(scope, input.experimental === true, signal);
        else if (input.action === "shutdown") { await shutdownDurable(scope, signal); data = { paused: true }; }
        else {
          // Keep explicit arguments separate from fallback settings. The engine
          // fingerprints intent and resolves these only on first admission; no
          // caller-supplied fingerprint can disguise an explicit payload change.
          const request = input.action === "spawn" ? { ...input, defaults: {
            ...(ctx.model ? { model: { provider: ctx.model.provider, modelId: ctx.model.id } } : {}),
            ...(ctx.thinkingLevel === undefined ? {} : { thinking: ctx.thinkingLevel }),
            cwd: ctx.cwd,
          } } : input;
          data = await durableRequest(scope, request, signal);
        }
        envelope = JSON.parse(JSON.stringify({ ok: true, action: input.action, data })) as JsonValue;
      } catch (error) {
        failed = true;
        envelope = { ok: false, action: input.action, error: error instanceof Error ? error.message : String(error) };
      }
      return { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope, details: envelope, ...(failed ? { isError: true } : {}) };
    },
  });
}
