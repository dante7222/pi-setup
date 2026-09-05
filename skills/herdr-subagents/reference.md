# Options

`spawn [tasks.json]` accepts a file or stdin JSON array. Names match `[a-z][a-z0-9_-]{0,31}`, unique among open jobs. Omit `cwd`, `model` and `thinking` when matching the parent.

- `model`: Pi selector, preferably `provider/model`; defaults to the parent's current model.
- `thinking`: `off|minimal|low|medium|high|xhigh|max`; inherits only when `model` is omitted. Set explicitly with a model override if needed.
- `cwd`: defaults to caller directory; worktrees must already exist.
- `timeout`: integer seconds, default 1800; range 1–86400.
- `extensions`: extra local extension paths, added to normal Pi discovery; no tool allowlist.

`collect [seconds]` waits 0–60 seconds (default 0); cancelling the wait leaves workers running. Reports paginate losslessly: 12 KB per call, not per report.

See [troubleshooting.md](troubleshooting.md) for lifecycle, resource inheritance, artifacts and errors.
