---
name: show-me
description: Explain the current topic visually with concise terminal-safe diagrams, code-shape sketches, or focused HTML. Use when the user asks to see a flow, structure, change, or visual explanation.
---

Help the user understand the current topic visually. Skip the preamble. Pick the smallest view that makes the key point clear, usually one visual with a short caption. Respect requested formats and no-file/no-browser constraints. Do not turn a simple explanation into a presentation.

## Default: readable in Pi

**Default to a fenced `text` sketch**, not wide tables or elaborate box art. Some Pi versions/settings render Mermaid, but unsupported or too-wide diagrams fall back to source. Use Mermaid when requested or when a supported rendered graph is genuinely clearer; prefer a compact top-level `flowchart TD` with short quoted labels. If rendering cannot be checked, use text for an ordinary explanation; for explicitly requested Mermaid, include a small text equivalent.

- Keep diagram lines within **60 display columns**, including indentation. If the usable pane width is known, use the smaller of 60 and that width minus 4. For a very narrow pane, use short vertical steps. Do not run tools just to discover terminal width.
- Use spaces, never tabs. Prefer short labels and ASCII `->`, `|`, `+--`, `\--`. Avoid emoji, aligned multi-column lanes, and hand-drawn boxes. Unicode labels are fine; their display width may exceed their character count.
- Put fences at the left margin, not inside lists or quotes. Use top-to-bottom flow when horizontal chains would wrap. Move long paths/details to a keyed note outside the diagram; do not truncate meaningful names silently.
- Keep trees shallow and diagrams small. Split larger views by responsibility; keep shared names consistent. Never add nodes to fill out a diagram or omit an essential branch just to fit.
- Preserve the supplied names and behavior exactly. Label proposals, unknowns, and inferred links. Do not invent calls, files, states, UI effects, or timings.

## Choose by the question

**Logic, branching, retries:** use pseudocode. Mutually exclusive outcomes need explicit `if/else` or an early exit, not consecutive message arrows. Show retry limits when known. For concurrency mark parallel starts and the actual completion rule (all, first, fail-fast, or detached); show `wait for both` only when both are required. Do not draw tangled return arrows.

```text
on submit credentials
  server validates
  if invalid
    show error
  else
    create session
    redirect
```

**Order or messages:** use numbered steps or one message per line. Arrows mean sender -> receiver; labels say what travels. Mark replies, async work, or parallel branches when relevant. Do not imply that concurrent work is serial.

```text
1. User -> UI: choose command
2. UI -> Daemon: send prompt
3. Daemon -> UI: stream (reply)
```

**Ownership or calls:** use a shallow tree. State what indentation means (contains, owns, or calls). A call tree is not a timeline or a call stack. Annotate hooks/state as owned behavior, not rendered children. Structural sketches use `text`, not `tsx`.

```text
Page [owns hook: useSave]
\-- Toolbar
    \-- SaveButton
```

**Files and responsibilities:** use a shallow file tree with brief comments. Show real paths if known; label an illustrative or proposed layout. For a move with long paths, draw `A -> B` and give the full source/destination as inline-code notes outside the fence. Long paths must not force a diagram to wrap.

```text
src/
+-- commands/   # parses actions
+-- sessions/   # owns session state
\-- transport/  # sends API requests
```

Proposed move (use this shape for long paths):
```text
A -> B
```
A: `src/features/session-management/Timeline.tsx`
B: `packages/conversation-ui/src/Timeline.tsx`

**What changes:** use a small `diff` when the existing shape matters. Label non-patch diagrams as “Schematic diff”; keep unchanged context needed to show ownership/order. Preserve existing semantics (a cache hit returns the cached result, not the fresh result). If most of it is new, show the complete target shape instead. Copyable code must be valid code in its actual language, not a structural sketch.

Schematic diff — cache before writing:
```diff
 on save
+  if unchanged
+    return cached result
   write content
   return fresh result
```

**UI/layout, rich comparison, or a genuinely dense concept:** create one focused HTML file when a text sketch cannot answer well, or when requested. Read [HTML guidance](references/html.md) first. Don't create an artifact for an ordinary flow just to make it prettier.

## Before sending

Silently check: does this answer the actual question? Are direction, ownership, order, and branches unambiguous? Will every diagram line fit without wrapping? Are labels readable without color? Are fences closed and code/sketch labels honest? If not, simplify or split the view rather than decorating it. Keep each visual next to its supporting sentence; stop when the point is clear.
