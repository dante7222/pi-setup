# Pi 1.x upgrade progress

## Scope and rules

Implement the improvements approved after the Pi 0.85 → 1.0.2 audit. Work in the canonical package only; preserve existing functionality and keep the permissions extension disabled. No commits or changes to installed/upstream Pi. Target installed Pi 1.0.2; the local upstream source checkout reports 1.0.0 and is supporting reference only.

Each phase must include regression tests, a separate subagent review, resolution of findings, and an updated entry here before the next implementation phase starts. Final validation includes the full local test suite, TypeScript, JSON/resource checks, diff checks, and isolated interactive reload/UI checks without paid provider calls or private settings changes.

## Phases

| Phase | Scope | Implementation | Independent review | Validation |
| --- | --- | --- | --- | --- |
| 1 | Footer mouse coordinates, canonical context edits, Git refresh/error state, Fast Mode capability list, virtual-model metrics/titles | Complete | Approved after repairs | 73 focused tests, TypeScript, diff check passed |
| 2 | Renderer-only yellow edit/write headers; Tokyo Night readable secondary text and scrollbar | Complete | Approved | 79 footer/presentation/theme tests, TypeScript, diff check passed |
| 3 | UTF-8-safe transcript filenames; incomplete-response annotations | Complete | Approved after repairs | 10 transcript tests, TypeScript, diff check passed |
| 4 | Herdr administrative cancellation propagation | Complete | Approved | 70 focused Herdr tests, TypeScript, diff check passed |
| 5 | Web-access exclusion-only resource filters | Complete | Approved | 6 focused tests, TypeScript, diff check passed |
| 6 | Disabled permissions: Pi-consistent file URLs and serialized/cancellable approvals | Complete within public APIs; upstream limit documented | Local repairs approved | 67 focused tests, TypeScript, diff check passed |
| 7 | Documentation and full integration/interactive validation | Complete | Approved after documentation corrections | 531/531 tests; TypeScript/JSON/manifest/diff checks; both PTY modes passed |

## Acceptance checklist

- [x] Clicking the custom editor and autocomplete uses the correct coordinates.
- [x] Context edits invalidate stale accounting and use canonical projected history.
- [x] Git refreshes coalesce, retain known data on failures, and report stale/unknown state.
- [x] Fast Mode indication matches the installed integration and represents requested, not guaranteed, service.
- [x] Virtual selections and physical responses have correct labels, limits, accounting, and provider-neutral title generation.
- [x] Yellow headers persist through results without overriding executable tools.
- [x] Secondary reading text and fullscreen scrollbar are more legible without changing the Tokyo Night identity.
- [x] Unicode transcript paths fit filesystem limits, including atomic-write temporary names.
- [x] Aborted, errored, and length-limited transcript responses are identifiable.
- [x] Cancelled administrative calls cannot execute after waiting for a Herdr lock.
- [x] Explicit web enable recovers exclusion-only filters and status is not falsely on.
- [x] Permission matching uses decoded/resolved native file targets; approval dialogs serialize and honor exposed run/lifecycle cancellation. Document upstream nested-call cancellation limits.
- [x] Permissions remain absent from the package's active extension manifest.
- [x] All separate phase reviews completed and reports acknowledged; all workers closed.
- [x] Final checks complete; any remaining limitations explicitly documented.

## Execution log

### Baseline

- Working tree clean at `ed2608b` before implementation.
- Audit baseline: TypeScript and 66 focused footer/transcript/bash/web tests passed; Tokyo Night passed installed Pi theme validation with 52 explicit tokens.
- The audit identified behavioral gaps not exercised by those existing tests. No prior audit edits were made.

### Phase 1 — Footer correctness and virtual models

- Implementation worker `phase1-footer-impl` completed; report consumed and worker closed.
- Implemented custom-editor/autocomplete mouse translation, canonical projected-context edit invalidation, coalesced Git requests with stale/unknown state and disposal cancellation, updated Fast Mode IDs/requested badge, and virtual-selection/physical-response accounting and labels.
- Title requests use public `ModelRegistry.streamSimple(...).result()`: installed 1.0.2 does not expose `completeSimple()` on that facade.
- Worker validation: 67 focused tests, direct TypeScript check, and `git diff --check` passed; no provider calls. Parent independently reran the same focused tests and TypeScript check successfully.
- Independent review `phase1-footer-review` found: P2 boundary compactions missed without `session_compact`; P2 canonical/prepared tool declarations discarded during estimation; P3 equal/non-monotonic timestamps rejecting valid post-compaction usage. Findings accepted; focused repairs and regression tests required before acceptance. Report consumed and worker closed.
- Repair worker `phase1-context-fixes` addressed all three findings and added five real-SessionManager regressions; 72/72 tests, TypeScript, and diff checks passed. Report consumed and worker closed; independent re-review requested.
- Re-review confirmed the three repairs, but found equal-text forced prompts were inferred incorrectly. Parent replaced that inference with the shared explicit `before_agent_start.systemPromptOptions` reference; later handlers setting/clearing overrides and empty-string overrides are covered. All 73 footer tests, TypeScript, and diff checks pass. Targeted independent final review requested.
- Public-API limitation: Pi filters private hidden declarations after `context_with_system`; exact post-filter/later-handler payload accounting is unavailable. Estimates remain marked approximate and finalized provider usage reconciles them.
- Interactive checks and README synchronization remain scheduled for phase 7.
- Interactive-test preparation: `tmux` is unavailable; final UI checks will use an isolated pseudo-terminal with the installed CLI, temporary configuration/session storage, and an offline fake provider.
- Final independent reviewer `phase1-forced-review` approved the remaining fix; 73 tests, TypeScript, and diff checks passed. All phase 1 findings resolved, reports consumed, and workers closed.

### Phase 2 — Tool presentation and Tokyo Night readability

- Migrated to `registerToolRenderer()` without registering or replacing executable tools; composed both native renderers and preserved shell/state behavior. Semantic `fg()` and `style()` headers become yellow, including completed edit headers.
- Added a brighter blue-violet secondary text variable for thinking, syntax comments, diff context, and link URLs; decorative borders stay subdued. Defined distinct scrollbar colors.
- Six new regression tests cover native partial/success/error rendering, Unicode/narrow widths, renderer composition, theme changes, native schema validation, truecolor/256-color output, >=4.5:1 reading-text contrast on intended backgrounds, and >=3:1 thumb/track contrast.
- Fixed one initial test expectation to account for native `Text` width padding. All 79 footer/presentation/theme tests, TypeScript, and diff checks now pass.
- Independent reviewer `phase2-render-review` approved; six focused tests and 112 extra renderer-state probes passed. Reviewer verified minimum reading contrast 4.76:1 truecolor / 5.56:1 256-color and scrollbar contrast 3.83:1 / 4.03:1. Report consumed; worker closed.

### Phase 3 — Transcript robustness

- Budgeted slug length against the full sidecar basename's 255-byte UTF-8 limit; atomic writes now use short random same-directory temporary names. Existing short/ASCII names remain unchanged.
- Added per-attempt annotations for aborted, errored, and length-limited assistant messages without changing stored response text or including provider diagnostics. Successful retries remain distinguishable.
- Added three regressions covering long CJK/astral/accented names, private file permissions, rename cleanup, exact raw serialization (including system/context-edit/nested-call data), empty failures, and successful retries.
- Initial 8 tests, TypeScript, and diff checks passed. Reviewer `phase3-transcript-review` approved filename/atomic-write behavior (including extra failure-path probes), but found status/retries could be swallowed by unterminated Markdown fences/comments. Report consumed; worker closed.
- Accepted the finding: status now precedes its attempt body; rendering-only Markdown boundaries close unfinished root fences/comments/preformatted HTML and separate containers. Applied boundaries to question/thinking text as well. Raw text and sidecars are unchanged. Uses `Marked` already exported by the existing Pi TUI peer, with no new dependency.
- Added semantic Markdown-render regressions for incomplete fences/comments, nested quote/list fences, raw HTML blocks, later retries, and partial question/thinking content. This is not a general raw-HTML sanitizer.
- Re-review confirmed original fence/comment repairs but caught an over-escaped whitespace regex for attributed preformatted tags. Corrected it and added attributed/multiline/uppercase pre/script/style/textarea cases. All 10 transcript tests, TypeScript, and diff checks pass.
- Final reviewer `phase3-final-review` approved and independently confirmed parsed retries remain root paragraphs after repaired blocks. All phase 3 reports consumed and workers closed.

### Phase 4 — Herdr cancellation admission

- Threaded the native tool signal through stop/recover/reattach and both configuration writers into existing `locked(..., signal)` admission. Once admitted, existing cleanup/atomic publication remains noncancellable.
- Extended real held-lock native-tool regressions for all five administrative write paths, checking abort settles while the lock is held and no job/settings/preset/recovery mutation occurs after release.
- All 70 focused Herdr tools/RPC/presentation/scheduler/abort tests pass (serial file scheduling), as do TypeScript and diff checks. Independent review requested.
- Reviewer `phase4-cancel-review` approved after independently running 23 native tool tests, TypeScript, and scoped diff checks. Report consumed; worker closed.

### Phase 5 — Web-access filter state

- Represented custom resource filters separately instead of guessing resolved glob matches or installing packages to inspect status. Explicit on/off normalizes filtered registrations while preserving version pins and unrelated entries.
- Status describes global configuration, not project overrides or proven effective loading. Known disabled forms remain off; mixed registrations and custom includes/excludes are filtered. Filtered selectors default to restoring normal loading.
- All six focused tests, TypeScript, and diff checks pass; tests use temporary global settings and cover exclusion-only recovery, no-op known states, cancellation/no UI, malformed settings, and missing registration. Independent review requested.
- Reviewer `phase5-web-review` approved and independently reran all six tests, TypeScript, and scoped diff checks. Report consumed; worker closed.

### Phase 6 — Disabled permissions hardening

- Kept the extension disabled in the manifest. Worker `phase6-permissions-impl` normalized file targets consistently with Pi and serialized approval dialogs with cancellation/lifecycle guards; preserved deny precedence, hashed grants, and YOLO behavior.
- Worker reports 49 focused tests, TypeScript, and diff checks passing. Added path-parity and concurrency/lifecycle regressions. Report consumed; worker closed; independent review requested.
- Deliberate safety behavior: a noncooperative UI retains its queue slot until settling, so cancellation cannot open overlapping dialogs. Lexical path checks remain non-symlink-safe; Windows execution is not available locally.
- Parent preflight across all non-permissions suites passed 464/464 tests while the worker owned only permissions files.
- Parent independently reran all 49 permissions tests and TypeScript successfully. Reviewer `phase6-permissions-review` found: P1 native read fallbacks can change the approved filename; P2 installed Pi drops nested per-call signals before permission hooks; P2 interrupted YOLO-disable loading can restore persisted bypass. Findings accepted; reviewer report consumed and worker closed. Resolve local defects and investigate supported cancellation mitigation before acceptance.
- Parent confirmed the upstream cancellation boundary in installed `agent-session.js` (`_beforeToolCall`, `_executeNestedToolCall`, `getSignal: () => this.agent.signal`) and public event/context types: permission hooks expose only the run signal, not a nested call's separate signal. No supported extension hook supplies the missing signal. Preserve nested functionality and avoid private monkey-patching or modifying installed/upstream Pi; document that isolated nested cancellation alone cannot dismiss an approval or suppress a late session grant. Run Stop/session lifecycle cancellation is handled. This extension remains disabled.
- Repair worker `phase6-permissions-fixes` resolved actual native read fallbacks (including non-renormalized selected names) with abort-safe filesystem probes and made YOLO-disable durable before awaiting policy. Added 18 regressions; 67 focused tests, TypeScript, and diff checks passed. Report consumed; worker closed; independent re-review requested.
- Parent independently reran all 67 tests and TypeScript. Reviewer `phase6-final-review` approved local repairs and explicitly confirmed the remaining upstream signal limitation. Report consumed; worker closed.

### Phase 7 — Documentation and final validation

- Full offline suite passed 531/531 tests with serial file scheduling and no skips/TODOs. Direct invocation avoids dependency-synchronizer hooks.
- Isolated installed-CLI PTY smoke passed in fullscreen and regular modes: offline virtual router → physical model, generated title, real native write/edit execution and yellow-header ANSI output, resize 160→40→160 columns, long CJK session title/transcript export, `/reload`, and a second reply. Both exited successfully. Temporary HOME/config/session/project, fake provider, no inherited credentials or Herdr environment.
- PTY harness initially asserted the model ID instead of its displayed name and had unbounded failure cleanup; corrected the temporary harness, then both complete runs passed. No production fix was needed.
- PTY artifacts/scripts: `/tmp/pi-upgrade-smoke.RgtXuX/`; suite log: `/tmp/pi-upgrade-full-suite.log`. These are temporary validation evidence, not package resources. Automated terminal behavior/ANSI validation is not a human visual review.
- README synchronized with actual behavior, including requested Fast Mode, virtual dispatch, canonical context and hidden-declaration estimation limits, renderer-only headers, theme contrast/scrollbar, transcript safeguards, global filtered web state, admission-only Herdr cancellation, and disabled permissions' upstream signal limitation. Corrected package-theme reload guidance and retained Bash timeout scope without claiming a new core fix.
- Final direct TypeScript, JSON parsing (theme/package/lock/policy), manifest resource existence, disabled-permissions registration, peer-range checks, and `git diff --check` passed. No dependency or manifest changes were necessary. Final independent integration review requested.
- Reviewer `phase7-final-review` found no runtime integration blocker, independently passed 106 focused tests and both PTY modes, and confirmed full-suite evidence. Accepted three P3 documentation corrections: automatic transcript export covers `session_compact`, not boundary-appended compactions (use `/transcript`); Git cancellation is on session shutdown/reload, not footer-slot disposal; installed Pi 1.0.2 requires Node 22.19+. README corrected. Report consumed; worker closed; targeted final documentation re-review requested.
- Reviewer `phase7-docs-final` approved the corrected documentation and verified each claim against implementation/installed metadata; diff check passed. Report consumed; worker closed. All seven phase gates are complete within the documented public-API limits.

## Completion and remaining limits

- Saved canonical changes only; no dependency changes, active-resource changes, installed/upstream patches, or private settings edits. Run `/reload` in your regular Pi session to load them.
- Commit and push subsequently authorized by the user, using the completed validation above without rerunning checks or Git hooks.
- Pi 1.0.2 still does not expose isolated nested-call cancellation to permission hooks; late session grants remain possible for that case. The permissions extension stays disabled.
- Context estimates cannot see Pi's later hidden-declaration filtering; final provider usage reconciles them. Transcript boundary-appended compactions need `/transcript`; Markdown boundaries are not an HTML sanitizer.
- Permission checks remain lexical/TOCTOU-prone, not a sandbox. Windows and human visual checks were not performed; macOS automated truecolor/256-color tests and fullscreen/regular PTY behavior checks passed.
