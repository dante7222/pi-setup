---
name: herdr-subagents
description: Delegate 1–16 independent Pi tasks in Herdr panes; read reports, acknowledge and close, or continue a worker.
---

For parent orchestration, use **codemode with native `tools.subagents(...)`**, not the Bash runner. Read [orchestration.md](orchestration.md) before calling it. Use `prepare` then `spawn`; check `ok`. Work independently, then use `next` for report cycles. Emit pages before acknowledging them in a later call; never ack unseen output or use `collect` from codemode. Close acknowledged jobs before your final response.

Use unique lowercase slugs (max 32) and self-contained prompts with paths and acceptance criteria; workers receive no parent history. Roles: reviewer|explorer|tester|worker (default). Optional `cwd`, `model`, `thinking`: omit when matching the parent; model overrides drop inherited thinking. No overlapping writes; use existing worktrees. Normal Pi tools/extensions; roles are not permissions. Limit: 16 open jobs, including completed. No peer coordination or recursive delegation.

Without codemode, call native `subagents` directly. Only without native tools, use the CLI through **bash** inside Herdr:

```bash
node <absolute-skill-directory>/run.mjs spawn <<'JSON'
[{"name":"review-auth","role":"reviewer","prompt":"Review src/auth; report defects with file:line."}]
JSON
```

CLI: `collect 60` (Bash timeout 75s); read all output until `pending: 0`, then `close`. `complete: false` needs another page; failed/cancelled is not success. Reports: 12 KB/page; never pipe/truncate or scrape panes.

Use status IDs to cancel; never force-close workers. An unacknowledged cancellation retains its pane.

Read [reference.md](reference.md) only for options; [troubleshooting.md](troubleshooting.md) for lifecycle/errors.
