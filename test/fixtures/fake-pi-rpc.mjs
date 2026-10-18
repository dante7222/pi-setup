#!/usr/bin/env node
// Minimal stand-in for `pi --mode rpc`, modelled on Pi 1.3.0 semantics:
// - `prompt` replies after preflight; `prompt` with streamingBehavior queues while
//   running and starts a run while idle; a bare prompt while running fails.
// - `abort` is a no-op before agent_start and otherwise replies after settlement.
// Prompt text drives behaviour:
//   "slow:<ms> ..."      run for <ms> before replying
//   "preflight:<ms> ..." delay before agent_start (abort-during-startup window)
//   "fail ..."           reply with a provider error
//   "dialog ..."         send a confirm dialog first and wait for its cancellation
//   "crash ..."          exit with code 3 mid-run, after writing to stderr
//   "ignoreterm ..."     ignore SIGTERM (cleanup escalation)
//   "reject ..."         refuse the prompt with an error response
//   "...slowclear..."    delay the clear_queue reply by 600ms (abort/settle race)
//   "orphan ..."         spawn a same-group child ignoring SIGTERM, then exit 1
// Replies echo the prompt, steering, history and argv for assertions.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const log = process.env.FAKE_PI_LOG;
const record = (value) => { if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...value })}\n`); };
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
record({ argv: process.argv.slice(2), env: { PI_SUBAGENT: process.env.PI_SUBAGENT, PI_SESSION_ID: process.env.PI_SESSION_ID, PI_OFFLINE: process.env.PI_OFFLINE, prompt: process.env.PI_SUBAGENT_PROMPT?.slice(0, 40) } });

let running = false;
let steering = [];
let abortRun;
let settled = Promise.resolve();
let dialogResolve;
let lastPrompt = "";
const history = [];

const usage = { input: 10, output: 5, cacheRead: 900, cacheWrite: 3, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
const assistant = (text, stopReason = "stop", errorMessage) => ({ role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, usage, ...(errorMessage ? { errorMessage } : {}) });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(message) {
  lastPrompt = message;
  running = true;
  let finished;
  settled = new Promise((resolve) => { finished = resolve; });
  history.push(message);
  if (message.startsWith("ignoreterm")) process.on("SIGTERM", () => record({ ignored: "SIGTERM" }));
  out({ type: "agent_start" });
  let aborted = false;
  const abort = new Promise((resolve) => { abortRun = () => { aborted = true; resolve(); }; });
  if (message.startsWith("dialog")) {
    out({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow?", message: "x" });
    out({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "k", statusText: "v" });
    await new Promise((resolve) => { dialogResolve = resolve; });
  }
  if (message.startsWith("crash")) { process.stderr.write("fatal: worker crashed\n"); process.exit(3); }
  if (message.startsWith("orphan")) {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    record({ orphan: child.pid });
    await delay(200);
    process.exit(1);
  }
  const slow = /slow:(\d+)/.exec(message);
  out({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: {} });
  // A partial answer before the slow part, so aborted runs have text to keep.
  if (slow) out({ type: "message_end", message: { ...assistant("partial progress", "toolUse"), content: [{ type: "text", text: "partial progress" }, { type: "toolCall", id: "t1" }] } });
  await Promise.race([delay(slow ? Number(slow[1]) : 20), abort]);
  out({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", isError: false });
  // Steering queued during the run is answered in the same run.
  while (!aborted && steering.length) { history.push(...steering); steering.splice(0); }
  let reply;
  if (aborted) reply = assistant("", "aborted", "Operation aborted");
  else if (message.startsWith("fail")) reply = assistant("", "error", "boom");
  else reply = assistant(`reply to: ${message} | history: ${history.join(" / ")} | argv: ${process.argv.slice(2).join(" ")}`);
  out({ type: "message_end", message: reply });
  out({ type: "agent_end", messages: [reply], willRetry: false });
  running = false;
  abortRun = undefined;
  out({ type: "agent_settled", aborted });
  finished();
}

let preflighting = false;
async function prompt(command, reply) {
  // Like Pi while compacting: refuse any prompt with an error response.
  if (command.message.startsWith("reject")) { out({ id: command.id, type: "response", command: "prompt", success: false, error: "Cannot submit a prompt while compaction is in progress." }); return; }
  // Pi is already busy during preflight: a bare prompt is rejected, a steer is queued.
  if (running || preflighting) {
    if (!command.streamingBehavior) { out({ id: command.id, type: "response", command: "prompt", success: false, error: "Agent is already processing." }); return; }
    steering.push(command.message);
    reply({ disposition: "queued" });
    return;
  }
  const preflight = /^preflight:(\d+)/.exec(command.message);
  if (preflight) { preflighting = true; await delay(Number(preflight[1])); preflighting = false; }
  reply({ disposition: "started" });
  void run(command.message);
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    record({ command });
    const reply = (data) => out({ id: command.id, type: "response", command: command.type, success: true, ...(data ? { data } : {}) });
    switch (command.type) {
      case "extension_ui_response": dialogResolve?.(); break;
      case "prompt": void prompt(command, reply); break;
      case "steer": steering.push(command.message); reply({ disposition: "queued" }); break;
      case "clear_queue": {
        const cleared = { steering, followUp: [] };
        steering = [];
        if (lastPrompt.includes("slowclear")) setTimeout(() => reply(cleared), 600);
        else reply(cleared);
        break;
      }
      case "abort":
        if (!running) { reply(); break; }
        abortRun?.();
        void settled.then(() => reply());
        break;
      default: reply();
    }
  }
});
process.stdin.on("end", () => { if (!process.listenerCount("SIGTERM")) process.exit(0); });
