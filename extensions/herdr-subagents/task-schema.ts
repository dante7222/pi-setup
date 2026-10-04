import { Type } from "typebox";

const nonempty = Type.String({ minLength: 1, pattern: "\\S" });

/** Explicit caller intent only; no parent defaults or preset expansion. */
export const taskSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }),
  prompt: Type.String({ minLength: 1, maxLength: 100_000, pattern: "\\S" }),
  role: Type.Optional(Type.Union([Type.Literal("reviewer"), Type.Literal("explorer"), Type.Literal("tester"), Type.Literal("worker")])),
  cwd: Type.Optional(nonempty),
  model: Type.Optional(nonempty),
  thinking: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)))),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
  extensions: Type.Optional(Type.Array(nonempty)),
  persistent: Type.Optional(Type.Boolean()),
  group: Type.Optional(nonempty),
  presentation: Type.Optional(Type.Union([Type.Literal("quiet"), Type.Literal("agent")])),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  maxCost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  preset: Type.Optional(nonempty),
}, { additionalProperties: false });

export const tasksSchema = Type.Array(taskSchema, { minItems: 1, maxItems: 16 });
