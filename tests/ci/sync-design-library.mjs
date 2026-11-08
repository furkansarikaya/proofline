// @ts-check
// Design library sync (A170): keeps skills/ui-design/library/ byte-identical to the pinned sources listed in
// skills/ui-design/library/THIRD_PARTY_NOTICES.md. Sources, pins, paths and file names are read from that file.
// Usage: node tests/ci/sync-design-library.mjs                       re-fetch every source at its pin, rewrite copies and notices
//        node tests/ci/sync-design-library.mjs --update <id> <sha>   move one source's pin, then re-fetch it
//        node tests/ci/sync-design-library.mjs --check               fail when a copy, hash or licence text differs from its pin
// DESIGN_LIBRARY_MIRROR=<dir> reads <dir>/<source-id>/<path-in-source> instead of the network (tests).
// Prints failures and one summary line. Exit 0 ok, 1 mismatch or fetch failure, 2 usage error.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

class Fail extends Error { /** @param {string} m @param {number} [code] */ constructor(m, code = 1) { super(m); this.code = code; } }
/** @param {string | Buffer} b */
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The notices file, read as lines. @param {string} text */
function parseNotices(text) {
  const lines = text.split('\n');
  const section = (/** @type {string} */ id) => {
    /** @type {string[]} */ const out = []; let on = false;
    for (const l of lines) { if (l.startsWith('## ')) on = l.split(/\s+/)[1] === id; if (on) out.push(l); }
    return out;
  };
  return {
    ids: lines.flatMap((l) => { const m = /^- (source-[0-9]+) \| /.exec(l); return m ? [m[1]] : []; }),
    /** the value of "- Key: value" inside the section "## id" */
    field: (/** @type {string} */ id, /** @type {string} */ key) => { const p = `- ${key}: `; const l = section(id).find((x) => x.startsWith(p)); return l === undefined ? '' : l.slice(p.length); },
    files: (/** @type {string} */ id) => section(id).flatMap((l) => { const m = /^ {2}- `([^`]+)` sha256 /.exec(l); return m ? [m[1]] : []; }),
    recorded: (/** @type {string} */ id, /** @type {string} */ f) => { const l = section(id).find((x) => x.startsWith(`  - \`${f}\` sha256 `)); return l === undefined ? '' : l.split(/\s+/).at(-1) ?? ''; },
    /** the licence text inside the ```text fence of the section */
    licence: (/** @type {string} */ id) => {
      /** @type {string[]} */ const out = []; let fence = false;
      for (const l of section(id)) { if (!fence) { if (l === '```text') fence = true; continue; } if (l === '```') break; out.push(l); }
      return out.map((l) => `${l}\n`).join('');
    },
  };
}

export const MAX_BYTES = 5 * 1024 * 1024;
const RAW_HOST = 'raw.githubusercontent.com';

/** A source's fields must be what a pinned GitHub source looks like: refuse anything else before a request or a write. @param {ReturnType<typeof parseNotices>} n @param {string} id */
function checkSource(n, id) {
  if (!n.field(id, 'Repository').startsWith('https://github.com/')) throw new Fail(`sync-design-library: ${id}: Repository must start with https://github.com/`);
  if (!/^[0-9a-f]{40}$/.test(n.field(id, 'Commit'))) throw new Fail(`sync-design-library: ${id}: Commit must be 40 hex characters`);
  for (const rel of [n.field(id, 'Path'), n.field(id, 'Licence file'), ...n.files(id)]) {
    if (rel === '' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || rel.includes('\0')) throw new Fail(`sync-design-library: ${id}: unsafe path in the notices: ${rel}`);
  }
}
/** A library file name must stay inside the library folder. @param {string} lib @param {string} f */
function inLibrary(lib, f) {
  const full = path.resolve(lib, f);
  if (path.relative(lib, full).startsWith('..') || path.isAbsolute(path.relative(lib, full))) throw new Fail(`sync-design-library: ${f} resolves outside skills/ui-design/library/`);
  return full;
}

/**
 * One GET with no hidden hops: a redirect is followed at most once and only to https://raw.githubusercontent.com; the body may not exceed MAX_BYTES.
 * @param {string} url @param {typeof fetch} [fetchImpl] @returns {Promise<Buffer | null>}
 */
export async function getLimited(url, fetchImpl = fetch) {
  let res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    let u;
    try { u = new URL(loc ?? '', url); } catch { return null; }
    if (u.protocol !== 'https:' || u.hostname !== RAW_HOST) return null;
    res = await fetchImpl(u.href, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  }
  if (!res.ok || !res.body) return null;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
  /** @type {Buffer[]} */ const chunks = []; let size = 0;
  for await (const c of /** @type {AsyncIterable<Uint8Array>} */ (res.body)) { size += c.length; if (size > MAX_BYTES) return null; chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks);
}

/** @param {{ root: string, mirror?: string, fetchImpl?: typeof fetch }} o @returns {(id: string, p: string, n: ReturnType<typeof parseNotices>) => Promise<Buffer | null>} */
function fetcher({ mirror, fetchImpl }) {
  return async (id, p, n) => {
    if (mirror) {
      try { const f = path.join(mirror, id, p); return statSync(f).size > MAX_BYTES ? null : readFileSync(f); } catch { return null; }
    }
    const raw = n.field(id, 'Repository').replace(/^https:\/\/github\.com\//, `https://${RAW_HOST}/`);
    try { return await getLimited(`${raw}/${n.field(id, 'Commit')}/${p}`, fetchImpl); } catch { return null; }
  };
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, write?: (s: string) => void, fetchFile?: ReturnType<typeof fetcher>, fetchImpl?: typeof fetch }} [o]
 * @returns {Promise<number>}
 */
export async function main(argv, o = {}) {
  const root = o.root ?? path.resolve(import.meta.dirname, '../..');
  const env = o.env ?? process.env;
  const write = o.write ?? ((s) => process.stdout.write(s));
  const lib = path.join(root, 'skills/ui-design/library');
  const noticesFile = path.join(lib, 'THIRD_PARTY_NOTICES.md');
  const fetchFile = o.fetchFile ?? fetcher({ root, mirror: env.DESIGN_LIBRARY_MIRROR, fetchImpl: o.fetchImpl });
  try {
    if (!existsSync(noticesFile)) throw new Fail(`sync-design-library: missing ${noticesFile}`);
    let notices = parseNotices(readFileSync(noticesFile, 'utf8'));
    let mode = 'sync'; let updId = ''; let updSha = '';
    const first = argv[0] ?? '';
    if (first === '') { /* sync */ }
    else if (first === '--check') mode = 'check';
    else if (first === '--update') {
      if (argv.length !== 3) throw new Fail('sync-design-library: usage: --update <source-id> <commit>', 2);
      updId = argv[1]; updSha = argv[2];
      if (!/^[0-9a-f]{40}$/.test(updSha)) throw new Fail('sync-design-library: commit must be a full 40-character sha', 2);
      if (!notices.ids.includes(updId)) throw new Fail(`sync-design-library: unknown source id: ${updId}`, 2);
      mode = 'update';
    } else if (first === '-h' || first === '--help') { write('Design library sync (A170): node tests/ci/sync-design-library.mjs [--check | --update <id> <sha>]\n'); return 0; }
    else throw new Fail(`sync-design-library: unknown argument: ${first}`, 2);
    if (argv.length > 1 && mode !== 'update') throw new Fail('sync-design-library: too many arguments', 2);

    let bad = 0; let total = 0;
    const failLine = (/** @type {string} */ m) => { write(`FAIL ${m}\n`); bad++; };

    if (mode === 'update') {   // move the pin in place; the hashes are rewritten below
      let on = false;
      const text = readFileSync(noticesFile, 'utf8').split('\n').map((l) => { if (l.startsWith('## ')) on = l.split(/\s+/)[1] === updId; return on && l.startsWith('- Commit: ') ? `- Commit: ${updSha}` : l; }).join('\n');
      writeFileSync(noticesFile, text);
      notices = parseNotices(text);
    }
    const ids = notices.ids;
    if (ids.length === 0) throw new Fail(`sync-design-library: no sources listed in ${noticesFile}`);
    for (const id of ids) { checkSource(notices, id); for (const f of notices.files(id)) inLibrary(lib, f); }

    if (mode === 'check') {
      for (const id of ids) {
        const p = notices.field(id, 'Path'); const lf = notices.field(id, 'Licence file');
        const lic = await fetchFile(id, lf, notices);
        if (lic) { if (!Buffer.from(notices.licence(id)).equals(lic)) failLine(`${id}: licence text in the notices differs from the pinned licence file`); }
        else failLine(`${id}: cannot fetch ${lf}`);
        for (const f of notices.files(id)) {
          total++;
          const local = path.join(lib, f);
          if (!existsSync(local)) { failLine(`${id}: ${f} is missing from the library`); continue; }
          const got = await fetchFile(id, `${p}/${f}`, notices);
          if (got) { if (!got.equals(readFileSync(local))) failLine(`${id}: ${f} differs from the pinned source`); }
          else failLine(`${id}: cannot fetch ${p}/${f}`);
          if (sha(readFileSync(local)) !== notices.recorded(id, f)) failLine(`${id}: ${f} hash in the notices is stale`);
        }
      }
      if (bad === 0) { write(`design library: ${total} files byte-identical to their pins\n`); return 0; }
      write(`design library: ${bad} problem(s)\n`);
      return 1;
    }

    // sync / update: fetch everything first, only then touch the library
    /** @type {Map<string, Buffer>} */ const got = new Map();
    for (const id of ids) {
      if (mode !== 'sync' && id !== updId) continue;
      const p = notices.field(id, 'Path'); const lf = notices.field(id, 'Licence file');
      const lic = await fetchFile(id, lf, notices);
      if (!lic) throw new Fail(`sync-design-library: ${id}: cannot fetch ${lf}`);
      got.set(`${id}/LICENSE`, lic);
      for (const f of notices.files(id)) {
        const b = await fetchFile(id, `${p}/${f}`, notices);
        if (!b) throw new Fail(`sync-design-library: ${id}: cannot fetch ${p}/${f}`);
        got.set(`${id}/${f}`, b);
      }
    }
    const old = readFileSync(noticesFile, 'utf8');
    const head = old.split('\n'); const cut = head.findIndex((l) => l.startsWith('## source-'));
    /** @type {Array<string | Buffer>} */ const out = [cut < 0 ? old : `${head.slice(0, cut).join('\n')}\n`];   // everything before the first source section is kept
    let firstSection = true;
    for (const id of ids) {
      if (!firstSection) out.push('\n');
      firstSection = false;
      const fetched = mode === 'sync' || id === updId;
      out.push(`## ${id}\n\n- Repository: ${notices.field(id, 'Repository')}\n- Commit: ${notices.field(id, 'Commit')}\n- Path: ${notices.field(id, 'Path')}\n- Licence file: ${notices.field(id, 'Licence file')}\n- Files:\n`);
      for (const f of notices.files(id)) {
        let h;
        if (fetched) { const b = got.get(`${id}/${f}`); if (!b) throw new Fail('sync-design-library: internal: file not fetched'); writeFileSync(path.join(lib, f), b); total++; h = sha(b); } else h = notices.recorded(id, f);
        out.push(`  - \`${f}\` sha256 ${h}\n`);
      }
      out.push('\n### Licence text\n\n```text\n');
      out.push(fetched ? (got.get(`${id}/LICENSE`) ?? '') : notices.licence(id));
      out.push('```\n');
    }
    writeFileSync(noticesFile, Buffer.concat(out.map((x) => (typeof x === 'string' ? Buffer.from(x) : x))));
    write(`design library: synced ${total} files\n`);
    return 0;
  } catch (e) {
    if (e instanceof Fail) { console.error(e.message); return e.code; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
