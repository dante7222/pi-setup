#!/usr/bin/env node
// End-to-end check of the parent side: a real `pi --mode rpc` parent loads this
// package, calls the subagents tool once with two tasks of different duration, ends
// its turn, and is woken exactly once by one message carrying both reports.
// Usage: node test/live/subagents-e2e.mjs [provider/model]
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const model = process.argv[2] ?? "openai-codex/gpt-6-astra";
const env = { ...process.env };
for (const key of ["PI_SUBAGENT", "PI_SUBAGENT_PROMPT", "PI_SESSION_ID", "PI_SESSION_FILE"]) delete env[key];
const parent = spawn("pi", ["--mode", "rpc", "--no-session", "--model", `${model}:low`], { env, stdio: ["pipe", "pipe", "inherit"], detached: true });
const send = (value) => parent.stdin.write(`${JSON.stringify(value)}\n`);
const seen = { toolCalls: [], runs: 0, reportMessages: [], finalText: "" };
let resolveDone;
const done = new Promise((resolve) => { resolveDone = resolve; });
const timeout = setTimeout(() => resolveDone("timeout"), 300_000);
let settleTimer;

const decoder = new StringDecoder("utf8");
let buffer = "";
parent.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) send({ type: "extension_ui_response", id: event.id, cancelled: true });
    if (event.type === "tool_execution_start") seen.toolCalls.push(`${event.toolName} ${JSON.stringify(event.args).slice(0, 240)}`);
    if (event.type === "agent_start") { seen.runs++; clearTimeout(settleTimer); }
    if (event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "subagent-report") seen.reportMessages.push(event.message.content);
    if (event.type === "message_end" && event.message?.role === "assistant") {
      seen.finalText = (event.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    }
    // After the woken run settles, give a second wake-up (a split batch) time to appear.
    if (event.type === "agent_settled" && seen.reportMessages.length) settleTimer = setTimeout(() => resolveDone("woken"), 15_000);
  }
});

send({ id: "p1", type: "prompt", message: "Call the subagents tool exactly once with action run and two tasks, both role explorer: task named fast with task \"Reply with only the word ALPHA.\", and task named slow with task \"Run `sleep 12` with bash, then reply with only the word OMEGA.\". Do not call wait. End your turn with the single word STARTED. When reports arrive later, reply with both answers separated by a space." });
const outcome = await done;
clearTimeout(timeout);
console.log("outcome:", outcome);
console.log("tool calls:", seen.toolCalls);
console.log("parent runs:", seen.runs);
console.log("report messages:", seen.reportMessages.length, JSON.stringify(seen.reportMessages).slice(0, 400));
console.log("final parent text:", JSON.stringify(seen.finalText));
const message = seen.reportMessages[0] ?? "";
const ok = outcome === "woken"
  && seen.toolCalls.filter((call) => call.startsWith("subagents")).length === 1
  && seen.reportMessages.length === 1 && /subagent fast done/.test(message) && /subagent slow done/.test(message)
  && seen.runs === 2 && /ALPHA/.test(seen.finalText) && /OMEGA/.test(seen.finalText);
console.log(ok ? "PASS e2e one wake-up per batch" : "FAIL e2e one wake-up per batch");
parent.stdin.end();
setTimeout(() => { try { process.kill(-parent.pid, "SIGTERM"); } catch {} process.exit(ok ? 0 : 1); }, 3000);
