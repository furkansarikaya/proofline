// @ts-check
// ONE-TIME recorder of build-only states (temporary): `node record-state.mjs NAME 'SHELL SNIPPET'` builds the state with the legacy fixtures and stores it as a
// trace file without calls (tests/fixtures/port-t2/trace/state__NAME.json.gz); tests restore it with stateOf(NAME) of tests/core/port-t2-lib.mjs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { snapshot } from './snap.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptsDir = path.join(repo, 'control-plane/agents/scripts');
const [name, snippet] = process.argv.slice(2);
const out = mkdtempSync(path.join(tmpdir(), 'pl-t2st-'));
const env = { PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1', EQ_LIB: path.join(scriptsDir, 'test-lib.sh'), EQ_OUT: out, TMPDIR: process.env.TMPDIR ?? tmpdir() };
const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; PROOFLINE_ENGINE=sh; export PROOFLINE_ENGINE; ${snippet}\ncp -R "$PWD/." "$EQ_OUT/"`, path.join(scriptsDir, 'x.sh')], { env, encoding: 'utf8', timeout: 900000 });
if (r.status !== 0) { console.error(`state ${name} failed\n${r.stderr}${r.stdout}`); process.exit(1); }
/** @type {Record<string, any>} */ const blobs = {};
const { key, state } = snapshot(out, blobs);
writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'trace', `state__${name}.json.gz`), gzipSync(JSON.stringify({ blobs, states: { [key]: state }, calls: [] })));
console.log(name, 'recorded');
rmSync(out, { recursive: true, force: true });
