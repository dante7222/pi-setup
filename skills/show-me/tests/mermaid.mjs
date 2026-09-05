#!/usr/bin/env node
// Actual Pi Mermaid transformer + Markdown renderer; no model/network calls.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters as strip } from 'node:util';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pi = process.env.PI_TEST_PACKAGE || '/Users/ventris/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent';
const load = p => import(pathToFileURL(join(pi, p)));
const { Markdown, visibleWidth } = await load('node_modules/@earendil-works/pi-tui/dist/index.js');
const { createMermaidMarkdownTransformer } = await load('dist/modes/interactive/components/mermaid.js');
const themeModule = await load('dist/modes/interactive/theme/theme.js');
const original = await readFile(join(root, 'tests/original-skill.txt'), 'utf8');
const fixtures = {
  originalSequence: original.match(/```mermaid\n[\s\S]*?```/)[0],
  compactFlow: '```mermaid\nflowchart TD\n  A["Save"] --> B["Validate"]\n  B --> C["Result"]\n```',
  unsupported: '```mermaid\npie title Pets\n  "Cats" : 3\n  "Dogs" : 2\n```',
};
const results = [];
for (const theme of ['light', 'dark']) {
  themeModule.setThemeInstance(themeModule.loadThemeFromPath(join(pi, `dist/modes/interactive/theme/${theme}.json`), 'truecolor'));
  for (const width of [40, 60, 80, 120]) for (const mode of ['off', 'final', 'streaming']) for (const isStreaming of [false, true]) for (const [id, source] of Object.entries(fixtures)) {
    const transform = createMermaidMarkdownTransformer({ getMode: () => mode, theme: themeModule.theme });
    const transformed = transform(source, { messageType: 'assistant', availableWidth: width - 2, isStreaming });
    const rendered = !transformed.includes('```mermaid');
    const lines = new Markdown(transformed, 1, 0, themeModule.getMarkdownTheme()).render(width).map(strip);
    assert(lines.every(line => visibleWidth(line) <= width));
    const enabled = mode !== 'off' && (!isStreaming || mode === 'streaming');
    if (!enabled || id === 'unsupported') assert.equal(rendered, false);
    if (enabled && id === 'compactFlow') assert.equal(rendered, true);
    if (enabled && id === 'originalSequence' && width === 40) assert.equal(rendered, false);
    if (enabled && id === 'originalSequence' && width >= 80) assert.equal(rendered, true);
    assert.equal(transform(source, { messageType: 'assistant-thinking', availableWidth: width - 2, isStreaming }), source);
    results.push({ id, theme, width, mode, isStreaming, rendered, snapshot: lines.join('\n') });
  }
}
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const artifacts = join(root, 'tests/artifacts');
await mkdir(artifacts, { recursive: true });
await writeFile(join(artifacts, 'mermaid-results.json'), JSON.stringify(results, null, 2));
const views = results.filter(r => r.mode === 'final' && !r.isStreaming && r.theme === 'dark');
await writeFile(join(artifacts, 'mermaid-gallery.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Mermaid rendering</title><style>body{background:#121820;color:#eef2f7;font:16px/1.5 system-ui;margin:0;padding:24px}main{max-width:1100px;margin:auto}article{padding:16px;border:1px solid #63748b;margin:16px 0}h2{font-size:18px}pre{font:14px/1.4 ui-monospace,monospace;overflow:auto}a{color:#a9c0ff}</style><main><h1>Pi Mermaid: real rendered geometry</h1><p>Installed transform + Markdown output. ANSI stripped, not a full terminal screenshot. Narrow or unsupported diagrams fall back to source.</p>${views.map(r=>`<article><h2>${escape(r.id)} · ${r.width} columns · ${r.rendered?'rendered':'source fallback'}</h2><pre>${escape(r.snapshot)}</pre></article>`).join('')}</main></html>`);
console.log(`${results.length} Mermaid cases passed; ${results.filter(r=>r.rendered).length} rendered, ${results.filter(r=>!r.rendered).length} source fallback.`);
