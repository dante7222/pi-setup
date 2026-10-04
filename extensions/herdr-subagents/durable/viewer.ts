import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { scopeFor, type Scope } from "../core.ts";
import { claimScope } from "../ownership.ts";
import { durableDirectory, durableRequest } from "./transport.ts";

/** Caller-pane observer only: no storage, acknowledgement, resume or model work. */
export async function runDurableViewer(directory: string, id: string, claimed?: Scope): Promise<void> {
  const scope = claimed ?? scopeFor();
  if (!claimed) await claimScope(scope);
  if (resolve(directory) !== resolve(durableDirectory(scope))) throw new Error("Viewer directory does not belong to the current parent scope.");
  if (!id || id.length > 128) throw new Error("Expected a durable worker ID.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  let previous = "";
  try {
    do {
      // Engine's public report projection omits raw reasoning and tool payloads.
      const report = await durableRequest(scope, { action: "read", id, offset: 0 }, controller.signal);
      const display = JSON.stringify(report).replace(/[\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).slice(0, 16_000);
      if (display !== previous) {
        await new Promise<void>((resolve, reject) => process.stdout.write(`${display}\n`, (error) => error ? reject(error) : resolve()));
        previous = display;
      }
      if (!process.stdout.isTTY) break;
      await delay(1000, undefined, { signal: controller.signal });
    } while (!controller.signal.aborted);
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
}
