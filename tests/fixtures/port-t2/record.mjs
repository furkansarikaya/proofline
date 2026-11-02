// @ts-check
// ONE-TIME recorder of the T2 port (temporary, dies with the legacy shell): builds each state with the legacy shell fixtures (control-plane/agents/scripts/
// test-lib.sh helpers) and stores the project as a snapshot (tests/fixtures/port-t2/<name>.json.gz). Usage: node tests/fixtures/port-t2/record.mjs [name...]
// A snapshot holds the project files of the base commit (outside .agents), the working tree files (project files, .agents/runs, .agents/local, a changed
// config.yaml) and the recorded base commit hash. tests/core/port-t2-lib.mjs restores it with the Node core's own control plane.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { GIT_ENV, agentsSrc, dataDir, git, repo } from '../../core/port-t2-lib.mjs';
import { STATES } from '../../core/port-t2-states.mjs';

const scriptsDir = path.join(repo, 'control-plane/agents/scripts');
/** @param {string} p */
function enc(p) {
  const buf = readFileSync(p);
  const mode = lstatSync(p).mode & 0o777;
  const text = buf.toString('latin1');
  return Buffer.from(text, 'latin1').equals(buf) && !buf.includes(0) ? { mode, text } : { mode, b64: buf.toString('base64') };
}
/** @param {string} root @param {string} dir @param {string[]} out */
function walk(root, dir, out) {
  for (const n of readdirSync(path.join(root, dir))) {
    const rel = dir ? `${dir}/${n}` : n;
    if (rel === '.git') continue;
    const st = lstatSync(path.join(root, rel));
    if (st.isDirectory()) walk(root, rel, out); else if (st.isFile()) out.push(rel);
  }
}

const want = process.argv.slice(2);
for (const [name, snippet] of Object.entries(STATES)) {
  if (want.length && !want.includes(name)) continue;
  const out = mkdtempSync(path.join(tmpdir(), 'pl-t2rec-'));
  const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; PROOFLINE_ENGINE=sh; export PROOFLINE_ENGINE; ${snippet}\ncp -R "$PWD/." "$EQ_OUT/"`, path.join(scriptsDir, 'x.sh')],
    { env: { ...GIT_ENV, EQ_LIB: path.join(scriptsDir, 'test-lib.sh'), EQ_OUT: out }, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) { console.error(`state ${name} failed\n${r.stderr}${r.stdout}`); process.exit(1); }
  const y = path.join(out, '.agents/runs/LC/RUN.yaml');
  const baseSha = existsSync(y) ? ((/^ {2}base_sha: "?([0-9a-f]{40})"?/m.exec(readFileSync(y, 'latin1')) ?? [])[1] ?? '') : '';
  const baseRef = baseSha || 'HEAD';
  /** @type {Record<string, any>} */ const base = {};
  for (const rel of git(out, ['ls-tree', '-r', '--name-only', '-z', baseRef]).split('\0').filter(Boolean)) {
    if (rel.startsWith('.agents/')) continue;
    const tmp = path.join(out, '.t2-base-file');
    const b = spawnSync('git', ['-C', out, 'show', `${baseRef}:${rel}`], { env: GIT_ENV, maxBuffer: 1 << 28 });
    writeFileSync(tmp, b.stdout); const mode = Number.parseInt(git(out, ['ls-tree', baseRef, '--', rel]).split(' ')[0], 8) & 0o111 ? 0o755 : 0o644;
    base[rel] = { ...enc(tmp), mode }; rmSync(tmp);
  }
  /** @type {string[]} */ const all = [];
  walk(out, '', all);
  /** @type {Record<string, any>} */ const files = {};
  for (const rel of all) {
    if (rel === '.t2-base-file') continue;
    if (rel.startsWith('.agents/')) {
      const keep = rel.startsWith('.agents/runs/') || rel.startsWith('.agents/local/') || rel === '.agents/.proofline-manifest'
        || (!rel.startsWith('.agents/scripts/') && (!existsSync(path.join(agentsSrc, rel.slice(8))) || !readFileSync(path.join(out, rel)).equals(readFileSync(path.join(agentsSrc, rel.slice(8))))));
      if (!keep) continue;
    }
    files[rel] = enc(path.join(out, rel));
  }
  writeFileSync(path.join(dataDir, `${name}.json.gz`), gzipSync(JSON.stringify({ base, files, baseSha })));
  console.log(name, 'base', Object.keys(base).length, 'files', Object.keys(files).length, 'bytes', gzipSync(JSON.stringify({ base, files, baseSha })).length);
  rmSync(out, { recursive: true, force: true });
}
void chmodSync; void cpSync;
