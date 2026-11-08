// Browser part of the visual-proof fixture: measures the built fixture with skills/visual-proof/scripts/measure.mjs
// and compares the measured failures with the planted facts of EXPECTED.md (exactly those, traps not flagged),
// then proves on a local server that nothing outside the page's origin reaches it (network-check.mjs), then
// aborts two measurements with SIGTERM and SIGINT and checks no browser process or profile is left.
// Main/nightly CI only (.github/workflows/ci.yml); pull requests run the browser-less validator tests.
// No browser on the machine: prints `UNSUPPORTED: <reason>` and exits 0 (the accepted result; never a pass of
// the measurement). Installs nothing.
// Usage: node fixtures/visual-proof/browser-check.mjs [--no-sandbox]
//   --no-sandbox is forwarded to the browser (CI runners whose kernel forbids the browser sandbox; the page is
//   this repository's own static fixture).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from './setup.mjs';
import { repoRoot } from '../../tests/lib/fixture.mjs';

const extra = process.argv.slice(2);
const work = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'visual-proof-browser-'));
const cleanup = () => rmSync(work, { recursive: true, force: true });
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { cleanup(); process.exit(130); });
const node = (/** @type {string[]} */ args) => spawnSync(process.execPath, args, { stdio: 'inherit' }).status ?? 1;
const skill = path.join(repoRoot, 'skills/visual-proof/scripts');
const fx = path.join(work, 'fx');

build(fx);
const det = spawnSync(process.execPath, [path.join(skill, 'measure.mjs'), '--detect', '--repo', fx], { encoding: 'utf8' });
if (det.status !== 0) { process.stderr.write(det.stderr); process.exit(det.status ?? 1); }
const detect = JSON.parse(det.stdout);
if (detect.kind === 'none') { console.log(`UNSUPPORTED: ${detect.reason}`); process.exit(0); }
for (const args of [
  [path.join(skill, 'measure.mjs'), '--config', path.join(fx, 'visual.json'), '--out', path.join(work, 'out'), '--repo', fx, ...extra],
  [path.join(import.meta.dirname, 'expect.mjs'), path.join(work, 'out/report.json'), path.join(fx, 'spec.md')],
  [path.join(import.meta.dirname, 'network-check.mjs'), ...extra],
  [path.join(import.meta.dirname, 'abort-check.mjs'), fx, ...extra],
]) { const st = node(args); if (st !== 0) process.exit(st); }
