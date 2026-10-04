# Ventris Pi Setup

Personal [Pi](https://pi.dev) extensions, skills, prompt templates, and themes, bundled as one Pi package.

## Contents

- `extensions/` — TypeScript and JavaScript extensions
- `skills/` — Agent Skills
- `prompts/` — prompt templates
- `themes/` — TUI themes

Included now:

- **Bash Timeout** extension (`extensions/bash-timeout/index.ts`)
- **Compaction Transcript** extension (`extensions/compaction-transcript/index.ts`)
- **Tokyo Night** theme (`themes/tokyo-night.json`)
- **Tokyo Night Status Border** extension (`extensions/tokyo-night-footer/index.ts`)
- **Yellow File Headers** extension (`extensions/yellow-file-headers/index.ts`)
- **Web Access Toggle** extension (`extensions/web-access-toggle/index.ts`)
- **Herdr Subagents** skill and cleanup extension (`skills/herdr-subagents/`, `extensions/herdr-subagents/`)
- **Herdr Pi Subagent State** portable bundle (`integrations/herdr-pi-subagents/`) — patched integration and manual repair skill
- **Permissions** extension (`extensions/permissions/index.ts`) — retained but disabled

## Bash timeout

Agent `bash` calls that omit `timeout` receive a **120-second wall-clock timeout**, enforced by Pi's existing backend. Explicit timeouts remain unchanged, so intentional long builds can request `timeout: 600` (seconds), for example. Invalid explicit values are left for Pi to reject; zero does not mean unlimited.

The extension uses Pi's supported mutable `tool_call` input, not a replacement tool or shell wrapper. It preserves shell settings, output streaming/truncation, cancellation, session environment, and rendering. It adds no tools, schema text, system-prompt instructions, messages, polling, or model calls. Only Pi's normal timeout error enters context when a command expires. The default applies in new sessions and after `/reload`, including subagents that load this package.

Scope: agent `bash` calls only, not user `!`/`!!`, direct RPC shell commands, `pi.exec`, or processes hidden inside other tools. Later extensions can change the input; custom Bash backends must honor `timeout` themselves.

This fixes omitted deadlines for ordinary stalled commands (`fd`, `sleep`, builds). It is **not a universal hard-deadline watchdog**: Pi 0.85.0 kills the original process group, but a daemon that escapes that group and continuously writes inherited output can still hold the backend open; uninterruptible OS I/O and a blocked Node event loop are also outside this fix. See upstream [default-timeout issue #1335](https://github.com/earendil-works/pi/issues/1335), [unmerged PR #5481](https://github.com/earendil-works/pi/pull/5481), and [detached-stdio deadline issue #6787](https://github.com/earendil-works/pi/issues/6787). No installed Pi files are patched, so package updates do not overwrite this extension.

## Compaction transcripts

After every successful compaction, the extension rebuilds the complete active branch from Pi's append-only session data and writes private files under the session's adjacent `transcripts/` directory:

- `<session-title>--<session-key>.md` — a clean Obsidian-friendly reading view containing a linked table of contents, numbered user questions, model thinking in collapsed callouts, and model text responses. Stored text is never trimmed or summarized.
- `<session-title>--<session-key>.<sha256>.active-branch.jsonl` — a content-addressed snapshot containing the complete session header and active-branch entries for lossless machine use.

The readable title and filename come from Pi's session name; unnamed sessions fall back to a short version of the first user message. A short stable session hash prevents collisions between equally named sessions. Renaming a Pi session updates the reader filename on the next export and removes the superseded Markdown file, while older raw snapshots remain available.

The Markdown intentionally excludes tool calls, tool results, shell executions, images, custom extension data, model/settings events, compaction summaries, IDs, timestamps, and raw JSON. Its compact contents section uses Obsidian heading links with short question previews. A hidden HTML comment records the matching sidecar filename without cluttering Obsidian's reading view. Assistant messages from one user turn are collected into one thinking section and one response section, while repeated compactions keep each original question and response only once.

Each export safely writes its immutable sidecar before atomically refreshing the stable Markdown file; older sidecars remain as branch and compaction snapshots. Alternate branches remain in Pi's original session JSONL, while each transcript snapshot follows the active branch at export time.

Use `/transcript` to refresh the files without compacting. Pi's `--no-session` mode is intentionally not exported because it explicitly disables persistence. Tool output truncated before Pi stores it cannot be recovered. Both reader transcripts and raw snapshots may contain private material; review them before sharing.

## Tokyo Night status border

The extension replaces Pi's normal footer with a single status line embedded in the editor's top border. Its left group shows Pi, model, thinking level, effective Codex Fast Mode, working directory, Git branch and change counts, extension statuses, used/total context tokens, and the last successful response's throughput and time to first token when available. Codex Fast Mode appears as `● fast` immediately after the thinking level only while the installed `@ryan_nookpi/pi-extension-codex-fast-mode` setting is enabled and the active OpenAI Codex model supports it; disabled or ineffective Fast Mode has no segment. Git indicators use `*N` for unstaged files, `+N` for staged files, and `?N` for untracked files. The current agent title is right-aligned and shares a stable Tokyo Night accent with the editor border and the horizontal gap between groups. Explicit Pi session names, including subagent names, take precedence. Otherwise, title generation starts immediately from the submitted prompt and runs concurrently with the main response. The active model produces a concise 3–7 word title, which the extension persists as the Pi session name as soon as it is ready. The title has highest responsive priority, so it remains visible in narrow panes while lower-priority status details return as the pane expands. Use `/name` to override it.

Throughput is displayed as `󰓅 42.3 tps` (or `⚡` without Nerd Fonts): final provider-reported output tokens divided by monotonic elapsed time from the first `before_provider_request` hook to the completed assistant message. Custom providers without that hook use `before_provider_headers` (after auth resolution), then `context` on runtimes without either hook. Repeated or late hooks cannot restart the clock. This is **request-average throughput**, including latency, prompt processing, hidden reasoning and provider-internal retry/backoff—not server-side decode speed. Pi's output count already includes reasoning. Tool execution and previous turns are excluded; characters/chunks are never treated as output tokens, and TTFT is not subtracted from the denominator. Even responses under 100 ms are measured.

The following clock, ` 250ms` or ` 1.23s` (`◷` without Nerd Fonts), shows **observed TTFT**: from the same request start to the first non-empty text, thinking or tool-argument delta. Empty deltas, response headers, block-start markers and mutable partial content/usage cannot establish first-token timing. Hidden reasoning, buffered chunks and reasoning summaries mean this is first observable streamed output—not the server's actual first generated token. Responses with no non-empty deltas, including end-only and redacted-only output, leave TTFT unavailable instead of inventing a value. It still works when token usage is missing.

The timing pair updates together on successful completion, without extra streaming redraws. Failed responses retain the last successful pair; a successful response clears whichever measurement is unavailable. Model, session, tree and compaction changes clear both. Timing reflects arrival at the extension: network buffering and earlier awaited extension handlers can delay observations; Pi exposes no common wire-send, per-attempt or server-generation timestamps.

Context is displayed as `72k/272k` for completed current-model usage, `~72k/272k` for forecasts/streaming/restored estimates, and `?/272k` when unknown. The reported value is the latest request's total (including output), not cumulative session usage or a guarantee of the next request's occupancy. Cache buckets are counted once; reasoning is not added twice. Partial input usage does not freeze streaming growth. Compaction invalidates retained pre-compaction usage; model changes reject the previous model's counts. The denominator comes from the active model's configured context window, including custom models; no Codex-specific headroom is subtracted. Colors change to yellow above 70% and red above 90%.

Metrics add no network requests, tokenizer dependencies or polling timers. Rendering reads cached scalars instead of traversing session history. TTFT adds one clock read at the first non-empty delta per response, not per chunk; the headers fallback adds one request-boundary clock read. Streaming counts incremental character lengths; active tools and mutable schemas are re-measured only at request boundaries and setup changes. An O(1) session-leaf check schedules incremental accounting for idle `!` shell results outside rendering; excluded `!!` output is not counted. The cheap `characters / 4` fallback is approximate, not an upper bound: tokenizer differences, images, hidden reasoning, provider serialization and later extension context/payload rewrites can only be reconciled when the provider reports usage. Exact arbitrary-provider tokenization and server-side generation timing are not available through Pi's common API.

The accounting was compared with [Codex's token model](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/tui/src/token_usage.rs) and [OpenCode's context display](https://github.com/anomalyco/opencode/blob/e2894562f8ba943d72172d10b727c24d5f650c16/packages/tui/src/feature-plugins/sidebar/context.tsx). Their provider-specific normalization/headroom formulas are not copied into Pi.

Git status refreshes asynchronously after file and shell activity. Statuses such as the permission system's YOLO warning remain visible after the normal footer is hidden.

Prime Agent 0.7 does not expose Pi's `ctx.mode`, and its normal daemon protocol cannot carry executable custom footer or editor factories. In that runtime the extension automatically renders the status as a serializable one-line widget below the editor instead. Current in-process Pi sessions retain the integrated top-border layout.

With the **tokyo-night** theme in a truecolor terminal, status foregrounds use the matching Tokyo Night palette directly while inheriting the editor's background without a fill. The software caret uses Tokyo Night ultraviolet (`#bb9af7`). Other themes and reduced-color terminals fall back to Pi's semantic theme colors. Thin Powerline-style separator glyphs are used when a Nerd Font is detected, but the `pi-powerline-footer` package is neither used nor required.

The status border owns Pi's custom editor and custom footer slots, so another extension that replaces either one will conflict with it. The files under `integrations/pi-powerline-footer/` are retained only as legacy integration references and are not part of the active setup.

## Yellow file headers

The extension preserves Pi's built-in `edit` and `write` behavior and rendering, changing only each tool name and path to Tokyo Night pale yellow (`#e0af68`).

## Web access toggle

The always-loaded `/web-access` command controls the globally registered `npm:pi-web-access` package without uninstalling it. With no arguments it opens an On/Off selector; `/web-access on`, `/web-access off`, and `/web-access status` are also available. Changing state updates global Pi settings and reloads Pi automatically.

Off mode retains the package entry using `autoload: false`, so Pi continues to track the installation while loading none of its extensions or skills. The toggle remains available because it belongs to this setup package rather than `pi-web-access` itself.

## On-demand Herdr subagents

After `/reload`, ask Pi to delegate independent work, or invoke `/skill:herdr-subagents`. For example: “Spawn two reviewers and a tester in Herdr; collect their findings and close them.”

The extension registers deferred `subagents` and experimental `durable_subagents` tools: no active tool declarations or injected messages by default. Codemode/tool search can discover them; `/subagents enable` declares the ordinary tool directly and `/subagents disable` returns it to deferred exposure. There is no shared history, peer chat, automatic follow-up turn, or background model call. The [operational skill](skills/herdr-subagents/SKILL.md) loads only when needed and stays under 1,800 characters. The [options reference](skills/herdr-subagents/reference.md) stays under 1,100 characters; [lifecycle and troubleshooting](skills/herdr-subagents/troubleshooting.md) load separately, only when needed. Discovery, documentation and CLI output budgets, safety rules and the runnable example have regression tests. Loaded instructions and collected reports still occupy parent context until compaction; closing panes does not remove them.

By default each task runs a fresh one-shot Pi process in a named side pane, with an explicit prompt and optional role, model, thinking level, working directory, timeout, and local provider extensions. Omit `cwd`, `model` and `thinking` when matching the parent: defaults come from the dispatching session/caller directory. A model override does not inherit the parent's thinking level; set it explicitly if needed. Up to 16 panes are supported, with four active Pi processes by default and the rest queued; the main pane keeps its left half while the right half is subdivided into a balanced layout. Creation preserves focus and never creates tabs/worktrees implicitly. Very small terminals can reject splits; failed batches roll back their known new panes. A lost split response is explicitly reported as unresolved ownership rather than falsely claiming rollback; inspect Herdr before retrying that job.

Workers use the parent's normalized Pi config directory and normal Pi resource discovery: configured extensions, skills, prompt templates, AGENTS.md, APPEND_SYSTEM.md, models and saved authentication remain available. A worker-only extension adds the role instructions without suppressing normal appended prompts. There is no subagent-specific tool allowlist; roles are prompt guidance, not permission restrictions. Optional `extensions` paths add to normal discovery. Project resources follow Pi's trust rules for the task's cwd; session-only extension state is not copied. Extensions can add their usual tools and context to each worker. Concurrent writes require disjoint files or caller-provided worktrees. Herdr supplies the shell environment; credentials set only inside the parent process are not copied to disk or forwarded.

Workers default to quiet named terminal panes, without Herdr agent registration/attention. Opt-in `presentation: "agent"` supplies metadata and custom restore to a read-only report viewer, never an unsupervised Pi resume. The foreground Node supervisor keeps Pi detached, and Herdr's installed Pi integration skips JSON mode. Task status comes from the runner's files (`/subagents` or CLI `status`), not Herdr agent state; reports, cancellation and cleanup do not depend on registration.

The runner captures Pi's JSON stream directly, displays text/tool progress in the pane, and saves final reports independently of terminal size. Herdr's `pane read`/`agent read` use available viewport/scrollback and cannot recover text lost from an alternate screen. Collection therefore reads the saved final reports, not the terminal. It returns at most 12 KB per call, with lossless continuation for longer reports; raw tool events and reasoning stay out of the parent context. Routine output keeps stable job IDs/names, report states and explicit completeness, but omits repeated collection instructions, zero report offsets and false status flags. `spawn` returns IDs/names only; use `status` for the artifact root and `job.json` for pane identity and task settings.

Opt-in [persistent workers](skills/herdr-subagents/persistent.md) retain private Pi sessions across explicitly requested attempts. Continue with a new prompt after acknowledging the previous report; steer/follow-up active work through correlated RPC controls. Intentional stop is cancellation, not suspension. Stable parent ownership survives pane/server changes but rejects simultaneous live parents; forks have fresh ownership. Explicit reattachment requires process/PTY evidence. Explicit orphan recovery uses saved boot/process ownership and never replays a task. Per-session model presets, soft finalized-usage budgets, and concurrency settings are optional. No ordinary worker tools or resource discovery are removed.

Recommended setup: enable `+codemode` and `+tool_search` globally with `codemode.mode: "on"`; see [configuration](skills/herdr-subagents/setup.md) and the [workflow](skills/herdr-subagents/orchestration.md). The skill directs parent orchestration through codemode and the native `subagents` tool, with direct-native and CLI fallbacks only when the preferred interface is unavailable. Ordinary workers retain direct tools and choose codemode when useful; this is guidance, not forced routing.

The short tested recipe calls native `prepare` to persist exact tasks privately without launching, retains only its generated request ID in a successful codemode call, then calls `spawn` with that ID. Defaults resolve at first spawn admission, not preparation; ambiguous launch failures reuse the original ID. Recovery details are deferred to troubleshooting, with a compact opt-in progress example in the main guide. Native retries retain first-admission defaults even if the parent model/cwd or a preset changes; changed explicit arguments are rejected with structured diagnostics. `request_status` exposes bounded historical job metadata even after closure. Deferred discovery includes action-specific result types; optional `help` selects 1–3 actions using the same execution schemas and Pi's public declaration renderer. The standalone `pi-codemode` renderer is a runtime dependency because Pi 1.0 does not supply it through extension aliases; host-provided Pi APIs remain peers. The [tested codemode recipe](skills/herdr-subagents/orchestration.md) uses one `next` call: explicitly acknowledge previously consumed receipts, close eligible jobs, wait and return a report batch. Newly returned pages are never acknowledged in that call. The entire response shares one 12 KB budget, including errors, cleanup and optional progress. `acknowledgementRequired` marks newly delivered pages; finish only on `finished:true` (no reports/errors/pending). Final pages need one more cycle. Failed calls can retain earlier acknowledgements/closures, but never consume newly fetched pages; retry old receipts idempotently. [Granular operations](skills/herdr-subagents/manual.md) remain available. Never use consuming `collect` from codemode. Optional `details:true` exposes bounded worker phases and event age, not a stall diagnosis; finalized usage remains metadata, not repeated parent charges.

The agent collects every report and closes the panes before replying. Saved reports remain collectible during a Herdr outage. The cleanup extension also closes fully collected panes when the parent settles normally; unread panes are preserved. Stopping the main run cancels all its workers and closes safely acknowledged panes, without model calls or added context. Reports remain saved; edits are not undone. `/subagents` shows status, `/subagents close` closes collected panes, and `/subagents cancel` confirms cancellation of all owned panes. CLI `status [offset]` paginates historical unread jobs in groups of 16; use its `next` offset for continuation. Reload preserves running jobs; quitting, forking or switching the parent session cancels its remaining workers. Stopping Pi during collection now cancels workers too; killing only a standalone collect CLI does not. Automatic-compaction Stop is covered; retry-delay Stop uses a non-consuming observer of the configured TUI interrupt key. Ordinary provider errors do not cancel workers. Programmatic/RPC abort during signal-less retry backoff is not exposed by Pi; use `/subagents cancel` in that case. Each task has a 30-minute default deadline. Cancellation first requests worker shutdown and waits for acknowledgement before closing the terminal. A batch shares one 10-second acknowledgement deadline and attempts every job, including after another job fails. Atomic startup claims prevent a delayed launch from executing after cancellation. Ownership follows terminal identity across workspace moves and is checked again immediately before closure. Herdr restore/handoff can change terminal IDs: a proven live supervisor becomes `unattached` instead of being falsely declared dead. Unknown ownership is never resolved by blindly trusting a reused pane ID. Synthetic failure reports are not shutdown acknowledgements; a separate `shutdown.json` records verified process cleanup. Unacknowledged workers or process-cleanup failures retain their panes. Use `/subagents cancel`, not forced pane closure, for running workers.

The supervisor samples owned process ancestry and revalidates identities before signaling, including detached tool groups. A worker-only shutdown hook captures ancestry before normal Pi exit; success, failure and cancellation all reap observed descendants. Pipe draining is bounded independently of process exit. This is best-effort cleanup, not a sandbox: parent crashes/force-kills bypass its hooks; forced supervisor termination, fully daemonized descendants escaping between samples, and OS process-identity races can still leave subprocesses; inspect remaining processes explicitly in those cases.

Private artifacts remain under `~/.pi/agent/herdr-subagents/<scope>/<job>/` (or `PI_CODING_AGENT_DIR`): `result.md`, `events.jsonl`, `stderr.log`, and launch/state files. They can contain sensitive prompts/project data; they are not committed or automatically deleted. Delete obsolete scope directories only after their panes have closed. This implementation does not use or require the older `@tintinweb/pi-subagents` integration patch retained below `integrations/`.

Requires macOS/Linux with `/bin/ps`, Node 22.18+ (native TypeScript stripping), and the current Pi CLI/Herdr pane commands. Targets Pi 1.0.0 and Herdr 0.9.3. Child model usage is exposed in job progress and saved events, separately from the parent's token/cost totals.

### Experimental durable backend

The separate [durable prototype](skills/herdr-subagents/durable.md) requires Node 22.19+ and explicit `start` opt-in. A single coordinator owns private pi-durable storage; IPC clients and report viewers never open it. Persisted conversations, submission identities and report receipts survive restart; explicit `resume` restarts pending work. Parent Stop records cancellation even while the coordinator is offline. There are no automatic parent follow-up turns. Built-in read-only tools are the default; coding tools require explicit selection. This prototype does **not** discover ordinary Pi extensions/skills and does not promise exactly-once arbitrary tool side effects. Use ordinary workers when their full resource/permission configuration is required. Pi-durable is a host peer with development validation pinned to 1.0.0; Chord is a runtime dependency.

## Permissions (disabled)

The implementation and policy remain tracked for reference and testing, but the package manifest does not currently load this extension.

The approval gate reads the tracked [`pi.json`](pi.json) and applies OpenCode-style `allow`, `ask`, and `deny` rules to every agent tool call. A scalar applies to all resources for an action; object rules match resources in insertion order, with the last matching rule winning:

```json
{
  "$schema": "./extensions/permissions/pi.schema.json",
  "permission": {
    "*": "ask",
    "read": {
      "*": "allow",
      "*.env": "ask",
      "*.env.example": "allow"
    },
    "edit": "deny",
    "todowrite": "allow",
    "bash": {
      "*": "ask",
      "git status *": "allow",
      "./gradlew *": "allow"
    },
    "skill": {
      "*": "allow"
    },
    "external_directory": {
      "*": "ask",
      "~/projects/**": "allow",
      "~/.agents/**": "allow"
    }
  }
}
```

Patterns use the same simple matching as OpenCode: `*` matches any number of characters, `?` matches one, and all other characters are literal. A trailing ` *` is optional, so `git status *` matches both `git status` and `git status --short`. `~` and `$HOME` expand at the start of granular patterns.

Pi tools map to OpenCode permission names: `write` joins `edit`; `rg` joins `grep`; `find` becomes `glob`; and `ls` becomes `list`. Unknown extension tools use their exact tool name and `*` as the resource. Known path-bearing file and search tools that target paths outside the session working directory also require `external_directory` approval. Paths inside the launch directory never need that extra approval; an allowed external-directory pattern removes only the extra path-boundary prompt and does not override a separate action rule such as `edit: "deny"`.

An `ask` prompt offers deny, allow once, or allow for the current Pi session. Session grants are exact action/resource pairs stored as hashes in session state, and configured denies always override them. Use `/permissions` to inspect status and `/permissions clear` to revoke session grants. Configuration is snapshotted at session start; run `/reload` after editing `pi.json`. A missing or invalid file blocks all agent tool calls. Set `PI_PERMISSION_CONFIG` to use another absolute or working-directory-relative JSON file.

Use `/yolo` to toggle the bypass for the current session; the choice persists across `/reload`. Start Pi with `pi --yolo` to force YOLO from startup—`/yolo` cannot disable it until Pi is restarted without the flag. YOLO bypasses every permission check, including configured denies, prompts, config loading, and known-tool input classification. The footer stays silent during normal permission enforcement and shows a colored `YOLO mode` warning only while the bypass is active; `/permissions` reports full status.

This extension is an approval gate, not a security sandbox. It does not mediate user `!`/`!!` commands, direct RPC bash commands, extension filesystem/process access, native skill/template expansion, or operations hidden inside a custom tool. A `skill` rule gates a registered tool named `skill`, not Pi's native `/skill:name` expansion. Bash checks split unquoted `&&`, `||`, pipes, semicolons, background operators, and newlines so every command in a chain must resolve; dynamic substitutions and grouping require approval. This is conservative classification, not a complete shell parser. Path checks are lexical rather than symlink-safe. A disabled gate provides no protection, and later-loaded extensions can mutate already approved tool input. Use a container or OS sandbox when enforcement against untrusted code is required.

## Local development

The active `pi` executable on `PATH` is the development-runtime source of truth. `npm test` and `npm run typecheck` first run the runtime synchronizer, which skips this project's `node_modules/.bin`, reads the exact `pi-ai`, `pi-coding-agent`, `pi-tui`, and TypeBox versions bundled with the active Pi installation, couples `pi-server` to that Pi release, and synchronizes the exact local development dependencies and lockfile. Without an external Pi executable, validation uses the committed local pins without network access. Published compatibility remains expressed through `"*"` peer ranges. After upgrading Pi, the next local validation updates `package.json` and `package-lock.json`; review and commit those generated changes. Set `PI_RUNTIME_BIN` to an explicit Pi executable when testing a non-default installation.

Install this checkout globally by path:

```bash
pi install "$PWD"
```

Pi references the checkout directly. After changing a resource, run `/reload` in an active Pi session. Theme file edits hot-reload when that theme is active.

Select **tokyo-night** from `/settings` if it is not already active.

To remove the local package:

```bash
pi remove "$PWD"
```

## Install from Git

After publishing the repository, install it using its Git URL:

```bash
pi install git:github.com/OWNER/pi-setup
```

Review extensions and skills before installing packages from any untrusted source.
