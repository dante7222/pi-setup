import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createDurableEnvironment } from "../../extensions/herdr-subagents/durable/environment.ts";

const [mode, directory] = process.argv.slice(2);
if (mode === "coordinator") {
  const env = createDurableEnvironment(directory, "crash-conversation", directory);
  const result = await env.exec("touch ready; sleep 3; echo survived >after", undefined, BACKGROUND_CONTEXT);
  await writeFile(join(directory, "result.json"), JSON.stringify(result));
} else if (mode === "descendant") {
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "leaf", directory], { detached: true, stdio: "ignore" });
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 500));
} else if (mode === "leaf") {
  await writeFile(join(directory, "leaf.pid"), String(process.pid));
  setTimeout(async () => { await writeFile(join(directory, "after"), "survived"); }, 3000);
} else throw new Error("Unknown fixture mode");
