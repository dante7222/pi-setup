# Pi configuration and CLI fallback

## Global Pi configuration

Merge into `~/.pi/agent/settings.json`, preserving other settings and existing `defaultTools` entries:

```json
{
  "defaultTools": ["+codemode", "+tool_search"],
  "codemode": { "mode": "on" }
}
```

Run `/reload` in the parent. New ordinary workers read the same global configuration, subject to their project settings; already-running workers do not reload automatically. `on` keeps direct tools available, unlike `only`. The package does not rewrite global settings, force codemode activation, or configure the separate durable backend. Ordinary workers may use codemode when batching/filtering helps; they need not script every read/edit.

## CLI fallback

Only when native tools are unavailable, run `node <absolute-skill-directory>/run.mjs` through Bash:

- `spawn [tasks.json|-] [requestId]` (stdin when omitted or `-`)
- `wait [seconds]`
- `read <id> [offset]`
- `ack <receipt>`
- `status [offset]`, `cancel <id...|all>`, `close`
- Persistent controls/settings: [persistent.md](persistent.md).

Native `next`, `read_many` and wait `details` are conveniences; the CLI retains separate wait/read/ack/close/status operations. Use the native cycle for the short supported recipe.

`collect [seconds]` consumes pages after successful stdout delivery. Use it only for direct Bash output that the parent reads, never from codemode or a pipeline. For restart-safe delivery use `read`/`ack` instead. The same explicit spawn request ID and arguments reuse the original admission, including its resolved defaults; interrupted/failed launch attempts are not blindly replayed.

Return to the [native workflow](orchestration.md).
