# Ventris Pi Setup

Personal [Pi](https://pi.dev) extensions, skills, prompt templates, and themes, bundled as one Pi package.

Validated against installed Pi **1.3.0**. [docs/history/PI_1X_UPGRADE_PROGRESS.md](docs/history/PI_1X_UPGRADE_PROGRESS.md) records the earlier 1.0.x upgrade; [docs/history/SUBAGENTS-REVAMP.md](docs/history/SUBAGENTS-REVAMP.md) records the 1.3.0 move and the subagents rewrite.

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
- **Subagents** extension (`extensions/subagents/index.ts`)

## Bash timeout

Agent `bash` and built-in `powershell` calls (same input schema) that omit `timeout` receive a **120-second wall-clock timeout**, enforced by Pi's existing backend. Explicit timeouts remain unchanged, so intentional long builds can request `timeout: 600` (seconds), for example. Invalid explicit values are left for Pi to reject; zero does not mean unlimited.

The extension uses Pi's supported mutable `tool_call` input, not a replacement tool or shell wrapper. It preserves shell settings, output streaming/truncation, cancellation, session environment, and rendering. It adds no tools, schema text, system-prompt instructions, messages, polling, or model calls. Only Pi's normal timeout error enters context when a command expires. The default applies in new sessions and after `/reload`, including subagents that load this package.

Scope: agent `bash`/`powershell` calls only, not user `!`/`!!`, direct RPC shell commands, `pi.exec`, or processes hidden inside other tools. Later extensions can change the input; custom Bash backends must honor `timeout` themselves.

This fixes omitted deadlines for ordinary stalled commands (`fd`, `sleep`, builds). It is **not a universal hard-deadline watchdog**. The original Pi 0.85 audit found that a daemon escaping the original process group and continuously writing inherited output could hold the backend open. This extension does not add descendant containment or independent pipe-draining deadlines; uninterruptible OS I/O and a blocked Node event loop are also outside its scope. See upstream [default-timeout issue #1335](https://github.com/earendil-works/pi/issues/1335), [PR #5481](https://github.com/earendil-works/pi/pull/5481), and [detached-stdio deadline issue #6787](https://github.com/earendil-works/pi/issues/6787). No installed Pi files are patched, so package updates do not overwrite this extension.

## Compaction transcripts

After successful compactions reported through Pi's `session_compact` event, the extension rebuilds the complete active branch from append-only session data and writes private files under the session's adjacent `transcripts/` directory:

- `<session-title>--<session-key>.md` — a clean Obsidian-friendly reading view containing a linked table of contents, numbered user questions, model thinking in collapsed callouts, and model text responses. Stored text is never trimmed or summarized.
- `<session-title>--<session-key>.<sha256>.active-branch.jsonl` — a content-addressed snapshot containing the complete session header and active-branch entries for lossless machine use.

The readable title and filename come from Pi's session name; unnamed sessions fall back to a short version of the first user message. A short stable session hash prevents collisions between equally named sessions. Renaming a Pi session updates the reader filename on the next export and removes the superseded Markdown file. The newest three raw snapshots per session are kept (including the one the Markdown references); older ones are pruned. Slugs are budgeted in UTF-8 bytes against the complete 255-byte sidecar filename; short same-directory temporary names keep long CJK and other Unicode titles exportable.

The Markdown intentionally excludes tool calls, tool results, shell executions, images, custom extension data, model/settings events, compaction summaries, IDs, timestamps, and raw JSON. Its compact contents section uses Obsidian heading links with short question previews. A hidden HTML comment records the matching sidecar filename without cluttering Obsidian's reading view. Assistant messages from one user turn are collected into one thinking section and one response section, while repeated compactions keep each original question and response only once. Aborted, errored, and output-limited attempts carry individual incomplete-response warnings, so a later successful retry is distinguishable. Reading-only Markdown boundaries close unfinished fences/comments/preformatted blocks and separate attempts; they do not change raw snapshots or act as a general HTML sanitizer.

Each export safely writes its immutable sidecar before atomically refreshing the stable Markdown file; the two previous sidecars remain as branch and compaction snapshots. Session data is captured when the export is requested, so an export queued across a session switch or reload still writes the correct snapshot and never throws on a stale context. Alternate branches remain in Pi's original session JSONL, while each transcript snapshot follows the active branch at export time.

Use `/transcript` to refresh the files without compacting. Pi 1.0.2 boundary-appended compactions emit `entry_appended`, not `session_compact`, so they require this manual export; automatic export does not cover that event path. Pi's `--no-session` mode is intentionally not exported because it explicitly disables persistence. Tool output truncated before Pi stores it cannot be recovered. Both reader transcripts and raw snapshots may contain private material; review them before sharing.

## Tokyo Night theme

Thinking text, syntax comments, diff context, and link URLs use a brighter secondary blue-violet while decorative borders retain the subdued Tokyo Night palette. Explicit scrollbar colors improve fullscreen navigation. Regression checks cover Pi's theme schema, truecolor/256-color rendering, reading-text contrast, and thumb/track contrast.

## Tokyo Night status border

The extension replaces Pi's normal footer with a single status line embedded in the editor's top border. Its left group shows Pi, model, thinking level, requested Codex Fast Mode, working directory, Git branch and change counts, extension statuses, used/total context tokens, and the last successful response's throughput and time to first token when available. Virtual models show the selected router followed by its latest physical response model and thinking level. Editor and autocomplete mouse coordinates account for the added side borders and removed bottom border, including narrow panes and Unicode input.

Codex Fast Mode appears as `● fast requested` only while the installed `@ryan_nookpi/pi-extension-codex-fast-mode` setting is enabled and the response/selected physical OpenAI Codex model supports it. Supported IDs are aligned with the installed integration at validation time; the badge means requested service, not verified provider acceptance. Disabled or unsupported Fast Mode has no segment. Git indicators use `*N` for unstaged files, `+N` for staged files, and `?N` for untracked files.

The current agent title is right-aligned and shares a stable Tokyo Night accent with the editor border and the horizontal gap between groups. Explicit Pi session names, including subagent names, take precedence. Otherwise, title generation starts immediately from the submitted prompt and runs concurrently with the main response. Pi's public model-registry streaming API routes this request through the selected model, including virtual routers, to produce a concise 3–7 word title. The extension persists it as the Pi session name as soon as it is ready. The title has highest responsive priority, so it remains visible in narrow panes while lower-priority status details return as the pane expands. Use `/name` to override it.

Throughput is displayed as `󰓅 42.3 tps` (or `⚡` without Nerd Fonts): final provider-reported output tokens divided by monotonic elapsed time from the first `before_provider_request` hook to the completed assistant message. Custom providers without that hook use `before_provider_headers` (after auth resolution), then `context` on runtimes without either hook. Repeated or late hooks cannot restart the clock. This is **request-average throughput**, including latency, prompt processing, hidden reasoning and provider-internal retry/backoff—not server-side decode speed. Pi's output count already includes reasoning. Tool execution and previous turns are excluded; characters/chunks are never treated as output tokens, and TTFT is not subtracted from the denominator. Even responses under 100 ms are measured.

The following clock, ` 250ms` or ` 1.23s` (`◷` without Nerd Fonts), shows **observed TTFT**: from the same request start to the first non-empty text, thinking or tool-argument delta. Empty deltas, response headers, block-start markers and mutable partial content/usage cannot establish first-token timing. Hidden reasoning, buffered chunks and reasoning summaries mean this is first observable streamed output—not the server's actual first generated token. Responses with no non-empty deltas, including end-only and redacted-only output, leave TTFT unavailable instead of inventing a value. It still works when token usage is missing.

The timing pair updates together on successful completion, without extra streaming redraws. Failed responses retain the last successful pair; a successful response clears whichever measurement is unavailable. Model, session, tree and compaction changes clear both. Timing reflects arrival at the extension: network buffering and earlier awaited extension handlers can delay observations; Pi exposes no common wire-send, per-attempt or server-generation timestamps.

Context is displayed as `72k/272k` for completed current-model usage, `~72k/272k` for forecasts/streaming/restored estimates, and `?/272k` when usage is unknown (`?/?` when limits are also unknown). The reported value is the latest request's total (including output), not cumulative session usage or a guarantee of the next request's occupancy. Cache buckets are counted once; reasoning is not added twice. Partial input usage does not freeze streaming growth. Canonical session projection accounts for context edits, system/tool-declaration changes, and compaction boundaries rather than replaying stale history. These changes invalidate retained usage; model changes reject the previous model's counts. The denominator uses the response's physical model for virtual selections, or the selected model's declared limits before a physical response is known; no Codex-specific headroom is subtracted. Colors change to yellow above 70% and red above 90%.

Metrics add no network requests, tokenizer dependencies or polling timers. Rendering reads cached scalars instead of traversing session history. TTFT adds one clock read at the first non-empty delta per response, not per chunk; the headers fallback adds one request-boundary clock read. Streaming counts incremental character lengths; active tools and mutable schemas are re-measured only at request boundaries and setup changes. An O(1) session-leaf check schedules incremental accounting for idle `!` shell results outside rendering; excluded `!!` output is not counted. The cheap `characters / 4` fallback is approximate, not an upper bound: tokenizer differences, images, hidden reasoning, provider serialization and later extension context/payload rewrites can only be reconciled when the provider reports usage. Pi also filters private hidden declarations after the public `context_with_system` hook, so that final filtering and later handlers are outside the estimator's view. Exact arbitrary-provider tokenization and server-side generation timing are not available through Pi's common API.

The accounting was compared with [Codex's token model](https://github.com/openai/codex/blob/ddf04ad26789d040f9ef6a96736f76602e35a6cc/codex-rs/tui/src/token_usage.rs) and [OpenCode's context display](https://github.com/anomalyco/opencode/blob/e2894562f8ba943d72172d10b727c24d5f650c16/packages/tui/src/feature-plugins/sidebar/context.tsx). Their provider-specific normalization/headroom formulas are not copied into Pi.

Git status refreshes asynchronously after file and shell activity. Concurrent refresh requests coalesce; failed reads retain known counts with a stale marker instead of looking clean, and missing initial data is marked unknown. Session shutdown/reload cancels pending Git reads. Extension statuses remain visible after the normal footer is hidden.

Prime Agent 0.7 does not expose Pi's `ctx.mode`, and its normal daemon protocol cannot carry executable custom footer or editor factories. In that runtime the extension automatically renders the status as a serializable one-line widget below the editor instead. Current in-process Pi sessions retain the integrated top-border layout.

With the **tokyo-night** theme in a truecolor terminal, status foregrounds use the matching Tokyo Night palette directly while inheriting the editor's background without a fill. The software caret uses Tokyo Night ultraviolet (`#bb9af7`). Other themes and reduced-color terminals fall back to Pi's semantic theme colors. Thin Powerline-style separator glyphs are used when a Nerd Font is detected, but the `pi-powerline-footer` package is neither used nor required.

The status border owns Pi's custom editor and custom footer slots, so another extension that replaces either one will conflict with it.

## Yellow file headers

The extension composes Pi's `registerToolRenderer()` resolvers without registering or replacing executable tools. Native `edit` and `write` headers remain yellow through partial, completed, and error results, including headers rebuilt by native renderers. Only the header is recolored: the `toolTitle` token and the header path's `accent`; other accents in the output keep their color. The wrapper inherits from the theme, so theme methods that call `this.fg()` internally are recolored too. It uses the current theme's semantic warning color: Tokyo Night pale yellow (`#e0af68`) under this theme.

## Web access toggle

The always-loaded `/web-access` command controls the globally registered `npm:pi-web-access` package without uninstalling it. With no arguments it opens an On/Off selector; `/web-access on`, `/web-access off`, and `/web-access status` are also available. Changing state updates global Pi settings and reloads Pi automatically.

Off mode retains the package entry using `autoload: false`, so Pi continues to track the installation while loading none of its extensions or skills. The toggle remains available because it belongs to this setup package rather than `pi-web-access` itself.

Custom resource filters, including exclusion-only configurations, show as **filtered** instead of being guessed on. Explicit on/off replaces those filters with default loading or fully disabled loading while preserving version pins and unrelated settings. Status describes global configuration—not resolved glob matches, project overrides, or proof that tools are loaded—and does not install or resolve packages.

## Subagents

Ask Pi to delegate independent work, for example: "Spawn two reviewers on gpt-6-astra:xhigh and a tester; fix what they find."

`extensions/subagents` registers one `subagents` tool (about 450 tokens of declaration and guidelines) and no skill. Actions:

- `run` with `tasks[]`: `name`, `task`, optional `role` (`worker`, `reviewer`, `explorer`, `tester`), `model` (`provider/id`, a unique id, optional `:thinking` suffix), `thinking`, `cwd`. Models are validated against the parent's registry before anything starts. Omitted model and thinking inherit the parent's; an explicit model drops the inherited thinking level.
- `send` with `name`, `message`: steers a running subagent, or continues an idle, failed or stopped one with its full history.
- `wait` with optional `names`, `seconds`, `all`: blocks until the first report arrives, or with `all: true` until every target finished (or the time limit); use only when the next step needs them.
- `stop` with optional `names`; `list`.

Each subagent is a `pi --mode rpc` child process in its own process group, with normal Pi resource discovery (extensions, providers, skills, AGENTS.md, APPEND_SYSTEM.md). The role prompt is added by a worker-only extension. Reviewers and explorers start with `--exclude-tools edit,write`; no subagent can spawn subagents. Worker UI dialogs are cancelled automatically. At most six run at once; further runs queue in order. Each run has a 30-minute deadline.

Reports are pushed to the parent once per batch: the reports of one `run` call are held until all of its subagents finished, then sent together as one message that starts a turn. A `send` that starts a new run is its own batch. Reports taken by `wait` are not delivered again; the rest of their batch arrives on its own. While the parent is busy, reports wait and are delivered when it settles, since Pi drops queued messages on Esc. Each report has a one-line header (name, state, time, tokens), any error (at most 500 characters), and at most 3,000 characters of the final answer, with the full text in `~/.pi/agent/subagents/<parent-session>/<subagent-session>-<run>.md`. `/subagents auto off` records reports without starting a turn.

Esc on the parent stops the subagents that the interrupted run started or messaged; earlier background subagents keep running. Stopped sessions remain, and `send` resumes them. After Esc, reports are recorded without starting a turn until your next prompt. `/reload` keeps subagents running and keeps the `/subagents auto` setting, which lasts for the Pi process. Quitting or switching sessions stops them. Idle subagent processes exit after 10 minutes and are restarted from their session file on the next `send`. `/subagents` lists subagents; `/subagents stop [name|all]` stops them. Above the editor, a Tokyo Night widget lists active subagents one per line: name, short model name and effort (for example `GPT-6 Astra xhigh`, `Opus 5.5 high`), and how full the subagent's context is (bar and percentage, using the footer's green, yellow and red thresholds). Narrow panes drop the model column.

Worker sessions and report files under `~/.pi/agent/subagents/` are not deleted automatically; they can contain prompts and project data.

`test/live/subagents-smoke.mjs` exercises run, follow-up, steering and stopping against the installed Pi. `test/live/run-tasks.mjs` runs a JSON task list with the same manager outside a Pi session.

## Local development

The active `pi` executable on `PATH` is the development-runtime source of truth. `npm test` and `npm run typecheck` first run the runtime synchronizer, which skips this project's `node_modules/.bin`, reads the exact `pi-ai`, `pi-coding-agent`, `pi-tui`, and TypeBox versions bundled with the active Pi installation and synchronizes the exact local development dependencies and lockfile. Without an external Pi executable, validation uses the committed local pins without network access. Published compatibility remains expressed through `"*"` peer ranges. After upgrading Pi, the next local validation updates `package.json` and `package-lock.json`; review and commit those generated changes. Set `PI_RUNTIME_BIN` to an explicit Pi executable when testing a non-default installation.

Install this checkout globally by path:

```bash
pi install "$PWD"
```

Pi references the checkout directly. After changing a resource, including this package's theme, run `/reload` in an active Pi session. Only active user themes at `<agent-dir>/themes/<name>.json` hot-reload; package themes require `/reload`.

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
