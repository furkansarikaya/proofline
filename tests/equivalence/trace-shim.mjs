// @ts-check
// The trace recorder (PROOFLINE_TRACE, ADR 0001 section 6, input 2). It is a PATH shim named `sh`: the test harness puts its directory first on
// PATH, and every `sh <path>/agent.sh ...` call that a self-test makes is recorded before it is passed on to the real shell unchanged.
// It is NOT a seam: nothing under control-plane/, adapters/ or bin/ reads PROOFLINE_TRACE, the call is run with the same argv, stdin, cwd and
// environment (plus PROOFLINE_TRACE_NESTED, which only this file reads), and its exit status is the real one. Nested calls (agent.sh starting
// agent.sh or a sibling through `sh`) are not recorded: only the call the test made.
//
// Per call, under $PROOFLINE_TRACE: calls/<n>.json (argv, cwd, root, seams of the environment, stdin bytes, time, the manifest of the snapshot) and
// objects/<sha256> (the content-addressed snapshot of the project tree before the call, `.git` included).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const args = process.argv.slice(2);
const dir = process.env.PROOFLINE_TRACE;
const isAgentCall = !!dir && !process.env.PROOFLINE_TRACE_NESTED && /(^|\/)agent\.sh$/.test(args[0] ?? '');
const REAL_SH = '/bin/sh';

if (!isAgentCall) {
  const r = spawnSync(REAL_SH, args, { stdio: 'inherit' });
  process.exit(r.status ?? (r.signal ? 128 + 15 : 1));
}

const sha = (/** @type {Buffer|string} */ b) => createHash('sha256').update(b).digest('hex');
let stdin = Buffer.alloc(0);
try { const st = fstatSync(0); if (st.isFIFO() || st.isFile()) stdin = readFileSync(0); } catch { /* no stdin */ }

const cwd = process.cwd();
let root = cwd; for (let d = cwd; ; d = dirname(d)) { if (existsSync(join(d, '.agents'))) { root = d; break; } if (dirname(d) === d) break; }
const objects = join(/** @type {string} */ (dir), 'objects'); mkdirSync(objects, { recursive: true }); mkdirSync(join(/** @type {string} */ (dir), 'calls'), { recursive: true });
/** @type {{ p: string, sha?: string, mode: number, link?: string }[]} */ const manifest = [];
const walk = (/** @type {string} */ rel) => {
  let names; try { names = readdirSync(join(root, rel)).sort(); } catch { return; }
  for (const n of names) {
    const r = rel ? `${rel}/${n}` : n; let st; try { st = lstatSync(join(root, r)); } catch { continue; }
    if (st.isDirectory()) { manifest.push({ p: `${r}/`, mode: st.mode & 0o7777 }); walk(r); }
    else if (st.isSymbolicLink()) manifest.push({ p: r, mode: 0o120000, link: readlinkSync(join(root, r)) });
    else if (st.isFile()) {
      let data; try { data = readFileSync(join(root, r)); } catch { continue; }
      const h = sha(data); const o = join(objects, h); if (!existsSync(o)) writeFileSync(o, data);
      manifest.push({ p: r, sha: h, mode: st.mode & 0o7777 });
    }
  }
};
walk('');
const SEAM = /^(PROOFLINE_|AGENT_ROLE$|STUB_|SELFTEST_|GIT_|LC_ALL$|TMPDIR$|CLAUDE_|QA_NO_BIND$)/;
const seams = Object.fromEntries(Object.entries(process.env).filter(([k]) => SEAM.test(k) && !/^PROOFLINE_TRACE/.test(k)));
const record = { argv: args, cwd, root, cwdRel: relative(root, cwd), seams, stdinBase64: stdin.toString('base64'), time: Date.now(), manifest };
let n = readdirSync(join(/** @type {string} */ (dir), 'calls')).length + 1;
for (;;) { try { const fd = openSync(join(/** @type {string} */ (dir), 'calls', `${String(n).padStart(6, '0')}.json`), 'wx'); closeSync(fd); break; } catch { n++; } }
writeFileSync(join(/** @type {string} */ (dir), 'calls', `${String(n).padStart(6, '0')}.json`), JSON.stringify(record));

const r = spawnSync(REAL_SH, args, { input: stdin, stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, PROOFLINE_TRACE_NESTED: '1' } });
process.exit(r.status ?? 1);
