# Options and persistent workers

`spawn [tasks.json|-] [requestId]` accepts a file or stdin JSON array. Names match `[a-z][a-z0-9_-]{0,31}`, unique among open jobs. Omit `cwd`, `model` and `thinking` when matching the parent.

- `model`: Pi selector, preferably `provider/model`; defaults to the parent's current model.
- `thinking`: `off|minimal|low|medium|high|xhigh|max`; inherits only when `model` is omitted.
- `cwd`: caller directory by default; worktrees must already exist.
- `timeout`: execution seconds, default 1800; range 1–86400. Queue time is separate.
- `extensions`: additive local extension paths; normal Pi resource discovery remains enabled.
- `persistent`: opt in to a private saved Pi conversation and supervised RPC; default false.
- `presentation`: `quiet` (default) or `agent` for Herdr agent metadata/custom restore. Herdr restore opens a **read-only report viewer**, never replays the task or launches unsupervised Pi.
- `maxTokens`, `maxCost`: positive soft per-attempt budgets, checked after finalized usage. An in-flight request can exceed them; missing provider cost data cannot enforce a cost limit.
- `preset`: a configured per-parent model policy; explicit fields override it. Changing model drops inherited preset thinking unless supplied explicitly.

At most 16 open panes; at most **4 active Pi processes** by default. Other panes wait for capacity. Cancelled queued work never starts Pi. Unknown orphan execution retains capacity until verified recovery.

## Continue and control

Native actions (see `text(await describeTool("subagents"))` for the full schema):

- `continue`: persistent job `id`, new `message`, stable `requestId`; creates a new attempt after acknowledgement and verified cleanup.
- `send`: live persistent `id`, `message`, `kind` (`steer|follow_up`), stable `requestId`; inspect delivery `state`/`disposition`, including uncertainty.
- `stop`: `id`; cancellation without pane closure.
- `reattach`: `id`, optional `pane`; requires live process/terminal evidence.
- `recover`: `id`; proven orphan cleanup, never replay.
- `configure`: optional `concurrency` (1–16) and replacement `presets` object; omitted fields are read back.

Use these with the report protocol in [orchestration.md](orchestration.md), or their CLI forms:

- `continue <id> <requestId> [prompt-file|-]`: new prompt, new attempt ID, same saved conversation. Requires the previous report fully acknowledged and its process cleanup verified. Closes the old collected pane. Concurrent continuations cannot share execution ownership.
- `send <id> <steer|follow_up> <requestId> [message-file|-]`: message a live persistent attempt. Read `state` and `disposition`; accepted/queued is not proof of a final answer. If delivery is uncertain, inspect using the **same ID and same message**, never resend under a fresh ID.
- `stop <id>`: intentional cancellation; retains the pane and report for inspection. Not pause. `cancel` additionally closes safely stopped panes.
- `reattach <id> [pane]`: adopt changed Herdr terminal identity only after live supervisor/viewer boot/start identity and PTY process evidence agree.
- `recover <id>`: explicitly clean proven orphan execution, without sending a prompt. Requires a dead supervisor plus saved process ownership (or a changed OS boot). Missing evidence fails closed. Then read/ack the failure report and explicitly continue persistent work.

One-shot workers cannot be continued. No command blindly repeats an old task. Forking the parent creates a fresh worker scope. Resuming its same session can adopt the existing scope only when its previous parent process is dead; two live parents cannot control it.

## Settings

`configure` displays settings. `configure settings.json` or stdin with `configure -` updates `concurrency` (1–16) and/or replaces named model `presets`:

```json
{"concurrency":4,"presets":{"review":{"model":"provider/model","thinking":"high","maxTokens":50000}}}
```

Settings are per parent session. Budget counters are per attempt; continuation starts new counters, not a cumulative conversation budget.

`collect [seconds]` is direct-Bash convenience only; restart-safe/codemode clients use `read`/`ack`. See [troubleshooting.md](troubleshooting.md) for cleanup and retained evidence.
