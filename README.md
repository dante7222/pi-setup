# Ventris Pi Setup

Personal [Pi](https://pi.dev) extensions, skills, prompt templates, and themes, bundled as one Pi package.

## Contents

- `extensions/` — TypeScript and JavaScript extensions
- `skills/` — Agent Skills
- `prompts/` — prompt templates
- `themes/` — TUI themes

Included now:

- **Tokyo Night** theme (`themes/tokyo-night.json`)
- **Tokyo Night Footer** extension (`extensions/tokyo-night-footer/index.ts`)
- **Yellow File Headers** extension (`extensions/yellow-file-headers/index.ts`)
- **rg Only** extension (`extensions/rg-only/index.ts`)
- **Permissions** extension (`extensions/permissions/index.ts`)
- **Supacode Subagents** extension (`extensions/supacode-subagents/index.ts`)

## Tokyo Night footer

The custom footer puts the Pi session name first and renders it in bold Tokyo Night cyan so named main sessions and delegated workers are immediately recognizable. The working directory and Git branch remain on the first line at lower contrast. A second, palette-colored line preserves latest generation throughput, context pressure, model, provider, and thinking-level information without cumulative token, cache, or cost totals. Throughput is measured from the first streamed token to completion and displayed as `󰓅 42.3 t/s` (or `⚡` without Nerd Fonts). Extension statuses appear on an optional third line.

The footer is enabled automatically in interactive sessions and follows semantic theme colors, with the included **tokyo-night** theme providing its intended palette. Use `/name` to set or change the prominent session name; unnamed sessions begin with the working directory instead.

When [`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer) is installed, it owns Pi's footer component. This extension publishes the styled session name under `ventris-session-name` and the latest output-token throughput under `ventris-tps`, allowing powerline to promote both into dedicated custom segments. The tracked `integrations/pi-powerline-footer/settings.json` fragment puts the name first and pins only context usage and TPS to a separately aligned group at the right edge; cache, cumulative token, and cost/subscription segments are omitted. Merge its `powerline` object into the agent settings when setting up a new machine. The global settings in this environment already match it.

The matching palette lives at `integrations/pi-powerline-footer/theme.json`. Powerline 0.7.0 preserves `layout.right` as a group but concatenates it after the left group, so `integrations/pi-powerline-footer/right-aligned-layout.patch` adds true right alignment while retaining responsive overflow. The tracked settings disable the Bash-mode shortcut, and `integrations/pi-powerline-footer/disable-bash-commands.patch` removes `/bash-mode` and `/bash-reset` from slash-command discovery. The setup script applies both patches and links the tracked theme beside the installed module:

```bash
./scripts/link-powerline-theme.sh
```

The npm edits are runtime integration only; this repository remains the source of truth for the settings, patch, and colors. Rerun the script after updating `pi-powerline-footer`, then run `/reload`.

## Yellow file headers

The extension preserves Pi's built-in `edit` and `write` behavior and rendering, changing only each tool name and path to Tokyo Night pale yellow (`#e0af68`).

## rg only

The extension exposes Pi's ripgrep-backed content-search tool as `rg` instead of `grep`, adds an explicit search policy to the agent prompt, and blocks assistant bash commands that invoke `grep`, `git grep`, or common wrapped forms. Commands that merely search for the word `grep` with `rg` remain allowed.

## Permissions

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

The extension lets the main Pi delegate work to independent Pi sessions running in a visible Supacode batch tab. Parallel workers are tiled as split surfaces in that one tab, while results return to the main agent automatically through job files under `~/.pi/agent/subagents/`.

Available tools and commands:

- `delegate` — run one independent worker in a batch tab.
- `delegate_parallel` — run up to eight workers concurrently as tiled panes in one batch tab.
- `delegate_apply` — queue the confirmed apply flow for a returned coding worker after the user explicitly requests it.
- `/delegate-apply [worker-id]` — preview and apply a coding worker directly; omitting the ID opens a recent-worker selector.

Batch tabs use the parent Pi session name (or project directory) plus a short batch ID, for example `agents: auth-review [a7f3]`. Each pane runs a separately named Pi session. Two workers are placed side-by-side; additional workers split existing panes vertically to produce a compact tiled layout.

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

Workers inherit the parent model and thinking level unless overridden, and they also inherit the parent's YOLO mode. They do not inherit the parent conversation, so delegated tasks must be self-contained. The batch tab stays open by default for inspection; `keepOpen: false` closes the whole tab after every result is captured. Manually closing an active batch tab promptly aborts the parent Pi turn, while leaving the parent Supacode tab and Pi session open. Tab-list disappearance is corroborated against unsettled worker processes, so transient Supacode list omissions cannot discard completed results or abort a live worker. A worker timeout closes its pane and returns a failed result without misclassifying that cleanup as a manual tab close. Coding workers still use separate preserved worktrees—their panes simply start in their assigned worktree—so visual grouping does not sacrifice Git isolation. Each worker defaults to a 15-minute timeout.

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
