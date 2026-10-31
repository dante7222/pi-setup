# Obsidian setup

Snapshot of the `.obsidian` config folder from my main vault: community plugins with their settings, themes, Minimal theme settings, CSS snippets, hotkeys, and core settings. Copying it into a vault reproduces the setup. Not a Pi resource.

## Where it goes

Obsidian stores settings per vault, in a hidden `.obsidian` folder at the vault root:

```
<vault>/
├── .obsidian/    <- obsidian-setup/.obsidian goes here
└── notes...
```

If the target vault overrides the config folder name (Settings → Files and links → Override config folder), copy the contents into that folder instead.

## Install

1. Quit Obsidian. For a new vault, create it in Obsidian first (or make an empty folder), then quit.
2. Copy the folder into the vault root, backing up any existing config:

   macOS / Linux:

   ```bash
   VAULT="$HOME/path/to/vault"
   [ -d "$VAULT/.obsidian" ] && mv "$VAULT/.obsidian" "$VAULT/.obsidian.bak"
   cp -R obsidian-setup/.obsidian "$VAULT/"
   ```

   Windows (PowerShell):

   ```powershell
   $Vault = "$HOME\path\to\vault"
   if (Test-Path "$Vault\.obsidian") { Rename-Item "$Vault\.obsidian" ".obsidian.bak" }
   Copy-Item -Recurse "obsidian-setup\.obsidian" "$Vault\"
   ```

3. Install the fonts listed below.
4. Open the vault in Obsidian and choose **Trust author and enable plugins** when prompted.

`.obsidian` is hidden in file managers: press `Cmd+Shift+.` in Finder, or enable View → Show → Hidden items in Windows Explorer.

## Requirements outside this folder

- **Fonts.** Text font `Lora`, monospace font `Monaspace Neon Frozen`. Obsidian falls back to defaults without them.
  - macOS: `brew install --cask font-lora font-monaspace`
  - Other platforms: [Lora](https://fonts.google.com/specimen/Lora) from Google Fonts, [Monaspace](https://github.com/githubnext/monaspace/releases) from GitHub (includes the Frozen families).
- **Git plugin.** Needs `git` on `PATH` and credentials (SSH key or token) for the vault's remote. It has no saved settings here, so it runs on defaults.
- **Translucency** (`appearance.json`) only has an effect on macOS.

## Contents

Appearance: Minimal theme, accent `#cc30cf`, base font size 18, translucency on, snippet `code-block` enabled (`wide-diagrams` present but disabled).

Community plugins, all enabled. Plugin code (`main.js`) is bundled, so nothing has to be downloaded. Obsidian can update them afterwards.

| Plugin | Version | Saved settings |
|---|---|---|
| Editing Toolbar | 4.1.5 | yes |
| Folder notes | 1.8.26 | yes |
| Git | 2.41.1 | defaults |
| Homepage | 4.5.0 | defaults |
| Hover Editor | 0.11.31 | defaults |
| Latex Suite | 1.13.4 | defaults |
| Linter | 1.33.0 | yes |
| MathLive | 1.4.1 | defaults |
| Minimal Theme Settings | 9.0.0 | yes |
| Omnisearch | 1.31.0 | yes |
| PDF++ | 0.40.31 | yes |
| Tasks | 8.4.0 | defaults |
| Various Complements | 11.4.2 | defaults |

Themes: 80s Neon, AnuPpuccin, Border, Catppuccin, Encore, Minimal, Purple Aurora, Royal Velvet, Shimmering Focus, Things, Tokyo Night, Wyrd.

## Excluded

- `workspace.json`: open tabs, pane layout, and recently opened files. Obsidian regenerates it.
- `icons/`: about 60 MB of icon packs left by an uninstalled icon plugin.
- `.DS_Store`.
- App-level state stored outside the vault (vault list, window size).

## Updating the snapshot

From the repository root on the source machine:

```bash
rsync -a --delete --exclude '.DS_Store' --exclude 'icons/' --exclude 'workspace.json' \
  ~/Obsidian/primary/.obsidian/ obsidian-setup/.obsidian/
```

This repository is public. Before committing, check plugin `data.json` files for API keys, tokens, or absolute paths.
