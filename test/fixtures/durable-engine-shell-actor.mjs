import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openCoordinator } from "../../extensions/herdr-subagents/durable/engine.ts";

const directory = process.argv[2];
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("bash", { command: "touch ready; sleep 3; echo survived >after" }), { stopReason: "toolUse" }),
  fauxAssistantMessage("Finished"),
]);
const engine = await openCoordinator(directory, models, directory);
const job = await engine.dispatch({ action: "spawn", requestId: "shell-crash", name: "shell", prompt: "Faux shell only", model: { provider: "faux", modelId: "faux-1" }, tools: "coding" });
await writeFile(join(directory, "job-id.json"), JSON.stringify(job));
// Deliberately no graceful close: the regression kills this process mid-tool.
setInterval(() => {}, 1000);
