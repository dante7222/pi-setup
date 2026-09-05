#!/usr/bin/env node
// Run: node tests/render.mjs. No package installation or terminal session needed.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters as stripANSI } from 'node:util';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pi = process.env.PI_TEST_PACKAGE || '/Users/ventris/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent';
const tui = join(pi, 'node_modules/@earendil-works/pi-tui');
const themeDir = join(pi, 'dist/modes/interactive/theme');
const { Markdown, visibleWidth } = await import(pathToFileURL(join(tui, 'dist/index.js')));
const { getMarkdownTheme, loadThemeFromPath, setThemeInstance } = await import(pathToFileURL(join(themeDir, 'theme.js')));
const widths = [40, 60, 80, 120];
const themes = ['light', 'dark'];
const artifacts = join(root, 'tests/artifacts');
await mkdir(artifacts, { recursive: true });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const displayWidth = text => visibleWidth(text.replace(/\t/g, '   '));
const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Source scanner deliberately handles left-margin / <=3-space fenced examples,
// not arbitrary CommonMark containers. Full documents still use Pi's parser.
function fences(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const found = [];
  let current, heading = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!current) {
      if (/^#{1,6}\s/.test(line)) heading = line.replace(/^#+\s*/, '');
      const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (match) current = { index: found.length + 1, heading, startLine: i + 1,
        marker: match[2], language: match[3].trim().split(/\s+/)[0].toLowerCase(), lines: [], raw: [line] };
    } else {
      current.raw.push(line);
      const close = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[2][0] === current.marker[0] && close[2].length >= current.marker.length) {
        found.push({ ...current, closed: true }); current = undefined;
      } else current.lines.push({ line: i + 1, text: line, columns: displayWidth(line) });
    }
  }
  if (current) found.push({ ...current, closed: false });
  return found;
}
function diagnostic(fence) {
  const body = fence.lines.map(l => l.text).join('\n');
  const tsx = /^(tsx|jsx)$/.test(fence.language);
  return {
    index: fence.index, heading: fence.heading, startLine: fence.startLine,
    closed: fence.closed, language: fence.language, sourceLines: fence.lines.length,
    maxSourceColumns: Math.max(0, ...fence.lines.map(l => l.columns)),
    mermaidSource: fence.language === 'mermaid', tsxFence: tsx,
    // Heuristic, NOT a TSX validity check: bare hooks or tree notation inside JSX.
    tsxPseudoShape: tsx && (/(?:^|\n)\s*use\w+\([^\n]*\)\s*(?:\n|$)/.test(body) || /(?:\+--|\\--|├|└|\[owns:)/.test(body)),
    tabs: fence.lines.filter(l => l.text.includes('\t')).map(l => l.line),
    byWidth: widths.map(width => ({ width, usableWidth: width - 4,
      exceedingLines: fence.lines.filter(l => l.columns > width - 4) })),
    knownNarrow: /40[- ]column|40[- ]col\b/i.test(fence.heading) ? {
      width: 40, usableWidth: 36, exceedingLines: fence.lines.filter(l => l.columns > 36),
    } : null,
  };
}
const files = ['SKILL.md', 'tests/original-skill.txt', ...(await readdir(join(root, 'tests'))).filter(n => n.endsWith('-candidate.md') || n === 'mini-original.md').sort().map(n => `tests/${n}`)];
const documents = [];
const samples = [];
for (const file of files) {
  const source = await readFile(join(root, file), 'utf8');
  const blocks = fences(source);
  documents.push({ file, sha256: createHash('sha256').update(source).digest('hex'), fences: blocks.map(diagnostic) });
  samples.push({ id: file, kind: 'document', source });
  for (const block of blocks) samples.push({ id: `${file}:fence-${block.index}:line-${block.startLine}`, kind: 'fence', source: block.raw.join('\n') });
}
assert(documents.find(d => d.file === 'SKILL.md').fences.length > 0, 'SKILL examples missing');
assert(files.includes('tests/mini-original.md'), 'original fixture missing');
assert(files.some(f => f.endsWith('-candidate.md')), 'candidate fixtures missing');

const representatives = {
  branch: ['on save', '  if unchanged', '    return cached result', '  else', '    write content'],
  sequence: ['1. User -> UI: choose command', '2. UI -> Daemon: send prompt', '3. Daemon -> UI: stream result'],
  tree: ['Page [owns: useSave]', '+-- Toolbar', '|   \\-- SaveButton', '\\-- Timeline'],
  diff: [' on save', '+  if unchanged', '+    return cached result', '   write content'],
  CJK: ['用户 -> 验证', '  成功 -> 会话', '  失败 -> 错误', '界'.repeat(18)],
};
for (const [name, lines] of Object.entries(representatives)) {
  assert(lines.every(line => displayWidth(line) <= 36), `${name}: fixture exceeds 36 display columns`);
  samples.push({ id: `assertion:${name}`, kind: 'assertion', lines, source: `\`\`\`${name === 'diff' ? 'diff' : 'text'}\n${lines.join('\n')}\n\`\`\`` });
}
// This 37-cell source MUST wrap at 40: proves the harness exercises the boundary.
samples.push({ id: 'boundary:37-columns', kind: 'boundary', source: `\`\`\`text\n${'x'.repeat(37)}\n\`\`\`` });

// Final skill examples are regression-gated, not merely diagnostic.
for (const fence of documents.find(d => d.file === 'SKILL.md').fences) {
  assert(fence.closed, `Unclosed skill fence at ${fence.startLine}`);
  assert(fence.maxSourceColumns <= 36, `Skill example wraps at 40 columns: ${fence.startLine}`);
  assert.equal(fence.tabs.length, 0, 'Tabs in skill example');
}
const renders = [];
let assertionCases = 0;
for (const theme of themes) {
  // Explicit installed JSON paths prevent user-registered themes shadowing built-ins.
  setThemeInstance(loadThemeFromPath(join(themeDir, `${theme}.json`), 'truecolor'));
  for (const width of widths) {
    for (const sample of samples) {
      // 1 cell outer padding on each side + Pi's 2-cell code indent = width - 4.
      const ansi = new Markdown(sample.source, 1, 0, getMarkdownTheme()).render(width);
      const plain = ansi.map(stripANSI);
      const overflow = plain.flatMap((line, i) => visibleWidth(line) > width ? [{ line: i + 1, columns: visibleWidth(line) }] : []);
      if (sample.kind === 'assertion') {
        const expected = [` ${sample.source.split('\n')[0]}`, ...sample.lines.map(line => `   ${line}`), ' ```'];
        assert.deepEqual(plain.map(l => l.trimEnd()), expected, `${theme}/${width}/${sample.id}: source changed or wrapped`);
        assert.equal(overflow.length, 0, `${sample.id}: rendered overflow`);
        assertionCases++;
      }
      if (sample.kind === 'boundary' && width === 40) {
        assert(plain.length > 3, `${theme}: expected 37-cell source to wrap at 40`);
        assertionCases++;
      }
      renders.push({ id: sample.id, kind: sample.kind, theme, width, usableWidth: width - 4,
        renderedLines: plain.length, maxRenderedColumns: Math.max(0, ...plain.map(visibleWidth)),
        overflow, ansiPresent: ansi.some(l => l !== stripANSI(l)), snapshot: plain.join('\n') });
    }
  }
}
const summary = {
  documents: documents.length, fencedExamples: documents.reduce((n, d) => n + d.fences.length, 0),
  renders: renders.length, assertionCases, renderedOverflowLines: renders.reduce((n, r) => n + r.overflow.length, 0),
  sourceByWidth: widths.map(width => ({ width, usableWidth: width - 4,
    exceedingLines: documents.reduce((n, d) => n + d.fences.reduce((m, f) => m + f.byWidth.find(w => w.width === width).exceedingLines.length, 0), 0) })),
  mermaidSourceFences: documents.reduce((n, d) => n + d.fences.filter(f => f.mermaidSource).length, 0),
  tsxPseudoShapes: documents.reduce((n, d) => n + d.fences.filter(f => f.tsxPseudoShape).length, 0),
};
const limitations = [
  'Standalone actual Markdown renderer, paddingX=1, paddingY=0; not a full interactive Pi transcript or screenshot.',
  'Width-minus-4 accounts for outer padding and default code indent; nested lists/quotes may consume additional width.',
  'Source scanner covers left-margin and <=3-space fences, not nested CommonMark containers; TSX pseudo-shape detection is heuristic.',
  'Only headings explicitly naming 40-column panes are classified as known narrow cases. Source diagnostics are nonfatal.',
  'Gallery uses ANSI-stripped neutral snapshots; both actual themes are rendered, but syntax colors are intentionally not reproduced.',
  'Browser font/CJK glyph metrics may differ from terminal cells. No browser screenshot verification performed.',
];
const stats = { invocation: 'node tests/render.mjs', node: process.version,
  renderer: { pi, version: (await json(join(pi, 'package.json'))).version, tui, tuiVersion: (await json(join(tui, 'package.json'))).version },
  widths, themes, paddingX: 1, paddingY: 0, summary, limitations, documents, renders };
await writeFile(join(artifacts, 'render-stats.json'), JSON.stringify(stats, null, 2) + '\n');
await writeFile(join(artifacts, 'render-snapshots.txt'), renders.map(r => `=== ${r.id} | ${r.theme} | ${r.width} columns ===\n${r.snapshot}\n`).join('\n'));
const gallery = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Show-me · real Pi Markdown render gallery</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:1.5rem;font:16px/1.5 system-ui,sans-serif;background:#f4f4f4;color:#222}main{max-width:1500px;margin:auto}h1{font-size:1.6rem}h2{font-size:1.1rem;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,32rem),1fr));gap:1rem}article{min-width:0;border:1px solid #999;border-radius:5px;padding:1rem;background:#fff}article.dark{background:#202020;color:#eee}pre{font:14px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;overflow:auto;margin:0;padding:.5rem;background:#eee;color:#222}.dark pre{background:#161616;color:#eee}summary{cursor:pointer}pre:focus,summary:focus{outline:3px solid #547da7}li{margin:.3rem 0}code{overflow-wrap:anywhere}
</style><main><h1>Real Pi Markdown render gallery</h1>
<p>${summary.renders} renders · ${assertionCases} passing assertion cases · 40 / 60 / 80 / 120 columns · light / dark</p>
<p>Neutral ANSI-stripped snapshots from the installed renderer, not browser-rendered Markdown. Scroll each pane horizontally; browser wrapping is disabled.</p>
<details><summary>Method and limitations</summary><ul>${limitations.map(l => `<li>${escape(l)}</li>`).join('')}</ul></details>
<h2>Source diagnostics (nonfatal)</h2><pre tabindex="0">${escape(JSON.stringify(summary, null, 2))}</pre>
<div class="grid">${renders.map(r => `<article class="${r.theme}"><h2>${escape(r.id)}</h2><p>${r.theme} · ${r.width} columns · source budget ${r.usableWidth} · ${r.renderedLines} output lines · ${r.overflow.length} output overflows</p><pre tabindex="0" aria-label="${escape(`${r.id}, ${r.theme}, ${r.width} columns`)}">${escape(r.snapshot)}</pre></article>`).join('\n')}</div></main></html>`;
assert(!gallery.includes('\x1b'), 'ANSI leaked into HTML');
await writeFile(join(artifacts, 'render-gallery.html'), gallery);
console.log(JSON.stringify({ ...summary, artifacts, files: ['render-stats.json', 'render-snapshots.txt', 'render-gallery.html'] }, null, 2));
