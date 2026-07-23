import assert from "node:assert/strict";
import test from "node:test";
import { delegateToolText } from "../extensions/supacode-subagents/delegate-tool-text.ts";

test("delegate tool guidance stays compact without dropping quality and safety contracts", () => {
  assert.ok(JSON.stringify(delegateToolText).length <= 2200);

  assert.match(delegateToolText.delegate.description, /context-isolated worker/i);
  assert.match(delegateToolText.delegate.description, /same host/i);
  assert.match(delegateToolText.delegate.description, /instructed not to push or merge/i);
  assert.match(delegateToolText.delegate.promptGuidelines.join("\n"), /self-contained/i);
  assert.match(delegateToolText.delegate.promptGuidelines.join("\n"), /do not inherit/i);

  assert.match(delegateToolText.delegate_parallel.description, /context-isolated workers concurrently/i);
  assert.match(delegateToolText.delegate_parallel.promptGuidelines.join("\n"), /no more workers than needed/i);

  const loopGuidance = delegateToolText.delegate_loop.promptGuidelines.join("\n");
  assert.match(delegateToolText.delegate_loop.description, /implement-check-review-repair/i);
  assert.match(delegateToolText.delegate_loop.description, /predeclared validation commands/i);
  assert.match(delegateToolText.delegate_loop.description, /never applies automatically/i);
  assert.match(loopGuidance, /acceptance criteria/i);
  assert.match(loopGuidance, /trusted project files/i);
  assert.match(loopGuidance, /not a sandbox/i);
  assert.match(loopGuidance, /configured reviewer profiles/i);

  const applyGuidance = [
    delegateToolText.delegate_apply.description,
    ...delegateToolText.delegate_apply.promptGuidelines,
  ].join("\n");
  assert.match(applyGuidance, /explicit user/i);
  assert.match(applyGuidance, /never call it automatically/i);
});
