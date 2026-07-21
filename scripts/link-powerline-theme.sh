#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname -- "$script_dir")
source_theme="$repo_dir/integrations/pi-powerline-footer/theme.json"
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
powerline_dir="$agent_dir/npm/node_modules/pi-powerline-footer"
target_theme="$powerline_dir/theme.json"

if [ ! -d "$powerline_dir" ]; then
  printf 'pi-powerline-footer is not installed at %s\n' "$powerline_dir" >&2
  printf 'Install it first with: pi install npm:pi-powerline-footer\n' >&2
  exit 1
fi

if [ ! -f "$source_theme" ]; then
  printf 'Tokyo Night powerline theme not found at %s\n' "$source_theme" >&2
  exit 1
fi

if [ -e "$target_theme" ] || [ -L "$target_theme" ]; then
  rm -- "$target_theme"
fi
ln -s -- "$source_theme" "$target_theme"
printf 'Linked %s -> %s\n' "$target_theme" "$source_theme"
