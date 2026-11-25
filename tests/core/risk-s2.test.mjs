// @ts-check
// risk-test.sh scenarios sc_frozen .. sc_gate_deps (lines 517-996) as Node tests (176-D2). Every assertion, attack input and message of the shell scenario is
// kept. The control plane under test is the real one; the fixture is the harness's. Four scenarios of the slice are covered by existing hand-written ports
// (sc_log_words_match, sc_log_pattern_wide, sc_not_contract_drift: port-t2-drift.test.mjs; sc_eco_fallback: port-t2-eco.test.mjs) and are not repeated.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, accepted, agentsSrc, copyOf, gateOwner, must, passAll, refused, resultFor, rec, gpass, tmp } from '../lib/harness.mjs';
import { Aasync } from './gates-s1-lib.mjs';
import { Af, RUN, ap, appr, proj, freezeStandard, frozen, has, hasnt, implement, pv, rd, rrun, sed, sedFile, setBase, snap, stOf, tierOf, wr, commitHead } from './risk-s2-lib.mjs';

/** A config text written to a scratch file outside the project (the file argument of config-check). @param {string} name @param {string} text */
const scratch = (name, text) => { const dir = tmp('c'); wr(dir, name, text); return path.join(dir, name); };   // not wr('/', absolute): path.join('/', 'C:\\x') is 'D:\\C:\\x' on Windows (A262)
const CFG = '.agents/config.yaml';
const crit = () => proj({ cls: 'CRITICAL' });
const R = (/** @type {string} */ d) => `${RUN}/${d}`;

test('sc_frozen: flags need a refreeze, the mapping, the performance thresholds, the security policy and the contract globs are bound by risk_sha256, config-check refuses foreign checks', () => {
  const d = rrun('COMPLEX', 'api/openapi.yaml'); frozen(d);
  ap(d, R('PLAN.md'), '\n## Risk\n\ncontract_change: yes\nperformance_critical: yes budget_pct=5\n');
  refused(Af(d, ['verify-freeze', 'LC']), 'a flag changed after freeze', 'freeze mismatch: plan');
  wr(d, R('amendments/001.md'), '# Amendment 1\n\nDeclare the contract change.\n');
  appr(d, 'plan', 'approved: this plan');
  accepted(Af(d, ['refreeze', 'LC', '001.md']), 'refreeze 001'); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze after refreeze');
  has(snap(d), 'signal.contract_change=source=plan');
  // A87: the performance budget on the flag line is frozen with PLAN.md: raising it after freeze breaks the freeze
  const planKeep = rd(d, R('PLAN.md'));
  wr(d, R('PLAN.md'), sed(planKeep, /^performance_critical: yes budget_pct=5$/, 'performance_critical: yes budget_pct=50'));
  assert.ok(rd(d, R('PLAN.md')).includes('budget_pct=50'));
  refused(Af(d, ['verify-freeze', 'LC']), 'a performance budget raised after freeze', 'freeze mismatch: plan');
  wr(d, R('PLAN.md'), planKeep); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze with the plan restored');
  // the mapping: any edit of the risk block after freeze breaks the freeze
  const cfgKeep = rd(d, CFG); const cfgMap = sed(cfgKeep, /^ {4}check: contract$/, '    check: rules');
  wr(d, CFG, cfgMap);
  refused(Af(d, ['verify-freeze', 'LC']), 'a mapping change after freeze', 'freeze mismatch: risk');
  wr(d, CFG, cfgKeep); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze with the config restored');
  // A87: the performance thresholds are frozen too: raising regression_pct mid-run breaks the freeze
  const cfg500 = sed(cfgKeep, /^ {2}regression_pct: 10$/, '  regression_pct: 500');
  assert.ok(/^ {2}regression_pct: 500$/m.test(cfg500));
  wr(d, CFG, cfg500);
  refused(Af(d, ['verify-freeze', 'LC']), 'a performance threshold change after freeze', 'freeze mismatch: risk');
  wr(d, CFG, cfgKeep); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze after the threshold restore');
  // A98: risk.unsupported is part of the frozen mapping and config-check accepts only block|report
  wr(d, CFG, sed(cfgKeep, /^ {2}unsupported: report$/, '  unsupported: block'));
  assert.ok(/^ {2}unsupported: block$/m.test(rd(d, CFG)), 'the unsupported edit did not apply');
  accepted(A(d, ['config-check']), 'config-check with unsupported: block');
  refused(Af(d, ['verify-freeze', 'LC']), 'risk.unsupported changed after freeze', 'freeze mismatch: risk');
  const cfgBad = scratch('cfg.bad', sed(cfgKeep, /^ {2}unsupported: report$/, '  unsupported: maybe'));
  refused(A(d, ['config-check', cfgBad]), 'an invalid risk.unsupported', 'invalid value for risk.unsupported: maybe (want block|report)');
  wr(d, CFG, cfgKeep); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze after the unsupported restore');
  refused(A(d, ['config-check', scratch('cfg', cfgMap)]), 'a check outside the focus set', 'invalid value for risk.contract_file.check');
  // a new gate type in the mapping (awk: replace the body of risk.ui_path)
  /** @type {string[]} */ const o2 = []; let skip = false;
  for (const l of rd(d, CFG).split('\n')) {
    if (/^ {2}ui_path:/.test(l)) { o2.push(l, '    paths: "*.html"', '    check: VISUAL_GATE'); skip = true; continue; }
    if (skip && /^ {2}[a-z]/.test(l)) skip = false;
    if (!skip) o2.push(l);
  }
  refused(A(d, ['config-check', scratch('cfg2', `${o2.join('\n')}`)]), 'a new gate type in the mapping', 'invalid value for risk.ui_path.check');
  // A88: the shipped config carries the `security:` block (license policy, audit command) and config-check accepts it
  assert.ok(/^security:/m.test(rd(d, CFG)), 'shipped config has no security block');
  accepted(A(d, ['config-check']), 'config-check of the shipped config');
  // the license policy and audit command are bound by the freeze too: a mid-run edit is refused, restoring it passes
  const keep2 = rd(d, CFG);
  wr(d, CFG, sed(keep2, /^ {4}deny:.*$/, '    deny: GPL-3.0-only'));
  assert.ok(/^ {4}deny: GPL-3.0-only$/m.test(rd(d, CFG)), 'the test edit did not apply');
  refused(Af(d, ['verify-freeze', 'LC']), 'a license policy edit after freeze', 'freeze mismatch: risk');
  wr(d, CFG, sed(keep2, /^ {2}audit_command:.*$/, '  audit_command: make audit'));
  refused(Af(d, ['verify-freeze', 'LC']), 'an audit command edit after freeze', 'freeze mismatch: risk');
  wr(d, CFG, keep2); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze after the policy restore');
  // contract-proof's contract.paths / contract.ignore globs are frozen with the mapping (A83)
  ap(d, CFG, '\ncontract:\n  ignore: "i18n/**"\n');
  accepted(A(d, ['config-check']), 'config-check with contract.ignore');
  refused(Af(d, ['verify-freeze', 'LC']), 'contract.ignore added after freeze', 'freeze mismatch: risk');
  wr(d, CFG, keep2); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze after the contract restore');
  // A92: a RUN.yaml without freeze.risk_sha256 fails closed; a refreeze inserts the key
  wr(d, R('RUN.yaml'), rd(d, R('RUN.yaml')).split('\n').filter((l) => !l.startsWith('  risk_sha256:')).join('\n'));
  refused(Af(d, ['verify-freeze', 'LC']), 'a run without risk_sha256', 'no freeze.risk_sha256');
  wr(d, R('amendments/002.md'), '# Amendment 2\n\nBind the risk mapping.\n');
  appr(d, 'plan', 'approved, the plan please');
  accepted(Af(d, ['refreeze', 'LC', '002.md']), 'refreeze 002'); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze after refreeze 002');
  assert.ok(/^ {2}risk_sha256: "[0-9a-f]{64}"/m.test(rd(d, R('RUN.yaml'))), 'refreeze did not insert risk_sha256');
  refused(A(d, ['config-check', scratch('cfg3', `${rd(d, CFG)}\ncontract:\n  skip: "x"\n`)]), 'an unknown contract key', 'unknown contract key: contract.skip');
});

test('sc_prefreeze: signals of the planned scope are visible and next dispatches the design role', () => {
  let d = rrun('STANDARD', 'api/openapi.yaml');
  const next = (/** @type {string} */ x) => A(x, ['next', 'LC']);
  assert.ok(next(d).out.includes('next=dispatch.sh LC architect (declare contract_change in PLAN.md for risk signal contract_file: api/openapi.yaml'), `next: ${next(d).out}`);
  const po = snap(d);
  has(po, 'signal.contract_file=source=scope:api/openapi.yaml');
  has(po, 'missing_flag.contract_file=scope:api/openapi.yaml needs PLAN.md contract_change: yes (declare it before FREEZE)');
  d = rrun('STANDARD', 'db/migrations/002.sql');
  assert.ok(next(d).out.includes('next=dispatch.sh LC data_architect (declare data_change'), `next: ${next(d).out}`);
  d = rrun('STANDARD', 'api/openapi.yaml', '\n## Risk\n\ncontract_change: yes');
  assert.ok(next(d).out.includes('next=agent.sh freeze LC'), `next after the flag: ${next(d).out}`);
});

test('sc_contract_content: OpenAPI root key and JSON Schema found by content, nested .proto by path; prose and code quoting it are not', () => {
  const d = crit();
  wr(d, 'spec/service.yaml', 'openapi: 3.1.0\ninfo: { title: x }\n');
  wr(d, 'schemas/user.json', '{ "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object" }\n');
  wr(d, 'proto/v1/user.proto', 'message User { string id = 1; }\n');
  wr(d, 'docs/api-notes.md', '# API notes\n\nThe spec starts with:\n\nopenapi: 3.0.0\n');           // trap: prose quoting a contract
  wr(d, 'src.js', 'const yaml = "openapi: 3.0.0";\n');                                                    // trap: not at line start
  const po = snap(d);
  has(po, String.raw`signal.contract_file=source=diff:proto/v1/user.proto(*.proto),diff:schemas/user.json(content /^(openapi/asyncapi/swagger):/"\$schema"[[:space:]]*:[[:space:]]*"https?://json-schema\.org//^syntax = "proto/),diff:spec/service.yaml(content /^(openapi/asyncapi/swagger):/"\$schema"[[:space:]]*:[[:space:]]*"https?://json-schema\.org//^syntax = "proto/) check=REVIEW_RULES:contract`);
  hasnt(po, 'api-notes.md'); hasnt(po, 'src.js');
});

test('sc_contract_content_edit: an edit or deletion in a content-recognised contract signals; tsconfig, a non-json-schema.org schema and contract.ignore do not', () => {
  const d = crit();
  wr(d, 'spec/service.yaml', 'openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n  /b:\n    get: {}\n');
  wr(d, 'tsconfig.json', '{ "compilerOptions": {} }\n');
  const sha = commitHead(d, 'add spec and tsconfig');
  // the run's base is the commit that holds the contract, so the edit below is an edit of a file that exists at base
  setBase(d, sha);
  wr(d, 'spec/service.yaml', 'openapi: 3.0.0\npaths:\n  /a:\n    get: {}\n');
  let po = snap(d);
  has(po, 'diff:spec/service.yaml(content '); has(po, 'focus.REVIEW_RULES.contract=missing');
  has(po, 'missing_flag.contract_file=diff:spec/service.yaml needs PLAN.md contract_change: yes');
  wr(d, 'tsconfig.json', '{ "$schema": "https://json.schemastore.org/tsconfig", "compilerOptions": {} }\n');
  wr(d, 'tooling.json', '{ "$schema": "https://json.schemastore.org/biome.json" }\n');
  wr(d, 'shape.json', '{ "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object" }\n');
  po = snap(d);
  hasnt(po, 'tsconfig.json'); hasnt(po, 'tooling.json'); has(po, 'diff:shape.json(content ');
  ap(d, CFG, 'contract:\n  ignore: "shape.json"\n');
  po = snap(d); hasnt(po, 'shape.json');
});

test('sc_migration_small: migration at tier small: escalated to full, REVIEW_DATA carries the migration check, tier never decreases', () => {
  const d = rrun('STANDARD', 'queries/drop_theme.sql');
  freezeStandard(d);
  wr(d, 'queries/drop_theme.sql', 'alter table settings drop column theme;\n');
  const po = snap(d);
  assert.equal(pv(po, 'tier'), 'full', `a one-file migration is tier ${pv(po, 'tier')}, want full`);
  has(po, 'gates=SECRETS REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA SECURITY QA VERIFY');
  has(po, 'signal.migration=source=diff:queries/drop_theme.sql(*.sql)'); has(po, 'focus.REVIEW_DATA.migration=missing');
  has(po, 'missing_flag.migration=diff:queries/drop_theme.sql needs PLAN.md data_change: yes (a blocking finding');
  tierOf(d); rmSync(path.join(d, 'queries/drop_theme.sql'));
  assert.equal(tierOf(d), 'full', 'the tier decreased after the migration was removed');
});

const MANIFESTS = ['npm-shrinkwrap.json', 'requirements-dev.txt', 'requirements.in', 'requirements/base.txt', 'requirements/prod.in', 'setup.py', 'setup.cfg', 'gradle/libs.versions.toml',
  '.npmrc', 'packages.config', 'environment.yml', 'deno.json', 'Package.swift', 'go.sum', 'Gemfile.lock', 'composer.lock', 'pom.xml', 'build.gradle.kts', 'app.csproj', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock'];
test('sc_dependency_manifests: every manifest and lockfile the dependency diff reads is a SECURITY:dependencies signal; documentation is not', () => {
  const d = crit();
  for (const f of MANIFESTS) wr(d, f, 'x\n');
  wr(d, 'docs/requirements.md', '# Requirements\n');      // trap: documentation about requirements
  wr(d, 'setup.pyc', 'x\n');                              // trap: not a manifest
  const po = snap(d);
  for (const f of MANIFESTS) has(po, `diff:${f}(`);
  hasnt(po, 'docs/requirements.md'); hasnt(po, 'setup.pyc');
});

test('sc_eco_risky_paths: every risky path of ecosystems.json (root and nested) makes the tier full alone; every manifest, lock and package-source setting is a dependency signal', async () => {
  const j = JSON.parse(readFileSync(path.join(agentsSrc, 'ecosystems.json'), 'utf8'));
  /** @param {string} g */
  const sample = (g) => g.split('/').map((s, i, a) => (s === '**' ? (i === a.length - 1 ? 'sub/f.txt' : 'sub') : s.replace(/\*/g, 'a'))).join('/');
  /** @type {Set<string>} */ const out = new Set();
  /** @param {string} kind @param {string} g */
  const add = (kind, g) => {
    const root = g.replace(/^(\*\*\/)+/, '');
    out.add(`${kind} ${sample(root)}`);
    if (g.startsWith('**/') || (kind === 'dep' && !g.includes('/'))) out.add(`${kind} src/Api/${sample(root)}`);
  };
  for (const g of j.global.risky_paths) add('risk', g);
  for (const e of j.ecosystems) {
    for (const g of e.risky_paths) add('risk', g);
    for (const g of [...e.manifests, ...e.locks, ...e.settings]) add('dep', g);
  }
  const list = [...out];
  assert.ok(list.length > 100, `the generated path list is too short: ${list.length}`);
  // the named ones of the 0.0.30 request must be in the list (the loop would pass vacuously on an emptied definition)
  const listText = list.join('\n');
  for (const n of ['Directory.Build.props', 'Directory.Build.targets', 'global.json', 'src/Api/a.fsproj', 'a.vbproj', '.config/dotnet-tools.json', 'NuGet.config', 'nuget.config', '.npmrc', '.yarnrc.yml', 'pip.conf',
    '.cargo/config.toml', 'settings.xml', 'build.rs', 'gradle-wrapper.properties', 'a.gradle', '.github/', 'Dockerfile', 'docker-compose', 'package-lock.json']) {
    assert.ok(listText.includes(n), `the definition no longer lists ${n}`);
  }
  const d = rrun('STANDARD', 'lib.txt');
  freezeStandard(d);
  wr(d, 'lib.txt', 'x\n');
  let po = snap(d);
  assert.equal(pv(po, 'tier'), 'small', `the control (a plain file) is tier ${pv(po, 'tier')}, want small`);
  hasnt(po, 'signal.dependency_manifest');
  rmSync(path.join(d, 'lib.txt'));
  // risk paths (CI, containers, build-changing files): each one alone makes the tier full. A manifest, lock or package-source setting is proven by its
  // dependency signal below; a few named ones also by the tier, alone.
  /** @type {string[]} */ const dep = []; /** @type {string[][]} */ const checks = [];
  const alone = new Set(['Directory.Build.props', 'src/Api/Directory.Build.props', 'src/Api/a.fsproj', 'src/Api/a.vbproj', 'global.json', 'package-lock.json', 'src/Api/.config/dotnet-tools.json']);
  for (const line of list) {
    const sp = line.indexOf(' '); const kind = line.slice(0, sp); const p = line.slice(sp + 1);
    if (kind === 'dep') { dep.push(p); if (!alone.has(p)) continue; }
    checks.push([kind, p]);
  }
  // each path is judged alone in its own copy of the frozen run, six copies at a time (the paths do not depend on each other: one file, one `tier`)
  const lanes = [0, 1, 2, 3, 4, 5].map((i) => ({ dir: i === 0 ? d : copyOf(d), items: checks.filter((_, k) => k % 6 === i) }));
  await Promise.all(lanes.map(async (lane) => {
    for (const [kind, p] of lane.items) {
      wr(lane.dir, p, 'x\n');
      const r = await Aasync(lane.dir, ['tier', 'LC']);
      assert.equal(r.status, 0, `tier failed for ${p}`);
      const t = r.out.replace(/\n+$/, '');
      assert.equal(t, 'full', `${p} (${kind}) is tier ${t}, want full`);
      sedFile(lane.dir, R('RUN.yaml'), /^ {2}tier: .*/, '  tier: small');   // `tier` records a rise; reset it
      rmSync(path.join(lane.dir, p), { force: true });
    }
  }));
  const n = checks.length;
  assert.ok(n > 40,`only ${n} risky paths were exercised`);
  // the dependency signal names every such path (one pipeline run per round; NuGet.config and nuget.config share a file on a case-insensitive
  // filesystem, so a path whose lower-case form was already placed waits for the next round)
  let rest = dep; let rounds = 0;
  while (rest.length > 0) {
    /** @type {string[]} */ const now = []; /** @type {string[]} */ const next = []; const seen = new Set();
    for (const p of rest) { const k = p.toLowerCase(); if (seen.has(k)) next.push(p); else { seen.add(k); now.push(p); } }
    for (const p of now) wr(d, p, 'x\n');
    po = snap(d);
    for (const p of now) has(po, `diff:${p}(`);
    for (const p of now) rmSync(path.join(d, p), { force: true });
    rest = next; rounds++; assert.ok(rounds < 4, `case-variant rounds do not end: ${rest.join(' ')}`);
  }
});

test('sc_eco_freeze_compat: a run frozen before the set keeps its hash and signal paths, a run frozen with it binds it, config-owned paths still count', () => {
  let d = rrun('COMPLEX', '');
  assert.ok(existsSync(path.join(d, '.agents/ecosystems.json')), 'the fixture has no .agents/ecosystems.json');
  const ecoKeep = rd(d, '.agents/ecosystems.json'); rmSync(path.join(d, '.agents/ecosystems.json'));
  // a missing definition is never silent: classify prints one warning line, pipeline names it (A174); nothing fails
  const cl = A(d, ['classify', 'LC', 'COMPLEX']);
  assert.ok(cl.text.split('\n').some((l) => l.startsWith('warning: .agents/ecosystems.json is missing or empty')), `classify does not warn about the missing definition: ${cl.text}`);
  has(snap(d), 'warning=.agents/ecosystems.json is missing or empty');
  appr(d, 'plan', 'approve the plan'); must(d, ['freeze', 'LC'], { bind: true }); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  wr(d, '.agents/ecosystems.json', ecoKeep);
  let po = snap(d); hasnt(po, 'warning=.agents/ecosystems.json');
  const vf = Af(d, ['verify-freeze', 'LC']);
  assert.equal(vf.status, 0, `a run frozen before the ecosystem set joined the hash fails verify-freeze: ${vf.text}`);
  wr(d, 'src/Api/a.fsproj', 'x\n'); wr(d, 'Directory.Build.props', 'x\n');
  po = snap(d); hasnt(po, 'diff:src/Api/a.fsproj('); hasnt(po, 'diff:Directory.Build.props(');
  // another risk key edited on that run is still refused
  const cfgKeep = rd(d, CFG);
  wr(d, CFG, sed(cfgKeep, /^ {2}regression_pct: 10$/, '  regression_pct: 500'));
  assert.notEqual(rd(d, CFG), cfgKeep, 'the regression_pct edit did not apply');
  refused(Af(d, ['verify-freeze', 'LC']), 'another risk key edited on a run frozen before the ecosystem set', 'freeze mismatch: risk');
  wr(d, CFG, cfgKeep);
  // a run frozen with the definition binds it and reads it for the dependency signal
  d = rrun('COMPLEX', '');
  appr(d, 'plan', 'approve the plan'); must(d, ['freeze', 'LC'], { bind: true }); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  const vf2 = Af(d, ['verify-freeze', 'LC']); assert.equal(vf2.status, 0, `a run frozen with the definition fails verify-freeze: ${vf2.text}`);
  wr(d, 'src/Api/a.fsproj', 'x\n'); wr(d, 'Directory.Build.props', 'x\n');
  po = snap(d); has(po, 'diff:src/Api/a.fsproj('); has(po, 'diff:Directory.Build.props(');
  const defn = JSON.parse(ecoKeep); defn.ecosystems.find((/** @type {{ id: string }} */ e) => e.id === 'npm').manifests.push('my-new-manifest.lock2'); wr(d, '.agents/ecosystems.json', JSON.stringify(defn, null, 2));
  refused(Af(d, ['verify-freeze', 'LC']), 'the ecosystem definition changed after freeze', 'freeze mismatch: risk');
  wr(d, '.agents/ecosystems.json', ecoKeep);
  const vf3 = Af(d, ['verify-freeze', 'LC']); assert.equal(vf3.status, 0, `restoring the definition does not restore the freeze: ${vf3.text}`);
  // the project's own config paths are read beside the definition's
  const cfgMine = sed(sed(cfgKeep, /^ {2}risky_paths: "/, '  risky_paths: "custom/** '), /^ {4}paths: "mix\.exs mix\.lock/, '    paths: "my.lock mix.exs mix.lock');
  assert.notEqual(cfgKeep, cfgMine, 'the config customisation did not apply');
  d = rrun('STANDARD', 'lib.txt'); wr(d, CFG, cfgMine);
  freezeStandard(d);
  wr(d, 'custom/f.txt', 'x\n');
  assert.equal(tierOf(d), 'full', 'a customised risky_paths entry no longer makes the tier full');
  rmSync(path.join(d, 'custom'), { recursive: true, force: true }); wr(d, 'my.lock', 'x\n');
  has(snap(d), 'diff:my.lock(');
});

test('sc_selective_focus: a change outside the dependency manifests keeps SECURITY:dependencies fresh (own focus stale); package.json stales it', () => {
  const d = rrun('COMPLEX', 'package.json src/a.js'); frozen(d);
  wr(d, 'src/a.js', 'export const a = 1;\n');
  implement(d, 'package.json', '{}');
  passAll(d);
  const dependencies = () => stOf(d, 'focus.SECURITY.dependencies');
  assert.equal(dependencies(), 'pass', `dependencies focus not pass after pass_all: ${dependencies()}`);
  wr(d, 'src/a.js', 'export const a = 2;\n');
  assert.equal(dependencies(), 'pass', `a change outside the manifests staled the dependencies focus: ${dependencies()}`);
  assert.equal(stOf(d, 'gate.SECURITY'), 'stale', `the SECURITY own focus did not go stale: ${stOf(d, 'gate.SECURITY')}`);
  wr(d, 'stray.txt', 'x\n');   // not task-owned: the fingerprint changes, the explained delta does not cover it
  assert.equal(dependencies(), 'stale', `a path that is not task-owned left the focus fresh: ${dependencies()}`);
  rmSync(path.join(d, 'stray.txt'));
  wr(d, 'package.json', '{ "name": "x" }\n');
  assert.equal(dependencies(), 'stale', `a package.json change left the dependencies focus fresh: ${dependencies()}`);
});


test('sc_log_sensitive: sensitive log calls added by the diff open the logging focus; ordinary calls, discard/classname, plain code and context lines do not', () => {
  let d = crit();
  wr(d, 'src/p_go.go', 'package x\nfunc f() { log.Printf("login %s", user.Password) }\n');
  wr(d, 'src/p_js.js', 'console.log("auth", req.headers.authorization);\n');
  wr(d, 'src/p_py.py', 'logger.info("t %s", user_token)\n');
  wr(d, 'src/p_rs.rs', 'fn f() { info!("mail {}", userEmail); }\n');
  wr(d, 'src/n_ok.py', 'logger.info("started")\n');
  wr(d, 'src/n_discard.go', 'func f() { log.Printf("discard %d", discardCount) }\n');
  wr(d, 'src/n_class.js', 'console.log("c", className);\n');
  wr(d, 'src/n_classname.js', 'console.log("c", classname)\n');
  wr(d, 'src/n_plain.go', 'func f() { password := 1; _ = password }\n');          // sensitive word, no log call
  let po = snap(d);
  for (const f of ['p_go.go', 'p_js.js', 'p_py.py', 'p_rs.rs']) has(po, `diff:src/${f}`);
  hasnt(po, 'src/n_');
  has(po, 'focus.SECURITY.logging=missing');
  // no sensitive log call at all: no signal, no focus
  d = crit(); wr(d, 'src/b.go', 'logger.info("started")\n');
  po = snap(d); hasnt(po, 'signal.log_sensitive'); hasnt(po, 'focus.SECURITY.logging');
  // the call is a context line (exists at base, untouched by the edit): not added, no signal
  d = crit(); wr(d, 'src/b.go', 'logger.info("login", user.Password)\nx := 1\n');
  setBase(d, commitHead(d, 'add b.go'));
  wr(d, 'src/b.go', 'logger.info("login", user.Password)\nx := 2\n');
  po = snap(d); hasnt(po, 'signal.log_sensitive'); hasnt(po, 'focus.SECURITY.logging');
  // control: the same call added by the edit fires
  wr(d, 'src/b.go', 'logger.info("login", user.Password)\nx := 2\nlogger.info("again", user.Password)\n');
  po = snap(d); has(po, 'signal.log_sensitive=source=diff:src/b.go'); has(po, 'focus.SECURITY.logging=missing');
});

test('sc_log_unsupported: the logging focus can not be UNSUPPORTED', () => {
  const d = rrun('COMPLEX', 'src/b.go'); frozen(d); implement(d, 'src/b.go', 'logger.info("login", user.Password)');
  wr(d, R('security/logging/REPORT.md'), '# log\n');
  has(snap(d), 'focus.SECURITY.logging=missing');
  refused(AS(d, 'security_reviewer', ['submit', 'LC', '--focus', 'logging', '--result', 'UNSUPPORTED', '--reason', 'no log tool in the project', '--confidence', 'high', '--artifact', 'security/logging/REPORT.md']),
    'UNSUPPORTED logging focus', 'logging focus always has a tool-free check');
});

test('sc_log_config_check: config-check rejects a bad log_sensitive regex, empty and missing words, and empty words on any signal', () => {
  const d = crit();
  accepted(A(d, ['config-check']), 'config-check of the shipped config');
  const cfg = rd(d, CFG); const cfgLines = cfg.split('\n');
  /** @type {string[]} */ const bad1 = []; let ls = false;
  for (const l of cfgLines) {
    if (l === '  log_sensitive:') ls = true;
    if (ls && l.startsWith('    content: ')) { bad1.push('    content: "("'); ls = false; continue; }
    bad1.push(l);
  }
  assert.notEqual(bad1.join('\n'), cfg, 'fixture did not change the log_sensitive content line');
  refused(A(d, ['config-check', scratch('bad.yaml', bad1.join('\n'))]), 'config-check accepted an invalid log_sensitive content', 'invalid regular expression for risk.log_sensitive.content');
  refused(A(d, ['config-check', scratch('bad.yaml', sed(cfg, /^ {4}words: password.*/, '    words:'))]), 'config-check accepted empty log_sensitive words', 'risk.log_sensitive.words is empty');
  refused(A(d, ['config-check', scratch('bad.yaml', cfgLines.filter((l) => !l.startsWith('    words: password')).join('\n'))]), 'config-check accepted log_sensitive without words', 'risk.log_sensitive.words is missing');
  // generic: empty words on another signal that has content
  /** @type {string[]} */ const bad4 = [];
  for (const l of cfgLines) { if (l === '  log_sensitive:') bad4.push('  other_sig:', '    content: foo', '    words:', '    check: logging'); bad4.push(l); }
  refused(A(d, ['config-check', scratch('bad.yaml', bad4.join('\n'))]), 'config-check accepted empty words on another risk signal', 'risk.other_sig.words is empty');
});

test('sc_log_upgrade_legacy: a run frozen before log_sensitive survives the upgrade without the logging focus; another risk key or a new-rule log_sensitive edit is refused', () => {
  let d = rrun('COMPLEX', '');
  const cfgNew = rd(d, CFG);
  /** @type {string[]} */ const old = []; let skip = false;
  for (const l of cfgNew.split('\n')) {
    if (l.startsWith('  log_sensitive:')) { skip = true; continue; }
    if (skip && l.startsWith('    ')) continue;
    skip = false; old.push(l);
  }
  wr(d, CFG, old.join('\n'));
  assert.ok(!rd(d, CFG).includes('log_sensitive'), 'the old config still has log_sensitive');
  appr(d, 'plan', 'approve the plan'); must(d, ['freeze', 'LC'], { bind: true });
  wr(d, CFG, cfgNew);
  const vf = Af(d, ['verify-freeze', 'LC']); assert.equal(vf.status, 0, `a run frozen before the upgrade fails verify-freeze: ${vf.text}`);
  const hf = A(d, ['handoff', 'LC', 'IMPLEMENTING']); assert.equal(hf.status, 0, `handoff IMPLEMENTING failed after the upgrade: ${hf.text}`);
  wr(d, 'impl.txt', 'logger.info("password " + password)\n');
  const po = snap(d); hasnt(po, 'signal.log_sensitive'); hasnt(po, 'focus.SECURITY.logging');
  // another risk key edited on the legacy-frozen run is still refused
  wr(d, CFG, sed(cfgNew, /^ {2}regression_pct: 10$/, '  regression_pct: 500'));
  assert.notEqual(rd(d, CFG), cfgNew, 'the regression_pct edit did not apply');
  refused(Af(d, ['verify-freeze', 'LC']), 'another risk key edited on a legacy-frozen run', 'freeze mismatch: risk');
  wr(d, CFG, cfgNew);
  // a run frozen under the new config binds log_sensitive: editing it is refused
  d = rrun('COMPLEX', '');
  appr(d, 'plan', 'approve the plan'); must(d, ['freeze', 'LC'], { bind: true }); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  wr(d, CFG, sed(cfgNew, /^ {4}words: password /, '    words: secret password '));
  assert.notEqual(rd(d, CFG), cfgNew, 'the log_sensitive edit did not apply');
  refused(Af(d, ['verify-freeze', 'LC']), 'log_sensitive edited on a run frozen under the new rule', 'freeze mismatch: risk');
  wr(d, CFG, cfgNew); accepted(Af(d, ['verify-freeze', 'LC']), 'verify-freeze after the restore');
});

test('sc_gate_deps: VERIFY is not offered, decided or recorded before QA visual, and runs after it', () => {
  const d = rrun('COMPLEX', 'web/index.html', '\n## UI\n\none status badge\nvisual_writes: DB_PATH=:memory:');
  frozen(d); implement(d, 'web/index.html', '<main></main>');
  for (const g of ['SECRETS', 'REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_TESTS', 'SECURITY']) {
    if (g === 'SECRETS') accepted(A(d, ['secret-scan', 'LC']), 'secret-scan'); else gpass(d, g);
  }
  gpass(d, 'QA');
  has(snap(d), 'gate.VERIFY.needs=QA:visual');
  const nx = A(d, ['next', 'LC']).out;
  assert.ok(nx.includes('dispatch.sh LC qa --focus visual'), `next does not offer QA visual: ${nx}`);
  assert.ok(!nx.includes('dispatch.sh LC verifier'), `next offers VERIFY before QA visual: ${nx}`);
  assert.ok(nx.includes('VERIFY waits for QA:visual'), `next does not say why VERIFY waits: ${nx}`);
  refused(A(d, ['decide', 'LC', 'verifier', '--agent-path']), 'VERIFY decided before QA visual', 'VERIFY needs QA:visual first');
  refused(AS(d, gateOwner('VERIFY'), ['record', 'LC', '--file', resultFor(d, 'VERIFY', 'PASS')]), 'VERIFY recorded before QA visual', 'VERIFY needs QA:visual first');
  let rf = resultFor(d, 'QA', 'PASS', [], { focus: 'visual' }); const rj = path.join(d, R('reviews/visual-proof/report.json'));
  rmSync(rj, { force: true });
  refused(AS(d, 'qa', ['record', 'LC', '--file', rf]), 'a visual PASS without report.json', 'visual PASS needs reviews/visual-proof/report.json');
  wr(d, R('reviews/visual-proof/report.json'), '{"schema":"visual-proof/1","result":"FAIL"}\n');
  refused(AS(d, 'qa', ['record', 'LC', '--file', rf]), 'a visual PASS against a FAIL report.json', 'contradicts reviews/visual-proof/report.json');
  // A200 review: the record reruns the source lint itself; the agent-written lint.json (or none) decides nothing
  wr(d, R('reviews/visual-proof/report.json'), '{"schema":"visual-proof/1","result":"PASS"}\n');
  rmSync(path.join(d, '.agents/skills/visual-proof'), { recursive: true, force: true });   // resultFor installed the fixture's copy; the next resultFor installs it again
  refused(AS(d, 'qa', ['record', 'LC', '--file', rf]), 'a visual PASS with the lint script missing', 'lint-source.mjs is missing');
  wr(d, 'web/lint-bait.html', '<style>.eyebrow{font-family:ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}\n.box{border:1px solid #ccc;padding:12px}\n.panel{border:1px solid #ddd;padding:12px}\n.tile{border:1px solid #ddd;padding:12px}</style>\n');
  rf = resultFor(d, 'QA', 'PASS', [], { focus: 'visual' });   // the files above changed the content fingerprint
  wr(d, R('reviews/visual-proof/lint.json'), '{"findings":[]}\n');   // the QA agent's own lint.json claims nothing is wrong
  refused(AS(d, 'qa', ['record', 'LC', '--file', rf]), "a visual PASS with a blocking source finding the agent's lint.json hides", 'blocking finding');
  rmSync(path.join(d, 'web/lint-bait.html'), { force: true }); rmSync(path.join(d, R('reviews/visual-proof/lint.json')), { force: true });
  rec(d, 'QA', 'PASS', [], { focus: 'visual' });
  wr(d, 'docs/design/a.md', '# design notes\n');   // a knowledge-scope document must not make the dependency look unmet
  accepted(A(d, ['decide', 'LC', 'verifier', '--agent-path']), 'VERIFY is refused after QA visual passed, with a knowledge-scope document present');
  rmSync(path.join(d, 'docs'), { recursive: true, force: true });
  gpass(d, 'VERIFY');
  assert.equal(stOf(d, 'gate.VERIFY'), 'pass', `VERIFY did not record after QA visual: ${stOf(d, 'gate.VERIFY')}`);
});
