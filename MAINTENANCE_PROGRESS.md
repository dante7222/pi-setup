# Maintenance progress

## Scope

Complete the approved feature removal from the working tree, including runtime integrations, tests, documentation, manifest registration, and exclusive direct dependencies. Preserve unrelated functionality, private runtime data, and Git history. The user subsequently approved committing and pushing the reviewed changes.

## Progress

- [x] Stop superseded implementation workers and consume cancellation reports.
- [x] Remove obsolete implementation, dedicated tests, and planning documents.
- [x] Remove manifest entry and exclusive direct dependency; regenerate lockfile offline.
- [x] Clean README, skill guides, and historical maintenance notes.
- [x] Simplify footer integration while preserving titles and context metrics.
- [x] Simplify subagent launch policy while preserving isolation, replay, and process cleanup.
- [x] Run complete tests, typecheck, JSON/manifest checks, and reference scan.
- [x] Independent fresh review A; no blocking findings.
- [x] Independent fresh review B; no blocking findings.
- [x] Exercise canonical resources and reload in an isolated Pi terminal.
- [x] Consume all reports, close workers, and review final diff/status.

## Validation log

- Superseded workers are cancelled and closed; no continuing modernization jobs.
- Package lock regenerated using `npm install --package-lock-only --ignore-scripts --offline`; changes limited to the removed direct dependency and its development-only transitive classification.

- Footer worker: 51 tests pass; preserved title generation and generic loadout/context lifecycle coverage.
- Subagent worker: all 357 focused tests pass; no residual launch-policy fields or imports. OS process cleanup remains intact.
- Parent: all 442 repository tests pass with no failures/skips; TypeScript and diff checks pass.
- Isolated installed-Pi PTY smokes pass in fullscreen and regular modes: canonical package loads, session naming works, `/reload` completes, a post-reload command responds, and `/quit` exits cleanly. Herdr tools remain registered. No provider calls or private data changes.
- Fresh review A approved the removal with no blockers; reference scan, typecheck, JSON/manifest and diff checks passed independently. Its two full-suite runs each passed 441/442 with different unrelated timing assertions (scheduler overlap and codemode wall-time wrapper comparison); affected isolated reruns passed. Parent's full run passed all 442. These unrelated assertions were not weakened or changed.
- Fresh review B independently approved with no removal-related defects. Typecheck, JSON/resource and diff checks passed; full runs also encountered pre-existing timing-sensitive assertions, with all affected files passing a serial rerun (59/59). Existing codemode wall-time comparisons and short worker-checkpoint polling deadlines are outside this removal.
- Both review reports consumed and acknowledged; all workers closed. Final source/reference scans and diff/status checks completed before commit preparation.

## Boundaries

Private runtime storage is intentionally untouched. No installed/upstream package code or Git history is rewritten.
