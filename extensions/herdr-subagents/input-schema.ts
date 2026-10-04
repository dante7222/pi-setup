import { Type } from "typebox";
import { LIMIT } from "./core.ts";
import { tasksSchema } from "./task-schema.ts";

const nonempty = Type.String({ minLength: 1, pattern: "\\S" });
const id = Type.String({ pattern: "^[a-f0-9]{12}$" });
const offset = Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const action = Type.Union(["prepare", "spawn", "request_status", "status", "wait", "next", "read", "read_many", "ack", "cancel", "close", "continue", "send", "stop", "recover", "reattach", "configure", "help"].map((name) => Type.Literal(name)));
const selection = Type.Array(action, { minItems: 1, maxItems: 3, uniqueItems: true });
export const parameters = Type.Union([
  Type.Object({ action: Type.Literal("help"), actions: selection }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("prepare"), tasks: tasksSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("spawn"), tasks: Type.Optional(tasksSchema), requestId: nonempty }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("request_status"), requestId: nonempty }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("status"), offset }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("wait"), seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })), details: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("next"), acknowledge: Type.Optional(Type.Array(Type.String({ pattern: "^[a-f0-9]{12}\\.[a-f0-9]{64}$" }), { maxItems: LIMIT, uniqueItems: true })), seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })), details: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("read"), id, offset }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("read_many"), ids: Type.Array(id, { minItems: 1, maxItems: LIMIT, uniqueItems: true }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("ack"), receipt: nonempty }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cancel"), ids: Type.Union([Type.Literal("all"), Type.Array(id, { minItems: 1, maxItems: LIMIT, uniqueItems: true })]) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("close") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("continue"), id, message: nonempty, requestId: nonempty }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("send"), id, message: nonempty, kind: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]), requestId: nonempty }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("stop"), id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("recover"), id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("reattach"), id, pane: Type.Optional(nonempty) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("configure"), concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMIT })), presets: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, { additionalProperties: false }),
]);
// Provider adapters expect an object root; a union root loses its properties on
// Anthropic. Keep strict action-specific validation above at execution time.
export const publicParameters = Type.Object({
  action,
  actions: Type.Optional(selection),
  tasks: Type.Optional(tasksSchema),
  requestId: Type.Optional(nonempty),
  offset,
  seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })),
  details: Type.Optional(Type.Boolean()),
  id: Type.Optional(id),
  receipt: Type.Optional(nonempty),
  acknowledge: Type.Optional(Type.Array(Type.String({ pattern: "^[a-f0-9]{12}\\.[a-f0-9]{64}$" }), { maxItems: LIMIT, uniqueItems: true })),
  ids: Type.Optional(Type.Union([Type.Literal("all"), Type.Array(id, { minItems: 1, maxItems: LIMIT, uniqueItems: true })])),
  message: Type.Optional(nonempty),
  kind: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("follow_up")])),
  pane: Type.Optional(nonempty),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMIT })),
  presets: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });
