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
- **Permissions** extension (`extensions/permissions/index.ts`) — retained but disabled
- **Supacode Subagents** extension (`extensions/supacode-subagents/index.ts`)

## Compaction transcripts

After every successful compaction, the extension rebuilds the complete active branch from Pi's append-only session data and writes private files under the session's adjacent `transcripts/` directory:

- `<session-title>--<session-key>.md` — a clean Obsidian-friendly reading view containing a linked table of contents, numbered user questions, model thinking in collapsed callouts, and model text responses. Stored text is never trimmed or summarized.
- `<session-title>--<session-key>.<sha256>.active-branch.jsonl` — a content-addressed snapshot containing the complete session header and active-branch entries for lossless machine use.

The readable title and filename come from Pi's session name; unnamed sessions fall back to a short version of the first user message. A short stable session hash prevents collisions between equally named sessions. Renaming a Pi session updates the reader filename on the next export and removes the superseded Markdown file, while older raw snapshots remain available.

The Markdown intentionally excludes tool calls, tool results, shell executions, images, custom extension data, model/settings events, compaction summaries, IDs, timestamps, and raw JSON. Its compact contents section uses Obsidian heading links with short question previews. A hidden HTML comment records the matching sidecar filename without cluttering Obsidian's reading view. Assistant messages from one user turn are collected into one thinking section and one response section, while repeated compactions keep each original question and response only once.

Each export safely writes its immutable sidecar before atomically refreshing the stable Markdown file; older sidecars remain as branch and compaction snapshots. Alternate branches remain in Pi's original session JSONL, while each transcript snapshot follows the active branch at export time.

Use `/transcript` to refresh the files without compacting. Pi's `--no-session` mode is intentionally not exported because it explicitly disables persistence. Tool output truncated before Pi stores it cannot be recovered. Both reader transcripts and raw snapshots may contain private material; review them before sharing.

## Tokyo Night status border

The extension replaces Pi's normal footer with a single status line embedded in the editor's top border. Its left group shows Pi, model, thinking level, working directory, Git branch and change counts, extension statuses, used/total context tokens, and latest generation throughput when those values are available. Git indicators use `*N` for unstaged files, `+N` for staged files, and `?N` for untracked files. The session name is right-aligned and shares a stable Tokyo Night accent with the editor border and the horizontal gap between groups. Use `/name` to set or change it.

Throughput is calculated from turn start through the completed assistant message and displayed as `󰓅 42.3 tok/s` (or `⚡` without Nerd Fonts). The latest successful value remains visible until another response completes. Context is displayed as `72k/272k`, updates from live assistant usage, and changes from green to yellow above 70% and red above 90%. Git status refreshes asynchronously after file and shell activity, while context follows the active session branch. Statuses such as the permission system's YOLO warning remain visible after the normal footer is hidden.

With the **tokyo-night** theme in a truecolor terminal, status foregrounds use the matching Tokyo Night palette directly while inheriting the editor's background without a fill. The software caret uses Tokyo Night ultraviolet (`#bb9af7`). Other themes and reduced-color terminals fall back to Pi's semantic theme colors. Thin Powerline-style separator glyphs are used when a Nerd Font is detected, but the `pi-powerline-footer` package is neither used nor required.

The status border owns Pi's custom editor and custom footer slots, so another extension that replaces either one will conflict with it. The files under `integrations/pi-powerline-footer/` are retained only as legacy integration references and are not part of the active setup.

## Yellow file headers

The extension preserves Pi's built-in `edit` and `write` behavior and rendering, changing only each tool name and path to Tokyo Night pale yellow (`#e0af68`).

## rg only

The extension exposes Pi's ripgrep-backed content-search tool as `rg` instead of `grep`, adds an explicit search policy to the agent prompt, and blocks assistant bash commands that invoke `grep`, `git grep`, or common wrapped forms. Commands that merely search for the word `grep` with `rg` remain allowed.

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
    "task": "allow",
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

Pi tools map to OpenCode permission names: `write` joins `edit`; `rg` joins `grep`; `find` becomes `glob`; `ls` becomes `list`; `delegate`/`delegate_parallel` become `task` with `research` or `coding` resources; and `delegate_apply` becomes `task` with the `apply` resource. Unknown extension tools use their exact tool name and `*` as the resource. Known path-bearing file and search tools that target paths outside the session working directory also require `external_directory` approval. Paths inside the launch directory never need that extra approval; an allowed external-directory pattern removes only the extra path-boundary prompt and does not override a separate action rule such as `edit: "deny"`.

An `ask` prompt offers deny, allow once, or allow for the current Pi session. Session grants are exact action/resource pairs stored as hashes in session state, and configured denies always override them. Use `/permissions` to inspect status and `/permissions clear` to revoke session grants. Configuration is snapshotted at session start; run `/reload` after editing `pi.json`. A missing or invalid file blocks all agent tool calls. Set `PI_PERMISSION_CONFIG` to use another absolute or working-directory-relative JSON file.

Use `/yolo` to toggle the bypass for the current session; the choice persists across `/reload`. Start Pi with `pi --yolo` to force YOLO from startup—`/yolo` cannot disable it until Pi is restarted without the flag. YOLO bypasses every permission check, including configured denies, prompts, config loading, and known-tool input classification. The footer stays silent during normal permission enforcement and shows a colored `YOLO mode` warning only while the bypass is active; `/permissions` reports full status. Supacode delegated workers inherit the parent policy path, including a working-directory-relative `PI_PERMISSION_CONFIG`, and the parent YOLO state.

This extension is an approval gate, not a security sandbox. It does not mediate user `!`/`!!` commands, direct RPC bash commands, extension filesystem/process access, native skill/template expansion, or operations hidden inside a custom tool. A `skill` rule gates a registered tool named `skill`, not Pi's native `/skill:name` expansion. Bash checks split unquoted `&&`, `||`, pipes, semicolons, background operators, and newlines so every command in a chain must resolve; dynamic substitutions and grouping require approval. This is conservative classification, not a complete shell parser. Path checks are lexical rather than symlink-safe. The separate **rg Only** extension still blocks assistant Bash invocations of `grep` even if the permission policy allows `grep *`. A disabled gate provides no protection, and later-loaded extensions can mutate already approved tool input. Delegated workers are separate Pi processes with independent permission prompts and session grants when YOLO is not active. Use a container or OS sandbox when enforcement against untrusted code is required.

## Supacode subagents

The extension lets the main Pi delegate work to independent Pi sessions in visible Supacode tabs. Research workers stay in the current worktree and tile as split surfaces in one batch tab. Each coding worker runs in a tab inside its own isolated Supacode Git worktree. Results return to the main agent automatically through job files under `~/.pi/agent/subagents/`.

Available tools and commands:

- `delegate` — run one independent worker in a visible Supacode tab.
- `delegate_parallel` — run up to eight workers concurrently; research panes tile in the current worktree, while coding workers open in their isolated worktrees.
- `delegate_apply` — queue the confirmed apply flow for a returned coding worker after the user explicitly requests it.
- `/delegate-apply [worker-id]` — preview and apply a coding worker directly; omitting the ID opens a recent-worker selector.

Worker tabs use the parent Pi session name (or project directory) plus a short batch ID, for example `agents: auth-review [a7f3]`. Each pane runs a separately named Pi session. Two research workers are placed side-by-side; additional research workers split breadth-first across both columns, growing through `1/1`, `2/1`, `2/2`, `3/2`, `3/3`, `4/3`, and `4/4` layouts. Coding workers are not tiled together because each tab belongs to its assigned worktree.

Each task supports two modes:

- `research` (default) — works in the current project with only `read`, `rg`, `find`, and `ls`.
- `coding` — creates a separate Supacode Git worktree and branch, allows coding tools, and asks the worker to test and commit without pushing or merging.

Coding worktree folders combine a readable task slug with the first 12 hexadecimal characters of the worker UUID, for example `tree-sitter-bash-permissions-4e9a04efc879`. Git branches retain the stable `pi-agent/<batch>/<worker>` structure.

Example requests:

```text
Delegate a research task to find the authentication flow.
Use as many parallel workers as needed, up to eight, to review security, correctness, and test coverage.
Delegate this implementation in coding mode, then review the returned commit.
```

Workers inherit the parent model and thinking level unless overridden, and they also inherit the parent's YOLO mode. They do not inherit the parent conversation, so delegated tasks must be self-contained. Worker tabs stay open by default for inspection; `keepOpen: false` closes them after every result is captured. Manually closing an active worker tab promptly aborts the parent Pi turn, while leaving the parent Supacode tab and Pi session open. Tab-list disappearance is corroborated against unsettled worker processes, so transient Supacode list omissions cannot discard completed results or abort a live worker. A worker timeout closes its pane and returns a failed result without misclassifying that cleanup as a manual tab close. Each worker defaults to a 15-minute timeout.

Applying a coding worker constructs an immutable binary Git patch from the delegation base to the worker's final filesystem state. This includes every worker commit plus staged, unstaged, and untracked non-ignored files without modifying the worker's real index during preview or apply. The confirmation preview names both checkout paths and the changed paths. Touched destination changes block the operation, while unrelated destination changes are preserved; destination commit drift uses Git's three-way application. Applied changes remain uncommitted and unstaged. Conflicts retain the pane and worktree for recovery. After a fully successful apply, cleanup closes only that worker's pane, materializes its final non-ignored filesystem state as a recovery commit on the worker branch, removes the now-clean worktree without force, and then removes the Supacode resource. Compare-and-swap refs and a temporary recovery ref prevent cleanup from overwriting concurrent branch changes. Applying the same snapshot twice is refused.

The extension requires the parent Pi session to run inside a Supacode terminal. Runtime output and errors are grouped by batch under `~/.pi/agent/subagents/<batch-id>/<worker-id>/` as `result.md`, `status.json`, and `stderr.log`. Apply artifacts are stored under that job's `handoffs/<handoff-id>/` directory as `changes.patch` and `manifest.json`.

## Local development

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
