// @ts-check
// `proofline insights` (A89, bin/lib/insights.sh): the aggregator of the cost and recurring-failure report, as the awk program of the shell
// front end read it, rule by rule. Read-only: it opens nothing for writing. Text is a byte string (LC_ALL=C: lengths are bytes).
import { readdirSync, readFileSync, lstatSync, statSync } from 'node:fs';
import { trimSpace } from './shellglob.mjs';

const isnum = (/** @type {string} */ v) => /^[0-9]+$/.test(v);

/** awk's number to string: an integral value as an integer, any other with CONVFMT %.6g. @param {number} x */
export function awkStr(x) {
  if (Number.isInteger(x)) return String(x);
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : x < 0 ? '-inf' : 'nan';
  const [mant, exp] = x.toExponential(5).split('e');
  const e = Number(exp);
  if (e < -4 || e >= 6) {
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    return `${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  const s = x.toFixed(Math.max(0, 5 - e));
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** A tiny printf for the formats of the awk program: %s, %d, widths and the `-` flag. @param {string} f @param {Array<string | number>} args */
function printf(f, ...args) {
  let i = 0;
  return f.replace(/%(-?)([0-9]*)([sd%])/g, (_m, left, width, conv) => {
    if (conv === '%') return '%';
    const a = args[i++];
    const s = conv === 'd' ? String(Math.trunc(Number(a) || 0)) : typeof a === 'number' ? awkStr(a) : String(a ?? '');
    const w = Number(width || 0);
    return s.length >= w ? s : left ? s.padEnd(w) : s.padStart(w);
  });
}

/** @param {string} s @param {string} k */
function jv(s, k) {
  const p = `"${k}":`;
  const i = s.indexOf(p);
  if (i < 0) return '';
  let r = s.slice(i + p.length);
  if (r[0] === '"') { r = r.slice(1); const q = r.indexOf('"'); return q < 0 ? r : r.slice(0, q); }
  r = r.replace(/[,}][^]*$/, '');
  return r === 'null' ? '' : r;
}

/** @param {string} s */
function jesc(s) {
  let o = '';
  for (const c of s) o += c === '\\' ? '\\\\' : c === '"' ? '\\"' : c < ' ' ? ' ' : c;
  return o;
}

/** @param {string} s */
function norm(s) { return s.replace(/[ \t]+/g, ' ').replace(/^ /, '').replace(/ $/, ''); }

/** @param {string[]} a ascending, strings compared as bytes */
const isortStr = (a) => a.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

const SCOPE_RE = /out[ -]of[ -]scope|outside (of )?(the )?(frozen |plan |plan.s )?scope|unmapped|scope (violation|creep)|not in (the )?(plan |frozen )?scope|unauthori[sz]ed path/;

/** @param {string} g */
function gsugg(g) {
  if (g === 'SECRETS') return 'Find what keeps putting secret-like text into diffs (fixtures, env files, examples) and keep it out on purpose, or record a reason for each deliberate exception.';
  if (g === 'SECURITY') return 'Read the repeated security findings together: if they share a cause, state the rule in the plan so the implementer sees it before the gate does.';
  if (g === 'QA') return 'Make the failing acceptance criteria more concrete in the task, so the implementer and QA read the same test.';
  if (g === 'VERIFY') return 'Check whether the verify commands are stable on this machine; a gate that fails the same way every time usually points to an environment or flaky-test cause.';
  return 'Read the repeated findings of this gate; if they share a cause, name it in the plan or the task so it is handled before review.';
}

/**
 * @typedef {{ kind: 'M', text: string } | { kind: 'R', run: string } | { kind: 'L', run: string, row: string }
 *   | { kind: 'G', run: string, fn: string, line: string } | { kind: 'U', run: string, fn: string, line: string }} Ev
 */

/** The records of a file as awk reads them. @param {string} text */
function recs(text) { const r = text.split('\n'); if (r[r.length - 1] === '') r.pop(); return r; }

/** @param {string} f a regular file that is not a symbolic link */
function plainFile(f) { try { return lstatSync(f).isFile(); } catch { return false; } }

/** @param {string} d @param {(n: string) => boolean} ok */
function listDir(d, ok) { try { return readdirSync(d, { encoding: 'latin1' }).filter(ok).sort(); } catch { return []; } }

/**
 * `insights_stream`: the tagged events, one source file at a time.
 * @param {string} root @param {string} only
 * @returns {Ev[]}
 */
export function insightsStream(root, only) {
  /** @type {Ev[]} */ const ev = [];
  const mf = `${root}/.agents/local/metrics/records.jsonl`;
  try { if (statSync(mf).isFile()) for (const l of recs(readFileSync(mf, 'latin1'))) ev.push({ kind: 'M', text: l }); } catch { /* none */ }
  const runs = `${root}/.agents/runs`;
  for (const id of listDir(runs, (n) => !n.startsWith('.'))) {
    const rd = `${runs}/${id}`;
    try { if (!statSync(rd).isDirectory()) continue; } catch { continue; }
    if (only !== '' && id !== only) continue;
    ev.push({ kind: 'R', run: id });
    /** @type {Array<[string, string]>} */ const files = [];
    if (plainFile(`${rd}/LEDGER.log`)) files.push(['LEDGER.log', `${rd}/LEDGER.log`]);
    for (const n of listDir(`${rd}/gates`, (x) => x.endsWith('.yaml') && !x.startsWith('.'))) if (plainFile(`${rd}/gates/${n}`)) files.push([n, `${rd}/gates/${n}`]);
    for (const n of listDir(`${rd}/results`, (x) => x.endsWith('.result.md') && !x.startsWith('.'))) if (plainFile(`${rd}/results/${n}`)) files.push([n, `${rd}/results/${n}`]);
    for (const [fn, file] of files) {
      let text;
      try { text = readFileSync(file, 'latin1'); } catch { continue; }
      const kind = fn === 'LEDGER.log' ? 'L' : /\.yaml$/.test(fn) ? 'G' : 'U';
      for (const l of recs(text)) {
        if (kind === 'L') ev.push({ kind: 'L', run: id, row: l });
        else if (kind === 'G' && /^(result|finding):/.test(l)) ev.push({ kind: 'G', run: id, fn, line: l });
        else if (kind === 'U' && l.includes('UNSUPPORTED')) ev.push({ kind: 'U', run: id, fn, line: l });
      }
    }
  }
  return ev;
}

/**
 * The report. @param {Ev[]} events @param {{ json: boolean, only: string, off: boolean }} opt
 * @returns {string}
 */
export function insightsReport(events, opt) {
  const { only } = opt;
  const SEP = '\x1c';
  /** @type {Map<string, number>} */ const C = new Map();
  /** @type {Map<string, number>} */ const S = new Map();
  /** @type {Map<string, number>} */ const N = new Map();
  const g0 = (/** @type {Map<string, number>} */ m, /** @type {string} */ k) => m.get(k) ?? 0;
  const key3 = (/** @type {string} */ g, /** @type {string} */ k, /** @type {number} */ i) => `${g}${SEP}${k}${SEP}${i}`;
  const key2 = (/** @type {string} */ g, /** @type {string} */ k) => `${g}${SEP}${k}`;
  /** @type {Set<string>} */ const SET = new Set();
  /** @type {Map<string, string>} */ const LST = new Map();
  /** @param {string} nm @param {string} key @param {string} v */
  const addset = (nm, key, v) => {
    const k = `${nm}${SEP}${key}${SEP}${v}`;
    if (!SET.has(k)) { SET.add(k); const lk = key2(nm, key); const cur = LST.get(lk) ?? ''; LST.set(lk, cur + (cur === '' ? '' : ',') + v); }
  };
  /** @param {string} g @param {string} key @param {string[]} w */
  const add = (g, key, ...w) => {
    C.set(key2(g, key), g0(C, key2(g, key)) + 1);
    for (let i = 1; i <= 5; i++) { const v = w[i - 1] ?? ''; if (isnum(v)) { S.set(key3(g, key, i), g0(S, key3(g, key, i)) + Number(v)); N.set(key3(g, key, i), g0(N, key3(g, key, i)) + 1); } }
  };
  const cell = (/** @type {string} */ g, /** @type {string} */ key, /** @type {number} */ i) => {
    const n = g0(N, key3(g, key, i)); const c = g0(C, key2(g, key));
    if (n === 0) return 'n/a';
    return n < c ? `${awkStr(g0(S, key3(g, key, i)))} (${n}/${c})` : awkStr(g0(S, key3(g, key, i)));
  };
  const jcell = (/** @type {string} */ g, /** @type {string} */ key, /** @type {number} */ i) => (g0(N, key3(g, key, i)) === 0 ? 'null' : awkStr(g0(S, key3(g, key, i))));
  const nn = (/** @type {string} */ g, /** @type {string} */ key, /** @type {number} */ i) => g0(N, key3(g, key, i));

  /** @type {Set<string>} */ const known = new Set();
  /** @type {Set<string>} */ const hasdir = new Set();
  /** @type {Set<string>} */ const rmSeen = new Set();
  /** @type {Set<string>} */ const mdSeen = new Set();
  /** @type {Set<string>} */ const bound = new Set();
  /** @type {Map<string, string>} */ const rres = new Map(); const rdur = new Map(); const rdel = new Map(); const rfix = new Map(); const rsz = new Map(); const rsp = new Map();
  /** @type {Set<string>} */ const hasrun = new Set();
  let nrec = 0; let skipped = 0; let nonjson = 0; let dupruns = 0; let scopen = 0;
  /** @type {Map<string, number>} */ const gf = new Map(); const fcount = new Map(); const ucount = new Map();
  /** @type {Map<string, number>} */ const asks = new Map(); const grants = new Map();
  /** @type {Map<string, [string, string]>} */ const akind = new Map();
  /** @type {Set<string>} */ const fseen = new Set();

  for (const e of events) {
    if (e.kind === 'M') {
      const j = e.text;
      if (!/^[ \t]*\{/.test(j)) { if (/[^ \t]/.test(j)) nonjson++; continue; }
      if (jv(j, 'schema') !== 'proofline.metrics/1') { skipped++; continue; }
      const t = jv(j, 'task');
      if (t === '' || (only !== '' && t !== only)) continue;
      nrec++; known.add(t);
      const kd = jv(j, 'kind'); let ro = jv(j, 'role'); let mo = jv(j, 'model');
      if (mo === '') mo = 'n/a';
      if (ro === '') ro = 'n/a';
      if (kd === 'dispatch') {
        const d = jv(j, 'duration_s'); const ti = jv(j, 'tokens_in'); const to = jv(j, 'tokens_out'); const tt = jv(j, 'tokens_total'); const re = jv(j, 'retries');
        add('run', t, d, ti, to, re, tt); add('rm', `${ro}|${mo}`, d, ti, to, re, tt); add('model', mo, d, ti, to, re, tt); add('all', 'all', d, ti, to, re, tt);
        rmSeen.add(`${ro}|${mo}`); mdSeen.add(mo);
      } else if (kd === 'run') {
        if (hasrun.has(t)) { dupruns++; continue; }
        hasrun.add(t); rres.set(t, jv(j, 'result')); rdur.set(t, jv(j, 'duration_s')); rdel.set(t, jv(j, 'delegations')); rfix.set(t, jv(j, 'fix_rounds'));
        add('runrec', 'all', rdur.get(t) ?? '', rdel.get(t) ?? '', rfix.get(t) ?? '', '', '');
        rsz.set(t, jv(j, 'size')); rsp.set(t, jv(j, 'scope_paths'));
      }
      continue;
    }
    if (e.kind === 'R') { known.add(e.run); hasdir.add(e.run); continue; }
    if (e.kind === 'L') {
      const r = e.run; const row = e.row; known.add(r);
      const m = / event=[^ ]+/.exec(row);
      if (!m) continue;
      const evn = row.slice(m.index + 7, m.index + m[0].length);
      const di = row.indexOf(' detail=');
      const d = di >= 0 ? row.slice(di + 8) : '';
      if (/^gate:/.test(evn)) {
        const p = evn.split(':');
        const gm = /gates\/[0-9][0-9][0-9]-[A-Z_]+\.yaml@/.exec(d);
        if (gm) bound.add(`${r}${SEP}${d.slice(gm.index + 6, gm.index + gm[0].length - 1)}`);
        if (p[2] === 'fail') { gf.set(p[1], (gf.get(p[1]) ?? 0) + 1); addset('gf', p[1], r); }
      } else if (/^record:/.test(evn)) {
        const rm = /^results\/[^ ]+\.result\.md/.exec(d);
        if (rm) bound.add(`${r}${SEP}${d.slice(8, rm[0].length)}`);
      } else if (evn === 'approval-request' || evn === 'approval') {
        const w = d.split(/[ \t\n]+/).filter((x) => x !== '');
        let k = w[0] ?? '';
        if (/^approvals\//.test(k)) k = w[1] ?? '';
        if (k !== '') {
          const ak = `${r}${SEP}${k}`;
          if (evn === 'approval') grants.set(ak, (grants.get(ak) ?? 0) + 1); else asks.set(ak, (asks.get(ak) ?? 0) + 1);
          akind.set(ak, [r, k]);
        }
      }
      continue;
    }
    if (e.kind === 'G') {
      const r = e.run; const fn = e.fn; let line = e.line;
      if (!bound.has(`${r}${SEP}${fn}`)) continue;
      if (!/^finding:/.test(line)) continue;
      line = line.replace(/^finding: */, '');
      const f = line.split('|');
      if (f.length < 4 || f[1] !== 'blocking') continue;
      const g = fn.replace(/^[0-9]+-/, '').replace(/\.yaml$/, '');
      const pth = norm(f[2]).replace(/:[^]*$/, '');
      const txt = norm(f[3]);
      const key = `${g}|${pth}|${txt}`;
      const fk = `${r}${SEP}${fn}${SEP}${key}`;
      if (!fseen.has(fk)) {
        fseen.add(fk); fcount.set(key, (fcount.get(key) ?? 0) + 1); addset('f', key, r);
        if (SCOPE_RE.test(txt.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)))) { scopen++; addset('scope', 'all', r); }
      }
      continue;
    }
    // U
    const r = e.run; const fn = e.fn;
    let line = norm(e.line);
    if (!bound.has(`${r}${SEP}${fn}`)) continue;
    if (line.length > 160) line = `${line.slice(0, 160)}...`;
    ucount.set(line, (ucount.get(line) ?? 0) + 1); addset('u', line, r);
  }

  // ---- recurring patterns ----
  /** @type {Array<{ kind: string, subj: string, cnt: number, runs: string, sugg: string }>} */ const pats = [];
  /** @type {Map<string, number>} */ const pord = new Map();
  const addpat = (/** @type {string} */ kind, /** @type {string} */ subj, /** @type {number} */ cnt, /** @type {string} */ runs, /** @type {string} */ sugg) => {
    pats.push({ kind, subj, cnt, runs, sugg });
    pord.set(`${String(999999999 - cnt).padStart(9, '0')}|${kind}|${subj}|${String(pats.length).padStart(6, '0')}`, pats.length - 1);
  };
  for (const [key, c] of fcount) {
    if (c < 2) continue;
    const kp = key.split('|');
    const txt = key.slice(kp[0].length + kp[1].length + 2);
    addpat('repeated-finding', `${kp[0]} ${kp[1]}: ${txt.length > 200 ? `${txt.slice(0, 200)}...` : txt}`, c, LST.get(key2('f', key)) ?? '',
      `The same blocking finding came back ${c} times. Put it in the task acceptance criteria or the plan so it is handled before review, and consider a test or validator that catches it earlier.`);
  }
  for (const [g, c] of gf) if (c >= 2) addpat('gate-fail', g, c, LST.get(key2('gf', g)) ?? '', gsugg(g));
  if (scopen >= 2) addpat('scope', 'findings that name a scope violation', scopen, LST.get(key2('scope', 'all')) ?? '',
    'Findings keep naming paths outside the plan scope. List the files the task really touches in the plan scope at planning time (ask the explorer for the impact), or split the task so each plan stays small.');
  for (const [u, c] of ucount) if (c >= 2) addpat('unsupported', u, c, LST.get(key2('u', u)) ?? '',
    'A check could not run because the project lacks the tool or capability it needs, so its result is UNSUPPORTED, not PASS. Proofline never installs anything: add the tool yourself if you want the check to run, or accept that it stays unsupported.');
  /** @type {Map<string, number>} */ const unmet = new Map();
  // awk walks `akind` in hash order (unspecified, differs between awks); the runs of an approval pattern are listed in byte order here
  for (const [ak, [r, k]] of [...akind].sort((x, y) => (x[1][1] < y[1][1] ? -1 : x[1][1] > y[1][1] ? 1 : x[1][0] < y[1][0] ? -1 : x[1][0] > y[1][0] ? 1 : 0))) {
    const a = asks.get(ak) ?? 0; const gr = grants.get(ak) ?? 0;
    if (a >= 2 && gr < a) { unmet.set(k, (unmet.get(k) ?? 0) + a - gr); addset('ap', k, r); }
  }
  for (const [k, c] of unmet) if (c >= 2) addpat('approval', k, c, LST.get(key2('ap', k)) ?? '',
    `The ${k} approval was asked for more often than it was granted (refused, or never answered). Check that the question was clear and the plan is what you wanted to approve; approval phrases are listed in approval.phrases of .agents/config.yaml.`);
  const ordk = isortStr([...pord.keys()]);
  const pat = (/** @type {number} */ i) => pats[/** @type {number} */ (pord.get(ordk[i]))];

  const rl = isortStr([...known]);
  const rml = isortStr([...rmSeen]);
  const mdl = isortStr([...mdSeen]);
  const nr = rl.length; const nm = rml.length; const nd = mdl.length; const po = ordk.length;

  // ---- calibration ----
  /** @param {number[]} v */
  const med = (v) => {
    const n = v.length;
    if (n === 0) return 'n/a';
    const a = v.slice().sort((x, y) => x - y);
    const m = Math.floor((n + 1) / 2);
    return n % 2 ? awkStr(a[m - 1]) : String(Math.trunc((a[m - 1] + a[m]) / 2));
  };
  /** @type {Array<{ z: string, n: number, md: string, mt: string, mp: string, sg: string }>} */
  const cal = [];
  const calib = () => {
    /** @type {Record<string, number[]>} */ const CD = { S: [], M: [], L: [] }; const CT = { S: [], M: [], L: [] }; const CP = { S: [], M: [], L: [] };
    for (const t of hasrun) {
      const z = rsz.get(t) ?? '';
      if (/^[SML]$/.test(z) && isnum(rdur.get(t) ?? '')) {
        CD[z].push(Number(rdur.get(t)) / 60);
        if (nn('run', t, 5) > 0) CT[z].push(g0(S, key3('run', t, 5)));
        const sp = rsp.get(t) ?? '';
        if (isnum(sp) && Number(sp) > 0) CP[z].push(Number(sp));
      }
    }
    let prev = '';
    for (const z of ['S', 'M', 'L']) {
      if (CD[z].length === 0) continue;
      const cur = { z, n: CD[z].length, md: med(CD[z]), mt: med(CT[z]), mp: med(CP[z]), sg: '' };
      let why = '';
      if (prev !== '') {
        const b = cal[cal.length - 1];
        if (cur.n < 3 || b.n < 3) why = `too few finished tasks (3 or more of each size are needed) to compare ${b.z} with ${cur.z}.`;
        else if (Number(b.md) > Number(cur.md) || (b.mp !== 'n/a' && cur.mp !== 'n/a' && Number(b.mp) > Number(cur.mp)))
          why = `${b.z} tasks took longer or touched more paths than ${cur.z} tasks; consider estimating tasks like the ${b.z} ones one size up.`;
        else why = `${b.z} to ${cur.z}: the estimates follow the actuals; no change suggested.`;
      }
      cur.sg = why; prev = z;
      cal.push(cur);
    }
  };

  /** @type {string[]} */ const out = [];
  const P = (/** @type {string} */ s) => out.push(s);

  if (opt.json) {
    P(printf('{"schema":"proofline.insights/1","run":%s,"metrics":{"records":%d,"skipped_unknown_schema":%d,"skipped_non_json":%d,"duplicate_run_records":%d,"off":%s},\n',
      only === '' ? 'null' : `"${jesc(only)}"`, nrec, skipped, nonjson, dupruns, opt.off ? 'true' : 'false'));
    P(' "runs":[');
    for (let i = 0; i < nr; i++) {
      const r = rl[i];
      P(printf('%s{"run":"%s","result":%s,"duration_s":%s,"dispatches":%d,"tokens_in":%s,"tokens_in_reported":%d,"tokens_out":%s,"tokens_out_reported":%d,"tokens_total":%s,"tokens_total_reported":%d,"retries":%s,"delegations":%s,"fix_rounds":%s}',
        i > 0 ? ',' : '', jesc(r), hasrun.has(r) && (rres.get(r) ?? '') !== '' ? `"${jesc(rres.get(r) ?? '')}"` : 'null', isnum(rdur.get(r) ?? '') ? (rdur.get(r) ?? '') : 'null', g0(C, key2('run', r)),
        jcell('run', r, 2), nn('run', r, 2), jcell('run', r, 3), nn('run', r, 3), jcell('run', r, 5), nn('run', r, 5), jcell('run', r, 4), isnum(rdel.get(r) ?? '') ? (rdel.get(r) ?? '') : 'null', isnum(rfix.get(r) ?? '') ? (rfix.get(r) ?? '') : 'null'));
    }
    P('],\n "by_role_model":[');
    for (let i = 0; i < nm; i++) {
      const k = rml[i]; const q = k.split('|');
      P(printf('%s{"role":"%s","model":"%s","dispatches":%d,"duration_s":%s,"tokens_in":%s,"tokens_in_reported":%d,"tokens_out":%s,"tokens_out_reported":%d,"tokens_total":%s,"tokens_total_reported":%d,"retries":%s}',
        i > 0 ? ',' : '', jesc(q[0]), jesc(q[1] ?? ''), g0(C, key2('rm', k)), jcell('rm', k, 1), jcell('rm', k, 2), nn('rm', k, 2), jcell('rm', k, 3), nn('rm', k, 3), jcell('rm', k, 5), nn('rm', k, 5), jcell('rm', k, 4)));
    }
    P('],\n "by_model":[');
    for (let i = 0; i < nd; i++) {
      const k = mdl[i];
      P(printf('%s{"model":"%s","dispatches":%d,"duration_s":%s,"tokens_in":%s,"tokens_in_reported":%d,"tokens_out":%s,"tokens_out_reported":%d,"tokens_total":%s,"tokens_total_reported":%d,"retries":%s}',
        i > 0 ? ',' : '', jesc(k), g0(C, key2('model', k)), jcell('model', k, 1), jcell('model', k, 2), nn('model', k, 2), jcell('model', k, 3), nn('model', k, 3), jcell('model', k, 5), nn('model', k, 5), jcell('model', k, 4)));
    }
    P(printf('],\n "totals":{"dispatches":%d,"dispatch_duration_s":%s,"tokens_in":%s,"tokens_in_reported":%d,"tokens_out":%s,"tokens_out_reported":%d,"tokens_total":%s,"tokens_total_reported":%d,"retries":%s,"run_duration_s":%s,"run_records":%d,"delegations":%s,"fix_rounds":%s},\n',
      g0(C, key2('all', 'all')), jcell('all', 'all', 1), jcell('all', 'all', 2), nn('all', 'all', 2), jcell('all', 'all', 3), nn('all', 'all', 3), jcell('all', 'all', 5), nn('all', 'all', 5), jcell('all', 'all', 4),
      jcell('runrec', 'all', 1), g0(C, key2('runrec', 'all')), jcell('runrec', 'all', 2), jcell('runrec', 'all', 3)));
    calib();
    P(' "calibration":[');
    cal.forEach((c, i) => P(printf('%s{"size":"%s","tasks":%d,"median_min":%s,"median_tokens":%s,"median_paths":%s,"suggestion":"%s"}', i > 0 ? ',' : '', c.z, c.n,
      c.md === 'n/a' ? 'null' : c.md, c.mt === 'n/a' ? 'null' : c.mt, c.mp === 'n/a' ? 'null' : c.mp, jesc(c.sg))));
    P('],\n');
    P(' "patterns":[');
    for (let i = 0; i < po; i++) {
      const x = pat(i);
      P(printf('%s{"kind":"%s","subject":"%s","count":%d,"runs":[', i > 0 ? ',' : '', jesc(x.kind), jesc(x.subj), x.cnt));
      x.runs.split(',').forEach((rr, j) => P(printf('%s"%s"', j > 0 ? ',' : '', jesc(rr))));
      P(printf('],"suggestion":"%s"}', jesc(x.sugg)));
    }
    P(']}\n');
    return out.join('');
  }

  const off = opt.off;
  P('proofline insights (read-only report: nothing was changed)\n');
  if (only !== '') P(`run filter: ${only}\n`);
  if (nrec === 0) P(`metrics: no metrics recorded${off ? ' (metrics: off)' : ''} (.agents/local/metrics/records.jsonl)\n`);
  else P(`metrics: ${nrec} record(s)${off ? ' (metrics: off now; earlier records are shown)' : ''}${skipped ? `, ${skipped} with an unknown schema skipped` : ''}${nonjson ? `, ${nonjson} non-JSON line(s) ignored` : ''}${dupruns ? `, ${dupruns} duplicate run record(s) ignored (the first counts)` : ''}\n`);
  P(`runs: ${nr}\n`);
  P('\n');
  P('COST (tokens are what the runtime reported; n/a = none recorded, never estimated; (k/n) = k of n dispatches reported)\n');
  if (nr === 0) P('  no runs and no metrics to report\n');
  else {
    P(printf('  %-22s %-12s %9s %5s %-16s %-16s %-16s %7s %6s %5s\n', 'RUN', 'RESULT', 'DURATION', 'DISP', 'TOKENS_IN', 'TOKENS_OUT', 'TOKENS_TOTAL', 'RETRIES', 'DELEG', 'FIX'));
    for (const r of rl) {
      const res = hasrun.has(r) && (rres.get(r) ?? '') !== '' ? (rres.get(r) ?? '') : hasdir.has(r) ? 'open' : 'n/a';
      P(printf('  %-22s %-12s %9s %5d %-16s %-16s %-16s %7s %6s %5s\n', r, res, isnum(rdur.get(r) ?? '') ? `${rdur.get(r)}s` : 'n/a', g0(C, key2('run', r)),
        cell('run', r, 2), cell('run', r, 3), cell('run', r, 5), cell('run', r, 4), isnum(rdel.get(r) ?? '') ? (rdel.get(r) ?? '') : 'n/a', isnum(rfix.get(r) ?? '') ? (rfix.get(r) ?? '') : 'n/a'));
    }
  }
  const secs = (/** @type {string} */ d) => (d !== 'n/a' ? d.replace(/^[0-9]+/, '$&s') : d);
  if (nm > 0) {
    P('\n');
    P(printf('  %-18s %-18s %5s %9s %-16s %-16s %-16s %7s\n', 'ROLE', 'MODEL', 'DISP', 'DURATION', 'TOKENS_IN', 'TOKENS_OUT', 'TOKENS_TOTAL', 'RETRIES'));
    for (const k of rml) {
      const q = k.split('|');
      P(printf('  %-18s %-18s %5d %9s %-16s %-16s %-16s %7s\n', q[0], q[1] ?? '', g0(C, key2('rm', k)), secs(cell('rm', k, 1)), cell('rm', k, 2), cell('rm', k, 3), cell('rm', k, 5), cell('rm', k, 4)));
    }
    P('\n');
    P(printf('  %-35s %5s %9s %-16s %-16s %-16s %7s\n', 'MODEL', 'DISP', 'DURATION', 'TOKENS_IN', 'TOKENS_OUT', 'TOKENS_TOTAL', 'RETRIES'));
    for (const k of mdl) P(printf('  %-35s %5d %9s %-16s %-16s %-16s %7s\n', k, g0(C, key2('model', k)), secs(cell('model', k, 1)), cell('model', k, 2), cell('model', k, 3), cell('model', k, 5), cell('model', k, 4)));
    P('\n');
    P(printf('  total over %d dispatch(es): duration %s, tokens in %s, tokens out %s, tokens total %s, retries %s\n', g0(C, key2('all', 'all')), secs(cell('all', 'all', 1)), cell('all', 'all', 2), cell('all', 'all', 3), cell('all', 'all', 5), cell('all', 'all', 4)));
    P(printf('  total over %d finished run(s): duration %s, delegations %s, fix rounds %s\n', g0(C, key2('runrec', 'all')), secs(cell('runrec', 'all', 1)), cell('runrec', 'all', 2), cell('runrec', 'all', 3)));
  }
  calib();
  P('\n');
  P('CALIBRATION (task-author size estimate against the actual run; a suggestion only, nothing is changed)\n');
  if (cal.length === 0) P('  no finished run record carries a size estimate yet\n');
  for (const c of cal) {
    P(printf('  %s tasks (%d): median %s min / %s tokens / %s paths\n', c.z, c.n, c.md, c.mt, c.mp));
    if (c.sg !== '') P(printf('     suggestion: %s\n', c.sg));
  }
  P('\n');
  P('RECURRING FAILURES (2 or more occurrences; suggestions are not applied)\n');
  if (po === 0) P('  none found\n');
  for (let i = 0; i < po; i++) {
    const x = pat(i);
    P(printf('  %d. %s x%d: %s\n     runs: %s\n     suggestion: %s\n', i + 1, x.kind, x.cnt, x.subj, x.runs, x.sugg));
  }
  P('\n');
  P('Sources: the metrics records, each run LEDGER.log and the gate records and results it binds. Control-plane refusals\n');
  P('(a blocked scope check, a refused approval phrase) leave no record, so only what a ledger or finding states is counted.\n');
  return out.join('');
}

export { trimSpace };
