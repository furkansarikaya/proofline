// @ts-check
// A371 attack review: `proofline upgrade --rollback` restores files named by the rows of `.agents/local/upgrade-backup/<old>-to-<new>/UPGRADE.tsv`. That file and the copies beside it are
// plain files a hostile checkout or another process could plant, so every row is validated BEFORE anything is written: the path is a plain relative path of the set an upgrade installs (never
// `..`, never under .agents/runs, .agents/local or .git), no component of it and no component of the backup copy is a symbolic link, the backup copy still has the sha256 recorded when it was
// made, and a file is deleted or replaced only while it still holds what the upgrade wrote. One bad row refuses the whole rollback and nothing is written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { sandbox, upstream } from './frontend-lib.mjs';

const sb = sandbox();
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const sha = (/** @type {string | Buffer} */ s) => createHash('sha256').update(s).digest('hex');
const home = upstream(sb.T, (h) => {
  appendFileSync(`${h}/control-plane/agents/GATES.md`, 'rollback attack release\n');
  writeFileSync(`${h}/control-plane/agents/NEW-ROLLBACK.md`, 'new\n');
  const f = `${h}/control-plane/agents/scripts/core/proflinecli.mjs`;
  writeFileSync(f, read(f).replace(/PROOFLINE_VERSION = '[^']*'/, "PROOFLINE_VERSION = '0.0.951'"));
});
const pl = (/** @type {string} */ d, /** @type {string[]} */ args) => sb.pl(d, ['upgrade', ...args], {}, `${home}/bin/proofline`);

/** A project that was upgraded once; returns it with the backup folder and a snapshot of the files a rollback would touch. @param {string} name */
function upgraded(name) {
  const d = sb.copy(name);
  const r = pl(d, []);
  assert.equal(r.status, 0, r.text);
  const bd = `${d}/.agents/local/upgrade-backup`;
  const b = `${bd}/${readdirSync(bd)[0]}`;
  return { d, b, tsv: `${b}/UPGRADE.tsv`, gates: read(`${d}/.agents/GATES.md`) };
}
const outside = (/** @type {string} */ n) => { const f = `${sb.T}/outside-${n}`; mkdirSync(f, { recursive: true }); writeFileSync(`${f}/victim.txt`, 'victim\n'); return f; };
const row = (/** @type {string} */ k, /** @type {string} */ rel, /** @type {string} */ after, /** @type {string} */ before = '-') => `${k}\t${rel}\t${after}\t${before}\n`;

test('a row that leaves the project (..) is refused and the file outside is not touched', () => {
  const { d, b, tsv, gates } = upgraded('r1');
  const o = outside('r1');
  const rel = `../outside-r1/victim.txt`;
  mkdirSync(`${b}/outside-r1`, { recursive: true });
  writeFileSync(`${b}/outside-r1/victim.txt`, 'planted\n');
  appendFileSync(tsv, row('replaced', rel, sha('victim\n'), sha('planted\n')));
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /not a path this upgrade installed: \.\.\/outside-r1\/victim\.txt; nothing was restored/);
  assert.equal(read(`${o}/victim.txt`), 'victim\n');
  assert.equal(read(`${d}/.agents/GATES.md`), gates, 'nothing restored');
});

test('a row under .agents/runs, .agents/local or .git, or outside the install set, is refused: the ledger of a run is not restorable', () => {
  for (const rel of ['.agents/runs/LC/LEDGER.log', '.agents/local/ACTIVE_RUN', '.git/config', 'README.md', 'src/app.js']) {
    const { d, b, tsv, gates } = upgraded(`r2-${rel.replace(/\W/g, '')}`);
    mkdirSync(`${d}/.agents/runs/LC`, { recursive: true });
    writeFileSync(`${d}/.agents/runs/LC/LEDGER.log`, 'seq=1 sealed\n');
    writeFileSync(`${d}/src-app.txt`, 'x');
    mkdirSync(`${b}/files/${rel.slice(0, Math.max(0, rel.lastIndexOf('/')))}`, { recursive: true });
    writeFileSync(`${b}/files/${rel}`, 'forged\n');
    appendFileSync(tsv, row('replaced', rel, '-', sha('forged\n')));
    const r = pl(d, ['--rollback']);
    assert.equal(r.status, 1, `${rel}: ${r.text}`);
    assert.match(r.err, /not a path this upgrade installed/);
    assert.equal(read(`${d}/.agents/runs/LC/LEDGER.log`), 'seq=1 sealed\n');
    assert.equal(read(`${d}/.agents/GATES.md`), gates);
  }
});

test('a backup copy that is a symbolic link is refused (the link would be followed to a secret)', () => {
  const { d, b, gates } = upgraded('r3');
  const o = outside('r3');
  rmSync(`${b}/files/.agents/GATES.md`);
  symlinkSync(`${o}/victim.txt`, `${b}/files/.agents/GATES.md`);
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /backup copy .*GATES\.md is not a plain file/);
  assert.equal(read(`${d}/.agents/GATES.md`), gates);
});

test('a backup copy whose content changed since the backup is refused (its sha256 was recorded)', () => {
  const { d, b, gates } = upgraded('r4');
  appendFileSync(`${b}/files/.agents/GATES.md`, 'tampered\n');
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /backup copy .*GATES\.md does not match the sha256 recorded when it was made/);
  assert.equal(read(`${d}/.agents/GATES.md`), gates);
});

test('a symbolic link among the parents of the destination is refused', () => {
  const { d, b, tsv } = upgraded('r5');
  const o = outside('r5');
  rmSync(`${d}/.agents/hooks/lib`, { recursive: true, force: true });
  symlinkSync(o, `${d}/.agents/hooks/lib`);
  mkdirSync(`${b}/files/.agents/hooks/lib`, { recursive: true });
  writeFileSync(`${b}/files/.agents/hooks/lib/text.mjs`, 'evil\n');
  appendFileSync(tsv, row('replaced', '.agents/hooks/lib/text.mjs', '-', sha('evil\n')));
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /symbolic link/);
  assert.equal(existsSync(`${o}/text.mjs`), false);
});

test('a new row deletes a file only while it still holds what the upgrade wrote; a row without that sha is refused', () => {
  const { d, tsv } = upgraded('r6');
  const f = '.agents/NEW-ROLLBACK.md';
  assert.ok(existsSync(`${d}/${f}`));
  appendFileSync(`${d}/${f}`, 'my edit\n');
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /kept \(changed since the upgrade\): \.agents\/NEW-ROLLBACK\.md/);
  assert.ok(existsSync(`${d}/${f}`));
  const e = upgraded('r6b');
  appendFileSync(e.tsv, row('new', '.agents/GATES.md', '-'));
  const r2 = pl(e.d, ['--rollback']);
  assert.equal(r2.status, 1, r2.text);
  assert.match(r2.err, /not a path this upgrade installed|no recorded sha256/);
  assert.equal(read(`${e.d}/.agents/GATES.md`), e.gates);
  assert.ok(tsv.length > 0);
});

test('the restore writes through an exclusive random temporary name: a planted link at the old fixed name is never followed', () => {
  const { d } = upgraded('r7');
  const o = outside('r7');
  symlinkSync(`${o}/victim.txt`, `${d}/.agents/GATES.md.proofline-restore`);
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 0, r.text);
  assert.equal(read(`${o}/victim.txt`), 'victim\n');
  assert.ok(!read(`${d}/.agents/GATES.md`).includes('rollback attack release'));
  assert.equal(lstatSync(`${d}/.agents/GATES.md.proofline-restore`).isSymbolicLink(), true, 'the planted link is left alone');
});

test('with local_state: off a rollback is refused (the upgrade made no backup and takes no lock)', () => {
  const d = sb.copy('r8');
  writeFileSync(`${d}/.agents/config.yaml`, read(`${d}/.agents/config.yaml`).replace(/^local_state: on$/m, 'local_state: off'));
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /local_state is off: nothing was backed up, so there is nothing to restore/);
  assert.equal(existsSync(`${d}/.agents/local/locks`), false);
});

// ---- second attack review ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('F1: the manifest copy inside the backup authorises nothing: a path it lists (and a matching row and hash) outside the current install set is refused', () => {
  const { d, b, tsv, gates } = upgraded('f1');
  writeFileSync(`${d}/package.json`, '{"name":"mine"}\n');
  appendFileSync(`${b}/files/.agents/.proofline-manifest`, `${sha('x')}  package.json\n`);
  const mf = `${b}/files/.agents/.proofline-manifest`;
  writeFileSync(tsv, read(tsv).split('\n').map((l) => (l.startsWith('replaced\t.agents/.proofline-manifest\t') ? l.split('\t').slice(0, 3).concat(sha(readFileSync(mf))).join('\t') : l)).join('\n'));
  writeFileSync(`${b}/files/package.json`, 'planted\n');
  appendFileSync(tsv, row('replaced', 'package.json', sha(readFileSync(`${d}/package.json`)), sha('planted\n')));
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /not a path this upgrade installed: package\.json; nothing was restored/);
  assert.equal(read(`${d}/package.json`), '{"name":"mine"}\n');
  assert.equal(read(`${d}/.agents/GATES.md`), gates);
});

test('F1: a hook file is restorable only when this plugin ships it; a planted hook path is refused, a hook file this version dropped is listed and not restored', () => {
  const { d, b, tsv } = upgraded('f1b');
  mkdirSync(`${b}/files/.agents/hooks/lib`, { recursive: true });
  writeFileSync(`${b}/files/.agents/hooks/lib/evil.mjs`, 'evil\n');
  appendFileSync(tsv, row('replaced', '.agents/hooks/lib/evil.mjs', '-', sha('evil\n')));
  let r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /not a path this upgrade installed: \.agents\/hooks\/lib\/evil\.mjs/);
  assert.equal(existsSync(`${d}/.agents/hooks/lib/evil.mjs`), false);
  const e = upgraded('f1c');
  mkdirSync(`${e.b}/files/.agents/hooks/lib`, { recursive: true });
  writeFileSync(`${e.b}/files/.agents/hooks/lib/gone.mjs`, 'old\n');
  appendFileSync(e.tsv, row('removed', '.agents/hooks/lib/gone.mjs', '-', sha('old\n')));
  r = pl(e.d, ['--rollback']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /not restored \(a hook file this version does not ship; not vouched for\): \.agents\/hooks\/lib\/gone\.mjs/);
  assert.equal(existsSync(`${e.d}/.agents/hooks/lib/gone.mjs`), false);
});

test('F2: case variants, a normalisation variant and a name that resolves into the runs, the local state or .git are refused; the sealed ledger is never restored over', () => {
  for (const [i, rel] of ['.AGENTS/RUNS/LC/LEDGER.log', '.agents/Runs/LC/LEDGER.log', '.Agents/Local/ACTIVE_RUN', '.GIT/config', '.agents/local/é.txt', '.agents/RUNS/../runs/LC/LEDGER.log'].entries()) {
    const { d, b, tsv, gates } = upgraded(`f2-${i}`);
    mkdirSync(`${d}/.agents/runs/LC`, { recursive: true });
    writeFileSync(`${d}/.agents/runs/LC/LEDGER.log`, 'seq=1 sealed\n');
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    if (!dir.includes('..')) { mkdirSync(`${b}/files/${dir}`, { recursive: true }); writeFileSync(`${b}/files/${rel}`, 'forged\n'); }
    appendFileSync(tsv, row('replaced', rel, '-', sha('forged\n')));
    const r = pl(d, ['--rollback']);
    assert.equal(r.status, 1, `${rel}: ${r.text}`);
    assert.match(r.err, /not a path this upgrade installed|resolves into/);
    assert.equal(read(`${d}/.agents/runs/LC/LEDGER.log`), 'seq=1 sealed\n');
    assert.equal(read(`${d}/.agents/GATES.md`), gates);
  }
});

test('F4: a directory at a destination refuses the whole rollback before anything is written', () => {
  const { d } = upgraded('f4');
  rmSync(`${d}/.agents/GATES.md`);
  mkdirSync(`${d}/.agents/GATES.md`);
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /\.agents\/GATES\.md is not a regular file; nothing was restored/);
  assert.ok(existsSync(`${d}/.agents/NEW-ROLLBACK.md`), 'the new file was not removed');
});

test('F4: a failure half way is reported and marked in UPGRADE.tsv, not silent', { skip: process.platform === 'win32' || (process.getuid?.() === 0) }, () => {
  const { d, tsv } = upgraded('f4b');
  const dir = `${d}/.agents`;
  chmodSync(dir, 0o500);
  try {
    const r = pl(d, ['--rollback']);
    assert.equal(r.status, 1, r.text);
    assert.match(r.err, /the rollback stopped after \d+ file\(s\) restored/);
    assert.match(read(tsv), /^rollback_failed=/m);
    assert.doesNotMatch(read(tsv), /^rolled_back=yes$/m);
  } finally { chmodSync(dir, 0o755); }
});
