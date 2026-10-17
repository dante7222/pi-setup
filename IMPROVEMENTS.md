# Improvements tracker

Source: deep review (2026-10-17). Subagents extension out of scope.
Each batch: implement -> review by `claude-opus-5-5:xhigh` + `gpt-6-astra:xhigh` -> fix findings -> mark done.

Status: `[ ]` todo, `[~]` implemented/in review, `[x]` reviewed and done.

## Batch F: tokyo-night-footer rendering/perf
- [x] F1 Centered `↓ N more` scroll border not detected (index.ts findBottomBorderIndex)
- [x] F2 `styleCaret` never matches (fake cursor markers)
- [x] F3 codex-fast-mode readFileSync per render -> cache
- [x] F4 git status spawned from render, even outside git repos
- [x] F5 git status backoff on timeout/failure
- [x] F6 Title generation retry cap
- [x] F7 Re-measure left width after dropping segments
- [x] F8 Truncate Prime Agent widget to terminal width
- [x] F10 sanitizeStatusText strips non-SGR escapes
- [x] F11 truncatePath O(n^2)
- [x] F12 Simplify checkContextEntries indirection / duplicate agent title calc
- [x] F13 Unused tracker in session_shutdown
- [x] F14 Document compat casts
- [x] F15 Tests for the above

## Batch C: context calculation
- [x] C1 Routed model contextWindow 0 -> `?/?`
- [x] C2 Model switch shows `?/window` until next request
- [x] C3 JSON.stringify anchor comparison -> field compare
- [x] C4 indexOf assumption in projection -> track index
- [x] C5 (skipped: invalid, Pi drops sections too) Forced-prompt override drops `sections`
- [x] C6 formatTokens rounding boundaries
- [x] C7 Color thresholds vs compaction reserve
- [x] C8 Throughput label/semantics
- [x] C9 Tests

## Batch R: footer refactor
- [x] F9 Split index.ts (context tracking / rendering)

## Batch P: permissions
- [x] Removed at user request: custom permissions extension, pi.json policy, schema, tests, README section. Footer keeps priority slot for the third-party `@gotgenes/pi-permission-system` status (separately installed npm package).

## Batch O: other extensions
- [x] O1 compaction-transcript: prune old snapshots; stale ctx after session switch
- [x] O2 yellow-file-headers: theme recolor scope
- [x] O3 bash-timeout: powershell default timeout
- [x] O4 Tests

## Batch H: repo hygiene
- [x] H1 Remove dead scripts/link-powerline-theme.sh + README reference
- [x] H2 Untrack show-me test artifacts; move harness out of skill dir
- [x] H3 Move finished progress logs to docs/history/
- [x] H4 Re-verify README Pi 1.0.2 limitation note against 1.3.0

## Review log

- 2026-10-17: Batches P, O, H implemented (impl-permissions, impl-other-hygiene). npm test 228/228, typecheck clean. Sent to review.
- 2026-10-17: Batch F/C worker timed out after F3; resumed. C5 judged invalid by worker (Pi's own forced-prompt projection also drops `sections`).
- 2026-10-17: Batch O/H review — astra: no blocking issues. opus reviewer hit 429 rate limit; re-run (rev-other-opus2).
- 2026-10-17: Batch P review — astra: 7 findings (escaped-space `#`, `<<$'EOF'`/continued delimiters, dangling symlinks, `link/../x` lexical normalization, backslash-newline in redirect target, quoted `~`, grants not rebuilt on session_tree). Sent back to impl-permissions. opus reviewer hit 429; will re-run after fixes.
- 2026-10-17: Batch F/C worker hit 429 mid-run; retried.
- 2026-10-17: Batch O/H opus review: no blocking; low fixes applied (prune best-effort catch, mtime tie-break by name). Batch O/H DONE.
- 2026-10-17: Batch P round-2 fixes (7 astra findings) implemented; 249/249 tests, typecheck clean. Sent to dual review.
- 2026-10-17: Batch F/C implemented (C5 skipped); new test/tokyo-night-review-fixes.test.mjs. Sent to dual review.
- 2026-10-17: Batch F/C dual review: opus+astra both flagged styleCaret breaking pi-tui hardware-cursor marker adjacency (high). Also: metadata-only anchor compare accepts content-replaced anchors; git backoff bypassed by invalidation; short borders w/o arrow; reserve>=window threshold; unterminated OSC. Sent back.
- 2026-10-17: Batch P round-2 dual review: `\r` as separator, heredoc continuation, `$\<nl>(` substitution (all reproduced in bash), POSIX backslash path split, fd quoted/move redirects, cd detection, grep file kind, cwd realpath cache. Sent back. Note (not changed): root pi.json allows `find *`, `sed *`, `git diff/log *` which can write/exec — policy decision for user.
- 2026-10-17: Batch F/C round-2 fixes done (caret marker adjacency, content-aware anchor, backoff kept on invalidation, structural border lookup, reserve>=window -> error, OSC to EOS). 250/250. Sent to round-3 dual review.
- 2026-10-17: Batch P round-3 fixes done (`\r`, heredoc continuation, continuation-aware substitution detection, POSIX `/` split, fd redirects, broad cd/eval/source detection, grep file kind, cwd realpath cache). 258/258. Sent to round-3 dual review.
- 2026-10-17: Batch F/C round-3: opus no blocking; astra 2 P2 (follow-up git reads skip backoff; shape cache on mutable clones) + nit reserveTokens validation. Sent back.
- 2026-10-17: Batch P round-3: `"${..}"` nested quotes, `$[..]` arithmetic, arithmetic eval of vars, heredoc grant collision, macOS Unicode normalization. Sent back.
- 2026-10-17: Batch P cancelled; custom permissions implementation removed entirely.
- 2026-10-17: Batch F/C round-3 fixes done (follow-up git reads respect backoff, shape cache only for canonical anchors, reserveTokens validation). 261/261. Sent to round-4 dual review.
- 2026-10-17: Batch F/C round-4: opus + astra no blocking. Applied opus nits (non-object model override -> default; branch-change bypass resets failure count). 165/165. Batch F/C DONE.
- 2026-10-17: Batch R (F9 split) started.
- 2026-10-17: Batch R: index.ts 1593 -> 588 lines; new status-line.ts, context-tracker.ts, editor.ts, colors.ts, state.ts. opus + astra: no blocking. Applied nits (privatize unused exports, rename shadowed git tracker, blank line). 165/165, typecheck clean. Batch R DONE.

## Final status
All batches done (P removed by user). Not committed. Interactive `/reload` check pending.
