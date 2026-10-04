# Herdr subagents modernization

## Scope and execution policy

Implement the approved investigation in four ordered phases. Keep the ordinary, isolated one-shot worker workflow as the default. Persistent conversations, agent registration, background behavior, and the experimental durable backend are explicit choices. No automatic replay of unsafe side effects, no peer delegation, no automatic follow-up model turns, and no loss of unacknowledged reports. No commits unless requested.

Every phase requires implementation, focused validation, and at least two independent subagent reviews. Review findings are recorded below and resolved or explicitly bounded before proceeding. This file is the authoritative progress log.

## Baseline

- Installed Pi: 1.0.0; installed Herdr: 0.9.3; shell Node: 22.23.1.
- Original development dependencies: Pi 0.86.1.
- Source checkouts: `/Users/ventris/pi-development/pi` and `/Users/ventris/pi-development/herdr` contain unreleased changes; installed APIs are the compatibility target.
- Current integration: one-shot CLI JSON workers, private file-backed reports, supervised process trees, ordinary named Herdr panes.
- Investigation found synthetic completion accepted as cleanup acknowledgement; PID-only stale locks; terminal identity changes across Herdr restore/handoff; consuming report cursors on emission; ephemeral worker sessions; incomplete parent usage visibility.

## Phase 1 — Correctness

Status: complete.

- [x] Align development dependencies with installed Pi (1.0.0).
- [x] Separate report completion from verified process cleanup (`shutdown.json`).
- [x] Fence stale locks and worker/process incarnations using boot/start identities.
- [x] Reconcile Herdr handoff/restore conservatively: live workers become `unattached`, never falsely dead; explicit reattachment is Phase 3.
- [x] Require final settlement and checkpoint recoverable reports.
- [x] Focused regression tests, independent reruns, full typecheck and final Phase 1 suite (334/334 passed).
- [x] Independent review A: `p1-safety-review`.
- [x] Independent review B: `p1-test-review`.

## Phase 2 — Orchestration

Status: complete.

- [x] Typed deferred `subagents` tool, namespace and direct activation command.
- [x] Replayable report reads, private version-bound receipts, contiguous/idempotent acknowledgements.
- [x] Idempotent spawn requests; abort-aware lock admission and launch batches; bounded waits.
- [x] Finalized usage/progress metadata without repeated parent charging.
- [x] CLI/skill/docs updated; direct-Bash convenience collection retained.
- [x] Independent reviews: `p2-protocol-review`, `p2-api-review`; both consumed and closed.

Review fixes: cancelled queued spawns can no longer launch after cleanup; public schema has an object root for Anthropic while execution retains per-action validation; wait deadlines include initial readiness I/O. Ready backlogs are bounded. Real Pi codemode tests cover deferred calls, failed-script read replay, structured errors, and a network-blocked Anthropic payload capture. Full suite passed 363 tests before final schema/deadline fixes; all 25 affected tests and typecheck passed afterward.

## Phase 3 — Experience

Status: complete.

- [x] Persistent worker conversations and execution-attempt identities.
- [x] Continue, steer/follow-up, intentional stop, and explicit recovery.
- [x] Stable parent ownership and safe reattachment/fork behavior.
- [x] Optional Herdr metadata/registration/custom resume entrypoint.
- [x] Bounded concurrency (default four), explicit group inheritance, named model presets and soft budgets.
- [x] Focused tests and real Herdr/Pi RPC smoke with a faux provider (no paid/network model calls).
- [x] Independent reviews: `p3-safety-review`, `p3-rpc-review`; all findings addressed, reports consumed and panes closed.

Review fixes: recovery now merges/persists the matching late shutdown process snapshot before each cleanup pass; owner leases carry generation tokens checked inside every scoped mutation lock, fencing CLI processes that outlive a parent transfer; closed RPC mailboxes reject unattempted late sends; unsupported Pi startup dialogs get a bounded responsiveness probe and actionable failure. Added regression reproductions for each. Full suite passed **433/433** before these final review fixes; all **71** affected experience/RPC/worker tests and typecheck passed afterward. One heavily loaded reviewer run hit the deliberately fail-closed initial-process-snapshot race in a fast fake process; isolated rerun passed.

Implementation agents: `p3-rpc-worker` (58 worker/RPC tests), `p3-herdr-integration` (10 presentation tests), `p3-group-policy` (57 group tests), `p3-scheduler` (14 scheduler/identity/lock tests). All reports consumed and panes closed. Main integration adds stable live-parent fencing, native/CLI controls, process-ownership checkpoints and explicit orphan cleanup, model presets, and nine experience tests.

Validation: full suite **432/433 passed**; the only failure was the intentionally bounded options reference growing too large. Advanced documentation moved to `persistent.md`; all 62 affected worker/RPC/skill tests and typecheck passed afterward. Real Herdr 0.9.3 + installed Pi 1.0.0 smoke ran twice: persistent attempt one saw one user message, explicit continuation saw two, usage was reported, optional presentation produced no diagnostic errors, scheduler markers released, reports acknowledged, and all smoke panes closed. Temporary smoke artifacts were removed. Fresh Pi processes loaded the canonical resources; the controlling session itself has not been reloaded mid-implementation.

Safety boundaries: cold restore is a read-only viewer, not task replay; stopped work needs an explicit new prompt. Orphan recovery refuses missing ownership evidence. Scope keys changed to session identity; finish legacy jobs before upgrade/reload, with no automatic legacy-scope migration.

## Phase 4 — Experimental durable backend

Status: complete (explicit opt-in prototype, not the ordinary default).

- [x] Separate opt-in coordinator engine, private IPC transport, runtime integration and read-only viewer.
- [x] Persisted child conversations/submissions, request deduplication, explicit report delivery.
- [x] Cancellation, restart recovery, task/usage views; clients/viewers never own storage.
- [x] Preserve unsafe replay boundaries and ordinary backend default.
- [x] Faux-provider engine tests, real SIGKILL/restart test and documented limitations.
- [x] Initial independent reviews: `p4-engine-review`, `p4-transport-review`; reports consumed and panes closed.
- [x] Final process re-review: `p4-final-process-review`; 29 targeted tests and two independent multi-conversation cancellation probes passed, no actionable defects.
- [x] Final protocol re-review: `p4-final-protocol-review`; found an additional queued-admission race, now fixed with a regression.
- [x] Independent acceptance reviews: `p4-stop-generation-review`, `p4-final-acceptance-review`; all reports consumed, findings fixed, panes closed.

`p4-durable-engine` implemented the engine and 12 actual-core faux tests; report consumed. Main integrated the deferred `durable_subagents` facade, explicit activation command, independent parent lifecycle cancellation, docs and facade tests. Main also removed the initial 256 KiB report truncation (full reports must remain readable), bounded serialized report pages to 12 KB, set the recursive-delegation shell fence, and added a real coordinator SIGKILL/offline-stop recovery test. That test exposed an integration deadlock: paused cancellation could not finish before the transport released its resume fence. The final engine gates model/tool admission while atomic conversation abort drains cleanup, then closes/reopens when needed to preserve paused scheduling; unrelated recovered work stays paused. All 14 initial engine/crash tests passed. The ordinary/facade suite passed 450 tests during integration; final validation below supersedes this interim result.

Initial full Phase 4 suite: **464/464 passed**, plus typecheck. Independent reviews nevertheless found four defects; all were fixed before acceptance:

1. **P1** task-ID cancellation snapshots missed generation successors. Replaced with a gate installed before cancellation admission plus Pi-durable's atomic conversation-wide abort/queue withdrawal. Idempotent cancel replay also finishes pending cancellation. Added delayed-inspection/handoff fault regression; 14 engine tests pass.
2. **P1** SIGKILL of NodeExecutionEnv's owner left detached Bash commands running after recovered cancellation. `p4-shell-supervisor` added independent process supervision, gated startup, durable boot/start/process-tree evidence and fail-closed recovery. Engine wiring seals execution on unknown cleanup, and global recovery runs only at idle boundaries (never to cancel another live conversation). Real engine SIGKILL/delayed-effect regressions pass. Main identified environment secrets in initial request journalling; `p4-private-shell-env` moved environment transfer entirely to anonymous FD3, with sanitized supervisor startup and 1 MiB bounds. All 13 shell tests pass, including environment/argv privacy, hostile loader variables, large transfers and 4 MiB output.
3. **P1** slow ordinary pane cleanup could prevent the offline durable Stop intent from being written. Stop publication now uses a short ownership-transfer lock separate from ordinary I/O admission; same-live-parent claim is read-only/fast. Ownership transfer takes the same short lock before replacing the lease. Server emergency cancellation and watchdog also bypass ordinary pane cleanup; intent completion checks its exact request ID. Added held-lock publication and live-cancellation regressions.
4. **P2** native durable start/shutdown ignored cancellation after claim. Signals now propagate through admission, startup polling and socket waits, with a pre-launch recheck and cleanup of aborted boot reservations. Added abort-during-claim and queued-admission tests.

The combined safety subset initially passed 52 tests, with one test-fixture failure from assuming `Harness` was a class; wrapping `Harness.open()` fixed the fixture. The full suite subsequently passed **483/483**, plus typecheck. A third real Herdr/Pi persistent smoke passed after integration, including presentation, continuation and pane closure.

Final protocol review found **P1** queued spawn/send/resume could run after completed Stop erased its intent. Stop now atomically persists a monotonic admission generation with its intent and retains the completed record. Clients capture the generation before queuing; server admission compares it and enqueues synchronously under the same short lock as Stop publication. Tests cover queued socket and client calls, disconnected clients, restart persistence, explicit fresh work and repeat Stop. All **28** transport/crash/lifecycle tests and typecheck passed after this fix. Both independent acceptance reviews confirmed the generation fencing. One found **P2** invalid wait requests could reject before lock cleanup attached a promise handler, terminating the server. Added immediate rejection observation and regressions for negative, oversized and wrongly typed waits; the server now returns validation errors and remains available. The acceptance reviewer independently passed **484/484** full tests, **85/85** focused tests, typecheck and diff checks with no further actionable defects.

Real Pi TUI validation passed in a dedicated Herdr pane: both native tools loaded deferred, direct activation worked, `/reload` emitted shutdown/start reload events and reloaded canonical resources, a post-reload command worked, and `/quit` exited cleanly. Two earlier smoke-driver attempts sent `/quit` before reload restored its editor; adding an explicit post-reload command handshake fixed the driver. All smoke panes closed; no paid model calls. A separate real Herdr durable-viewer smoke also passed: faux submission settled, the viewer read through IPC without acknowledgement or new tasks, parent acknowledgement remained explicit, the storage lease stayed unchanged, and viewer/coordinator exited before cleanup.

Dependencies: development Pi-durable pinned to 1.0.0 with host peer `*`; Chord 1.0.0 runtime dependency. `npm audit --omit=dev` is clean. Full audit reports one existing bundled development-only `brace-expansion` advisory inside Pi 1.0.0; `npm update brace-expansion` cannot replace Pi's bundled copy. No upstream/installed package files were patched. Prototype remains experimental, disables automatic retries/compaction, retains its archive, and makes no power-loss or arbitrary-effects exactly-once guarantee.

## Validation and review log

### Phase 1 implementation

- `p1-worker` implemented settlement/checkpoint/cleanup verification and 30 worker fault tests; report consumed and pane closed.
- Main implementation added process boot/start identity, stale-lock recovery, separate parent cleanup acknowledgement, conservative handoff status, checkpoint reconciliation and focused regressions.
- Initial validation: 97 Herdr tests and typecheck passed after dependency synchronization; final identity wiring was subsequently validated by both reviews and the full Phase 1 suite.
- Both independent reviews consumed and panes closed. Findings fixed: enumerate lock claims before process sampling (deterministic new-contender regression); invalidate provisional death deadlines on verified recovery and recheck before synthetic completion; prefer checkpoints and atomically publish final text; isolate worker-test environment from inherited worker markers.
- Pi 1.0 Bash now returns structured nonzero-exit results rather than rejecting; updated the unrelated timeout test to assert the new contract without altering production Bash behavior.
- Final Phase 1 full suite: **334/334 passed** (`/tmp/pi-herdr-phase1-final.log`). Typecheck passed; review fixes preserve fail-closed ownership.
- An immutable temporary copy of the original runner at `/tmp/pi-herdr-modernization-bootstrap` manages implementation/review agents while the canonical runner is being changed. It is not an installed/canonical resource and is not committed.
- Safety limitation retained: ps start timestamps have second precision; fully daemonized descendants can escape sampling. New checks fail closed on unknown cleanup rather than claiming a sandbox.

## Final acceptance

- [x] Changed JSON parses; existing extension entry point imports new modules and the skills manifest covers new guides/CLI.
- [x] Final main full suite **484/484 passed** (`/tmp/pi-herdr-final.log`); `npm run typecheck` passed against Pi 1.0.0. Independent reviewer also passed 484/484.
- [x] Real Herdr/Pi persistent RPC, optional presentation, continuation, TUI activation/reload/quit, and durable read-only viewer exercised with faux providers. No paid model calls in validation.
- [x] Every phase reviewed by multiple independent subagents; all implementation/review reports consumed and owned panes closed.
- [x] `git diff --check` and final `git status` reviewed; production dependency audit clean. No commits made.

Remaining intentional boundaries: experimental durable API; no ordinary resources in durable children; no arbitrary-effects exactly-once or power-loss guarantee; process sampling is not a sandbox; durable archives are retained; one bundled development-only upstream dependency advisory. Run `/reload` in the parent to use the canonical changes, after finishing any legacy-scope jobs.

## Follow-up — Codemode defaults and workflow

Status: complete, explicitly approved by the user.

- Updated live `~/.pi/agent/settings.json` with additive `+codemode`, `+tool_search` defaults and `codemode.mode: "on"`; preserved all other settings. This personal preference is documented in the repository, not imposed by extension startup or copied into a tracked machine-specific settings file.
- Made the compact skill explicitly codemode-first for parent orchestration through `tools.subagents(...)`. Direct-native fallback requires unavailable codemode; CLI fallback requires unavailable native tools. Failed/denied calls are not grounds to bypass the interface. Preserved report read/emit/later-ack, cancellation, CLI compatibility and all documentation budgets.
- Ordinary workers keep direct tools and optional codemode; no forced routing or durable-mode activation. New workers inherit global settings subject to their own project settings; running workers are not automatically reloaded.
- Validation: six focused skill/actual-Pi-codemode tests passed, typecheck passed, global JSON parsed and `git diff --check` passed. Real Herdr TUI startup and `/reload` confirmed `read`, `bash`, `edit`, `write`, `codemode` and `tool_search` all active. The faux smoke exited, its pane closed and its temporary session scope was removed. No paid calls or commits.

## Follow-up — Context overhead audit

Completed a read-only fresh-session measurement and two independent reviews (`context-passive-review`, `context-codemode-review`); reports consumed and panes closed. Findings and methodology: [HERDR_CONTEXT_AUDIT.md](HERDR_CONTEXT_AUDIT.md).

Fresh native ordinary/durable schemas and namespaces cost zero passive context; the skill listing shrank five characters. Explicit codemode/search activation added 2,966 characters to the captured model-facing system/tool representation, about 742 tokens by Pi's characters/4 estimate. This is not an exact provider token count. First-use skill plus required native guide costs about 1,915 estimated tokens, with room to defer setup/CLI documentation. No settings or runtime behavior were changed during the audit.

## Follow-up — Agent ergonomics and retry correctness

Status: complete. Approved after comparing firsthand use with another agent's report.

- [x] Stable explicit spawn intent and first-admission defaults across native/CLI/durable retries (`retry-intent-fix`).
- [x] Test isolation under inherited worker markers without weakening production guards (`worker-test-isolation`, `worker-fixtures-final`).
- [x] Implement bounded ordinary `read_many`: one page per requested job, shared 12 KB budget, per-job errors, unchanged receipt validation and separate acknowledgement. Initial 23 report tests pass.
- [x] Implement optional wait details: capped pending-worker phases, submission age and last-event age; no stall inference or usage dumps.
- [x] Native facade integration and a short executable codemode recipe that stores receipts by job/page, plus awaited discovery.
- [x] Independent reviews A/B, full validation in parent/worker environments and real Herdr/Pi smoke.
- [x] Two final independent reviews of expanded test fixtures and mock-clock cleanup.

Original reproductions: `describeTool()` is async; printing its promise produced `{}`. Awaited discovery returns the complete declaration. Identical raw spawn arguments failed replay after parent model changes; durable transport parent fixtures failed under inherited worker markers. All addressed without removing the production recursion fence, auto-acknowledging fetched reports, or activating schemas at startup.

Implementation details:

- Ordinary admission fingerprints explicit intent before resolving defaults/presets; intent, resolved tasks and Pi executable are published together before launch. Concurrent/restarted retries retain the first snapshot; changed explicit fields collide. Failed/interrupted launches remain fail-closed. Durable admission similarly commits explicit intent, resolved execution, conversation and job together. No migration of old request fingerprints: pre-upgrade retry IDs may be rejected and need inspection, never blind replay.
- Batch reads share a single escaped-JSON/UTF-8 budget fairly across requested jobs; per-job failures do not discard successful pages. Reading never advances cursors. Receipts still bind scope, incarnation, completion revision and exact contiguous range. Optional wait details are bounded to 16 unfinished workers, preserve deadlines and explicitly do not diagnose stalls.
- The actual four JavaScript fences in `orchestration.md` execute verbatim in real Pi/QuickJS tests. Tests cover awaited discovery without permanent activation, stored receipts, multi-page reports, unread-store overwrite rejection, failed-script store rollback and idempotent retries after partially committed acknowledgements. An actual fresh model-context capture excludes ordinary/durable schemas, namespaces and recipe text.
- Setup/CLI details moved to conditional `setup.md`; advanced controls remain in `persistent.md`. First-use skill plus native guide shrank by 781 characters (about 195 estimated tokens), with no new passive overhead; see the updated context audit.

Reviews: `review-retry-safety` found no actionable defects and independently passed 70 focused tests; `review-report-ux` found no actionable defects and passed all 39 protocol/facade/recipe/skill tests. Both reports consumed, acknowledged and panes closed. The three implementation workers also reported, were acknowledged and closed. Final independent fixture reviews (`review-fixtures-env`, `review-fixtures-timers`) found no actionable defects; the latter independently passed 14 focused tests. Their reports were consumed and acknowledged, panes closed; no current workers remain.

Validation:

- Full suite **507/507 passed in the parent environment**, and **507/507 passed with worker/group/stale-owner/future markers inherited**, using `node --experimental-strip-types --test --test-concurrency=4 test/*.test.mjs`. Logs: `/tmp/herdr-ergonomics-{parent,worker}-bounded.log`. Typecheck and diff checks passed.
- Initial unrestricted runs exposed inherited-environment leaks in older CLI/group fixtures, now isolated using one test-only namespace helper with failure-safe restoration. Expanded fixture worker independently passed all 66 affected tests in both environments. Production policies were not changed.
- Also fixed a test-only mock-clock freeze: after firing the real Bash timeout, restore real timers before Pi asynchronously arms its post-exit stdio drain. Under unrestricted full-suite load, two other runs hit unrelated existing group-store/lock timing races in unchanged files; the store case passed isolated rerun. Bounded-concurrency full reruns both passed. These broader group races were not disguised by weakened assertions or production changes.
- Real Herdr/Pi native smoke spawned two faux workers, retried identical explicit arguments after changing parent defaults to invalid values, batch-read both reports, acknowledged them separately and closed both panes. A dedicated real TUI smoke confirmed deferred registration, direct activation, `/reload`, post-reload responsiveness and clean quit. All smoke-owned panes/scopes were cleaned. No paid model calls in validation.
- Package/lockfile JSON parsed; manifest covers all new modules/guides through the existing extension entry point and skill directory. Final `git diff --check` passed and `git status` was reviewed. Saved canonical resources are available to the controlling session after `/reload`; that session was not reloaded mid-implementation. No commits made.

## Follow-up — Typed discovery and one-call report cycle

Status: complete; user approved after feedback from a fresh one-shot review session.

- [x] Action-specific output schemas generated into deferred discovery (`typed-result-schemas`).
- [x] Native `next`: acknowledge only supplied prior receipts, close eligible jobs, wait and return one bounded batch.
- [x] Entire cycle response shares the 12 KB budget, including errors/cleanup/progress; no automatic acknowledgement of newly returned pages.
- [x] Short canonical recipe, existing granular actions retained in advanced guidance; real Pi/QuickJS tests execute the exact snippets.
- [x] Independent adversarial protocol tests (`next-protocol-tests`), two independent final reviews, parent/worker validation and real Herdr/reload smoke.

Design boundaries: acknowledgement still requires a later model call after consuming output. No inferred consumption, automatic model follow-ups, recursive delegation or durable-backend changes. Partial acknowledgements/closures can survive a failed call; retrying the same old receipts is idempotent, while newly issued pages remain unread. Fatal acknowledgement/cleanup failures stop before new report delivery. Both tools remain deferred; no added startup context.

Implementation workers completed: schemas cover all 15 ordinary actions plus failures, with compile-time drift checks and 22 focused tests; independent adversarial tests cover receipt rejection, paging, partial effects, lost responses, metadata fairness and lock admission. Both reports consumed and workers closed. Main integrated the facade and exact three-snippet canonical recipe; manual workflow moved intact to `manual.md` and remains executable/tested. Actual deferred discovery is 4,362 characters including the codemode result wrapper, with concrete return shapes and no `data: unknown` escape. Initial full parent suite passed 548/548; actual Herdr next smoke delivered two faux reports without consuming them, then acknowledged and closed both in a later cycle.

Initial reviews: `review-next-contracts` found no actionable defects and passed 57 targeted tests plus typecheck. `review-next-safety` passed 75 tests but independently reproduced two P2 cancellation races: admission could mutate after abort during awaited authority verification; queued native close/cancel ignored tool cancellation. Fixed with a final post-authority signal check and signal propagation through cleanup and both cancellation branches. Added six deterministic regressions, including authority-bearing scopes and actual read-stage admission. All 33 affected next/facade tests passed. Initial review reports consumed and panes closed. Independent fix re-reviews (`review-admission-fix`, `review-cycle-final`) found no actionable defects: the former passed 72 focused tests plus four ownership/admission tests; the latter passed 95 tests, typecheck and diff checks. Both final reports consumed and acknowledged, panes closed.

Final acceptance:

- **554/554 tests passed in the parent environment** (`/tmp/herdr-next-parent-final.log`) and **554/554 with inherited worker/group/stale-owner/future markers** (`/tmp/herdr-next-worker-rerun.log`), using four-way file concurrency. An earlier worker run hit the already documented unrelated reentrant group-lock test race; the unchanged suite passed on full rerun. No assertions were weakened or unrelated production behavior changed.
- Typecheck passed. Canonical six-line cycle (215 characters) and advanced manual snippets run verbatim under actual Pi/QuickJS. Deferred discovery exposes typed action results; fresh context still contains no native subagent declarations or guide text. Context tradeoffs recorded in `HERDR_CONTEXT_AUDIT.md`.
- Real Herdr smoke after safety fixes spawned two faux workers; initial `next` returned reports while cursors remained unchanged and panes stayed open, the following cycle acknowledged/closed both, and the terminating result contained empty reports/errors with pending zero. Dedicated TUI startup, activation, `/reload`, post-reload command and quit passed (`/tmp/herdr-next-tui-final.log`). All smoke scopes/panes cleaned; no paid model calls in validation.
- Canonical resources remain covered by the existing extension/skills manifest; JSON and whitespace validation completed. No commits. The controlling session needs another `/reload` to load this round's code.

## Follow-up — Request diagnostics and self-explanatory results

Status: complete; all four improvements implemented and independently reviewed in the approved order.

1. Structured collision diagnostics and scoped historical `request_status`, preserving replay rejection. Implementation worker: `request-diagnostics`.
2. A collision-resistant request-ID recipe, committed with its explicit tasks in a successful codemode call before spawning; reuse only for retries. No automatic replay or silent new ID after an ambiguous launch.
3. Explicit `next.acknowledgementRequired` and `next.finished`; final pages still require a later acknowledgement cycle.
4. Optional narrow action discovery generated from the same schemas; full discovery remains available and native tools remain deferred.

Each phase receives two independent reviews. Final acceptance includes focused/full parent and worker tests, real Pi/QuickJS guide execution, native Herdr and reload smokes, context accounting, and cleanup of all review workers. No commits or passive schema activation.

Reproduction: a historical closed/collected request conflicts with changed tasks while ordinary status correctly omits those closed jobs. Different Pi session IDs have different request scopes. The external agent's actual session was not inspected; this reproduction establishes the diagnostic gap, not that incident's cause.

Phase 1 implemented and reviewed by `diagnostics-safety-review` and `diagnostics-api-review`. Request inspection is same-scope, metadata-only, bounded to 16 jobs and available after closure; errors retain rejection and add code/diagnostic/inspection. Private snapshots are not emitted. Corrupt, oversized or symlinked artifacts fail closed. The safety reviewer found truncated completed journals could return a false successful replay; completed job counts now must match their nonempty saved task snapshot. Added a regression. Request tests **9/9**, facade/schema tests **39/39**, and typecheck passed; API reviewer independently passed 50 tests plus budget/privacy probes. Implementation/review reports consumed and panes closed.

Phase 2 implemented: the recipe commits a timestamp/random request ID and explicit tasks in a separate successful codemode call before spawn. Repreparing an existing operation is rejected; ambiguous launch failures retry the stored operation. This requires no new runtime feature or passive context. Exact QuickJS guide tests exercise lost spawn responses and retain the previously committed payload; guide/skill tests **8/8** passed. Independent reviewers `recipe-safety-review` and `recipe-api-review` found no actionable defects and independently passed 12 and 17 tests, including the phase-1 completeness regression. Both reports consumed and panes closed.

Phase 3 implemented and reviewed by `flags-protocol-review` and `flags-contract-review`: `acknowledgementRequired` tracks returned pages; `finished` requires empty reports/errors and pending zero. Both flags are reserved inside the aggregate response budget. Existing later-call acknowledgements, cancellation, and verified cleanup remain unchanged. Main **66/66** focused tests and typecheck passed; independent reviewers passed 43 and 66 tests with no actionable defects. Reports consumed, acknowledged and panes closed.

Phase 4 implemented: optional `help` selects 1–3 strict action argument/result schemas and renders them through Pi-codemode's public declaration API. Full discovery remains available; help needs no scope/ownership lookup. All selections are budget-tested, strict TypeScript examples compile, and oversized declarations fail explicitly instead of silently becoming unknown or truncated. Initial focused tests **53/53** passed.

Initial independent reviews: `discovery-safety-review` identified two P2 issues, now fixed: Pi managed installs omit dev/peer packages and do not alias the standalone `pi-codemode` renderer, so it is now a runtime dependency; the renderer ignores Record patternProperties, so preset output schemas now also supply typed additionalProperties. Added actual Pi loader isolation and nested preset TypeScript regressions (**33/33** affected tests passed). Host-provided Pi APIs remain peers; no installed/upstream files were changed. `discovery-final-review` found no production defect and independently passed the full worker suite on unchanged rerun (**572/572**); the first run had an unidentifiable nested isolation failure (**571/572**). Fixed its P3 test-diagnostics finding by preserving child TAP stdout/stderr and the original cause, with an additional regression (**6/6** isolation tests passed). Assertions and production safety were not weakened. Both initial review reports consumed, acknowledged and panes closed. Final fix re-reviews: `acceptance-package-review`, `acceptance-protocol-review`.

Pre-fix full parent suite **572/572** passed. Real native Herdr smoke passed: two faux workers, same-ID retry under changed defaults, narrow discovery, later acknowledgement/closure, final flags, empty ordinary status plus historical request lookup and structured conflict inspection. A real TUI startup/activation/reload/post-reload command/quit smoke passed. Smoke-owned panes/scopes were cleaned; no paid model calls in smoke validation. Final post-fix acceptance:

- **574/574 parent tests passed** (`/tmp/herdr-diagnostics-parent-acceptance.log`) and **574/574 in the actual worker environment** (`/tmp/herdr-diagnostics-worker-acceptance.log`), both with four-way file concurrency. No failures, cancellations or skips in either final run.
- Final independent reviewers `acceptance-package-review` and `acceptance-protocol-review` found no actionable defects; they additionally passed 33 and 88 focused tests and typecheck. All implementation/review reports consumed and acknowledged; all owned review panes closed.
- Typecheck, JSON parsing, resource-manifest coverage and `git diff --check` passed; final `git status` reviewed. Production dependency audit reports zero vulnerabilities. Existing unrelated uncommitted modernization changes retained; no commits.
- Both real native Herdr and TUI reload smokes reran successfully after the dependency/schema fixes (`/tmp/herdr-diagnostics-live-acceptance.log`, `/tmp/herdr-diagnostics-tui-acceptance.log`), with faux providers and cleanup of smoke-owned scopes/panes.
- Actual QuickJS discovery: narrow spawn/next 2,168 characters, complete interface 5,733. Guide plus skill plus narrow discovery totals about 2,490 estimated tokens, roughly 102 fewer than the previous full-discovery first-use path. No added passive context; measurements and caveats are in `HERDR_CONTEXT_AUDIT.md`.
- Controlling-session runtime was not reloaded during implementation. Run `/reload` to use the completed changes.

## Follow-up — Happy-path guide and native preparation

Status: implementation and independent reviews complete; full-suite validation has the existing unrelated session-groups failure documented below.

1. Shorten the required first-use guide: executable happy path and essential safety rules first; deeper recovery/reference detail moves to troubleshooting.
2. Show a compact optional `details:true` progress example, not a larger default response.
3. Add native `prepare(tasks)` to persist an immutable, private explicit task payload and generate an ID without launching. `spawn(requestId)` uses that preparation; defaults remain fixed at first spawn admission, not preparation. A successful preparation call must precede launch; ambiguous launch retries reuse its ID.

Keep direct explicit-task spawn available, preserve collision/authority/replay fencing and later-call acknowledgement, keep schemas deferred, and do not add a JavaScript/eval helper. Each phase receives multiple independent reviews. Final validation includes exact QuickJS recipes, fake fault tests, full parent/worker suites, real Herdr/reload smokes, context measurement and worker cleanup. No commits.

Phases 1 and 2 completed by `guide-polish`: guide **5,998 → 3,707 characters (38% shorter)**; all four executable snippets retained, recovery/reference explanations moved intact to troubleshooting, and progress shown as an opt-in inline variation. Documentation budget tightened to 4,200 characters. Both independent reviewers (`guide-safety-review`, `guide-ux-review`) found no actionable defects and each passed **9/9** exact skill/QuickJS tests. Reports consumed and acknowledged; owned panes closed. The safety reviewer could not independently compare historical untracked-file bytes; the implementation worker verified snippet equality, and actual execution tests pass.

Phase 3 implemented by `prepare-core` plus parent integration. A private prepared-state request journal stores exact explicit JSON and a UUID. ID-only spawn is restricted to valid prepared-origin requests; raw explicit-task spawn remains available. Immutable payload/marker/ID/hash are validated across admission and retries; first-admission defaults are resolved only when spawning. The canonical four-snippet guide now uses native preparation and stores only its ID. Actual QuickJS tests use real preparation/admission against a fake Herdr backend, including lost spawn/preparation replies, a >262,144-character task batch, one actual admission after response loss, and the opt-in progress variation.

Parent integration found and fixed two issues before final review: preparation initially avoided the common lock/live-owner checks to remain entirely process-free, and importing TypeBox into standalone core broke plain Node CLI/worker loading without development dependencies. Preparation now uses normal scoped admission/identity checks (but launches no workers); core reuses its existing syntax validator with inert values rather than importing host-only peer packages. Added deterministic queued-abort/owner-change, dead-owner, pre-publication abort and no-development-dependencies regressions. Also bound resolved prepared job/admission artifacts before launch so ID-only retry evidence stays readable. A concurrency test assumed the first caller won admission; both contenders now compare JSON wire values, preserving the one-admission assertion.

Focused integration/safety tests **61/61** and typecheck passed. Implementation worker reported 60 earlier focused tests; its report was consumed and acknowledged, pane closed. Final independent reviewers `prepare-safety-review` and `prepare-acceptance-review` found no actionable defects in these phases. The safety reviewer independently passed **125** focused tests and typecheck; the acceptance reviewer confirmed exact QuickJS recipes, deferred context, replay/ownership boundaries and standalone loading, while explicitly flagging the unrelated full-suite failure. Both reports consumed and acknowledged; all owned review panes closed. Final native status contains no jobs. All prior uncommitted modernization changes are retained.

Final validation and remaining caveat:

- Final parent focused rerun **61/61 passed** (`/tmp/herdr-preparation-wrapup.log`); typecheck, package/lock JSON parsing, resource-manifest paths and `git diff --check` passed. No assertions were weakened or production safety checks removed.
- Full parent and actual worker reruns each finished **597/598**, not clean acceptance. The remaining failure is the previously documented concurrent catalog test in unchanged `test/session-groups-store.test.mjs:629`, reporting a non-private/missing regular metadata file; an earlier parent run instead failed directory cleanup. The unchanged store tests pass alone **24/24**. An initial worker run hit the also previously documented group-lock rejection race; that unchanged subset passed alone **30/30**, and the full rerun passed that test but failed the store case. Logs: `/tmp/herdr-prepare-parent-rerun.log`, `/tmp/herdr-prepare-worker-final-rerun.log`, `/tmp/herdr-prepare-group-store-rerun.log`, `/tmp/herdr-prepare-worker-lock-rerun.log`.
- A serial full-suite run also finished **597/598** with the same store failure (`/tmp/herdr-prepare-parent-serial.log`); lowering cross-file concurrency did not resolve it. The affected group-store production/test files are unchanged. This issue remains unfixed and separate from the approved subagent ergonomics work; no claim of a green full suite is made.
- Real Herdr/Pi smoke passed: preparation with invalid execution defaults returned only an ID and no jobs, ID-only spawn admitted two faux workers, retry under changed defaults returned the same jobs, first delivery preserved cursors/open panes, and the later acknowledgement cycle closed both and returned `finished:true`. Historical request inspection and structured mismatched-task collision also passed (`/tmp/herdr-prepare-live-final.log`).
- Dedicated TUI startup, deferred registration, direct activation, `/reload`, post-reload command and clean quit passed (`/tmp/herdr-prepare-tui-final.log`). All smoke-owned scopes/panes were cleaned; no paid model calls in smoke validation. The controlling session was not reloaded mid-implementation.
- Final guide is **3,768 characters**; skill plus guide plus three-action narrow discovery totals **8,213 characters**, about **437 fewer estimated first-use tokens** than the preceding version, with **no added passive context**. Detailed accounting is in `HERDR_CONTEXT_AUDIT.md`.
- No commits. Run `/reload` in the controlling session to load native `prepare` and the updated workflow. The JavaScript-helper proposal remains intentionally deferred.

## Follow-up — Final context remeasurement

Status: complete; read-only runtime/configuration audit requested after all changes.

- Repeated the actual installed Pi fresh-session faux-provider capture with final canonical resources, once with current settings and once excluding only codemode/search. No workers were spawned by the captures and no network model calls were made. The final static context matches the initial audit exactly after timestamp normalization: **29,703 versus 26,737 characters**, an unchanged **2,966-character / about 742-token** codemode/search increment. Deferred subagent schemas/namespaces and on-demand guides contribute **zero** passive context; the existing skill listing is five characters smaller than Git HEAD.
- Exact QuickJS discovery and current documents total **8,213 characters / about 2,053 estimated first-use tokens**, excluding task prompts/scripts/reports/provider framing. This saves about 437 estimated tokens versus the preceding guide/discovery path, but is more initial guidance than the original minimal CLI-only skill; the audit now states both comparisons explicitly. Recorded separate parent/child usage, fixed-prefix versus repeated input billing, task-argument visibility and report-budget caveats.
- **16/16** focused codemode/discovery/skill tests passed (`/tmp/pi-context-audit-final/tests.log`). Independent reviewers `context-final-passive` and `context-final-ondemand` found no actionable runtime defects. They confirmed measurements, suggested small conditional-documentation/declaration savings, and identified a low-priority coverage gap: the current focused fresh-context fixture does not load the production entry point/resources, whereas this manual CLI audit does. No runtime or settings changes were made.
- Both reviewer reports consumed and acknowledged, owned panes closed; final delivery cycle returned `finished:true`. Fresh capture scopes were removed only after checking owner exit and absence of jobs. Detailed current conclusions are now first in `HERDR_CONTEXT_AUDIT.md`; local captures/measurement script/summary are under `/tmp/pi-context-audit-final/`. No commits at this stage.

## Commit preparation

The user subsequently approved committing and pushing the completed changes. The pre-typecheck hook detected that installed Pi had advanced to **1.0.2** and synchronized the existing development dependencies and lockfile; Pi-durable/Chord/pi-codemode remain at their explicitly tested 1.0.0 versions. Typecheck and **61/61** preparation/discovery/facade tests passed (`/tmp/herdr-precommit-focused.log`), followed by **124/124** durable/RPC/experience/worker tests (`/tmp/herdr-precommit-runtime.log`). Real native preparation/retry/report/cleanup and TUI startup/activation/reload/quit smokes passed again against the new runtime (`/tmp/herdr-precommit-live.log`, `/tmp/herdr-precommit-tui.log`), with all smoke-owned panes/scopes cleaned. Production dependency audit reports zero vulnerabilities. The full-suite **597/598** caveat above remains; no new full-suite success is claimed. Context character measurements above were captured on Pi 1.0.0 before this runtime update.
