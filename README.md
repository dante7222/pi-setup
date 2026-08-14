# Ventris Pi Setup

Personal [Pi](https://pi.dev) extensions, skills, prompt templates, and themes, bundled as one Pi package.

## Contents

- `extensions/` — TypeScript and JavaScript extensions
- `skills/` — Agent Skills
- `prompts/` — prompt templates
- `themes/` — TUI themes

Included now:

- **Compaction Transcript** extension (`extensions/compaction-transcript/index.ts`)
- **Tokyo Night** theme (`themes/tokyo-night.json`)
- **Tokyo Night Status Border** extension (`extensions/tokyo-night-footer/index.ts`)
- **Yellow File Headers** extension (`extensions/yellow-file-headers/index.ts`)
- **rg Only** extension (`extensions/rg-only/index.ts`)
- **Session Groups** extension (`extensions/session-groups/index.ts`)
- **Web Access Toggle** extension (`extensions/web-access-toggle/index.ts`)
- **Permissions** extension (`extensions/permissions/index.ts`) — retained but disabled

## Compaction transcripts

After every successful compaction, the extension rebuilds the complete active branch from Pi's append-only session data and writes private files under the session's adjacent `transcripts/` directory:

- `<session-title>--<session-key>.md` — a clean Obsidian-friendly reading view containing a linked table of contents, numbered user questions, model thinking in collapsed callouts, and model text responses. Stored text is never trimmed or summarized.
- `<session-title>--<session-key>.<sha256>.active-branch.jsonl` — a content-addressed snapshot containing the complete session header and active-branch entries for lossless machine use.

The readable title and filename come from Pi's session name; unnamed sessions fall back to a short version of the first user message. A short stable session hash prevents collisions between equally named sessions. Renaming a Pi session updates the reader filename on the next export and removes the superseded Markdown file, while older raw snapshots remain available.

The Markdown intentionally excludes tool calls, tool results, shell executions, images, custom extension data, model/settings events, compaction summaries, IDs, timestamps, and raw JSON. Its compact contents section uses Obsidian heading links with short question previews. A hidden HTML comment records the matching sidecar filename without cluttering Obsidian's reading view. Assistant messages from one user turn are collected into one thinking section and one response section, while repeated compactions keep each original question and response only once.

Each export safely writes its immutable sidecar before atomically refreshing the stable Markdown file; older sidecars remain as branch and compaction snapshots. Alternate branches remain in Pi's original session JSONL, while each transcript snapshot follows the active branch at export time.

Use `/transcript` to refresh the files without compacting. Pi's `--no-session` mode is intentionally not exported because it explicitly disables persistence. Tool output truncated before Pi stores it cannot be recovered. Both reader transcripts and raw snapshots may contain private material; review them before sharing.

## Session groups

Session groups attach one global shared context file to related Pi sessions. Use `/group` for the interactive menu, or use `/group create <name>`, `/group join <name>`, `/group leave`, `/group edit`, `/group changelog`, `/group show`, `/group list`, `/group rename <name>`, `/group delete [name]`, and `/group active [name|off|status]` directly. Creating a group opens its context in Zed and optionally makes it the global active group. `/group edit` and `/group changelog` use `zed --wait`; there is intentionally no editor fallback.

Group data is private to the local user under `~/.pi/agent/session-groups/`. Each group has stable metadata and a `context.md` file limited to 64 KiB. The full context is injected into each member session's system prompt at the start of a run, remains stable for that run, and refreshes from disk on the next turn. Prompt injection does not automatically copy it into session JSONL files, although explicit tool-call inputs and diff results are ordinary session messages and may contain requested excerpts. The `edit_group_context` agent tool can apply exact revision-checked edits only when the current direct user message explicitly asks to update the shared group context and the user approves an execution-time confirmation showing the proposed change; the extension never summarizes or writes context automatically. The tool is active only in grouped sessions, so ungrouped sessions receive neither shared context nor its tool schema or prompt guidance.

A group may also have an optional `changelog.md`, created lazily by `/group changelog` or an approved append. Changelog content is never passively injected. The minimal grouped-only `group_changelog` tool reads at most the latest 16 KiB on demand or appends an entry of at most 8 KiB after confirmation; the complete file is limited to 256 KiB. Append headings receive a UTC timestamp and current session name automatically. Requested read results and append inputs/results are ordinary tool messages and therefore persist in the requesting session JSONL. Ungrouped sessions expose no changelog tool or content.

A session can belong to at most one group. Existing sessions preserve their stored membership. New sessions use the global active group when one is set; otherwise `/new` inherits from its source session. Forks and clones prefer the source session's group before the active group. Turning the active group off does not detach existing sessions. Deleting a group permanently removes its metadata, context, and optional changelog, clears it as active, and leaves historical session JSONL files untouched.

Storage uses private atomic files, optimistic context revisions, recoverable edit transactions, and cross-process locks so multiple Pi processes and long-running Zed edits cannot write the same group concurrently. This protects consistency, not against another process running as the same OS user deliberately modifying the files. The Tokyo Night status border displays membership as `Session Name [group]` and updates after joins, leaves, renames, and deletion.

## Tokyo Night status border

The extension replaces Pi's normal footer with a single status line embedded in the editor's top border. Its left group shows Pi, model, thinking level, effective Codex Fast Mode, working directory, Git branch and change counts, extension statuses, used/total context tokens, and latest generation throughput when those values are available. Codex Fast Mode appears as `● fast` immediately after the thinking level only while the installed `@ryan_nookpi/pi-extension-codex-fast-mode` setting is enabled and the active OpenAI Codex model supports it; disabled or ineffective Fast Mode has no segment. Git indicators use `*N` for unstaged files, `+N` for staged files, and `?N` for untracked files. The current agent title is right-aligned, appends the current session group in brackets when present, and shares a stable Tokyo Night accent with the editor border and the horizontal gap between groups. Explicit Pi session names, including subagent names, take precedence. Otherwise, title generation starts immediately from the submitted prompt and runs concurrently with the main response. The active model produces a concise 3–7 word title, which the extension persists as the Pi session name as soon as it is ready. The title has highest responsive priority, so it remains visible in narrow panes while lower-priority status details return as the pane expands. Use `/name` to override it.

Throughput is calculated from turn start through the completed assistant message and displayed as `󰓅 42.3 tok/s` (or `⚡` without Nerd Fonts). The latest successful value remains visible until another response completes. Context is displayed as `72k/272k`, updates from live assistant usage, and changes from green to yellow above 70% and red above 90%. Git status refreshes asynchronously after file and shell activity, while context follows the active session branch. Statuses such as the permission system's YOLO warning remain visible after the normal footer is hidden.

Prime Agent 0.7 does not expose Pi's `ctx.mode`, and its normal daemon protocol cannot carry executable custom footer or editor factories. In that runtime the extension automatically renders the status as a serializable one-line widget below the editor instead. Current in-process Pi sessions retain the integrated top-border layout.

With the **tokyo-night** theme in a truecolor terminal, status foregrounds use the matching Tokyo Night palette directly while inheriting the editor's background without a fill. The software caret uses Tokyo Night ultraviolet (`#bb9af7`). Other themes and reduced-color terminals fall back to Pi's semantic theme colors. Thin Powerline-style separator glyphs are used when a Nerd Font is detected, but the `pi-powerline-footer` package is neither used nor required.

The status border owns Pi's custom editor and custom footer slots, so another extension that replaces either one will conflict with it. The files under `integrations/pi-powerline-footer/` are retained only as legacy integration references and are not part of the active setup.

## Yellow file headers

The extension preserves Pi's built-in `edit` and `write` behavior and rendering, changing only each tool name and path to Tokyo Night pale yellow (`#e0af68`).

## rg only

The extension exposes Pi's ripgrep-backed content-search tool as `rg` instead of `grep`, adds an explicit search policy to the agent prompt, and blocks assistant bash commands that invoke `grep`, `git grep`, or common wrapped forms. Commands that merely search for the word `grep` with `rg` remain allowed.

## Web access toggle

The always-loaded `/web-access` command controls the globally registered `npm:pi-web-access` package without uninstalling it. With no arguments it opens an On/Off selector; `/web-access on`, `/web-access off`, and `/web-access status` are also available. Changing state updates global Pi settings and reloads Pi automatically.

Off mode retains the package entry using `autoload: false`, so Pi continues to track the installation while loading none of its extensions or skills. The toggle remains available because it belongs to this setup package rather than `pi-web-access` itself.

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

This extension is an approval gate, not a security sandbox. It does not mediate user `!`/`!!` commands, direct RPC bash commands, extension filesystem/process access, native skill/template expansion, or operations hidden inside a custom tool. A `skill` rule gates a registered tool named `skill`, not Pi's native `/skill:name` expansion. Bash checks split unquoted `&&`, `||`, pipes, semicolons, background operators, and newlines so every command in a chain must resolve; dynamic substitutions and grouping require approval. This is conservative classification, not a complete shell parser. Path checks are lexical rather than symlink-safe. The separate **rg Only** extension still blocks assistant Bash invocations of `grep` even if the permission policy allows `grep *`. A disabled gate provides no protection, and later-loaded extensions can mutate already approved tool input. Use a container or OS sandbox when enforcement against untrusted code is required.

## Local development

The active `pi` executable on `PATH` is the development-runtime source of truth. `npm test` and `npm run typecheck` first run the runtime synchronizer, which skips this project's `node_modules/.bin`, reads the exact `pi-ai`, `pi-coding-agent`, `pi-tui`, and TypeBox versions bundled with the active Pi installation, and synchronizes the exact local development dependencies and lockfile. Without an external Pi executable, validation uses the committed local pins without network access. Published compatibility remains expressed through `"*"` peer ranges. After upgrading Pi, the next local validation updates `package.json` and `package-lock.json`; review and commit those generated changes. Set `PI_RUNTIME_BIN` to an explicit Pi executable when testing a non-default installation.

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
