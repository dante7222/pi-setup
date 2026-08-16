import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  patchHerdrAgentState,
} from "../integrations/herdr-pi-subagents/patch-herdr-subagent-state/scripts/patch-herdr-agent-state.mjs";

const HERDR_SOURCE = `// HERDR_INTEGRATION_ID=pi
export default function (pi) {
  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage;
  let lastState;
  let lastMessage;
  let rootSession = false;

  function desiredState() {
    if (blockedCount > 0) {
      return { state: "blocked", message: blockedMessage };
    }
    if (agentActive) {
      return { state: "working", message: undefined };
    }
    return { state: "idle", message: undefined };
  }

  function publishState() {}

  pi.on("session_start", async (event, ctx) => {
    void event;
    void ctx;
  });
}
`;

test("patches Herdr state with pi-subagents lifecycle tracking", () => {
  const result = patchHerdrAgentState(HERDR_SOURCE);

  assert.equal(result.changed, true);
  assert.match(result.source, /HERDR_PI_SUBAGENTS_PATCH/);
  assert.match(result.source, /if \(agentActive \|\| activeSubagents\.size > 0\)/);
  assert.match(result.source, /subagents:created/);
  assert.match(result.source, /subagents:started/);
  assert.match(result.source, /subagents:completed/);
  assert.match(result.source, /subagents:failed/);
  assert.ok(
    result.source.indexOf("subagents:failed") < result.source.indexOf('pi.on("session_start"'),
  );
});

test("bundled extension snapshot contains the complete patch", () => {
  const bundledSource = readFileSync(
    new URL("../integrations/herdr-pi-subagents/herdr-agent-state.ts", import.meta.url),
    "utf8",
  );
  const result = patchHerdrAgentState(bundledSource);

  assert.equal(result.changed, false);
});

test("package manifest exposes only the manually invoked repair skill", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const skillSource = readFileSync(
    new URL(
      "../integrations/herdr-pi-subagents/patch-herdr-subagent-state/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );

  assert.ok(
    packageJson.pi.skills.includes(
      "./integrations/herdr-pi-subagents/patch-herdr-subagent-state",
    ),
  );
  assert.match(skillSource, /^disable-model-invocation: true$/m);
});

test("is idempotent", () => {
  const first = patchHerdrAgentState(HERDR_SOURCE);
  const second = patchHerdrAgentState(first.source);

  assert.equal(second.changed, false);
  assert.equal(second.source, first.source);
});

test("rejects unrelated and unsupported files", () => {
  assert.throws(
    () => patchHerdrAgentState("export default function () {}\n"),
    /not Herdr's managed Pi integration/,
  );
  assert.throws(
    () => patchHerdrAgentState("// HERDR_INTEGRATION_ID=pi\nexport default function () {}\n"),
    /missing root session anchor/,
  );
});
