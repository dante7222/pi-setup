# Options and troubleshooting

`spawn [tasks.json]` accepts a file or stdin JSON array. Names match `[a-z][a-z0-9_-]{0,31}`, unique among open jobs.

- `model`: Pi selector, preferably `provider/model`. Omitted: parent's current model.
- `thinking`: `off|minimal|low|medium|high|xhigh|max`. Inherits only when `model` is omitted.
- `cwd`: defaults to caller directory; worktrees must already exist.
- `timeout`: integer seconds, default 1800; range 1–86400.
- `extensions`: extra local extension paths, added to normal Pi discovery. The parent's Pi config directory supplies configured extensions, skills, templates, models and saved authentication; AGENTS.md and project resources follow normal cwd/trust rules. Herdr supplies the shell environment; parent-only environment credentials are not forwarded.

All roles use normal configured tools/extensions without a subagent-specific allowlist. Roles guide behavior, not permissions; session-only extension state is not copied. Workers are one-shot, not interactive chats; include clear success criteria and expect blockers in their reports.

`collect [seconds]` waits 0–60 seconds (default 0). Cancelling its wait leaves workers running. Reports paginate losslessly; 12 KB is a per-call limit, not a total-report limit.

`close` and parent settle close only fully collected panes. Reload preserves active jobs. Leaving the parent session (quit/new/resume/fork) requests cancellation. Cancellation waits for worker shutdown before closing the pane; failure to acknowledge retains it. Only owned panes are touched; creation preserves focus.

Workers stay in named terminal panes but do not register as Herdr agents: no Agents/priority entries or agent-attention notifications/counts. Use `/subagents` or CLI `status` for their file-backed state, not `herdr agent` commands.

`status` provides the artifact root. `<root>/<id>/result.md`, `events.jsonl`, and `stderr.log` preserve final text, raw events and errors after pane closure. Read/search only relevant evidence. Files may contain sensitive project data. Herdr viewport/scrollback reads can crop text; alternate-screen losses cannot be recovered by requesting more lines.

Requires macOS/Linux, Node 22.18+ and Pi inside Herdr. If a worker fails, inspect its error/report and relevant saved logs; do not treat failure as success or blindly retry. Forced pane/process termination can bypass cleanup and leave subprocesses.
