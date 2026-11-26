// @ts-check
// A371 attack review: `proofline upgrade --rollback` restores files named by the rows of `.agents/local/upgrade-backup/<old>-to-<new>/UPGRADE.tsv`. That file and the copies beside it are
// plain files a hostile checkout or another process could plant, so every row is validated BEFORE anything is written: the path is a plain relative path of the set an upgrade installs (never
// `..`, never under .agents/runs, .agents/local or .git), no component of it and no component of the backup copy is a symbolic link, the backup copy still has the sha256 recorded when it was
// made, and a file is deleted or replaced only while it still holds what the upgrade wrote. One bad row refuses the whole rollback and nothing is written.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  writeFileSync(`${b}/files/.agents/hooks/lib/evil.mjs`, 'evil\n');
  appendFileSync(tsv, row('replaced', '.agents/hooks/lib/evil.mjs', '-', sha('evil\n')));
  const r = pl(d, ['--rollback']);
  assert.equal(r.status, 1, r.text);
  assert.match(r.err, /symbolic link/);
  assert.equal(existsSync(`${o}/evil.mjs`), false);
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
