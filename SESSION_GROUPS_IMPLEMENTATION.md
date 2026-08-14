# Session Groups Implementation

This file tracks the nine implementation stages agreed with the user. A stage is complete only after local validation, a fresh-context review, and resolution of blocking findings.

## Status

1. [x] Extension foundation and data contracts
2. [x] Global storage and group CRUD
3. [x] `/group` command interface and Zed workflow
4. [x] Session membership and inheritance
5. [x] Per-turn shared-context injection
6. [x] Explicit agent context-edit tool
7. [x] Cross-process concurrency and revision safety
8. [x] Tokyo Night footer integration
9. [x] Complete tests, manifest, documentation, and final validation

## Review log

- Stage 1: approved after strict UUID/timestamp/schema validation, Unicode-safe names, outbound event validation, exact template tests, targeted tests, and typecheck.
- Stage 2: approved after atomic/private CRUD storage, strict UTF-8 and byte limits, path-link rejection, permission repair, durable directory syncing, crash-artifact recovery, and targeted tests.
- Stage 3: approved with the full `/group` menu/commands, Zed-only manual editing and revision reconciliation, confirmations, active-group controls, autocomplete, configurable viewer input, and real membership-controller tests.
- Stage 4: approved with stored/active/source precedence, `/new` and fork/clone inheritance, startup forks, stale/corrupt handling, fresh named-session detection, exact persisted handoffs, and async-context-isolated in-memory handoffs.
- Stage 5: approved with run-stable snapshots, next-turn disk refresh, non-persistent system-prompt injection, rename/deletion refresh, collision-safe boundaries, 64 KiB omission, and actionable repair distinctions.
- Stage 6: approved with current-turn direct-user authorization, fail-closed streaming association, revision/hash checks, exact edits, Pi mutation queuing, diff rendering, no-op/size rejection, and recoverable two-file transactions.
- Stage 7: approved with SQLite row locks, inode/namespace-bound persistent connections, crash-recoverable identity bootstrap, process-incarnation ownership, same-PID gated Zed exec, strict lock ordering/reentrancy, startup-safe busy-group deferral, optimistic revisions, and exact-byte transaction rollback.
- Stage 8: approved with session-scoped presentation events, live join/leave/rename updates, `Session Name [group]` rendering in TUI and Prime Agent modes, lifecycle reset, and suffix-preserving truncation.
- Stage 9: approved after manifest ordering guaranteed footer subscription before startup presentation, README usage/storage/security documentation, full-suite coverage, typecheck, JSON/resource validation, successful Pi `/reload`, offline command exercise, and final fresh-context review.
- Post-completion optimization: ungrouped sessions deactivate `edit_group_context` at startup and before each agent run, so its schema and guidance consume no model context. Grouped tool selection survives reload through non-context session state, and manual tool disabling is respected.
- Post-review authorization hardening: `edit_group_context` now requires an execution-time user confirmation with a bounded proposed-diff preview; negative-intent wording and noninteractive execution fail closed.
- Optional changelog: approved by fresh review after groups lazily create `changelog.md`; `/group changelog` edits it in Zed, while the minimal grouped-only `group_changelog` tool reads a bounded recent tail or appends confirmed timestamped entries without passive prompt injection. Full validation passed with 139 tests, typecheck, and Pi `/reload`.
- Context-overhead optimization: approved by fresh review after the footer moved estimation behind membership-specific tool gating and final prompt injection. Redundant model-supplied group ID/revision/hash fields were removed while controller-bound snapshots and store-level optimistic checks remain authoritative. Compact schemas and collision-safe prompt framing reduced estimated fixed grouped overhead from about 615 to 313 tokens. Full validation passed with 141 tests and typecheck.
