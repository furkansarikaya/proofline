#!/usr/bin/env node
// Conformance check for roles/*.md against roles/README.md: key order, enums, tier floors, D5 profile rules,
// body sections, skill references, result header, severity values, finding ids, RESULT sets, the no-spawn
// rule and owns/tools/sandbox/writes_code consistency. Node since A234 (it was role-conformance.sh, one awk program per role).
// Usage: node tests/generator/role-conformance.mjs [--root REPO | ROLES-DIR]   (default: the repository's roles/)
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYS = 'id name purpose conditional reads owns skills gate result tools writes_code sandbox model effort tier_floor timeout_seconds stop_condition'.split(' ');
const SKILLS = new Set('proofline-lead task-author intent-grill evidence-map plan-contract system-design api-design data-design ui-design qa-plan tdd-proof debug-proof test-trust proof-review exploit-proof verify-proof design-sync concurrency-proof visual-proof performance-proof contract-proof docs-writer llm-wiki explain-html product-spec'.split(' '));
const GATES = new Set('REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA REVIEW_SMALL SECURITY QA VERIFY'.split(' '));
const TIER = { haiku: 1, sonnet: 2, opus: 3, 'gpt-6-luna': 1, 'gpt-6-sol': 2, 'gpt-6-astra': 3 };
const PROFILES = ['max', 'balanced', 'economy'];
const GATE_RES = 'RESULT: <PASS|FAIL|BLOCKED>';
const TASK_RES = 'RESULT: <DONE|BLOCKED|NEEDS_INPUT>';
const words = (s) => s.split(/[ \t]+/).filter(Boolean);
const lowerIndex = (s, w) => s.toLowerCase().indexOf(w);

/** The problems of one role file (the awk program of the shell version). @param {string} text @param {string} base */
export function problems(text, base) {
  const out = [];
  const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
  const val = {}; let ki = 0, sc = 0, cur = '', fm = 0, body = '';
  const h = [], ids = new Set(), ref = new Set(), mt = {}, ct = {};
  let nid = 0, rg = false, rt = false;
  lines.forEach((raw, idx) => {
    let l = raw;
    if (idx === 0) { if (l !== '---') out.push('no opening ---'); return; }
    if (fm === 0) {
      if (l === '---') { fm = 1; return; }
      if (l.startsWith('  ')) {
        l = l.slice(2);
        const at = l.indexOf(': ');
        const a1 = (at < 0 ? l : l.slice(0, at)).replace(/:$/, ''), a2 = at < 0 ? '' : l.slice(at + 2);
        sc++;
        const want = PROFILES[(sc - 1) % 3];
        if (a1 !== want) out.push(`sub-line order ${cur} got ${a1} want ${want}`);
        if (cur === 'model') {
          if (!/^claude=[a-z]+ codex=gpt-6-[a-z]+$/.test(a2)) out.push(`bad model line ${l}`);
          const mm = a2.split(' ');
          mt[want] = (mm[0] ?? '').replace(/claude=/, ''); ct[want] = (mm[1] ?? '').replace(/codex=/, '');
        }
        if (cur === 'effort' && !/^(low|medium|high|xhigh)$/.test(a2)) out.push(`bad effort ${l}`);
        return;
      }
      const k = l.replace(/:.*$/s, ''), v = l.replace(/^[^:]*: ?/, '');
      ki++;
      if (k !== KEYS[ki - 1]) out.push(`key ${ki} is ${k} want ${KEYS[ki - 1] ?? ''}`);
      cur = k; val[k] = v;
      if (v.includes('#')) out.push(`hash in ${k}`);
      if (k !== 'model' && k !== 'effort' && v === '') out.push(`empty ${k}`);
      return;
    }
    body += `${l}\n`;
    if (l.startsWith('## ')) h.push(l);
    if (l.startsWith('RESULT: ')) {
      if (l === GATE_RES || (base === 'reviewer' && l === 'RESULT: <PASS|FAIL|BLOCKED|UNSUPPORTED>')) rg = true;
      else if (l === TASK_RES) rt = true;
      else out.push(`bad RESULT line ${l}`);
    }
    if (/(^|[^A-Za-z_])(INFO|HIGH|MEDIUM|LOW)([^A-Za-z_]|$)/.test(l)) out.push(`old severity word: ${l}`);
    if (l.toLowerCase().includes('severity') && !l.startsWith('| id | severity')) {
      if (l.includes('CRITICAL')) out.push(`old severity word: ${l}`);
      const m = /`[^`]+`/.exec(l.slice(lowerIndex(l, 'severity')));
      if (m) { const w = m[0].slice(1, -1); if (w !== 'blocking' && w !== 'info') out.push(`bad severity value ${w}`); }
    }
    for (const m of l.matchAll(/`([A-Za-z_<>]+)-<n>`/g)) { ids.add(m[1]); nid++; }
    for (const m of l.matchAll(/\{\{skill:([a-z-]+)\}\}/g)) { if (!SKILLS.has(m[1])) out.push(`unknown skill ref ${m[1]}`); ref.add(m[1]); }
  });
  const g = (k) => val[k] ?? '';
  if (g('id') !== base) out.push('id mismatch');
  if (h[0] !== '## Does / Must not' || h[1] !== '## Method' || h[2] !== '## Output' || h.length !== 3) out.push('body sections wrong');
  for (const s of words(g('skills'))) { if (!SKILLS.has(s)) out.push(`unknown skill ${s}`); if (!ref.has(s)) out.push(`skill not referenced in method ${s}`); }
  for (const q of PROFILES) {
    if (TIER[mt[q]] === undefined || TIER[ct[q]] === undefined) out.push(`unknown model ${q}`);
    if (TIER[mt[q]] !== TIER[ct[q]]) out.push(`tier mismatch ${q}`);
    if ((TIER[mt[q]] ?? 0) < Number(g('tier_floor'))) out.push(`below floor ${q}`);
  }
  if ((parseFloat(g('timeout_seconds')) || 0) < 30) out.push('timeout');
  const gate = g('gate') !== 'none';
  if (gate !== (g('result') === 'gate')) out.push('gate/result');
  if (gate) for (const x of words(g('gate'))) if (!GATES.has(x)) out.push(`unknown gate ${x}`);
  if (g('result') === 'gate') { if (!rg) out.push(`gate role lacks ${GATE_RES}`); if (rt && base !== 'qa') out.push('gate role with task RESULT set'); }
  else if (g('result') === 'task') { if (!rt) out.push(`task role lacks ${TASK_RES}`); if (rg) out.push('task role with gate RESULT set'); }
  else out.push(`bad result kind ${g('result')}`);
  for (const x of ids) {
    const okid = (g('result') === 'task' && x === base) || (g('result') === 'gate' && (GATES.has(x) || x === '<GATE>')) || (base === 'qa' && x === 'qa');
    if (!okid) out.push(`bad finding id ${x}-<n>`);
  }
  if (base !== 'lead' && nid === 0) out.push('no finding id format');
  if (base === 'qa' && (!ids.has('qa') || !ids.has('QA'))) out.push('qa needs qa-<n> and QA-<n>');
  if (/(^| )(Agent|Task)( |$)/.test(g('tools'))) out.push('spawn tool');
  if (base === 'lead') { if (!/Let a specialist dispatch another/.test(body)) out.push('no-spawn rule missing'); }
  else if (!body.toLowerCase().includes('spawn agents')) out.push('no-spawn rule missing');
  const owns = words(g('owns')); let ps = false;
  for (const t of owns) {
    if (t === 'PRODUCT_SCOPE') ps = true;
    else if (t.startsWith('/')) { if (!/\.md$/.test(t) && !t.startsWith('/.agents/')) out.push(`project-relative owns token not a doc: ${t}`); }
    else if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(t) || t.includes('..')) out.push(`bad owns token ${t}`);
  }
  const wr = /(^| )Write( |$)/.test(g('tools')) && /(^| )Edit( |$)/.test(g('tools'));
  if (owns.length > 0 && !wr) out.push('owns paths but no Write/Edit');
  if (wr && owns.length === 0) out.push('Write/Edit without owns');
  if (wr !== (g('sandbox') === 'workspace-write')) out.push(`sandbox ${g('sandbox')} vs tools`);
  if ((g('writes_code') === 'yes') !== (base === 'implementer')) out.push('writes_code');
  if (ps !== (g('writes_code') === 'yes')) out.push('PRODUCT_SCOPE vs writes_code');
  if (g('writes_code') !== 'yes' && g('writes_code') !== 'no') out.push('writes_code value');
  if (!body.includes(`ROLE: ${base}\n`)) out.push('header ROLE missing');
  if (!body.includes('| id | severity | path:line | finding | evidence |')) out.push('findings table missing');
  if (g('result') === 'task' && !body.includes('QUESTIONS:')) out.push('no QUESTIONS format');
  return out;
}

/** The D5 profile rules and the file shape (the shell around the awk program). @param {string} text @param {string} base */
export function profileProblems(text, base) {
  const out = [];
  const lines = text.split('\n'); if (lines[lines.length - 1] === '') lines.pop();
  const model = (p) => { for (const l of lines) { const w = words(l); if (w[0] === `${p}:`) return (w[1] ?? '').replace(/claude=/, ''); } return ''; };
  if (['lead', 'architect', 'data_architect'].includes(base) && model('balanced') !== 'opus') out.push('balanced-not-opus');
  if (['explorer', 'implementer', 'verifier', 'designer', 'reviewer'].includes(base) && model('balanced') !== 'sonnet') out.push('balanced-not-sonnet');
  if (base === 'security_reviewer') {
    for (const q of PROFILES) if (model(q) !== 'opus') out.push(`sec-not-opus-${q}`);
    if (!lines.includes('tier_floor: 3')) out.push('sec-floor');
  } else if (model('economy') === 'opus') out.push('economy-opus');
  if (model('max') !== 'opus') out.push('max-not-opus');
  if (lines.some((l) => l.startsWith('FOCUS:')) && base !== 'reviewer') out.push('stray-FOCUS');
  if (base === 'reviewer' && !lines.includes('FOCUS: <plan|rules|tests|data|rules+tests|contract|concurrency|performance|config|migration>')) out.push('no-FOCUS');
  return out;
}

/** @param {string} dir the roles directory @returns {{ lines: string[], fail: boolean }} */
export function conform(dir) {
  const res = [];
  let fail = false;
  const files = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  for (const name of files) {
    if (name === 'README.md') continue;
    const b = name.slice(0, -3);
    const text = readFileSync(join(dir, name), 'utf8');
    const n = (text.match(/\n/g) ?? []).length;
    const all = [...problems(text, b), ...profileProblems(text, b)];
    if (n < 60 || n > 160) all.push(`lines=${n}`);
    if (all.length) { res.push(`FAIL ${b}:${all.join(' ').replace(/^/, '')} `); fail = true; } else res.push(`ok ${b} (${n} lines)`);
  }
  const c = files.filter((n) => n !== 'README.md').length;
  if (c !== 11) { res.push(`FAIL count ${c}`); fail = true; }
  let readme = null; try { readme = readFileSync(join(dir, 'README.md'), 'utf8'); } catch { /* none */ }
  if (readme !== null) {
    if (!readme.includes('`severity` is exactly `blocking` or `info`')) { res.push('FAIL README: severity set'); fail = true; }
    if (/(^|[^A-Za-z_])(INFO|HIGH|MEDIUM|LOW)([^A-Za-z_]|$)/m.test(readme)) { res.push('FAIL README: old severity word'); fail = true; }
  }
  return { lines: res, fail };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const dir = a[0] === '--root' ? join(a[1] ?? '', 'roles') : a[0] ?? resolve(fileURLToPath(new URL('../..', import.meta.url)), 'roles');
  const r = conform(dir);
  process.stdout.write(r.lines.length ? `${r.lines.join('\n')}\n` : '');
  process.exitCode = r.fail ? 1 : 0;
}
