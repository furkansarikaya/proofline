// @ts-check
// A340 (second form): a QA visual pass is not carried over a fix round that changes a script or style file the project's UI is made of (React/TSX, Astro, plain JS), nor any
// code under a mapped design surface; without a surface mapping any non-test product code makes it stale. Test files and documents still carry it over.
// The fixtures are real runs (rrun/frozen/implement of the risk tests); the fix round is a recorded FIX step and a handoff IMPLEMENTED.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { A, accepted, copyOf, must, rec, solo } from '../lib/harness.mjs';
import { asciiLower } from '../../control-plane/agents/scripts/core/shellglob.mjs';
import { frozen, implement, rd, rrun, snap, wr } from './risk-s1-lib.mjs';

const UI = '\n## UI\n\none status badge\nvisual_writes: DB_PATH=:memory:';
const CFG = '.agents/config.yaml';

/** A project whose plan names PATHS (new, UI), config text appended before the freeze, with a recorded QA visual PASS on the implemented tree. @param {string} paths @param {string} first @param {string} [cfg] */
function passed(paths, first, cfg = '') {
  const d = rrun('COMPLEX', paths, UI);
  if (cfg !== '') wr(d, CFG, `${rd(d, CFG)}\n${cfg}\n`);
  frozen(d);
  for (const p of paths.split(' ')) if (p !== first) wr(d, p, `// ${p}\n`);
  implement(d, first, `// ${first} v1`);
  rec(d, 'QA', 'PASS', [], { focus: 'visual' });
  assert.equal(focus(d), 'pass', 'the recorded visual pass is not current before the fix round');
  return d;
}
/** @param {string} d */
const focus = (d) => snap(d).split('\n').find((l) => l.startsWith('focus.QA.visual='))?.slice('focus.QA.visual='.length).split(/\s/)[0];
/** A fix round that changes only FILE. @param {string} d @param {string} file */
function fixRound(d, file) {
  rec(d, 'REVIEW_TESTS', 'FAIL', ['REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil']);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  solo(d, 'FIX', 'pass', file, `// fix in ${file}`, `impl.txt,impl_test.txt,${file}`);
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'handoff IMPLEMENTED after the fix round');
  return focus(d);
}

const surf = (p) => `design_docs:\n  design:\n    surfaces:\n      app:\n        doc: docs/design/APP.md\n        paths: ${p}\n        mode: operate`;
const MAP = surf('src/**');
/** The warm runs (a recorded QA visual PASS on the implemented tree), built once in before(); each test works on a copy. @type {Record<string, string>} */
const warm = {};
const SCEN = {
  react: ['src/App.tsx src/styles.css', 'src/App.tsx', ''],
  astro: ['src/pages/index.astro src/scripts/tags.ts', 'src/pages/index.astro', ''],
  astroMapped: ['src/pages/index.astro src/scripts/tags.ts', 'src/pages/index.astro', MAP],
  plain: ['public/index.html public/app.js', 'public/index.html', ''],
  playground: ['src/service.js public/index.html', 'public/index.html', ''],
  mapped: ['public/index.html apps/web/render.py server/api.py', 'public/index.html', surf('apps/web/**')],
  docs: ['src/App.tsx README.md', 'src/App.tsx', ''],
  // the review probes: one run per mode with every candidate file in the plan scope
  none: ['src/App.tsx src/pages/index.mdx src/components/ABTest.tsx src/app/test/page.tsx src/HearingTest.vue public/app.JS tailwind.config.js tests/foo.js __tests__/a.js src/x.test.tsx README.MD',
    'src/App.tsx', ''],
  depsCase: ['src/pages/index.html REQUIREMENTS.TXT PACKAGE.JSON', 'src/pages/index.html', surf('src/pages/**')],
  deps: ['src/App.tsx requirements.txt requirements/base.txt constraints.txt notes.txt', 'src/App.tsx', ''],
  depsSurf: ['src/pages/index.html requirements.txt notes.txt', 'src/pages/index.html', surf('src/pages/**')],
  surfMixed: ['public/index.html apps/web/lib/x.js', 'public/index.html', surf('Apps/Web/**')],
  surfCase: ['public/index.html Web-App/x.py', 'public/index.html', surf('web-app/**')],
  noneB: ['src/App.tsx src/components/speed_test.tsx src/components/Card.spec.vue tests/ui/Widget.tsx src/pages/about.md public/logo.svg package.json public/robots.txt site/INDEX.HTML packages/x/tests/a.js', 'src/App.tsx', ''],
  surfPages: ['src/pages/index.html public/app.js src/widgets/Card.TSX tailwind.config.js src/theme.json public/build/app.min.js server/api.py', 'src/pages/index.html', surf('src/pages/**')],
  surfPagesB: ['src/pages/index.html src/styles.ts src/locales/en.json src/routes.yaml package.json public/logo.svg public/hero.png public/data.json src/pages/about.md src/pages/speed_test.vue packages/theme/colors.ts docs/guide.md', 'src/pages/index.html', surf('src/pages/**')],
  surfWeb: ['apps/web/index.html packages/ui/button.js apps/web/src/Card.TSX server/api.py SRC/Components/x.MJS', 'apps/web/index.html', surf('apps/web/**')],
};
/** @param {string} k */
const fresh = (k) => copyOf(warm[k]);

describe('A340 ui_path and the visual QA pass after a fix round', { concurrency: 2 }, () => {
  before(() => { for (const [k, [paths, first, cfg]] of Object.entries(SCEN)) warm[k] = passed(paths, first, cfg); });

  /** the ui_path signal line of a project that has PATHS (new files, not committed) @param {string} paths @param {string} [cfg] */
  const uiSignal = (paths, cfg = '') => {
    const d = rrun('COMPLEX', paths, UI);
    if (cfg !== '') wr(d, CFG, `${rd(d, CFG)}\n${cfg}\n`);
    for (const p of paths.split(' ')) wr(d, p, `// ${p}\n`);
    return snap(d).split('\n').find((l) => l.startsWith('signal.ui_path=')) ?? '';
  };

  test('the signal: unambiguous frontend files and scripts in a frontend directory raise ui_path; backend scripts do not', () => {
    const sig = uiSignal('src/App.tsx public/app.js src/pages/index.astro src/service.js server/app.ts lib/util.mjs bin/cli.cjs scripts/build.js src/scripts/tags.ts');
    for (const yes of ['src/App.tsx', 'public/app.js', 'src/pages/index.astro']) assert.ok(sig.includes(`diff:${yes}(`), `${yes} did not raise ui_path: ${sig}`);
    for (const no of ['src/service.js', 'server/app.ts', 'lib/util.mjs', 'bin/cli.cjs', 'scripts/build.js', 'src/scripts/tags.ts']) assert.ok(!sig.includes(`diff:${no}`), `${no} raised ui_path: ${sig}`);
  });
  test('the signal: backend folders named client, web, static or views raise nothing; INDEX.HTML does', () => {
    const sig = uiSignal('src/service.js src/client/http.ts server/static/handler.js lib/views/render.js src/web/server.ts site/INDEX.HTML');
    for (const no of ['src/service.js', 'src/client/http.ts', 'server/static/handler.js', 'lib/views/render.js', 'src/web/server.ts']) assert.ok(!sig.includes(`diff:${no}`), `${no} raised ui_path: ${sig}`);
    assert.ok(sig.includes('diff:site/INDEX.HTML('), `INDEX.HTML did not raise ui_path: ${sig}`);
  });
  test('the signal: the surface and the path compare without case; backend route folders raise nothing for a script', () => {
    assert.ok(uiSignal('apps/web/lib/x.js', surf('Apps/Web/**')).includes('diff:apps/web/lib/x.js('), 'a mixed-case surface did not match a lower-case path');
    assert.ok(uiSignal('Apps/Web/lib/y.js', surf('apps/web/**')).includes('diff:Apps/Web/lib/y.js('), 'a lower-case surface did not match a mixed-case path');
    const sig = uiSignal('apps/api/src/app/app.service.ts src/pages/api/users.ts src/pages/api/page.tsx src/pages/home.ts');
    for (const no of ['apps/api/src/app/app.service.ts', 'src/pages/api/users.ts']) assert.ok(!sig.includes(`diff:${no}`), `${no} raised ui_path: ${sig}`);
    // r4: the exclusion is only for the framework route folders; an api folder inside a ui_dir or a surface is UI
    const api = uiSignal('public/api/widget.js assets/api/x.js www/api/index.js ui/api/x.mjs frontend/api/client.ts src/components/api/Form.ts public/api/app.js');
    for (const yes of ['public/api/widget.js', 'assets/api/x.js', 'www/api/index.js', 'ui/api/x.mjs', 'frontend/api/client.ts', 'src/components/api/Form.ts', 'public/api/app.js']) assert.ok(api.includes(`diff:${yes}(`), `${yes} did not raise ui_path: ${api}`);
    assert.ok(uiSignal('apps/web/api/x.js', surf('apps/web/**')).includes('diff:apps/web/api/x.js('), 'an api folder inside a surface did not raise ui_path');
    for (const yes of ['src/pages/api/page.tsx', 'src/pages/home.ts']) assert.ok(sig.includes(`diff:${yes}(`), `${yes} did not raise ui_path: ${sig}`);
  });
  test('the signal: case folding is ASCII only, so Turkish-sensitive names neither crash nor change bytes', () => {
    assert.equal(asciiLower('İSTANBUL/APP.TSX'), 'İstanbul/app.tsx', 'the fold touched a non-ASCII letter');
    const sig = uiSignal('ISTANBUL/App.TSX ASSETS/ISIK.JS PUBLIC/INDEX.MJS');
    for (const yes of ['ISTANBUL/App.TSX', 'ASSETS/ISIK.JS', 'PUBLIC/INDEX.MJS']) assert.ok(sig.includes(`diff:${yes}(`), `${yes} did not raise ui_path: ${sig}`);
  });
  test('the signal: a script under a mapped design surface raises ui_path; a script test file never does', () => {
    const sig = uiSignal('src/service.js public/app.test.js', MAP);
    assert.ok(sig.includes('diff:src/service.js(*.js)'), `a script under a mapped surface did not raise ui_path: ${sig}`);
    assert.ok(!sig.includes('.test.'), `a test file raised ui_path: ${sig}`);
  });
  test('the signal: extensions compare without case; names that only look like tests are UI', () => {
    const sig = uiSignal('src/widgets/Card.TSX public/app.JS src/components/ABTest.tsx src/HearingTest.vue src/app/test/page.tsx public/x.test.js');
    for (const yes of ['src/widgets/Card.TSX', 'public/app.JS', 'src/components/ABTest.tsx', 'src/HearingTest.vue', 'src/app/test/page.tsx']) assert.ok(sig.includes(`diff:${yes}(`), `${yes} did not raise ui_path: ${sig}`);
    assert.ok(!sig.includes('x.test.js'), `a test file raised ui_path: ${sig}`);
  });

  for (const [k, script] of [['react', 'src/App.tsx'], ['astro', 'src/scripts/tags.ts'], ['astroMapped', 'src/scripts/tags.ts'], ['plain', 'public/app.js']]) {
    test(`${k}: a fix that changes only ${script} makes the visual focus required again`, () => {
      const st = fixRound(fresh(k), script);
      assert.equal(st, 'stale', `${script} changed and the visual pass was carried over (${st})`);
    });
  }
  test('the playground layout: a backend fix in src/service.js stales an existing pass (no surfaces: any product code)', () => {
    assert.equal(fixRound(fresh('playground'), 'src/service.js'), 'stale');
  });

  test('a change to a test file or to a document still carries the pass over', () => {
    const d = fresh('docs');
    assert.equal(fixRound(d, 'impl_test.txt'), 'pass', 'a test-only fix made the visual pass stale');
    rec(d, 'REVIEW_TESTS', 'FAIL', ['REVIEW_TESTS-2|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil']);
    must(d, ['handoff', 'LC', 'IMPLEMENTING']);
    solo(d, 'FIX', 'pass', 'README.md', 'docs only', 'impl.txt,impl_test.txt,src/App.tsx,README.md');
    accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'handoff IMPLEMENTED');
    assert.equal(focus(d), 'pass', 'a document change made the visual pass stale');
  });

  for (const [file, want] of [['apps/web/render.py', 'stale'], ['server/api.py', 'pass']]) {
    test(`with a surface mapping a change to ${file} leaves the visual focus ${want === 'pass' ? 'carried over' : 'stale'}`, () => {
      assert.equal(fixRound(fresh('mapped'), file), want);
    });
  }

  // the review probes: [scenario, file, expected focus]
  for (const [k, file, want] of [
    ['surfWeb', 'packages/ui/button.js', 'stale'],            // M1 a script the signal raises, outside the surface
    ['surfWeb', 'apps/web/src/Card.TSX', 'stale'],            // M2 inside the surface, upper-case extension
    ['surfWeb', 'server/api.py', 'pass'],
    ['deps', 'requirements.txt', 'stale'],                    // r3: a manifest is decided before the document skip
    ['deps', 'requirements/base.txt', 'stale'],
    ['deps', 'constraints.txt', 'stale'],
    ['deps', 'notes.txt', 'pass'],
    ['depsSurf', 'requirements.txt', 'stale'],
    ['depsSurf', 'notes.txt', 'pass'],
    ['depsCase', 'REQUIREMENTS.TXT', 'stale'],               // r4: the manifest check ignores case
    ['depsCase', 'PACKAGE.JSON', 'stale'],
    ['surfMixed', 'apps/web/lib/x.js', 'stale'],              // a mixed-case surface matches a lower-case path
    ['surfCase', 'Web-App/x.py', 'stale'],                    // surface segments compare without case
    ['surfWeb', 'SRC/Components/x.MJS', 'stale'],
    ['surfPages', 'public/app.js', 'stale'],                  // S1
    ['surfPages', 'src/widgets/Card.TSX', 'stale'],           // S2 upper-case TSX
    ['surfPages', 'tailwind.config.js', 'stale'],             // S3 UI-driving config
    ['surfPages', 'src/theme.json', 'stale'],                 // S4
    ['surfPages', 'public/build/app.min.js', 'stale'],        // S5
    ['surfPages', 'server/api.py', 'pass'],
    ['surfPagesB', 'docs/guide.md', 'pass'],                   // a document outside every surface and ui_dir
    ['surfPagesB', 'src/styles.ts', 'stale'],                  // CSS-in-JS
    ['surfPagesB', 'src/locales/en.json', 'stale'],
    ['surfPagesB', 'src/routes.yaml', 'stale'],
    ['surfPagesB', 'package.json', 'stale'],                   // dependency manifest
    ['surfPagesB', 'public/logo.svg', 'stale'],                // an asset in a ui_dir
    ['surfPagesB', 'public/hero.png', 'stale'],
    ['surfPagesB', 'public/data.json', 'stale'],
    ['surfPagesB', 'src/pages/about.md', 'stale'],             // a document inside the surface
    ['surfPagesB', 'src/pages/speed_test.vue', 'stale'],
    ['surfPagesB', 'packages/theme/colors.ts', 'stale'],
    ['none', 'src/pages/index.mdx', 'stale'],                 // N1 mdx is JSX, not a document
    ['none', 'src/components/ABTest.tsx', 'stale'],           // N2
    ['none', 'src/app/test/page.tsx', 'stale'],               // N3
    ['none', 'src/HearingTest.vue', 'stale'],                 // N11
    ['none', 'public/app.JS', 'stale'],
    ['none', 'tailwind.config.js', 'stale'],
    ['none', 'tests/foo.js', 'pass'],                         // strict test paths keep the pass
    ['none', '__tests__/a.js', 'pass'],
    ['none', 'src/x.test.tsx', 'pass'],
    ['none', 'README.MD', 'pass'],
    ['noneB', 'src/components/speed_test.tsx', 'stale'],       // r2: _test names are tests only for non-UI types
    ['noneB', 'src/components/Card.spec.vue', 'pass'],         // .spec. names stay tests
    ['noneB', 'tests/ui/Widget.tsx', 'pass'],                  // root tests/ is a test by the project convention (A340.1)
    ['noneB', 'src/pages/about.md', 'stale'],                  // a document inside a ui_dir is UI
    ['noneB', 'public/logo.svg', 'stale'],
    ['noneB', 'package.json', 'stale'],
    ['noneB', 'public/robots.txt', 'stale'],
    ['noneB', 'site/INDEX.HTML', 'stale'],                     // html, upper case
    ['noneB', 'packages/x/tests/a.js', 'stale'],               // nested tests/ is not a strict test path (fail-safe)
  ]) {
    test(`${k}: a fix to ${file} leaves the visual focus ${want === 'pass' ? 'carried over' : 'stale'}`, () => {
      assert.equal(fixRound(fresh(k), file), want);
    });
  }

  test('missing or empty ecosystem UI data makes the visual focus stale, not carried over', () => {
    const d = fresh('surfPages');
    const eco = JSON.parse(readFileSync(path.join(d, '.agents/ecosystems.json'), 'utf8'));
    delete eco.global.ui_config;
    writeFileSync(path.join(d, '.agents/ecosystems.json'), JSON.stringify(eco));
    assert.equal(fixRound(d, 'server/api.py'), 'stale');
  });
});
