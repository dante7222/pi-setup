# AGENTS.md

## Purpose

This repository is the source of truth for Ventris's personal Pi setup. It is a Pi package that collects extensions, skills, prompt templates, and themes for local development and eventual distribution through Git.

## Repository layout

- `extensions/` — Pi TypeScript or JavaScript extensions.
- `skills/` — Agent Skills, normally one directory per skill containing `SKILL.md`.
- `prompts/` — Markdown prompt templates.
- `themes/` — Pi theme JSON files.
- `package.json` — Pi package manifest. Keep resource paths current when the layout changes.

## Working rules

- Treat this repository as the source of truth; do not make the canonical edit in Pi's installed or generated package directories.
- Never commit API keys, credentials, session files, machine-specific secrets, or dependency directories.
- Follow Pi's installed documentation and examples before adding or changing Pi resources.
- Keep resources focused and independently understandable. Document non-obvious behavior near the implementation.
- Preserve compatibility with the Pi version currently installed unless a change explicitly targets a newer version.
- Use Pi terminology: extensions, skills, prompt templates, themes, and packages.

## Resource conventions

- Extensions should export a default Pi extension factory and keep runtime packages in `dependencies`. Pi core packages belong in `peerDependencies` with a `"*"` range.
- Skills must follow the Agent Skills format and include clear activation guidance in `SKILL.md`.
- Prompt templates are Markdown files and should use descriptive, stable filenames.
- Themes must have a unique slash-free `name`, include the Pi theme schema, and define every required color token.

## Validation

Before committing:

1. Parse changed JSON files.
2. Verify new resources are covered by the `pi` manifest.
3. Reload Pi with `/reload` and exercise the changed resource interactively.
4. Review `git diff --check` and `git status`.

The package is installed locally by path, so saved changes become available after `/reload` without copying files elsewhere.
