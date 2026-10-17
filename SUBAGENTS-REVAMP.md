# Subagents revamp progress

Goal: replace `extensions/herdr-subagents` (Herdr panes, file mailboxes, receipts,
durable backend; ~4,600 lines) with lightweight, native, steerable subagents.

## Decisions

- Runtime: one `pi --mode rpc` child process per worker, owned by the parent extension.
  No Herdr, no supervisor process, no pi-durable.
- Workers do not survive parent quit. Idle workers close after 10 minutes and are
  resumed from their session file on the next `send`.
- Worker UI dialogs are auto-cancelled (no permission system; yolo).
- Completion delivery: auto-wake (A). Reports are batched and pushed with
  `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. `/subagents auto off`
  queues them for the next turn instead. `wait` consumes reports inline.
- Roles and models per task at spawn time; model validated against the parent's
  registry; inherit parent model/thinking when omitted. Reviewer/explorer exclude
  `edit,write`.
- Remove `durable_subagents`, CLI runners, skill docs, `integrations/herdr-pi-subagents`.
- Update dev pins to Pi 1.3.0; drop `pi-server`, `pi-durable`, `chord`, `pi-codemode`.

## Milestones

- [x] M1 Core: `extensions/subagents` (worker RPC wrapper, manager, tool, delivery, widget, commands)
- [x] M1 tests (fake RPC Pi fixture) + live smoke test with real Pi
- [x] M1 review (Opus 5.5 xhigh + GPT-6 Astra xhigh) and fixes
- [x] M2 Removal of old extension, skill, integration, durable; package/runtime pins to 1.3.0
- [x] M2 typecheck, full test suite
- [x] M2 review and fixes
- [x] M3 Final review of whole change, docs (README); fixes applied
- [x] M3 confirmation review of the M3 fixes (Opus: approve; Astra: 2 medium, fixed)

## Log

- M1: wrote `extensions/subagents/{tasks,rpc,manager,index,worker-prompt}.ts` (~560 lines).
  Bumped dev pins to 1.3.0 early (needed `agent_settled.aborted` types); removed
  `pi-server`, `pi-durable`, `chord`, `pi-codemode` deps and the herdr integration skill path.
  `test/subagents-manager.test.mjs` (11 tests, fake RPC Pi) passes.
- M1 live: `test/live/subagents-smoke.mjs` with `openai-codex/gpt-6-astra:low`: explorer ran
  bash, reported "8" in 7s; `send` continued in the same process with history ("9").
  Worker session showed the `subagent` prompt section; edit/write/subagents excluded.
- M1 review (both reviewers agreed on the main issues). Fixed:
  - Stop/timeout before `agent_start`: Pi's abort is a no-op then, so the process is
    closed instead; after `agent_start` abort is used and escalates to close after 10s
    only when the run does not settle (escalation cleared on settlement, not on abort reply).
  - Failed/handled/queued prompt: the process is discarded so nothing runs unseen.
  - Steer racing settlement: `send` uses `prompt` + `streamingBehavior: "steer"`, which
    starts a run when idle; unsolicited `agent_start` begins a tracked run.
  - `send` while stopping: queued as the next run.
  - Report loss on Esc: reports are delivered only while the parent is idle (Pi clears
    queued follow-ups on Esc); delivery retries every 2s and on `agent_settled`;
    aborted parent gets reports with `triggerTurn: false`.
  - `/reload` no longer kills workers: managers are kept per session id across reload.
  - Quit: `session_shutdown` awaits disposal; a global exit hook SIGTERMs live groups
    (Pi then stops its detached bash groups; SIGKILL would orphan them). Group sweep
    also after leader exit.
  - `close` instead of `exit` for final output/stderr; exit handler owns crash reports.
  - Dropped `PI_OFFLINE=1` (it disables model refresh); use `PI_SKIP_VERSION_CHECK`.
  - Queued-stop wakes waiters; FIFO queue; per-run report files; partial text kept on
    abort; timers unref'd.
  - Fake fixture now models Pi: delayed preflight, abort replies after settlement,
    steer-prompt starts a run when idle. 15 manager + 7 extension tests pass.
- M1 live (real Pi, gpt-6-astra:low): run, follow-up with history, steer mid-run
  (ALPHA -> BRAVO), stop during startup, stop mid-run (28 ms) all PASS.
- M2: deleted `extensions/herdr-subagents`, `skills/herdr-subagents`, `integrations/`,
  29 `test/herdr-*` files, herdr test helper and durable fixtures (75 files, ~16k lines).
  Manifest `pi.skills` is now `./skills` only.
  Pi 1.3.0 fallout fixed outside subagents:
  - `tokyo-night-footer`: `before_agent_start` is a union since 1.2.0; read `prompt`
    only for `messageType === "user"`. Test fixtures now send `messageType`.
  - `tokyo-night-theme.test`: `theme-json.js` moved to `theme-schema.js`.
  - `yellow-file-headers.test`: Pi 1.3.0's native edit header no longer truncates a
    hyperlinked path at width 12; assert the wrapper is never wider than native.
  `npx tsc -p tsconfig.json` clean; `npm test` 191/191.
  README: replaced the Herdr section with a short Subagents section; validated version 1.3.0.
  Added `test/live/run-tasks.mjs` (run tasks with the new manager outside a session);
  the M2 reviews themselves run through it.
- M2 review (Opus: changes-needed; Astra: changes-needed). Fixed:
  - Late reports after Esc woke the parent: an `interrupted` flag suppresses wake until
    the next user prompt (`before_agent_start` with `messageType: "user"`).
  - Esc stopped all subagents: now only those the aborted run started or messaged.
  - Group cleanup stopped at leader exit: `close()` polls the group (`kill(-pgid, 0)`)
    and escalates TERM -> KILL until it is empty; crashes sweep the group too; the exit
    hook keeps processes until swept.
  - Unbounded error text in reports: capped at 500 characters.
  - `/subagents auto` survives `/reload` (process-wide setting).
  - Test suite leaked `PI_SUBAGENT` from a worker environment; tests unset it.
  - Removed `HERDR_SUBAGENTS_MODERNIZATION.md`, `HERDR_CONTEXT_AUDIT.md`, the empty
    `integrations/` directory; README no longer mentions `pi-server`; theme `$schema`
    points to `https://pi.dev/schemas/theme.schema.json`; duplicated tool description
    text trimmed.
  - New tests: late-report no-wake, scoped Esc stop, orphaned SIGTERM-ignoring
    descendant killed, bounded errors. `npm test` 193/193, tsc clean, live smoke PASS.
- M3 e2e (`test/live/subagents-e2e.mjs`): a real `pi --mode rpc` parent loading this
  package called `subagents run` once, ended its turn, was woken by the batched report
  (`[subagent pong done 3s 3k tok $0.03]\nPONG`) and answered PONG. PASS. No leftover
  worker processes after any live run.
- M3 review (Astra: changes-needed; Opus: changes-needed, confirmed the working-tree
  fixes). Session was restarted mid-review; the standalone runner kept both reviews alive.
  Fixed:
  - Esc ownership reset on every `agent_start` (retries emit more): now reset only at
    `agent_settled`.
  - Stale abort could cancel the next run when `clear_queue` replied after settlement:
    abort is sent only if the same run is still active (run generation check).
  - `interrupted` and run ownership now survive `/reload` with the manager.
  - `send` during startup (before `agent_start`) could start a parallel prompt inside
    Pi's preflight and produce a false failure: it now queues as the next run.
  - Report files are named `<subagent-session>-<run>.md`, unique across managers.
  - Exact `provider/id` model matches now also require configured auth.
  - Fixture: top-level `spawn` import (no dynamic import).
  - New tests: stale-abort race (verified to fail without the guard), send during
    startup, wake suppression across reload, ownership across retries.
  `npm test` 196/196, tsc clean, live smoke PASS, e2e auto-wake PASS.
- M3 confirmation (Opus: approve, two lows; Astra: changes-needed, the same two as
  medium, both reproduced with the fixture). Fixed:
  - A steer prompt in flight at settlement could start a run that `stop` missed:
    `steersInFlight` / `cancelNextStart` cancel the run it starts.
  - Stopping a queued continuation left its idle process without a shutdown timer:
    `armIdle` restores it.
  Both regression tests fail without the fix. `npm test` 198/198, tsc clean, live smoke
  PASS, e2e auto-wake PASS, no leftover worker processes.

- Widget rework (`extensions/subagents/widget.ts`): header plus one line per active
  subagent: status dot, name, task summary, context bar and percentage (footer
  thresholds: green, yellow over 70%, red over 90%). No cost. Context tokens come
  from the latest response usage (Pi's `calculateContextTokens` rule) and compaction;
  the window comes from the worker model in the parent registry. Rendered as a component
  from live state; plain-text clipping avoids `truncateToWidth`'s SGR reset.
  `test/subagents-widget.test.mjs` covers layout, colours and widths.
- Flaky race test exposed a real gap: a steer prompt that started a new run left the
  worker idle until `agent_start` arrived in a later stdout chunk, so a stop in between
  was missed. The `started` disposition now begins tracking the run immediately.
  `npm test` 202/202 five times in a row; live smoke and e2e PASS.

- Widget middle column: short model name and effort (`GPT-6 Astra xhigh`) instead of
  the task text; compact aligned columns. Report header no longer shows cost.
- Batch delivery and `wait all`:
  - Each `run` call is a delivery batch; a `send` that starts a new run is its own.
    Reports stay in the outbox until no run of their batch is queued or running, then
    wake the parent once. Delivery is retriggered whenever state changes.
  - `wait` with `all: true` returns once none of the targets is queued or running.
  - Live e2e: one `run` with a 4 s and an 18 s subagent produced exactly one report
    message and one wake-up (`ALPHA OMEGA`).
- Batch review (Opus: approve, three lows; Astra: changes-needed). Fixed:
  - Reload crash: `render` accessed a stale ctx outside `try` from worker stdout
    handlers. All ctx access is now inside `try`; on reload the manager's hooks are
    detached and ctx cleared until the reloaded extension adopts it.
  - Phantom run: when a steer's whole run arrived buffered before its response, `send`
    began tracking a second, nonexistent run. It now checks the run counter first.
  - README: reports taken by `wait` are not delivered again (Opus low 1).
  Opus lows 2 (held reports not visible) and 3 (two parallel `send`s to one settling
  worker) left as is. Both regression tests fail without the fix.
  `npm test` 208/208 three times; live smoke and e2e PASS.

## Status

Done. Changes are staged, not committed.
