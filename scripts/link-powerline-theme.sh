#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname -- "$script_dir")
integration_dir="$repo_dir/integrations/pi-powerline-footer"
source_theme="$integration_dir/theme.json"
source_patch="$integration_dir/right-aligned-layout.patch"
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
powerline_dir="$agent_dir/npm/node_modules/pi-powerline-footer"
target_theme="$powerline_dir/theme.json"
installed_index="$powerline_dir/index.ts"

if [ ! -d "$powerline_dir" ]; then
  printf 'pi-powerline-footer is not installed at %s\n' "$powerline_dir" >&2
  printf 'Install it first with: pi install npm:pi-powerline-footer\n' >&2
  exit 1
fi

if [ ! -f "$source_theme" ]; then
  printf 'Tokyo Night powerline theme not found at %s\n' "$source_theme" >&2
  exit 1
fi

if [ ! -f "$source_patch" ]; then
  printf 'Powerline alignment patch not found at %s\n' "$source_patch" >&2
  exit 1
fi

if grep -q 'independently right-aligned primary group' "$installed_index"; then
  printf 'Powerline right-alignment patch already applied.\n'
elif patch --dry-run --silent -d "$powerline_dir" -p1 < "$source_patch"; then
  patch --silent -d "$powerline_dir" -p1 < "$source_patch"
  printf 'Applied powerline right-alignment patch.\n'
else
  printf 'The tracked right-alignment patch does not match the installed pi-powerline-footer.\n' >&2
  printf 'Update integrations/pi-powerline-footer/right-aligned-layout.patch for this package version.\n' >&2
  exit 1
fi

if [ -e "$target_theme" ] || [ -L "$target_theme" ]; then
  rm -- "$target_theme"
fi
ln -s -- "$source_theme" "$target_theme"
printf 'Linked %s -> %s\n' "$target_theme" "$source_theme"
