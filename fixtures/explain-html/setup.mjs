// Builds the explain-html fixture in <target-dir>: one good self-contained page (inline SVG, CSS and JS, no external reference).
// Deterministic and offline. usage: node setup.mjs <target-dir>
import path from 'node:path';
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  new Fx(target).cp(path.join(import.meta.dirname, 'page.html'), 'page.html');
}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });
