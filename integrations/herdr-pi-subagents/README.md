# Herdr Pi Subagent State

Portable Herdr integration patch for Pi sessions using [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

Herdr normally reports a pane as idle when Pi's main agent settles, even if background subagents are still running. This patch tracks pi-subagents lifecycle events and keeps Herdr in the `working` state until Pi processes the completion follow-up.

## Contents

| Repository path | Destination on another machine |
|---|---|
| `herdr-agent-state.ts` | `~/.pi/agent/extensions/herdr-agent-state.ts` |
| `patch-herdr-subagent-state/` | `~/.pi/agent/skills/patch-herdr-subagent-state/` |
| `patch-herdr-subagent-state/scripts/patch-herdr-agent-state.mjs` | Keep inside the copied skill directory |

If `PI_CODING_AGENT_DIR` is set, replace `~/.pi/agent` with that directory.

## Recommended installation

Install Herdr's Pi integration first so the patcher modifies the integration version supplied by the installed Herdr release:

```bash
herdr integration install pi
mkdir -p ~/.pi/agent/skills
cp -R integrations/herdr-pi-subagents/patch-herdr-subagent-state ~/.pi/agent/skills/
node integrations/herdr-pi-subagents/patch-herdr-subagent-state/scripts/patch-herdr-agent-state.mjs
```

Then run `/reload` in Pi while no subagents are active.

If this entire repository is installed as a Pi package, its manifest already exposes the skill; only the patcher command and `/reload` are needed.

## Direct snapshot installation

`herdr-agent-state.ts` is a patched snapshot of Herdr Pi integration version 8. To install that exact snapshot instead of patching the locally generated integration:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills
cp integrations/herdr-pi-subagents/herdr-agent-state.ts ~/.pi/agent/extensions/herdr-agent-state.ts
cp -R integrations/herdr-pi-subagents/patch-herdr-subagent-state ~/.pi/agent/skills/
```

Prefer the recommended patcher flow after upgrading Herdr, because copying the snapshot would replace any newer upstream integration changes.

## Reapply after Herdr updates

Herdr manages and may overwrite `herdr-agent-state.ts`. Reapply the patch with either:

```text
/skill:patch-herdr-subagent-state
```

or directly from this checkout:

```bash
node integrations/herdr-pi-subagents/patch-herdr-subagent-state/scripts/patch-herdr-agent-state.mjs
```

The patcher is idempotent. It exits without changes when the patch is present and fails safely if a future Herdr integration no longer matches the expected structure.

The skill uses `disable-model-invocation: true`, so it is available only through its explicit slash command and consumes no normal model-prompt context.
