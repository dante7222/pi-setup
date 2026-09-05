# Show-me evaluation

## Run locally

From the skill directory:

```sh
node tests/render.mjs
node tests/mermaid.mjs
node tests/browser.mjs
node tests/review.mjs
open tests/artifacts/show-me-review.html
```

These scripts do not call models or install packages. Render scripts default to the Pi 0.85.0 installation used for this evaluation; set `PI_TEST_PACKAGE` to another installed `@earendil-works/pi-coding-agent` directory. Browser tests use the local Playwright installation and Chrome; override `PLAYWRIGHT_PATH` and `CHROME_PATH` if needed. `CHROME_PATH=bundled` uses Playwright's installed Chromium. Browser tests target the supplied template's structure, not arbitrary HTML.

No test tools or dependencies are required to use the skill normally. `original-skill.txt` preserves the original instructions.

## Executed checks

- **688 actual Pi Markdown renders:** nine documents, 71 fences, 40/60/80/120 columns, light/dark themes. 42 exact-shape/boundary assertions pass. Every final skill fence is also asserted closed, tab-free, and at most 36 display cells (fits a 40-column pane with default padding).
- **144 Mermaid cases:** actual Pi transformer plus Markdown, all four widths, both themes, rendering off/final/streaming, completed/streaming messages, compact flow, original sequence, unsupported pie. 42 render as diagrams; 102 retain source as expected. Thinking bypass checked too.
- **24 Chrome cases:** 320/375/1280px, light/dark, 100%/200% root font size, baseline/adversarial text. Zero detected horizontal overflow, clipping, external requests, script errors, or unsafe injected DOM. Minimum measured text contrast: 7.008:1 light, 10.396:1 dark.
- **Visual inspection:** desktop dark and 320px doubled-text screenshots. First template passed geometry checks but crushed words through nested padding. Reduced mobile padding/indentation and replaced side borders with top borders; rerun passed and screenshot showed intact words.

The render corpus deliberately includes failures: 30 source lines exceed the 36-cell budget at 40 columns; four exceed 56 cells at 60. Those are original examples and model outputs, not final skill examples. Wrapped output staying within the pane is NOT proof of readable topology.

## Model probes and appraisal

16 Herdr jobs covered four initial audits, renderer/browser implementation, final review, and Mini/Spark generation probes. All reports were consumed and panes closed.

Eight multi-case requests: login branches; 40-column request/reply order; hook/component ownership; concurrent upload/save gate; three-attempt retry; long-path move; cache diff; CJK labels. First Spark probe had six cases. Models: `openai-codex/gpt-5.4-mini` and `openai-codex/gpt-5.3-codex-spark`, low thinking.

- Original Mini used a misleading TSX-shaped component sketch and an ambiguous retry trace.
- Revised Mini fixed component ownership, retries, concurrency, and cached/fresh return confusion across iterations. It repeatedly violated long-path width guidance, including a final isolated request.
- Revised Spark learned the alias-based move in round three. It still used malformed tree connectors and invented extra CJK flow nodes in the eight-case batch. The isolated CJK request returned exactly the requested three-node chain.
- Login improved after replacing the generic logic example with an explicit if/else example. Branch examples were more effective than prose rules alone in these samples.
- Spark round two read earlier fixtures despite being told not to; it is **not a blind sample**. Round-three prompts embedded the skill and requested no tools; outputs were copied from collected reports into the corresponding fixture files.
- Final isolated Mini path response and Spark CJK response are preserved in `single-probes.txt`.

This is exploratory qualitative testing, not a statistically powered A/B benchmark. There was one original Mini batch, not repeated matched baseline trials; the skill evolved between rounds. Final example shortening, concurrency generalization, and removal of the node-count target followed the main generation probes. Do not claim all model responses pass or that the skill guarantees perfect diagrams.

## Remaining limits

Standalone Markdown snapshots are not full interactive terminal screenshots; the Mermaid suite explicitly supplies the transformer that standalone Markdown lacks. Galleries strip ANSI, so they demonstrate geometry, not exact terminal syntax colors. Browser font metrics can differ from terminal fonts. Browser text enlargement is not OS/browser zoom or a complete accessibility audit. Safe textContent injection tests the template's wrapping and inert labels, not arbitrary model-generated HTML sanitization. Model facts/topology still require review.
