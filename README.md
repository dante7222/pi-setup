# Ventris Pi Setup

Personal [Pi](https://pi.dev) extensions, skills, prompt templates, and themes, bundled as one Pi package.

## Contents

- `extensions/` — TypeScript and JavaScript extensions
- `skills/` — Agent Skills
- `prompts/` — prompt templates
- `themes/` — TUI themes

Included now:

- **Tokyo Night** theme (`themes/tokyo-night.json`)
- **Supacode Subagents** extension (`extensions/supacode-subagents/index.ts`)

## Supacode subagents

The extension lets the main Pi delegate work to independent Pi sessions running in a visible Supacode batch tab. Parallel workers are tiled as split surfaces in that one tab, while results return to the main agent automatically through job files under `~/.pi/agent/subagents/`.

Available tools:

- `delegate` — run one independent worker in a batch tab.
- `delegate_parallel` — run up to three workers concurrently as tiled panes in one batch tab.

Batch tabs use the parent Pi session name (or project directory) plus a short batch ID, for example `agents: auth-review [a7f3]`. Each pane runs a separately named Pi session. Two workers are placed side-by-side; a third splits the first column to produce a compact tiled layout.

Each task supports two modes:

- `research` (default) — works in the current project with only `read`, `grep`, `find`, and `ls`.
- `coding` — creates a separate Supacode Git worktree and branch, allows coding tools, and asks the worker to test and commit without pushing or merging.

Example requests:

```text
Delegate a research task to find the authentication flow.
Use three parallel workers to review security, correctness, and test coverage.
Delegate this implementation in coding mode, then review the returned commit.
```

Workers inherit the parent model and thinking level unless overridden. They do not inherit the parent conversation, so delegated tasks must be self-contained. The batch tab stays open by default for inspection; `keepOpen: false` closes the whole tab after every result is captured. Coding workers still use separate preserved worktrees—their panes simply start in their assigned worktree—so visual grouping does not sacrifice Git isolation. Each worker defaults to a 15-minute timeout.

The extension requires the parent Pi session to run inside a Supacode terminal. Runtime output and errors are grouped by batch under `~/.pi/agent/subagents/<batch-id>/<worker-id>/` as `result.md`, `status.json`, and `stderr.log`.

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
