# Herdr modernization: context audit

## Final remeasurement — after all ergonomics changes

Re-ran the fresh installed Pi 1.0.0 CLI capture against the final canonical resources, with normal global/project configuration, an in-memory session, an explicit name, offline mode and a local faux provider. The paired control excludes only `codemode,tool_search`. Neither measurement session launched workers or made a network model request. This isolates our configuration change on the same Pi version; it is not a measurement of upgrading Pi itself.

**Result: final static startup context is identical to the initial audit after normalizing the timestamp.** All subsequent subagent features added no passive context.

| Final measurement | Characters | Estimated tokens (characters / 4) |
|---|---:|---:|
| Fresh static system/tools, codemode/search excluded | 26,737 | 6,684 |
| Fresh static system/tools, current configuration | 29,703 | 7,426 |
| Codemode/search increment | 2,966 | 742 |
| Ordinary/durable schemas, namespaces, worker instructions, journals and guides at fresh startup | 0 | 0 |
| Existing Herdr skill listing | 275 | 69 (already present; five characters smaller than Git HEAD) |
| First-use skill + required guide + narrow prepare/spawn/next discovery | 8,213 | 2,053 |

The approximately 742-token increment is about **0.37% of a 200k context window**, or 11% of this repository's measured static startup representation. It is a fixed prefix, not another 742-token transcript addition on every turn. Requests can still incur repeated input cost; caching may reduce billing but does not remove occupied context. These are serialized-model-context character estimates, not provider tokenizer/billing measurements.

The **2,053-token first-use figure is additional on-demand material**, not passive overhead and not a measurement of the entire delegation. It excludes task prompts, scripts, tool framing, reasoning and reports. It is about **437 tokens less** than the preceding 2,490-token guide/discovery path. The original CLI-only skill was 1,790 characters (about 448 tokens) with no mandatory native guide: the new initial guidance/discovery is roughly 1,606 estimated tokens more than that minimal reading path, in exchange for the richer protocol. Different orchestration/output paths mean this is not a claim about total old-versus-new task cost.

Ongoing cost is variable. The canonical `next` script is 225 characters (about 56 estimated tokens), plus response/framing; an empty pending payload is 99 characters. Complete response batches share a 12 KB serialized UTF-8 budget, not a fixed token allocation or total-report cap. Pagination preserves all evidence, and the final report still needs a later acknowledgement/cleanup cycle. `prepare` avoids repeating task payloads in results and retries; its initial task arguments still appear in the parent's tool-call transcript. Children have their own base context, tools, prompts and history (normally including inherited codemode settings); their model usage is additional, but their full transcripts do not enter the parent's context.

### Recommendations after the final audit

- **Keep the current passive design.** Both tools remain deferred; preserve `codemode.mode: "on"`, discovery access and the skill's activation guidance. Lowering `inlineBudget` saves nothing in the measured configuration. Disabling codemode/search or forcing `only` changes the workflow rather than providing a free equivalent saving.
- **Use the efficient path already implemented:** narrow discovery once, ID-only retries, receipt storage, one bounded `next` batch, progress only when useful, and no redundant full discovery/status dumps. While genuinely waiting, a 60-second wait can reduce empty polling turns without delaying ready reports. Never discard report pages/errors or merge delivery and acknowledgement.
- **Optional small on-demand savings, not yet implemented:** move the skill's detailed CLI fallback to its existing conditional setup guide (516 characters before replacement links); split focused recovery guidance into a linked document instead of loading all 11,803 troubleshooting characters; factor the duplicated task type in schema-derived narrow declarations (roughly 350 characters). Keep all content/options and test routing/declarations. None saves passive context; net documentation savings depend on the replacement links and the path actually read.
- **Coverage improvement, not a prompt reduction:** retain the current fresh-context regression and add a full-production-extension/CLI regression. The existing focused fixture bypasses the production entry point and excludes skills/resources; this audit's real CLI capture covers them manually. No runtime defect was found.

No prompt/routing change, including rearranged documentation, can guarantee identical model quality on every task. The safest measures avoid loading irrelevant material repeatedly without hiding task evidence, restricting tools, or weakening safety checks. There is no substantial remaining passive saving in this integration that meets a literal zero-behavior-change requirement.

Validation: **16/16** focused codemode/discovery/skill tests passed. Independent reviewers `context-final-passive` and `context-final-ondemand` found no actionable runtime defects and reproduced the relevant measurements; the former noted the regression-coverage gap above. Both reports were consumed, acknowledged and their panes closed. Fresh measurement scopes were removed after confirming their owners exited and no jobs existed. No runtime/configuration changes were made. Captures, measurement script and summary: `/tmp/pi-context-audit-final/`; these local artifacts are not committed. Earlier sections below retain the historical measurements and implementation sequence.

## Scope and method

Read-only audit of fresh-parent context after the modernization and codemode-default follow-up. No settings, tool exposure or workflow implementation changed during the audit.

Captured the first model-facing context from two fresh installed Pi 1.0.0 CLI sessions in this repository, with normal global/project resources and a local faux provider returning `OK`. Both used `--no-session`, an explicit name (no title-generation request), and offline mode. One used current settings; the control used `--exclude-tools codemode,tool_search`. Neither spawned workers. These measure Pi's serialized model-context representation, not a provider-specific wire payload or billed tokenizer count. All token figures below use Pi's rough characters/4 heuristic.

No paid model calls were made by the measurement fixtures. The two independent audit reviewers used ordinary subagents. Their reports were consumed and acknowledged; both panes were closed. Measurement session scopes were removed after their owners exited.

## Passive cost: before delegation/discovery

| Component | Measured characters | Estimated tokens | Increase today |
|---|---:|---:|---:|
| Existing Herdr skill listing (name/description/location) | 275 | 69 | -5 characters versus Git HEAD |
| Ordinary native subagent schema/namespace | 0 | 0 | 0 |
| Durable subagent schema/namespace | 0 | 0 | 0 |
| Skill body, operation guides, worker prompts/reports | 0 | 0 | 0 |
| Enabling codemode and tool search | +2,966 | +742 | About +740–750 estimated tokens |

The captured static system/tool representation was 26,737 characters without codemode/search and 29,703 with them: approximately 6,684 versus 7,426 tokens. That is about 11% more static startup context in this particular repository/configuration, or 0.37% of a 200k context window. These are estimates, not exact provider usage; other projects, active tools, providers and configuration change totals.

The codemode/search increment consists of 2,110 characters of new tool definitions, 587 characters of script-call hints added to existing tool descriptions, and the remaining prompt snippets/guidelines/serialization. Installed codemode filters deferred tools *before* forming namespaces: not even Herdr namespace headers or instructions are included at fresh startup. Tool-search's initial description also contains no per-tool catalog.

`codemode.inlineBudget` is a ceiling, not reserved context. In the observed `on` configuration, available tools are direct or deferred, so no inline catalog is added. Lowering its default 3000 budget to zero would not remove the current overhead; the codemode description remains 1,045 characters.

Lifecycle hooks do not send model messages or start follow-up turns. Runtime dependencies, storage archives, process journals, usage tracking, concurrency settings and CLI implementation size are not prompt text. Worker-only instructions do not enter the fresh parent's context.

A resumed branch or explicit `/subagents enable`/tool search can restore active schemas even before any worker is spawned. The zero-schema finding refers to a genuinely fresh, undiscovered parent session.

## On-demand context at the original audit

| Document | Characters | Estimated tokens when read |
|---|---:|---:|
| `SKILL.md` | 1,794 | 449 |
| `orchestration.md` (required on first native use) | 5,861 | 1,466 |
| `persistent.md` (conditional) | 3,823 | 956 |
| `durable.md` (conditional) | 5,141 | 1,286 |
| `reference.md` (conditional) | 986 | 247 |
| `troubleshooting.md` (conditional) | 5,922 | 1,481 |

At that measurement, first ordinary native use loaded roughly 1,915 estimated tokens of skill/guide text, plus any emitted discovery result. The previous skill was 1,790 characters; most of this new on-demand documentation cost is the native guide, not skill growth. No additional guide is loaded merely because it exists on disk.

Child conversations consume their own context and model usage, not the parent's context window. Parent context receives requested/emitted reports and metadata, not whole child transcripts. Persistent workers retain their own history. Usage metadata is not repeatedly charged as parent tool usage, although printing it repeatedly still consumes ordinary input tokens.

Stable startup overhead is not appended as another 742-token message every turn. It remains part of the prefix supplied to requests. Prompt caching may lower repeated input cost/latency; cached tokens still occupy model context.

## Recommendations without removing capabilities

1. Keep ordinary and durable tools deferred; use codemode discovery for known non-MCP subagent operations rather than activating permanent direct schemas. Keep the required MCP discovery path intact.
2. Keep `codemode.mode: "on"`. Do not force `only`, disable discovery, shorten safety rules, or omit report evidence solely to save this modest passive header.
3. Move global configuration and CLI instructions out of the mandatory native guide into conditional documentation. Those two sections total 1,131 characters (about 283 estimated tokens before replacement links); moving them could save roughly 250–280 tokens on ordinary native first use. Advanced persistent/recovery controls could also be loaded only when used. All information should remain available.
4. Avoid printing unchanged status/usage repeatedly. Keep compact readiness/IDs in scripts, but emit every required report page/error before acknowledgement; never substitute discarded or silently truncated reports.
5. Add a regression test/budget for the model-facing fresh prompt so future features cannot accidentally promote deferred schemas or inject documentation.

No prompt/routing change can honestly be guaranteed to preserve model quality identically in every task. Deferred loading and conditional setup documentation preserve capabilities and avoid deleting task evidence; behavior should still be validated. The substantive passive-context safeguards are already implemented. Further savings mainly concern on-demand documentation and active orchestration, not fresh startup.

## Independent reviews

- `context-passive-review`: confirmed fresh-parent scope, no lifecycle message injection, deferred schema/namespace exclusion, and worker/parent context separation. Identified duplicated protocol/routing text and unnecessary mandatory setup/CLI material.
- `context-codemode-review`: confirmed inline-budget behavior, per-tool hints, persistent activation after tool search, adapter-specific activation behavior and cache caveats. Warned that capability-preserving `only` mode still changes model behavior and does not guarantee unchanged quality.

Both reviews found no critical passive-context defect. Detailed local measurement summary: `/tmp/pi-context-audit/summary.json` (not committed).

## First implemented ergonomics follow-up

At this stage, setup/global configuration and CLI fallback moved to conditional `setup.md` (1,635 characters); advanced controls remain conditional in `persistent.md`. The required native guide now includes an executable four-step codemode recipe but is **5,080 characters**, down from 5,861. With the unchanged 1,794-character skill, first-use guidance totals **6,874 characters**, about **1,719 estimated tokens**: roughly **195 fewer tokens (10%)** than the audited guide pair. No report evidence or safety boundary was removed.

`read_many` bounds all pages/errors together to 12 KB; receipts stay in codemode store rather than being copied into later script arguments. Optional `wait details:true` adds bounded metadata only when requested. These features add **no passive startup context**: both schemas remain deferred, the skill listing and global codemode settings are unchanged. A new real-Pi regression captures the fresh model context and checks that neither subagent schema/namespace nor the on-demand recipe appears. The original approximately 742-token codemode/search overhead remains; this follow-up does not eliminate it.

## Typed discovery and native `next` follow-up

The canonical guide is now **4,211 characters** and the skill remains **1,794**, totaling **6,005 characters / about 1,501 estimated tokens** before discovery. This saves another 869 characters (about 217 estimated tokens) versus the first ergonomics guide pair. The repeating delivery script is only **six lines / 215 characters**; the manual wait/read/ack/close workflow remains conditional in `manual.md` (3,305 characters).

Typed discovery now provides concrete results for every action instead of `data: unknown`. Its actual Pi/QuickJS output is **4,362 characters including the result wrapper**, about 1,091 estimated tokens. This richer one-time discovery costs more on demand; it is not a claim that total first-use context decreased. Shorter repeated scripts and one native call per delivery cycle reduce ongoing orchestration boilerplate. All receipt/safety rules and full paginated reports remain intact.

**No additional passive startup context:** deferred exposure, skill listing and global settings remain unchanged; fresh model-context regression still excludes both subagent schemas/namespaces. `next` budgets reports, per-job errors, cleanup and optional progress together, not as separately appended batches.

## Request diagnostics and narrow discovery follow-up

The safer preparation/retry recipe and explicit completion flags bring the canonical guide to **5,998 characters**; the skill remains **1,794**. Narrow `help` for `spawn` + `next` emits **2,168 characters**, versus **5,733** for the complete interface (actual Pi/QuickJS output including wrappers): about **62% less discovery text**. Both are generated from runtime schemas; full discovery and advanced operations remain available.

The usual skill + guide + narrow discovery totals **9,960 characters / about 2,490 estimated tokens**, versus the prior 10,367 characters / about 2,592 tokens using its full discovery. This is roughly **102 fewer estimated first-use tokens**, despite preserving more retry and cleanup guidance. Full discovery is an optional cost; using both forms adds both outputs. These are characters/4 estimates, not provider tokenizer measurements.

New diagnostic metadata appears only on requested inspection or relevant errors; next adds two booleans within its existing shared 12 KB budget. The preparation ID/tasks live in codemode storage rather than repeated handwritten spawn arguments. Native schemas/namespaces remain deferred, the skill listing and global settings are unchanged, and fresh-context regression still passes: **zero additional passive startup context from this follow-up**. The earlier codemode/search startup overhead is unchanged.

## Happy-path guide and native preparation follow-up

The mandatory guide is now **3,768 characters**, down from 5,998 (37% shorter), with deeper reference/recovery detail preserved in conditional troubleshooting. The skill is **1,791 characters**. Essential safety rules, four executable snippets and the later-call acknowledgement boundary remain; optional progress is an inline `details:true` variation rather than a larger default response.

Actual Pi/QuickJS discovery, including wrappers, is **2,654 characters** for `prepare` + `spawn` + `next`, versus **5,848** for the full interface. Adding the third action increases narrow discovery by 486 characters, but shorter guidance more than offsets that. The normal skill + guide + narrow discovery totals **8,213 characters / about 2,053 estimated tokens**, down from 9,960 / about 2,490: **roughly 437 fewer estimated first-use tokens (18%)**. These estimates exclude tool-call arguments and provider framing and are not billed tokenizer measurements.

Native `prepare` keeps the exact task payload in a private host-side request journal; codemode storage and preparation output contain only the generated request ID. It does not launch workers or dump task content into the response. First launch still resolves execution defaults, and ambiguous launch retries must reuse the prepared ID. Report pagination and evidence are unchanged; there is no helper that silently consumes reports.

**Zero additional passive startup context from this follow-up:** the skill listing and global settings are unchanged, native schemas remain deferred, and the real fresh-context regression passes. The previously measured approximately 742-token codemode/search startup increment remains unchanged. Exact guide snippets, optional progress and discovery budgets passed again in `/tmp/herdr-preparation-wrapup.log`.
