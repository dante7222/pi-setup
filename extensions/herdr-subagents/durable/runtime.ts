import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** No AgentSession/resource loader: ordinary Pi extensions never execute here. */
export async function durableModels(agentDir: string): Promise<Models> {
  if (process.env.PI_HERDR_DURABLE_FAUX === "1") {
    // This test-only branch contains ONLY faux. Unknown/paid models fail closed.
    const models = createModels();
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux" }, { id: "slow" }] });
    const answer: FauxResponseFactory = async (_context, options, _state, model) => {
      faux.appendResponses([answer]);
      // The slow test model makes interrupted work deterministic without a paid
      // provider, arbitrary code injection, or a fallback to configured models.
      if (model.id === "slow") await delay(30_000, undefined, { signal: options?.signal });
      return fauxAssistantMessage("Durable faux report.");
    };
    faux.setResponses([answer]);
    models.setProvider(faux.provider);
    return models;
  }
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
}
