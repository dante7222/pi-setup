import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as readline from "node:readline";

function safeTerminalText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\u001b/g, "");
}

export function formatWorkerEvent(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "agent_start") return { type: "line", text: "Pi started; waiting for the model…" };
  if (event.type === "tool_execution_start") {
    const name = event.toolName ?? event.toolCall?.name ?? "tool";
    return { type: "line", text: `→ ${safeTerminalText(name)}` };
  }
  if (event.type === "tool_execution_end") {
    const name = event.toolName ?? event.toolCall?.name ?? "tool";
    const failed = event.isError === true || event.result?.isError === true;
    return { type: "line", text: `${failed ? "✗" : "✓"} ${safeTerminalText(name)}` };
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      return { type: "text", text: safeTerminalText(update.delta) };
    }
  }
  if (event.type === "agent_end") return { type: "end" };
  return undefined;
}

async function main() {
  const configuredHeartbeat = Number(process.argv[2]);
  const heartbeatMs = Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0
    ? configuredHeartbeat
    : 10_000;
  const startedAt = Date.now();
  let lineOpen = false;
  const heartbeat = setInterval(() => {
    if (lineOpen) process.stdout.write("\n");
    lineOpen = false;
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    process.stdout.write(`[working ${elapsedSeconds}s]\n`);
  }, heartbeatMs);
  heartbeat.unref();

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (lineOpen) process.stdout.write("\n");
      lineOpen = false;
      process.stdout.write(`${safeTerminalText(line)}\n`);
      continue;
    }
    const rendered = formatWorkerEvent(event);
    if (!rendered) continue;
    if (rendered.type === "text") {
      process.stdout.write(rendered.text);
      lineOpen = !rendered.text.endsWith("\n");
      continue;
    }
    if (lineOpen) process.stdout.write("\n");
    lineOpen = false;
    if (rendered.type === "line") process.stdout.write(`${rendered.text}\n`);
  }
  clearInterval(heartbeat);
  if (lineOpen) process.stdout.write("\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
