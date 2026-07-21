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

## Conversational Style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!").
- Technical prose only; be direct.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for external API types; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JavaScript emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g., `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

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
