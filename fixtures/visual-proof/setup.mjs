// Builds the visual-proof fixture in <target-dir> (must be empty or absent): the static orders app (app/: index.html,
// styles.css, app.js; no framework, no build), its UI spec (spec.md) and the measurement config (visual.json)
// whose base_url points at the built app/ folder. No network, no installs. usage: node setup.mjs <target-dir>
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const here = import.meta.dirname;
  const f = new Fx(target);
  f.mkdir('app');
  const root = realpathSync(target);
  for (const n of ['index.html', 'log.html', 'styles.css', 'app.js']) f.cp(path.join(here, 'app', n), `app/${n}`);
  f.cp(path.join(here, 'spec.md'), 'spec.md');
  // The config names the app by an absolute file: URL; the placeholder keeps the committed copy machine-independent.
  f.w('visual.json', readFileSync(path.join(here, 'visual.json'), 'utf8').split('/FIXTURE_ROOT').join(root));
}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });
