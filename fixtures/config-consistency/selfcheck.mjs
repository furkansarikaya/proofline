// Proves the planted facts of the config-consistency fixture built in <dir> against the skill's own scripts
// (skills/proof-review/scripts/check-config.mjs and validate-config.mjs). Offline; runs no project code.
// usage: node selfcheck.mjs <built-dir>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enter, fail, git, gitOut, repoRootOf, run } from '../selfcheck-lib.mjs';

const SCRIPTS = path.join(repoRootOf(import.meta.url), 'skills/proof-review/scripts');
enter();
if (gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'feature/config-drift') fail('HEAD is not feature/config-drift');
if (gitOut(['rev-list', '--count', 'main..feature/config-drift']) !== '1') fail('config-drift must be one commit');
if (gitOut(['rev-list', '--count', 'main..feature/config-clean']) !== '1') fail('config-clean must be one commit');
if (gitOut(['status', '--porcelain']) !== '') fail('working tree not clean');

const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'config-consistency-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const node = (/** @type {string[]} */ args) => run(process.execPath, args);
/** "<check>:<subject>" of the items of one class, sorted, one line. @param {string} json @param {string} cls */
const summary = (json, cls) => JSON.parse(readFileSync(json, 'utf8')).items.filter((/** @type {any} */ i) => i.class === cls).map((/** @type {any} */ i) => `${i.check}:${i.subject}`).sort().join(' ');
/** A script that must exit 0 (the shell ran under `set -e`). @param {string[]} args */
const mustRun = (args) => { const r = node(args); if (r.status !== 0) { process.stderr.write(r.text); process.exit(1); } return r; };

// --- feature/config-drift ---------------------------------------------------------------------------
const drift = path.join(tmp, 'drift.json');
mustRun([path.join(SCRIPTS, 'check-config.mjs'), '--base', 'main', '--plan', '.agents/runs/CC-1/PLAN-drift.md', '--out', drift]);
let want = 'env_undocumented:MAIL_FROM env_undocumented:QUEUE_URL env_undocumented:SMTP_HOST flag_default_on:new_checkout flag_removed_referenced:old_search secret_plaintext:STAGING_KEY secret_plaintext:api_key secret_plaintext:password';
if (summary(drift, 'blocking') !== want) fail(`blocking set differs: ${summary(drift, 'blocking')}`);
want = 'env_documented_unused:OLD_TIMEOUT flag_default_off:beta_banner flag_default_on_planned:dark_mode secret_allowlisted:token';
if (summary(drift, 'note') !== want) fail(`note set differs: ${summary(drift, 'note')}`);
const v = node([path.join(SCRIPTS, 'validate-config.mjs'), drift, '--table']);
if (v.status !== 0) fail('validator rejected the document');
if (!v.out.split('\n').includes('RESULT: FAIL')) fail('expected RESULT: FAIL');
// the secret values are masked everywhere
const driftText = readFileSync(drift, 'utf8');
if (['k3J9xQ2m', 'fakeT0ken', 'Qw8Er3Ty6Ui1'].some((s) => driftText.includes(s))) fail('a secret value leaked into the document');
// traps never reported: pre-existing PORT, ambient NODE_ENV, documented SMTP_PORT, README-only QUEUE_WORKERS, ${DB_PASSWORD}
for (const t of ['PORT', 'NODE_ENV', 'SMTP_PORT', 'QUEUE_WORKERS', 'DB_PASSWORD']) if (driftText.includes(`"subject": "${t}"`)) fail(`trap reported: ${t}`);
// without a plan the unplanned flag is a note, not a finding
const noplan = path.join(tmp, 'noplan.json');
mustRun([path.join(SCRIPTS, 'check-config.mjs'), '--base', 'main', '--out', noplan]);
if (summary(noplan, 'blocking').includes('flag_default_on')) fail('flag default is blocking without a plan');
// a value copied into the document is rejected
const d = JSON.parse(driftText); d.items[0].detail = `token ghp_${'a'.repeat(36)}`;
writeFileSync(path.join(tmp, 'leak.json'), JSON.stringify(d));
if (node([path.join(SCRIPTS, 'validate-config.mjs'), path.join(tmp, 'leak.json')]).status === 0) fail('a leaked secret was accepted');

// --- feature/config-clean ---------------------------------------------------------------------------
git(['checkout', '-q', 'feature/config-clean']);
const clean = path.join(tmp, 'clean.json');
mustRun([path.join(SCRIPTS, 'check-config.mjs'), '--base', 'main', '--plan', '.agents/runs/CC-1/PLAN-clean.md', '--out', clean]);
if (summary(clean, 'blocking') !== '') fail(`config-clean has blocking items: ${summary(clean, 'blocking')}`);
if (!node([path.join(SCRIPTS, 'validate-config.mjs'), clean]).out.split('\n').includes('RESULT: PASS')) fail('expected RESULT: PASS on config-clean');
git(['checkout', '-q', 'feature/config-drift']);
console.log('selfcheck: config-consistency facts ok');
