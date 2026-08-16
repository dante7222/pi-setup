---
name: patch-herdr-subagent-state
description: Reapply the local Herdr Pi subagent busy-state patch.
disable-model-invocation: true
---

# Patch Herdr Subagent State

Resolve `scripts/patch-herdr-agent-state.mjs` relative to this `SKILL.md`, then run it with Node:

```bash
node /absolute/path/to/this/skill/scripts/patch-herdr-agent-state.mjs
```

The patcher updates Herdr's managed `herdr-agent-state.ts` so active pi-subagents keep the pane in Herdr's `working` state until Pi processes their completion follow-up. It is idempotent and should be run again whenever Herdr reinstalls or updates its Pi integration.

Report whether the file was patched or was already patched. If the patcher rejects a changed Herdr integration, report the error without modifying the file manually.
