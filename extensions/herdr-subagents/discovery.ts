import { renderToolSignature } from "@earendil-works/pi-codemode/declarations";
import { Type } from "typebox";
import { PAGE_BYTES } from "./core.ts";
import { parameters } from "./input-schema.ts";
import { outputSchema } from "./output-schema.ts";

/** Narrow declarations use the actual strict execution schemas, not a second API. */
export function actionHelp(actions: string[]): { declaration: string } {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 3 || new Set(actions).size !== actions.length) {
    throw new Error("Select 1..3 unique subagents actions for help.");
  }
  const inputs = actions.map((action) => {
    const input = parameters.anyOf.find((branch) => branch.properties.action.const === action);
    if (!input) throw new Error("Unknown subagents action for help.");
    return input;
  });
  const outputs = outputSchema.anyOf.filter((branch) => branch.properties.ok.const === false ||
    ("const" in branch.properties.action && actions.includes(branch.properties.action.const)));
  const declaration = renderToolSignature({
    name: "subagents", inputSchema: { ...Type.Union(inputs) }, outputSchema: { ...Type.Union(outputs) },
  }, { inputMaxChars: Number.MAX_SAFE_INTEGER });
  const data = { declaration };
  // Never return a silently truncated declaration. Full discovery remains an
  // alternative if future schemas outgrow the bounded narrow selection.
  if (Buffer.byteLength(JSON.stringify({ ok: true, action: "help", data })) > PAGE_BYTES) {
    throw new Error("Selected help exceeds 12 KB; request fewer actions or await describeTool('subagents').");
  }
  return data;
}
