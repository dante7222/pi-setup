import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatWorkerEvent } from "../extensions/supacode-subagents/worker-output.mjs";

test("worker JSON events render visible progress without terminal control sequences", () => {
  assert.deepEqual(
    formatWorkerEvent({ type: "agent_start" }),
    { type: "line", text: "Pi started; waiting for the model…" },
  );
  assert.deepEqual(
    formatWorkerEvent({ type: "tool_execution_start", toolName: "read\u001b[2J" }),
    { type: "line", text: "→ read[2J" },
  );
  assert.deepEqual(
    formatWorkerEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "review\u0000 result" },
    }),
    { type: "text", text: "review result" },
  );
  assert.deepEqual(formatWorkerEvent({ type: "agent_end" }), { type: "end" });
  assert.equal(formatWorkerEvent({ type: "thinking" }), undefined);
});

test("worker formatter emits heartbeats and exits cleanly at JSON stream EOF", async () => {
  const formatterPath = fileURLToPath(new URL("../extensions/supacode-subagents/worker-output.mjs", import.meta.url));
  const child = spawn(process.execPath, [formatterPath, "20"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const started = once(child.stdout, "data");
  child.stdin.write('{"type":"agent_start"}\n');
  await started;
  await new Promise((resolve) => setTimeout(resolve, 55));
  child.stdin.end('{"type":"agent_end"}\n');
  const [code] = await once(child, "close");

  assert.equal(code, 0, stderr);
  assert.match(stdout, /Pi started; waiting for the model/);
  assert.match(stdout, /\[working \d+s\]/);
});
