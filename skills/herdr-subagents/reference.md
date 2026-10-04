# Options

`spawn [tasks.json|-] [requestId]` accepts stdin or a file. Names match `[a-z][a-z0-9_-]{0,31}`, unique among open jobs. Omit matching parent defaults.

- `model`: Pi selector, preferably `provider/model`; defaults to the parent model.
- `thinking`: `off|minimal|low|medium|high|xhigh|max`; inherits only without a model override.
- `cwd`: caller directory; worktrees must exist.
- `timeout`: execution seconds, default 1800; range 1–86400.
- `extensions`: additive local paths; normal Pi discovery stays enabled.
- `persistent`, `group`, `presentation`, `maxTokens`, `maxCost`, `preset`: opt-in conversation/control and policy options in [persistent.md](persistent.md).

Default concurrency: 4; maximum open jobs: 16. `collect [seconds]` waits 0–60 seconds and paginates losslessly (12 KB/call); use replayable `read`/`ack` in codemode.

See [orchestration.md](orchestration.md) for native actions and [troubleshooting.md](troubleshooting.md) for lifecycle and diagnostics.
