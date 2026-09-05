#!/usr/bin/env node
// Run: node tests/browser.mjs [path/to/visual.html]
// Optional: PLAYWRIGHT_PATH, CHROME_PATH (set to "bundled" for Playwright Chromium).
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/Users/ventris/.hermes/hermes-agent/node_modules/playwright');
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] || resolve(here, '../assets/visual.html'));
const output = resolve(here, 'artifacts');
await mkdir(output, { recursive: true });
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(chrome === 'bundled' ? {} : { executablePath: chrome }) });
const report = { target, browser: browser.version(), cases: [], failures: [], notes: ['Save flow is intentional sample content, not a placeholder defect.', 'Text enlargement uses html font-size:200% (text-only scaling, not browser zoom).', 'Clipping checks cover element and text-fragment bounds plus clipping ancestors; contrast covers opaque computed text/background colors.'] };
const malicious = '<img src="https://example.invalid/injected" onerror="window.__injected=true"><script>window.__injected=true</script>&"\'';
const longPath = '/Users/example/' + 'very-long-component-without-breaks'.repeat(16) + '/visual.html';
try {
  for (const width of [320, 375, 1280]) for (const colorScheme of ['light', 'dark']) for (const textScale of [1, 2]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const externalRequests = [], errors = [];
    page.on('request', request => { if (!request.url().startsWith('file:')) externalRequests.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await context.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(target).href, { waitUntil: 'networkidle' });
    if (textScale !== 1) await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    for (const injected of [false, true]) {
      if (injected) await page.evaluate(({ malicious, longPath }) => {
        document.querySelector('h1').textContent = malicious;
        const code = document.createElement('code');
        code.textContent = longPath;
        document.querySelector('.branch p').replaceChildren(code);
      }, { malicious, longPath });
      const id = `${width}-${colorScheme}-${textScale * 100}pct${injected ? '-injected' : ''}`;
      const metrics = await page.evaluate(() => {
        const overflow = [], clipping = [], contrasts = [];
        const vw = document.documentElement.clientWidth;
        const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
        const luminance = values => values.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const label = el => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).replaceAll(' ', '.') : ''}`;
        for (const el of document.querySelectorAll('body *')) {
          if (['STYLE', 'SCRIPT'].includes(el.tagName)) continue;
          const box = el.getBoundingClientRect();
          if (box.width && (box.left < -1 || box.right > vw + 1)) overflow.push({ element: label(el), left: box.left, right: box.right });
          for (const node of el.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (rect.left < -1 || rect.right > vw + 1) overflow.push({ text: node.textContent.slice(0, 70), left: rect.left, right: rect.right });
              for (let parent = el; parent; parent = parent.parentElement) {
                const s = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
                if ((['hidden', 'clip', 'auto', 'scroll'].includes(s.overflowX) && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) || (['hidden', 'clip', 'auto', 'scroll'].includes(s.overflowY) && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1))) clipping.push({ element: label(parent), text: node.textContent.slice(0, 70) });
              }
            }
            const style = getComputedStyle(el);
            let bg;
            for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
              const candidate = rgb(getComputedStyle(ancestor).backgroundColor);
              if (candidate.length === 3 || candidate[3] === 1) { bg = candidate; break; }
            }
            if (bg) {
              const fg = luminance(rgb(style.color)), back = luminance(bg);
              const ratio = (Math.max(fg, back) + .05) / (Math.min(fg, back) + .05);
              const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.6667 && parseInt(style.fontWeight) >= 700);
              contrasts.push({ element: label(el), ratio: Number(ratio.toFixed(3)), required: large ? 3 : 4.5 });
            }
          }
        }
        return { viewport: vw, scrollWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), overflow, clipping, contrasts, placeholders: document.body.innerText.match(/\b(?:TODO|FIXME|Lorem ipsum)\b|\{\{[^}]+\}\}|\[INSERT[^\]]*\]/gi) || [], injectedExecution: window.__injected === true, unsafeNodes: document.querySelectorAll('img,script,iframe').length, branchColumns: getComputedStyle(document.querySelector('.branches')).gridTemplateColumns, title: document.title, heading: document.querySelector('h1').textContent };
      });
      const failures = [];
      if (metrics.scrollWidth > width + 1 || metrics.overflow.length) failures.push('horizontal overflow');
      if (metrics.clipping.length) failures.push('clipped text');
      if (metrics.contrasts.some(c => c.ratio < c.required)) failures.push('WCAG AA text contrast');
      if (metrics.placeholders.length) failures.push('unresolved placeholders');
      if (externalRequests.length) failures.push('external requests');
      if (errors.length) failures.push('page errors');
      if (metrics.injectedExecution || metrics.unsafeNodes) failures.push('unsafe DOM nodes or injection execution');
      if (injected && metrics.heading !== malicious) failures.push('label did not remain literal');
      if (!injected && metrics.heading !== 'Save flow') failures.push('unexpected sample heading');
      const screenshot = resolve(output, `html-${id}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      report.cases.push({ id, failures, externalRequests: [...externalRequests], errors: [...errors], screenshot, ...metrics });
      report.failures.push(...failures.map(failure => `${id}: ${failure}`));
      console.log(`${failures.length ? 'FAIL' : 'PASS'} ${id}: scrollWidth=${metrics.scrollWidth}/${width}, contrastMin=${Math.min(...metrics.contrasts.map(c => c.ratio))}, screenshot=${screenshot}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, 'html-results.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(`${report.cases.length} cases; ${report.failures.length} failures`);
if (report.failures.length) process.exitCode = 1;
