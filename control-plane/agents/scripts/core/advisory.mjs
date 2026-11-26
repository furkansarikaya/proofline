// @ts-check
// `agent.sh advisory-check <ID>` (A373, issue 338 C10): the one counted request that asks the registry's advisory service about the lock file of a run whose diff touches dependencies, made by
// the CONTROL PLANE, never by a role (the SECURITY role stays network-blocked and READS the record this writes, ADVISORY_CHECK.json in the run).
//
// Off unless the user turned it on: `security.advisory_check: on` (hand edit of .agents/config.yaml; a non-empty `security.*` value is bound by the freeze), because the request sends the
// package names and versions of the lock file to the registry. NO npm and no project file runs or is read but the lock: the root lock (a regular file up to 16 MiB) is parsed as JSON, the
// `packages` map gives `node_modules/<name>` entries (name from the path, `version`), each checked against a strict grammar, and ONE bulk request per batch of at most 500 names goes to the FIXED
// https url of the control plane's OWN ecosystems.json (`advisory.url`: never the project's copy, `.npmrc`, environment or a lock `resolved` field). The request carries only names and versions,
// a JSON content type and a generic user agent; a redirect is a failure, TLS verification is the default, a proxy is not used (a proxy-only network fails closed). The answer is read with bounds
// and reduced to ids, package names, severities and a few bounded strings; the record never holds the raw answer. The HTTP function is a seam (`io.http`): tests inject a fake.
// The record is bound to the control plane by a row of the run's ledger (event `advisory-check`, detail `record=<sha256 of the record> lock=<sha256 of the lock> status=<status>`): a role
// cannot write the record (path guard) nor the ledger, and `validate-dependencies.mjs --advisory --ledger` treats a record without a matching row as not run. The attempt count is the
// number of rows, not a field of the record. Once per lock content: a measured record whose row holds is reused; a failed request set may be repeated up to MAX_ATTEMPTS times in all for one lock
// content and MAX_SETS times in one run. The reviewer decides exploitability; the record is evidence, and a high or critical advisory on a dependency the diff added or changed is made a finding by
// the dependencies validator.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { requireLead } from './approve.mjs';
import { ecosystemRowsOwn } from './ecodata.mjs';
import { fail } from './errors.mjs';
import { sha256, sha256File } from './hash.mjs';
import { led, need } from './lifeutil.mjs';
import * as proc from './proc.mjs';
import { requireRun, runDir } from './runs.mjs';
import { asciiLower } from './shellglob.mjs';
import { taskChangedPaths } from './signals.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ id: string, package: string, severity: string, affects: string[], title: string, url: string, vulnerable_versions: string }} Advisory */
/** @typedef {{ url: string, body: string, timeoutMs: number, maxBytes: number }} HttpRequest */
/** @typedef {{ status: number, body: Buffer | string } | { error: 'timeout' | 'redirect' | 'network' | 'too_large' | 'scheme' | 'unsupported' }} HttpResult */

export const RECORD_NAME = 'ADVISORY_CHECK.json';
export const MAX_ATTEMPTS = 3;
export const MAX_SETS = 6;
export const MAX_PACKAGES = 5000;
export const BATCH = 500;
export const MAX_REQUESTS = 10;
export const MAX_BODY = 2 * 1024 * 1024;
export const MAX_RESPONSE = 8 * 1024 * 1024;
export const MAX_LOCK = 16 * 1024 * 1024;
export const TIMEOUT_MS = 30000;
const MAX_VERSIONS = 20000;
const MAX_ADVISORIES = 200;
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info', 'unknown'];
const ID_OK = /^[A-Za-z0-9._:-]{1,64}$/;
/** The npm package-name grammar the request is built from: URL-safe characters (legacy names with capitals, dots and tildes included), optional `@scope/`, no other slash, no leading dot or underscore, at most 214 characters. */
const NAME_OK = /^(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const VERSION_OK = /^(?:0|[1-9][0-9]{0,15})\.(?:0|[1-9][0-9]{0,15})\.(?:0|[1-9][0-9]{0,15})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+){0,15})?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+){0,15})?$/;
const URL_OK = /^https:\/\/[A-Za-z0-9._~/?#&=%:+@-]{1,200}$/;
/** @param {string} n */
const nameOk = (n) => n.length <= 214 && NAME_OK.test(n);
/** A `resolved` of a registry tarball has the layout `<host>/<name>/-/<file>.tgz`; a git, file, http or other spec is not a registry package. @param {string} r */
const registryResolved = (r) => /^https:\/\/[^\s/]+\/[^\s]*\/-\/[^\s/]+\.tgz(?:#[0-9a-f]{0,64})?$/.test(r);
/** @param {string} v */
const versionOk = (v) => v.length <= 64 && VERSION_OK.test(v);

/** `security.advisory_check` is `off` unless the user set `on`; anything else is off (fail closed). @param {Context} ctx */
export function advisoryEnabled(ctx) { return asciiLower(ctx.config().get('security.advisory_check', 'off').trim()) === 'on'; }

/** @param {Context} ctx @param {string} id */
export const recordFile = (ctx, id) => `${runDir(ctx, id)}/${RECORD_NAME}`;

/**
 * The advisory definition of every ecosystem of the control plane's OWN ecosystems.json that has one.
 * @param {Context} ctx
 * @returns {Array<{ eco: string, kind: string, url: string, locks: string[], watch: string[] }>}
 */
export function advisoryDefs(ctx) {
  const rows = ecosystemRowsOwn(ctx) ?? [];
  const ids = [...new Set(rows.filter((r) => r[1].startsWith('advisory.')).map((r) => r[0]))];
  return ids.map((eco) => {
    const mine = rows.filter((r) => r[0] === eco && r[1].startsWith('advisory.'));
    /** @param {string} p */ const list = (p) => mine.filter((r) => r[1] === `advisory.${p}`).map((r) => r[2]);
    return { eco, kind: list('kind')[0] ?? '', url: list('url')[0] ?? '', locks: list('locks'), watch: list('watch') };
  });
}

/** @param {Record<string, unknown>} o @param {string} k @returns {number} */
const num = (o, k) => (typeof o[k] === 'number' ? /** @type {number} */ (o[k]) : 0);

/**
 * The packages of an npm lock, for the request: `{ packages: Map<name, string[] versions>, skipped, reasons, total, versions }` or an error. Only the `packages` map is read, and of an entry only its
 * `name` (the real package when the entry is an alias, else the part of the path after its last `node_modules/`), `version`, `link` and `resolved`: a link, an entry whose `resolved` is not a registry
 * tarball (git, file, http), an entry without a version, a name or version that fails the grammar, or a path outside `node_modules/` is skipped and counted with its reason, so a hostile entry can only be
 * skipped; `total` is every entry but the root, so a record can say how much was not checked.
 * @param {Buffer | string} lock @returns {{ packages: Map<string, string[]>, skipped: number, reasons: Record<string, number>, total: number, versions: number } | { error: string, kind: string }}
 */
export function lockPackages(lock) {
  let doc;
  try { doc = JSON.parse(typeof lock === 'string' ? lock : lock.toString('utf8')); } catch { return { error: 'the lock file is not valid JSON', kind: 'lock_unreadable' }; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'the lock file is not a JSON object', kind: 'lock_unreadable' };
  const pk = doc.packages;
  if (pk === null || typeof pk !== 'object' || Array.isArray(pk)) return { error: 'the lock file has no `packages` map (lockfileVersion 1 is not supported: regenerate it with a current npm)', kind: 'lock_unsupported' };
  /** @type {Map<string, Set<string>>} */ const byName = new Map();
  /** @type {Record<string, number>} */ const reasons = Object.create(null);
  let skipped = 0; let total = 0;
  /** @param {string} why */
  const skip = (why) => { skipped++; reasons[why] = (reasons[why] ?? 0) + 1; };
  for (const key of Object.keys(pk)) {
    if (key === '') continue; // the root project itself
    total++;
    const e = pk[key];
    const at = key.lastIndexOf('node_modules/');
    const pathName = at === 0 || (at > 0 && key[at - 1] === '/') ? key.slice(at + 'node_modules/'.length) : '';
    if (pathName === '') { skip('outside-node_modules'); continue; }
    if (e === null || typeof e !== 'object' || Array.isArray(e)) { skip('invalid'); continue; }
    if (e.link === true || (e.resolved !== undefined && (typeof e.resolved !== 'string' || !registryResolved(e.resolved)))) { skip('non-registry'); continue; }
    if (typeof e.version !== 'string') { skip('no-version'); continue; }
    const name = e.name !== undefined ? e.name : pathName;
    if (typeof name !== 'string' || !nameOk(name) || !versionOk(e.version)) { skip('invalid'); continue; }
    const set = byName.get(name) ?? new Set();
    set.add(e.version);
    byName.set(name, set);
  }
  /** @type {Map<string, string[]>} */ const packages = new Map();
  let versions = 0;
  for (const name of [...byName.keys()].sort()) { const v = [...(byName.get(name) ?? [])].sort(); packages.set(name, v); versions += v.length; }
  return { packages, skipped, reasons, total, versions };
}

/** Whether the skipped entries are too many for the record to say `measured`: more than 5 percent of the entries or more than 25. @param {number} skipped @param {number} total */
export const tooManySkipped = (skipped, total) => skipped > 25 || skipped * 20 > total;

/**
 * The request bodies (JSON text, name -> versions) of at most BATCH names each, or a refusal when the lock is larger than the bounds.
 * @param {Map<string, string[]>} packages @param {number} versions @returns {{ bodies: string[] } | { error: string }}
 */
export function buildBatches(packages, versions) {
  if (packages.size > MAX_PACKAGES || versions > MAX_VERSIONS) return { error: `the lock file lists more than ${MAX_PACKAGES} packages (or ${MAX_VERSIONS} versions): too large for one counted request set, audit by hand` };
  const names = [...packages.keys()];
  /** @type {string[]} */ const bodies = [];
  for (let i = 0; i < names.length; i += BATCH) {
    /** @type {Record<string, string[]>} */ const o = Object.create(null);
    for (const n of names.slice(i, i + BATCH)) o[n] = /** @type {string[]} */ (packages.get(n));
    const body = JSON.stringify(o);
    if (body.length > MAX_BODY) return { error: 'a request body would be larger than 2 MiB: too large, audit by hand' };
    bodies.push(body);
  }
  if (bodies.length > MAX_REQUESTS) return { error: `the lock file needs more than ${MAX_REQUESTS} requests: too large, audit by hand` };
  return { bodies };
}

/** @param {string} s @param {number} n */
const line = (s, n) => s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The advisories of one answer of the bulk endpoint: `{ "<name>": [ { id, url, title, severity, vulnerable_versions, ... } ] }`. Only the names that were asked for are read; every string is reduced to a
 * safe shape (an unknown severity is `unknown`, a url off the two allowed hosts is dropped, a title is one bounded line); every other field (cwe, cvss, anything else) is ignored. At most MAX_ADVISORIES.
 * @param {unknown} doc @param {Set<string>} asked @returns {{ advisories: Advisory[], truncated: boolean } | { error: string }}
 */
export function parseNpmBulk(doc, asked) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'the answer is not a JSON object' };
  const d = /** @type {Record<string, unknown>} */ (doc);
  /** @type {Map<string, Advisory>} */ const found = new Map();
  let truncated = false;
  for (const pkg of Object.keys(d)) {
    if (pkg === '__proto__' || !asked.has(pkg)) continue;
    const list = d[pkg];
    if (!Array.isArray(list)) continue;
    for (const a of list.slice(0, 200)) {
      if (a === null || typeof a !== 'object' || Array.isArray(a)) continue;
      const o = /** @type {Record<string, unknown>} */ (a);
      const url = typeof o.url === 'string' && (o.url.startsWith('https://github.com/advisories/') || o.url.startsWith('https://nvd.nist.gov/')) && URL_OK.test(o.url) ? o.url : '';
      const ghsa = /\/(GHSA-[a-z0-9-]{4,40}|CVE-[0-9]{4}-[0-9]{3,10})$/i.exec(url);
      const id = ghsa ? ghsa[1] : (typeof o.id === 'number' && Number.isSafeInteger(o.id) && o.id >= 0 ? `npm:${o.id}` : (typeof o.id === 'string' && ID_OK.test(o.id) ? o.id : ''));
      if (id === '') continue;
      const sev = typeof o.severity === 'string' ? asciiLower(o.severity) : '';
      const key = `${pkg} ${id}`;
      if (found.has(key)) continue;
      if (found.size >= MAX_ADVISORIES * 10) { truncated = true; continue; }
      found.set(key, { id, package: pkg, severity: SEVERITIES.includes(sev) && sev !== 'unknown' ? sev : 'unknown', affects: [pkg], title: typeof o.title === 'string' ? line(o.title, 200) : '', url, vulnerable_versions: typeof o.vulnerable_versions === 'string' ? line(o.vulnerable_versions, 100) : '' });
    }
  }
  const order = (/** @type {string} */ s) => SEVERITIES.indexOf(s);
  return { advisories: [...found.values()].sort((x, y) => order(x.severity) - order(y.severity) || (x.package + x.id < y.package + y.id ? -1 : 1)), truncated };
}

/** The parsers by request kind (data names the kind; the code that is shaped like an ecosystem is only here). @type {Record<string, (doc: unknown, asked: Set<string>) => ReturnType<typeof parseNpmBulk>>} */
const KINDS = { 'npm-bulk': parseNpmBulk };

/**
 * The child that makes ONE request (the core is synchronous; Node's `fetch` is not): a fixed program text, started with an EMPTY environment (no proxy, no certificate or option variable of the
 * user's shell, nothing of the project) from the temp folder. It reads `{url, body, timeoutMs, maxBytes}` on stdin, makes a POST with fetch (https only, `redirect: 'error'`, a content type and the generic
 * user agent, no cookie or credential, default TLS verification) and prints `STATUS <n>` or `ERROR <kind>` on one line, then the answer bytes (read with a bound).
 */
const HTTP_CHILD = `
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const done = (head, body) => process.stdout.write(Buffer.concat([Buffer.from(head + '\\n'), body || Buffer.alloc(0)]), () => process.exit(0));
  try {
    const q = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const u = new URL(q.url);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return done('ERROR scheme');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), q.timeoutMs);
    try {
      const res = await fetch(u, { method: 'POST', redirect: 'error', signal: ac.signal, headers: { 'content-type': 'application/json', 'user-agent': 'proofline-advisory-check' }, body: q.body });
      const reader = res.body.getReader();
      const parts = [];
      let size = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        size += value.length;
        if (size > q.maxBytes) { ac.abort(); return done('ERROR too_large'); }
        parts.push(Buffer.from(value));
      }
      clearTimeout(timer);
      return done('STATUS ' + res.status, Buffer.concat(parts));
    } catch (e) {
      const text = String((e && e.cause && e.cause.message) || (e && e.message) || '');
      if (ac.signal.aborted) return done('ERROR timeout');
      return done(/redirect/i.test(text) ? 'ERROR redirect' : 'ERROR network');
    }
  } catch { return done('ERROR network'); }
});
`;

/**
 * The default HTTP function: one POST by the child above. Synchronous (the core is). Never used by a test (they inject `io.http`).
 * @param {HttpRequest} req @returns {HttpResult}
 */
export function httpPost(req) {
  if (process.platform === 'win32') return { error: 'unsupported' };
  const env = /** @type {NodeJS.ProcessEnv} */ ({});
  const r = proc.run(process.execPath, ['--no-warnings', '-e', HTTP_CHILD], { cwd: tmpdir(), env, input: JSON.stringify(req), stdio: 'pipe', timeoutMs: req.timeoutMs + 10000, maxBuffer: req.maxBytes + 4096, killSignal: 'SIGKILL' });
  if (!r.started || r.timedOut === true) return { error: 'timeout' };
  const nl = r.stdout.indexOf(0x0a);
  if (r.status !== 0 || nl < 0) return { error: r.stdout.length >= req.maxBytes ? 'too_large' : 'network' };
  const head = r.stdout.subarray(0, nl).toString('latin1');
  const st = /^STATUS ([0-9]{3})$/.exec(head);
  if (st) return { status: Number(st[1]), body: r.stdout.subarray(nl + 1) };
  const er = /^ERROR (timeout|redirect|network|too_large|scheme)$/.exec(head);
  return { error: /** @type {'timeout' | 'redirect' | 'network' | 'too_large' | 'scheme'} */ (er ? er[1] : 'network') };
}

/** @param {Advisory[]} list */
function countsOf(list) {
  /** @type {Record<string, number>} */ const c = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, unknown: 0 };
  for (const a of list) c[a.severity] = (c[a.severity] ?? 0) + 1;
  return c;
}

/** The lock file as bytes without following a link, or an error; a regular file up to MAX_LOCK. @param {string} file @returns {{ bytes: Buffer } | { error: string }} */
function readLock(file) {
  let fd = -1;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: 'is not a regular file' };
    if (st.size > MAX_LOCK) return { error: 'is larger than 16 MiB' };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) { const n = readSync(fd, buf, got, st.size - got, got); if (n <= 0) break; got += n; }
    return { bytes: buf.subarray(0, got) };
  } catch { return { error: 'cannot be read' }; } finally { if (fd >= 0) closeSync(fd); }
}

/** The record this run holds, or null. @param {string} file @returns {Record<string, any> | null} */
export function readRecord(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    const o = JSON.parse(readFileSync(file, 'utf8'));
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

/** The lock file the run's definition would audit (its sha), or ''. @param {Context} ctx */
function currentLockSha(ctx) {
  for (const def of advisoryDefs(ctx)) {
    for (const l of def.locks) {
      try { if (lstatSync(`${ctx.root}/${l}`).isFile()) return sha256File(`${ctx.root}/${l}`); } catch { /* next */ }
    }
  }
  return '';
}

/**
 * Whether `next` should offer `advisory-check` now: the user turned it on, and no record holds for the current lock file.
 * @param {Context} ctx @param {string} id
 */
export function advisoryDue(ctx, id) {
  if (!advisoryEnabled(ctx)) return false;
  const rec = readRecord(recordFile(ctx, id));
  return rec === null || !recordBound(ctx, id) || rec.lock_sha256 !== currentLockSha(ctx) || (rec.status === 'not_run' && rec.reason_kind === 'disabled');
}

/**
 * The rows `advisory-check` wrote into the run's ledger: record sha, lock sha, status. Read from the file as it is (a role cannot write it).
 * @param {Context} ctx @param {string} id @returns {Array<{ record: string, lock: string, status: string }>}
 */
export function advisoryRows(ctx, id) {
  let text = '';
  try { text = readFileSync(`${runDir(ctx, id)}/LEDGER.log`, 'latin1'); } catch { return []; }
  /** @type {Array<{ record: string, lock: string, status: string }>} */ const rows = [];
  for (const line of text.split('\n')) {
    if (!/ event=advisory-check /.test(line)) continue;
    const m = / detail=record=([0-9a-f]{64}) lock=([0-9a-f]{64}|-) status=([a-z_]{1,20})\s*$/.exec(line);
    if (m) rows.push({ record: m[1], lock: m[2], status: m[3] });
  }
  return rows;
}

/** The record is the one a row of the ledger names. @param {Context} ctx @param {string} id */
function recordBound(ctx, id) {
  const sha = sha256File(recordFile(ctx, id));
  return sha !== '' && advisoryRows(ctx, id).some((r) => r.record === sha);
}

/** Write the record and its ledger row. @param {Context} ctx @param {string} id @param {Record<string, unknown>} rec */
function writeRecord(ctx, id, rec) {
  const file = recordFile(ctx, id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 1)}\n`);
  renameSync(tmp, file);
  const lock = typeof rec.lock_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rec.lock_sha256) ? rec.lock_sha256 : '-';
  led(ctx, id, 'advisory-check', '-', '-', `record=${sha256File(file)} lock=${lock} status=${String(rec.status)}`);
}

/** One line for the lead. @param {Record<string, any>} r */
function summary(r) {
  if (r.status === 'measured' || r.status === 'partial') {
    const c = r.counts ?? {};
    const sk = num(r, 'skipped') > 0 ? `; skipped ${num(r, 'skipped')} of ${num(r, 'total')} entries (${Object.entries(r.skipped_reasons ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')})` : '';
    return `advisory-check: ${r.status === 'partial' ? 'PARTIAL, not a clean check' : 'measured'} by ${r.command}: ${r.advisories.length} advisories (critical ${num(c, 'critical')}, high ${num(c, 'high')}, moderate ${num(c, 'moderate')}, low ${num(c, 'low')}, info ${num(c, 'info')}, unknown ${num(c, 'unknown')})${sk}; the security reviewer reads ${RECORD_NAME}`;
  }
  return `advisory-check: ${r.status}: ${r.reason}`;
}

/** @param {string} kind @param {number} i @param {number} n @param {number} [status] */
function why(kind, i, n, status) {
  const at = `request ${i + 1} of ${n}`;
  switch (kind) {
    case 'unsupported': return 'advisory check is not supported on Windows (not run)';
    case 'timeout': return `network error: no answer within ${TIMEOUT_MS / 1000} seconds (${at})`;
    case 'redirect': return `network error: the service answered with a redirect, which is refused (${at})`;
    case 'too_large': return `the answer is larger than ${MAX_RESPONSE / (1024 * 1024)} MiB (${at})`;
    case 'status': return `the service answered HTTP ${status} (${at})`;
    case 'malformed': return `the answer is not the JSON the service sends (${at})`;
    default: return `network error: the request could not be made (${at}); a network that allows only a proxy fails closed, because proofline never uses a proxy`;
  }
}

/**
 * `advisory-check <ID>` (lead only). Always writes the record; the request set is made only when everything allows it.
 * @param {Context} ctx @param {string[]} args
 */
export function advisoryCheckCommand(ctx, args) {
  const id = need(args, 0);
  requireRun(ctx, id);
  requireLead(ctx);
  if (args.length > 1) fail('usage: agent.sh advisory-check <ID>');
  const dir = runDir(ctx, id);
  const rows = advisoryRows(ctx, id);
  const defs = advisoryDefs(ctx);
  const changed = taskChangedPaths(ctx, dir);
  const base = (/** @type {string} */ p) => p.slice(p.lastIndexOf('/') + 1);
  const def = defs.find((d) => changed.some((p) => d.watch.includes(base(p))));
  const requests = rows.filter((r) => r.status === 'measured' || r.status === 'partial' || r.status === 'failed').length;
  /** @param {string} status @param {string} kind @param {string} reason @param {Record<string, unknown>} [more] */
  const done = (status, kind, reason, more = {}) => {
    const rec = { schema: 1, status, reason_kind: kind, reason, ecosystem: def?.eco ?? '', requests, lock_sha256: currentLockSha(ctx), ...more };
    writeRecord(ctx, id, rec);
    ctx.out(`${summary(rec)}\n`);
    return 0;
  };
  if (!advisoryEnabled(ctx)) return done('not_run', 'disabled', 'advisory check not enabled: set security.advisory_check: on in .agents/config.yaml (it sends the package names and versions of the lock file to the registry)');
  if (def === undefined) return done('not_applicable', 'no_dependency_change', 'no dependency manifest or lock file changed in this run');
  const lockName = def.locks.find((l) => { try { return lstatSync(`${ctx.root}/${l}`).isFile(); } catch { return false; } });
  if (lockName === undefined) return done('not_run', 'no_lock', `no ${def.locks.join(' or ')} (a regular file) at the project root: only an npm lock is checked, and it is only parsed as JSON`);
  const parse = KINDS[def.kind];
  if (parse === undefined || !/^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~/-]*)?$/.test(def.url)) return done('not_run', 'bad_definition', `the ecosystem definition has no usable advisory request (kind ${def.kind})`);
  const read = readLock(`${ctx.root}/${lockName}`);
  if ('error' in read) return done('not_run', 'lock_unreadable', `${lockName} ${read.error}`);
  const lockBytes = read.bytes;
  const lockSha = sha256(lockBytes);
  const old = readRecord(recordFile(ctx, id));
  const mine = rows.filter((r) => r.lock === lockSha && (r.status === 'measured' || r.status === 'partial' || r.status === 'failed'));
  const attempts = mine.length;
  if (old !== null && recordBound(ctx, id) && old.lock_sha256 === lockSha && (old.status === 'measured' || old.status === 'partial' || attempts >= MAX_ATTEMPTS)) {
    ctx.out(`${summary(old)} (already recorded for this lock file: no second request)\n`);
    return 0;
  }
  if (attempts >= MAX_ATTEMPTS) return done('not_run', 'attempts', `${MAX_ATTEMPTS} requests were already made for this lock file`);
  if (requests >= MAX_SETS) return done('not_run', 'run_cap', `${MAX_SETS} request sets were already made in this run`);
  const pk = lockPackages(lockBytes);
  if ('error' in pk) return done('not_run', pk.kind, pk.error);
  const built = buildBatches(pk.packages, pk.versions);
  if ('error' in built) return done('not_run', 'too_large', built.error);
  const http = ctx.io.http ?? httpPost;
  const asked = new Set(pk.packages.keys());
  const command = `POST ${def.url}`;
  /** @type {Advisory[]} */ const all = [];
  let truncated = false;
  /** @param {string} kind @param {number} i @param {number} [status] */
  const failed = (kind, i, status) => done('failed', 'failed', why(kind, i, built.bodies.length, status), { command, lock: lockName, lock_sha256: lockSha, packages: pk.packages.size, skipped: pk.skipped });
  for (let i = 0; i < built.bodies.length; i++) {
    /** @type {HttpResult} */ let res;
    try { res = http({ url: def.url, body: built.bodies[i], timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE }); } catch { return failed('network', i); }
    if ('error' in res) return failed(res.error, i);
    if (res.status !== 200) return failed('status', i, res.status);
    const buf = typeof res.body === 'string' ? Buffer.from(res.body, 'utf8') : res.body;
    if (buf.length > MAX_RESPONSE) return failed('too_large', i);
    let doc;
    try { doc = JSON.parse(buf.toString('utf8')); } catch { return failed('malformed', i); }
    const parsed = parse(doc, asked);
    if ('error' in parsed) return failed('malformed', i);
    all.push(...parsed.advisories);
    if (parsed.truncated) truncated = true;
  }
  // the merged list is ordered by severity, then package and id, BEFORE the cut: the 200 kept are the worst, whatever the batch they came in
  const order = (/** @type {string} */ x) => SEVERITIES.indexOf(x);
  all.sort((x, y) => order(x.severity) - order(y.severity) || (x.package + x.id < y.package + y.id ? -1 : 1));
  if (all.length > MAX_ADVISORIES) { all.length = MAX_ADVISORIES; truncated = true; }
  const partial = tooManySkipped(pk.skipped, pk.total);
  const why2 = pk.skipped > 0 ? ` (${Object.entries(pk.reasons).map(([k, v]) => `${k} ${v}`).join(', ')})` : '';
  return done(partial ? 'partial' : 'measured', partial ? 'partial' : 'measured', partial ? `${pk.skipped} of ${pk.total} lock entries were not checked${why2}` : '', {
    requests: requests + 1, command, exit_code: 0, lock: lockName, lock_sha256: lockSha, packages: pk.packages.size, versions: pk.versions, skipped: pk.skipped, total: pk.total, skipped_reasons: pk.reasons, http_requests: built.bodies.length,
    sent: `the package names and versions of ${lockName} (${pk.packages.size} packages, ${pk.versions} versions) to ${new URL(def.url).host} over HTTPS, ${built.bodies.length} POST request${built.bodies.length === 1 ? '' : 's'}`,
    counts: countsOf(all), advisories: all, truncated,
  });
}
