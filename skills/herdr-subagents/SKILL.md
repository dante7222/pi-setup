---
name: herdr-subagents
description: Delegate 1–16 independent Pi review, exploration, testing or custom tasks in named Herdr panes; collect and close.
---

Commands below are arguments to `node <absolute-skill-directory>/run.mjs`, run through **bash** from Pi inside Herdr. No peer coordination, recursive delegation, or general Herdr skill needed.

```bash
node <absolute-skill-directory>/run.mjs spawn <<'JSON'
[{"name":"review-auth","role":"reviewer","prompt":"Review src/auth; report actionable defects with file:line."}]
JSON
```

Tasks require unique lowercase slug `name` (max 32) and self-contained `prompt`: include paths, essential context and acceptance criteria; workers receive no parent history. Roles: `reviewer|explorer|tester|worker` (default). Optional `cwd`, `model` (`provider/model`), `thinking`: omit when matching the parent. Thinking inherits only without a model override. No overlapping writes; use separate existing worktrees if needed. Normal Pi tools/extensions; roles are not permissions. Limit: 16 open jobs, including completed panes.

Do independent work, then run `collect 60` (Bash timeout 75s). **Read every report; repeat until `pending: 0`.** `complete: false` continues that report next call. Check `state`: failed/cancelled is not success. Output is file-backed, paged at 12 KB; never pipe/truncate it, scrape panes, or dump raw transcripts.

Run `close` after consuming all reports, **before your final response**. Automatic cleanup is only a fallback. `status` returns IDs/artifact root. Use `cancel <id...>` or `cancel all`, never force-close working panes; unacknowledged cancellation retains the pane for inspection.

Read [reference.md](reference.md) only for advanced options; [troubleshooting.md](troubleshooting.md) for lifecycle/errors.
