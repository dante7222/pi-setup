# Lifecycle and troubleshooting

## Resources

The parent's Pi config directory supplies configured extensions, skills, templates, models and saved authentication; AGENTS.md and project resources follow normal cwd/trust rules. Herdr supplies the shell environment; parent-only environment credentials are not forwarded. All roles use normal configured tools/extensions without a subagent-specific allowlist. Roles guide behavior, not permissions; session-only extension state is not copied. Workers are one-shot, not interactive chats; include clear success criteria and expect blockers in their reports.

## Collection and cleanup

`collect [seconds]` waits 0–60 seconds (default 0). Cancelling its wait leaves workers running. Reports paginate losslessly; 12 KB is a per-call limit, not a total-report limit. Every report includes its stable ID, name, state and `complete` flag; an omitted `offset` means 0. Repeat while `pending` is nonzero. Saved reports remain collectible if Herdr is unavailable; pending jobs may include a reconciliation `warning`.

`close` and parent settle close only fully collected panes. Reload preserves active jobs. Leaving the parent session (quit/new/resume/fork) requests cancellation. A batch shares one 10-second acknowledgement deadline and attempts every job. Atomic startup claims fence delayed/rejected launches. Missing acknowledgement or failed process cleanup retains the pane. Terminal identity follows cross-workspace moves and is rechecked immediately before closure; creation preserves focus. If a split response is lost, ownership remains unresolved: inspect Herdr instead of blindly retrying or closing unknown panes.

## Status and artifacts

Workers stay in named terminal panes but do not register as Herdr agents: no Agents/priority entries or agent-attention notifications/counts. Use `/subagents` or CLI `status` for their file-backed state, not `herdr agent` commands.

`spawn` returns only job IDs/names. `status [offset]` provides the artifact root and at most 16 entries; pass its `next` offset for another page. Omitted `collected`/`closed` flags mean false. `<root>/<id>/job.json` retains task settings, the original pane ID and stable terminal identity; match the terminal identity against live panes after workspace moves. `result.md`, `events.jsonl`, and `stderr.log` preserve final text, raw events and errors after pane closure. Read/search only relevant evidence. Files may contain sensitive project data. Herdr viewport/scrollback reads can crop text; alternate-screen losses cannot be recovered by requesting more lines.

## Process cleanup

Workers retain normal global/project `APPEND_SYSTEM.md` instructions; a worker-only hook adds the role prompt afterward. The hook also records process ancestry before Pi exits. A supervisor samples process identities, revalidates them before signaling, and reaps observed descendants (including detached tool groups) on success, failure and cancellation. Raw process snapshots contain IDs/timestamps, not command lines or environment.

Requires macOS/Linux with `/bin/ps`, Node 22.18+ and Pi inside Herdr. If a worker fails, inspect its error/report and relevant saved logs; do not treat failure as success or blindly retry. This is not a sandbox: forced supervisor termination, descendants that fully daemonize between samples, and OS process-identity races can still bypass cleanup.
