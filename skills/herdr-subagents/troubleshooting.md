# Lifecycle and troubleshooting

## Resources

The parent's Pi config directory supplies configured extensions, skills, templates, models and saved authentication; AGENTS.md and project resources follow normal cwd/trust rules. Herdr supplies the shell environment; parent-only environment credentials are not forwarded. All roles use normal configured tools/extensions without a subagent-specific allowlist. Roles guide behavior, not permissions; session-only extension state is not copied. Workers are one-shot by default; persistent mode uses supervised RPC, not interactive prompts. Include clear success criteria and expect blockers. RPC UI requests are cancelled. Pi 1.0.0 cannot consume cancellation replies while an extension blocks `session_start` on a dialog; the supervisor detects an unresponsive RPC reader and fails promptly. Such startup hooks must avoid interactive dialogs for workers.

## Collection and cleanup

`collect [seconds]` waits 0–60 seconds (default 0). Stopping the main Pi run cancels its workers too; killing only the standalone collect CLI does not. Reports paginate losslessly; 12 KB is a per-call limit, not a total-report limit. Every report includes its stable ID, name, state and `complete` flag; an omitted `offset` means 0. Repeat while `pending` is nonzero. Saved reports remain collectible if Herdr is unavailable; pending jobs may include a reconciliation `warning`.

`close` and normal parent settle close only fully collected panes. Stopping the main run broadcasts cancellation to all its workers and closes safely acknowledged panes, including unread ones; reports/logs remain on disk. This is cancellation, not pause/resume, and does not undo edits. Automatic-compaction cancellation also cancels workers once its signal is observed. Post-run compaction has two gaps: Stop while waiting for summarization authentication (before the hook), or after reloading during compaction, can miss worker cancellation; use `/subagents cancel` in those cases. Pi's terminal compaction event also marks extension vetoes as aborted, so it cannot safely identify Stop by itself. During retry backoff, the TUI observes the configured Stop key without consuming it and cancels workers only after Pi settles; ordinary provider failures, successful retries/continuations and cancelling manual compaction do not cancel workers. Pi exposes no retry-backoff abort event to extensions: programmatic/RPC cancellation during that signal-less gap requires `/subagents cancel` (active-generation/tool aborts work in every mode). The next prompt waits for cancellation cleanup to finish. Lifecycle hooks add no model messages or automatic turns; the native tool is deferred until explicitly activated. Reload preserves active jobs unless Stop already requested cancellation. Leaving the parent session (quit/new/resume/fork) requests cancellation. A batch shares one 10-second acknowledgement deadline and attempts every job. Atomic startup claims fence delayed/rejected launches. Missing acknowledgement or failed process cleanup retains the pane. Terminal identity follows cross-workspace moves and is rechecked immediately before closure; creation preserves focus. Herdr restore/handoff can change terminal IDs: verified live workers become `unattached`, requiring explicit recovery rather than unsafe pane-ID fallback. Synthetic reports never acknowledge process shutdown; only verified cleanup in `shutdown.json` permits closure. If a split response is lost, ownership remains unresolved: inspect Herdr instead of blindly retrying or closing unknown panes.

## Status and artifacts

By default, workers stay in quiet named terminal panes without Herdr agent registration. `presentation: "agent"` explicitly enables metadata and a custom cold-restore report viewer. Herdr 0.9.3 has no `agent resume` command; restored viewers never restart Pi. Use `/subagents` or CLI `status` and explicit `reattach`/`recover`/`continue`, not native Herdr Pi resume.

`spawn` returns only job IDs/names. `status [offset]` provides the artifact root and at most 16 entries; pass its `next` offset for another page. Omitted `collected`/`closed` flags mean false. `<root>/<id>/job.json` retains task settings, the original pane ID and stable terminal identity; match the terminal identity against live panes after workspace moves. `result.md`, `checkpoint.json`, `progress.json`, `execution.json`, `events.jsonl`, and `stderr.log` preserve final/checkpoint text, usage/progress, private process ownership, raw events and errors after pane closure. Persistent session JSONL lives under `<root>/conversations/<conversationId>`; each continuation gets a separate attempt/report directory. The stable scope is keyed by parent session, not Herdr's socket/pane. Finish old-version jobs before upgrading/reloading: legacy pane-keyed scopes are not migrated. Read/search only relevant evidence. Files may contain sensitive project data. Herdr viewport/scrollback reads can crop text; alternate-screen losses cannot be recovered by requesting more lines.

### Request-ID collisions

Native spawn errors include `code`, `diagnostic` and `inspection` for `REQUEST_ID_CONFLICT`, `REQUEST_NOT_REPLAYABLE` and `REQUEST_ARTIFACT_MISSING`. Call the returned `inspection` object (`{action:"request_status",requestId}`) to inspect that request in the current scope. It includes historical closed/collected job IDs even when ordinary status is empty. `admissionState: "done"` means launch admission finished, **not** that workers completed. Metadata is bounded to 16 jobs and excludes prompts/settings; `artifactsIncomplete` means evidence is missing or unusable, never permission to replay.

Scopes follow Pi session identity: resume retains the scope, a different/new session does not share it. Compare the diagnostic `scope` when investigating. `found:false` means no journal for that ID in this scope, not permission to replay an uncertain operation from another session. Never change tasks under an existing ID, erase its journal, or generate a replacement ID to bypass a failure. For genuinely new work, use the stored-ID recipe in [orchestration.md](orchestration.md).

## Native discovery and preparation

`help` accepts 1–3 action names and derives their arguments/results from execution schemas. For the complete interface use `text(await describeTool("subagents"))`; `await describeNamespace("subagents")` adds protocol instructions. Await discovery (printing a promise gives `{}`). Neither activates the schema; `/subagents enable` is unnecessary.

Native `prepare` validates and saves the exact explicit tasks with a host-generated UUID, returning only `{requestId}`. It launches nothing, does not resolve presets/model/cwd/group defaults, and does not reserve worker slots or names. `request_status` reports admission state `prepared` until launch admission begins. Drafts and admitted request journals remain private on disk; IDs are not security tokens. Prepared records are limited to 16 MiB; spawn also checks the existing 4 MiB job and 32 MiB request artifact budgets before launching. Normal scoped lock/live-owner checks still run during preparation.

**Let this call succeed before spawning**: codemode commits stores only on successful scripts. Only the compact ID is stored, so task batches need not fit codemode’s 262,144 JSON characters/value limit. If a preparation response or its store commit is lost, an unused draft may remain; preparing again is safe only when no spawn was attempted. After any possible spawn, never prepare a replacement: retain/recover the original ID and inspect it.

ID-only `spawn` requires a valid prepared-origin request in this Pi session. Explicit `spawn({requestId,tasks})` remains available; retain a fresh collision-resistant ID and exact payload before launching. A fixed descriptive ID can collide with historical work. Explicit tasks supplied with a prepared ID must match its immutable snapshot.

On response loss, rerun **only spawn** with the stored ID. Never regenerate an ID to bypass uncertainty. Defaults stay fixed from first admission, not preparation; changed or missing presets and path availability are evaluated only before that admission. Changed tasks collide; errors include `code`, `diagnostic` and `inspection` (`request_status`), including historical jobs hidden from ordinary status. Admission `done` is not worker completion. Interrupted/failed launches or incomplete artifacts need [inspection](troubleshooting.md#request-id-collisions), not blind replay. Use one stored operation at a time; after confirmed final cleanup, clear `herdr.operation` with `store("herdr.operation",undefined)` before preparing genuinely new work.

## Native delivery recovery

Every result is `{ok,action,data?,error?}`; check `ok` even when the call resolves. Successful `next` data includes:
- `reports`: pages with ID/name, state, text, UTF-16 offset, completeness, optional next offset and receipt.
- `errors`: per-job read failures; inspect these even when `ok:true`. Failed/cancelled reports are not success.
- `pending`: unfinished/unlisted jobs outside this batch, **not** pages still requiring acknowledgement.
- `closed`: job names closed during this call, capped at 16 with optional `closedOmitted`.

- `acknowledgementRequired`: returned pages still need acknowledgement after consumption.
- `finished`: reports and errors are empty and pending is zero; cleanup finished for this cycle.

The whole response shares one **12 KB aggregate budget**, including reports, errors, cleanup and optional progress. Never ack unseen/truncated output. If output/store is lost, clear only the local `herdr.receipts` store and call again without acknowledgements to reread from host cursors. Do not guess receipts or acknowledge by job ID.

Acknowledgements are contiguous and idempotent. A failed call/script can already have acknowledged prior pages or closed jobs; those effects are not rolled back. Retrying the same old receipts is safe; newly issued pages remain unacknowledged. Codemode store writes commit only when the script succeeds. Fatal acknowledgement/cleanup errors stop before new delivery; inspect/recover, then retry. No consuming `collect` from codemode.

## Optional controls

- `seconds:0..60` bounds waiting, not preceding acknowledgement/verified-cleanup I/O. Cancelling a wait alone does not cancel workers; parent Stop does.
- `details:true` adds at most 16 pending-worker phases, elapsed seconds since submission (including queue time), optional last-event age/tool and an omitted count. Event age is **not a heartbeat or proof of a stall**.
- Granular `wait/read/read_many/ack/close`, selective acknowledgement and recovery: [manual workflow](manual.md).
- Continue/send/stop/reattach, presets and concurrency: [persistent.md](persistent.md). Global configuration and CLI: [setup.md](setup.md).

The [durable prototype](durable.md) is separate and opt-in.

## Process cleanup

Workers retain normal global/project `APPEND_SYSTEM.md` instructions; a worker-only hook adds the role prompt afterward. The hook also records process ancestry before Pi exits. A supervisor samples process identities, revalidates them before signaling, and reaps observed descendants (including detached tool groups) on success, failure and cancellation. Raw process snapshots contain IDs/timestamps, not command lines or environment.

Requires macOS/Linux with `/bin/ps`, Node 22.18+ and Pi inside Herdr. If a worker fails, inspect its error/report and relevant saved logs; do not treat failure as success or blindly retry. This is not a sandbox: force-killing/crashing the parent bypasses its cancellation hooks; forced supervisor termination, descendants that fully daemonize between samples, and OS process-identity races can still bypass cleanup.
