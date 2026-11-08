// Proves the planted facts of the visual-proof fixture built in <dir> without a browser (pull-request CI):
// the planted defects and traps are in the source, the planted contrast ratio is below 4.5:1, and the
// browser-less path (no tooling) produces a valid UNSUPPORTED report, never a pass. The browser measurement
// is fixtures/visual-proof/browser-check.mjs (main/nightly CI). usage: node selfcheck.mjs <built-dir>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const dir = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const skill = path.join(repoRoot, 'skills/visual-proof/scripts');
const rd = (/** @type {string} */ f) => readFileSync(path.join(dir, f), 'utf8');
/** `grep -q '^…'`: some line of the file starts with the literal text. */
const hasLine = (/** @type {string} */ f, /** @type {string} */ start) => rd(f).split('\n').some((l) => l.startsWith(start));

// Planted defects.
if (!hasLine('app/styles.css', '.promo-banner { width: 400px;')) fail('fixed-width banner (overflow at 360px) missing');
if (!hasLine('app/styles.css', '.hint { color: #aaaaaa;')) fail('low-contrast hint missing');
if (!hasLine('app/styles.css', '#clear-search { width: 16px; height: 16px;')) fail('16px touch target missing');
if (!hasLine('app/styles.css', '.search-row { display: flex; gap: 0;')) fail('the small target must sit against its neighbours (no spacing exception)');
if (!rd('spec.md').includes('data-state=error')) fail('spec must define the error state');
if (rd('app/app.js').includes("'error'")) fail('app.js must not render the error state');
if (!rd('visual.json').includes('"name": "error"')) fail('config must measure the error state');
// Traps: intended patterns that must not be reported.
if (!hasLine('app/styles.css', '.carousel { display: flex; gap: 12px; overflow-x: auto;')) fail('scrollable carousel trap missing');
if (!hasLine('app/styles.css', '.skip-link { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);')) fail('visually hidden skip link trap missing');
if (!hasLine('app/styles.css', '.skip-link:focus { position: static;')) fail('skip link must become visible on focus');
if ((rd('app/log.html').match(/class="back"|<pre class="log"/g) ?? []).map((m) => `${m} `).join('') !== 'class="back" <pre class="log" class="back" ') fail('log page must be link, scrollable pre, link (focusable-scroller trap)');
if (!hasLine('app/styles.css', '.log { overflow-x: auto;')) fail('log block must scroll horizontally');

// The planted contrast, computed with the WCAG 2.2 formula: #aaaaaa on #ffffff is 2.32:1.
const lum = (/** @type {string} */ h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (lum('#ffffff') + 0.05) / (lum('#aaaaaa') + 0.05);
if (Math.floor(ratio * 100) / 100 !== 2.32) fail('planted contrast is not 2.32:1');

// No tooling: the report is UNSUPPORTED, valid, and every required criterion is unproven.
const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'visual-proof-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
writeFileSync(path.join(tmp, 'raw.json'), JSON.stringify({ tool: { kind: 'none', name: null, reason: 'no Chromium-family browser on PATH; no browser-test dependency in package.json' }, config: JSON.parse(rd('visual.json')) }));
const asm = run('node', [path.join(skill, 'measure.mjs'), '--assemble', path.join(tmp, 'raw.json'), '--out', path.join(tmp, 'out')], { cwd: dir });
if (asm.status !== 0) fail(`assemble failed: ${asm.out.trimEnd()}`);
const val = run('node', [path.join(skill, 'validate-visual.mjs'), path.join(tmp, 'out/report.json'), '--class', 'COMPLEX'], { cwd: dir });
if (val.status !== 0) fail(`UNSUPPORTED report invalid: ${val.out.trimEnd()}`);
if (!val.out.split('\n').includes('RESULT: UNSUPPORTED')) fail('no tooling must give RESULT: UNSUPPORTED');
if (!val.out.includes('AC-1=unproven AC-2=unproven AC-3=unproven AC-4=unproven')) fail('required criteria must be unproven without tooling');
console.log('selfcheck: visual-proof ok (browser measurement: fixtures/visual-proof/browser-check.mjs)');
