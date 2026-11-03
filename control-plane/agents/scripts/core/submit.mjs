// @ts-check
// Stage 4, package 4C: `submit` (agent.sh 0.0.47 `submit_result`): a specialist hands its result over; this builds the result document (header, findings
// table, evidence lines, reasons), checks what it can before recording, snapshots the artifact and calls `record` IN PROCESS (there is no nested
// `sh agent.sh record`). Every refusal is the shell's "submit rejected: ..." text, exit 1.
import { asciiLower } from './shellglob.mjs';
import { takeCommandLocks } from './lock.mjs';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { forgetFiles } from './approve.mjs';
import { ProoflineError, fail } from './errors.mjs';
import { gateFingerprint, hashFile } from './fingerprint.mjs';
import { languageFailText, languageScanFiles } from './language.mjs';
import { oneLine, readStdin } from './lifeutil.mjs';
import { pipelineClass, riskFocusRole } from './signals.mjs';
import { recordText } from './record.mjs';
import { fileText, textLines } from './records.mjs';
import {
  artifactAllowed, artifactPaths, canonRel, evidenceCiteCheck, findingPrefix, gateOf, isGateRole, normalizeArtifact, plainFile, reproduceRecheck,
  resultKind, riskFocusReport, skillValidator,
} from './resultutil.mjs';
import { gateDefaultArtifact } from './gatewrite.mjs';
import * as proc from './proc.mjs';
import { requireRun, runDir } from './runs.mjs';
import { inKnowledgeScope } from './scope.mjs';
import { now } from './clock.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const WSC = '[ \\t\\n\\v\\f\\r]';
const USAGE = 'usage: agent.sh submit <ID> [--result R] --confidence C [--focus F] [--artifact P] [--findings FILE|-] [--reason T] [--evidence P[@SHA256]]... [--validator-result PASS|FAIL] [--questions FILE] [--agent TOKEN]';

/** `[ -f F ]` (links followed) @param {string} f */
function isFileFollow(f) { try { return statSync(f).isFile(); } catch { return false; } }

/** The file of a path typed by the caller, relative to the working directory. @param {Context} ctx @param {string} p */
function diskPath(ctx, p) { return path.resolve(ctx.cwd, Buffer.from(p, 'latin1').toString('utf8')); }

/** `default_artifact ROLE RESULT FOCUS` @param {Context} ctx @param {string} role @param {string} res @param {string} focus */
function defaultArtifact(ctx, role, res, focus) {
  if (focus !== '' && riskFocusRole(focus) !== '') return `${riskFocusReport(focus)}REPORT.md`;
  if (role === 'qa' && res === 'DONE') return 'QA_PLAN.md';
  if (['reviewer', 'security_reviewer', 'qa', 'verifier'].includes(role)) {
    const g = gateOf(ctx, role, focus, '');
    return g === '' ? '' : gateDefaultArtifact(g);
  }
  return '';
}

/** `focus_from_artifact PATH` @param {string} p */
function focusFromArtifact(p) {
  const rules = [['reviews/proof-review/plan/', 'plan'], ['reviews/proof-review/rules/', 'rules'], ['reviews/proof-review/small/', 'rules+tests'], ['reviews/test-trust/tests/', 'tests'],
    ['reviews/data-design/', 'data'], ['reviews/proof-review/config/', 'config'], ['reviews/contract-proof/', 'contract'], ['reviews/concurrency-proof/', 'concurrency'],
    ['reviews/performance-proof/', 'performance'], ['reviews/data-migration/', 'migration']];
  for (const [pre, f] of rules) if (p.startsWith(pre)) return f;
  return '';
}

/** `verify_design_sync ID` (A65): '' when fine, else the refusal text. @param {Context} ctx @param {string} id */
function verifyDesignSync(ctx, id) {
  const dir = runDir(ctx, id);
  if (pipelineClass(ctx, dir) === 'TRIVIAL') return '';
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  if (plan === null) return '';
  if (existsSync(`${dir}/design/SYNC.md`)) return '';
  const verify = fileText(ctx, `${dir}/VERIFY.md`);
  if (verify !== null && verify.includes('design-sync: SKIPPED (')) return '';
  let need = false;
  for (const k of ['data_model', 'api', 'architecture']) {
    const p = ctx.config().get(`design_docs.${k}`, '');
    if (p === '' || !isFileFollow(`${ctx.root}/${p}`)) continue;
    if (k === 'data_model') {
      let inside = false; let n = 0;
      for (const l of textLines(plan)) {
        if (new RegExp(`^## Data${WSC}*$`).test(l)) { inside = true; continue; }
        if (l.startsWith('## ')) inside = false;
        if (inside && /[^ \t\n\v\f\r]/.test(l)) n++;
      }
      if (n > 1) need = true;
    } else if (k === 'api') {
      let inside = false;
      for (const l of textLines(plan)) {
        if (new RegExp(`^## Contracts${WSC}*$`).test(l)) { inside = true; continue; }
        if (l.startsWith('## ')) inside = false;
        if (inside && /[^ \t\n\v\f\r]/.test(l) && !/^none/.test(asciiLower(l))) { need = true; break; }
      }
    }
  }
  return need ? "the plan changes what a design document describes: write design/SYNC.md (design-sync) or record 'design-sync: SKIPPED (<reason>)' in VERIFY.md" : '';
}

/** `verify_tests_findings ID` (A171): '' when fine, else the refusal text; warnings go to stderr. @param {Context} ctx @param {string} id */
function verifyTestsFindings(ctx, id) {
  const s = `${ctx.root}/.agents/skills/test-trust/scripts/validate-findings.mjs`;
  if (!isFileFollow(s)) return '';
  const dir = runDir(ctx, id);
  const f = `${dir}/reviews/test-trust/tests/findings.json`;
  if (!isFileFollow(f)) return 'the tests review needs reviews/test-trust/tests/findings.json (test-trust diff mode, scope.diff.claims for every criterion of PLAN ## Tests); the report alone is not enough';
  const a = [s, f];
  if (isFileFollow(`${dir}/PLAN.md`)) a.push('--plan', `${dir}/PLAN.md`);
  const r = proc.run(process.execPath, a, { cwd: ctx.root, env: ctx.childEnv(), input: '', stdio: ['pipe', 'pipe', 'pipe'] });
  const out = r.stdout.toString('latin1') + r.stderr.toString('latin1');
  if (r.status !== 0) return out.replace(/\n/g, ' ');
  for (const l of out.split('\n')) if (l.startsWith('WARNING:')) ctx.err(`${l}\n`);
  return '';
}

/** `submit_status TOKEN STATUS ID ROLE RESULT GATE RAW ERROR` @param {Context} ctx @param {string[]} a */
function submitStatus(ctx, a) {
  const [token, status, id, role, result, gate, raw, error] = a;
  if (token === '') return;
  const dir = `${ctx.agents}/local/submissions`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${token}.status.tmp`, `status=${status}\ntask=${id}\nrole=${role}\nresult=${result}\ngate=${gate}\nraw=${raw}\nepoch=${now().epoch}\nerror=${oneLine(error)}\n`, 'latin1');
    renameSync(`${dir}/${token}.status.tmp`, `${dir}/${token}.status`);
  } catch { /* best effort, as the shell's `|| return 0` */ }
}

/** The `ae_*` state of `alloc_explorer_report`. @typedef {{ p: string, created: string, owner: string }} Alloc */

/**
 * `submit ID OPTIONS...`
 * @param {Context} ctx @param {string} id @param {string[]} args
 */
export function submitResult(ctx, id, args) {
  if (ctx.role === 'lead') fail('the lead never submits a specialist result');
  requireRun(ctx, id);
  const role = ctx.role;
  const sd = `${ctx.agents}/local/submissions`;
  let res = ''; let conf = ''; let focus = ctx.env.PROOFLINE_FOCUS ?? ''; let art = ''; let findingsSrc = ''; let reason = ''; let questionsSrc = ''; let report = '';
  let evidence = ''; let evlist = ''; let vres = ''; let agent = ctx.env.PROOFLINE_AGENT ?? '';
  const a = [...args];
  while (a.length > 0) {
    if (a.length < 2) fail(USAGE);
    const k = a[0]; const v = a[1];
    switch (k) {
      case '--result': res = v; break;
      case '--confidence': conf = v; break;
      case '--focus': focus = v; break;
      case '--artifact': art = v; break;
      case '--findings': findingsSrc = v; break;
      case '--report': report = v; break;
      case '--reason': reason = v; break;
      case '--evidence': evidence = v; evlist = `${evlist}\n${v}`; break;
      case '--validator-result': vres = v; break;
      case '--questions': questionsSrc = v; break;
      case '--agent': if ((ctx.env.PROOFLINE_AGENT ?? '') === '' || existsSync(`${sd}/${v}.started`)) agent = v; break;
      default: fail(`submit: unknown option ${k}`);
    }
    a.splice(0, 2);
  }
  if (/[^A-Za-z0-9_.-]/.test(agent)) fail('submit: invalid --agent token');
  if (/@[0-9a-f]/.test(evidence)) evidence = evidence.slice(0, evidence.lastIndexOf('@'));
  const tmp = mkdtempSync(path.join(tmpdir(), 'proofline-submit.'));
  const d = runDir(ctx, id);
  /** @type {Alloc} */ const alloc = { p: '', created: '', owner: '' };
  /** @param {string} msg @returns {never} */
  const submitFail = (msg) => {
    if (alloc.created !== '') { rmSync(`${d}/${alloc.created}`, { force: true }); if (alloc.owner !== '') rmSync(alloc.owner, { force: true }); }
    submitStatus(ctx, [agent, 'rejected', id, role, res, '', '', msg]);
    rmSync(tmp, { recursive: true, force: true });
    throw new ProoflineError(`submit rejected: ${msg}`, 1);
  };
  try {
    return submitBody();
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  function submitBody() {
    // A104: stdin is one stream
    let nstdin = 0;
    for (const v of [report, findingsSrc, questionsSrc]) if (v === '-') nstdin++;
    if (nstdin > 1) {
      if (report === '-' && findingsSrc === '-' && questionsSrc !== '-') {
        const all = readStdin();
        const lines = all.split('\n');
        if (!lines.includes('=== FINDINGS ===')) submitFail("only one of --report/--findings may read stdin (-); write one of them to a file under the run's scratch or reports dir, or give ONE stdin document: the report, then a line '=== FINDINGS ===', then the finding rows (severity|path:line|finding|evidence; an answer-only result has the row info|-|answer|<one line>, or use --findings none)");
        let into = 'report'; let rep = ''; let fin = '';
        const body = all.endsWith('\n') ? lines.slice(0, -1) : lines;
        for (const l of body) {
          if (l === '=== FINDINGS ===' && into === 'report') { into = 'findings'; continue; }
          if (into === 'report') rep += `${l}\n`; else fin += `${l}\n`;
        }
        writeFileSync(`${tmp}/report.pre`, rep, 'latin1'); writeFileSync(`${tmp}/findings.pre`, fin, 'latin1');
        report = `${tmp}/report.pre`; findingsSrc = `${tmp}/findings.pre`;
      } else {
        submitFail("only one of --report/--findings/--questions may read stdin (-); write the others to a file under the run's scratch or reports dir (e.g. printf '%s\\n' 'info|-|answer|<one line>' > <scratch>/rows, then --findings <scratch>/rows --report -)");
      }
    }
    if (findingsSrc === 'none' || findingsSrc === 'NONE' || findingsSrc === 'None') findingsSrc = '';
    if (!['high', 'medium', 'low'].includes(conf)) submitFail('--confidence must be high, medium or low');
    const gaterole = isGateRole(role);
    /** @type {string[]} */ let rows = [];
    if (findingsSrc !== '') {
      let text;
      if (findingsSrc === '-') text = readStdin();
      else {
        const f = diskPath(ctx, findingsSrc);
        if (!isFileFollow(f)) submitFail(`findings file not found: ${findingsSrc}`);
        text = readFileSync(f, 'latin1');
      }
      let bad = '';
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      lines.forEach((raw, i) => {
        const t = (/** @type {string} */ s) => s.replace(new RegExp(`^${WSC}+`), '').replace(new RegExp(`${WSC}+$`), '');
        if (new RegExp(`^${WSC}*(#|$)`).test(raw)) return;
        const line = raw.replace(new RegExp(`^${WSC}*\\|`), '').replace(new RegExp(`\\|${WSC}*$`), '');
        const f = line.split('|');
        const n = f.length;
        if (/^[-:| ]+$/.test(line)) return;
        let k = 0;
        const f1 = asciiLower(t(f[0]));
        if (f1 === 'id' || f1 === 'severity') return;
        if (!/^(blocking|info)$/.test(t(f[0])) && n >= 5) k = 1;
        const sev = t(f[k] ?? ''); const loc = t(f[k + 1] ?? ''); const fnd = t(f[k + 2] ?? '');
        let ev = '';
        for (let j = k + 3; j < n; j++) ev += (ev === '' ? '' : ' / ') + t(f[j]);
        if (/^agent\.sh([ \t\n\v\f\r]|$)/.test(ev)) { if (bad === '') bad = `BAD ${i + 1}: the evidence of a row may not start with agent.sh (reserved for rows the script adds; name the command you ran after scan:)`; return; }
        if (!/^(blocking|info)$/.test(sev) || loc === '' || fnd === '' || ev === '') { if (bad === '') bad = `BAD ${i + 1}: want severity|path:line|finding|evidence with severity blocking or info (an answer-only result: --findings none, or the row info|-|answer|<one line>; report text on stdin goes to --report -, never --findings -)`; return; }
        rows.push(`${sev}|${loc}|${fnd}|${ev}`);
      });
      if (bad !== '') submitFail(bad);
    }
    // A171: design-sync drift in a knowledge-scope document is information before the knowledge step
    if (role === 'verifier' && rows.length > 0) {
      rows = rows.map((r) => {
        const c = r.split('|');
        const kp = (c[1] ?? '').replace(/:[^]*$/, '');
        if (r.startsWith('blocking|') && r.includes('design-sync drift') && inKnowledgeScope(ctx, kp)) return `info|${c[1]}|KNOWLEDGE_DRIFT: ${c[2]}|${c.slice(3).join('|')}`;
        return r;
      });
    }
    const countBlocking = () => rows.filter((r) => r.startsWith('blocking|')).length;
    let blocking = countBlocking();
    let derive = gaterole;
    if (role === 'qa' && (res === 'DONE' || res === 'NEEDS_INPUT')) derive = false;
    if (derive) {
      switch (res) {
        case '': res = blocking > 0 ? 'FAIL' : 'PASS'; break;
        case 'PASS': if (blocking !== 0) submitFail(`--result PASS contradicts ${blocking} blocking finding(s); the result of a gate follows from the findings`); break;
        case 'FAIL': if (!(blocking > 0)) submitFail('--result FAIL needs at least one blocking finding'); break;
        case 'BLOCKED': break;
        case 'UNSUPPORTED':
          if (blocking !== 0) submitFail('--result UNSUPPORTED cannot carry blocking findings (a check that found a defect is FAIL; its UNSUPPORTED rows still block and are listed)');
          if (reason === '') submitFail('--result UNSUPPORTED needs --reason naming the missing tool or skill');
          break;
        default: submitFail(`--result ${res} is not valid for role ${role} (gate roles: PASS FAIL BLOCKED UNSUPPORTED, or omit it)`);
      }
    }
    if (!['PASS', 'FAIL', 'BLOCKED', 'UNSUPPORTED', 'DONE', 'NEEDS_INPUT'].includes(res)) submitFail(`--result is required (DONE, BLOCKED or NEEDS_INPUT for role ${role})`);
    if (role === 'reviewer') {
      if (focus === '' && art !== '') { const n = normalizeArtifact(ctx, id, art); if ('path' in n) focus = focusFromArtifact(n.path); }
      if (!['plan', 'rules', 'tests', 'data', 'rules+tests', 'contract', 'concurrency', 'performance', 'config', 'migration'].includes(focus)) submitFail('reviewer submissions need --focus plan|rules|tests|data|rules+tests|contract|concurrency|performance|config|migration');
    } else if (focus !== '' && riskFocusRole(focus) === role && res !== 'DONE' && res !== 'NEEDS_INPUT') { /* keep */ } else focus = '';
    const gate = gateOf(ctx, role, focus, id);
    if (art === '') art = defaultArtifact(ctx, role, res, focus);
    if (role === 'explorer' && report === '') {
      if (res === 'BLOCKED') { writeFileSync(`${tmp}/blocked.in`, `# BLOCKED\n\n${reason === '' ? 'no reason given' : reason}\n`, 'latin1'); report = `${tmp}/blocked.in`; }
      else submitFail('an explorer hands its report over with --report <file> (or --report - on stdin), written in your scratch folder; the script assigns the numbered reports/NNN-explorer.md name (no --artifact)');
    }
    if (report !== '') {
      if (art === '' && role !== 'explorer') submitFail('--report needs --artifact: the run-relative path to write');
      if (report === '-') writeFileSync(`${tmp}/report.in`, readStdin(), 'latin1');
      else {
        const f = diskPath(ctx, report);
        if (!isFileFollow(f) && !isFileFollow(report)) submitFail(`report file not found: ${report}`);
        const real = isFileFollow(f) ? f : report;
        if (role === 'explorer' && agent !== '') {
          const ok = report.includes(`/${agent}-`) || report.startsWith(`${agent}-`) || report.startsWith(`${tmp}/`);
          if (!ok) submitFail(`an explorer's report file name carries its own agent token, so a parallel explorer cannot overwrite it: write it to .agents/runs/${id}/scratch/${agent}-report.md (or pass --report - with the text on stdin); refused: ${report}`);
        }
        writeFileSync(`${tmp}/report.in`, readFileSync(real));
      }
      if (statSync(`${tmp}/report.in`).size === 0) submitFail('the report is empty (--report - reads stdin; give the report text on stdin, one stdin source per submit, or --report <file>)');
      let rp;
      if (role === 'explorer') { allocExplorer(); rp = alloc.p; }
      else {
        rp = art.startsWith(`.agents/runs/${id}/`) ? art.slice(`.agents/runs/${id}/`.length) : art;
        if (rp.startsWith('./')) rp = rp.slice(2);
        if (rp === '' || rp.startsWith('/') || rp.includes('..')) submitFail(`--artifact must be a run-relative path: ${art}`);
        rp = canonRel(rp);
      }
      if (rp === '' || rp.startsWith('/') || rp.includes('..')) submitFail(`--artifact must be a run-relative path: ${art}`);
      const rk = gaterole && res !== 'DONE' && res !== 'NEEDS_INPUT' ? 'gate' : 'task';
      if (!artifactAllowed(role, rk, focus, rp)) submitFail(`artifact ${rp} is outside the paths ${role}${focus !== '' ? ` (FOCUS ${focus})` : ''} reports in: ${artifactPaths(role, rk, focus)}`);
      try { mkdirSync(path.dirname(`${d}/${rp}`), { recursive: true }); copyFileSync(`${tmp}/report.in`, `${d}/${rp}`); } catch { submitFail(`could not write ${rp}`); }
      art = rp;
    }
    if (art === '') submitFail(`--artifact is required: the run-relative path of your report (allowed: ${artifactPaths(role, 'task', focus)})`);
    let norm;
    const nr = normalizeArtifact(ctx, id, art);
    if ('path' in nr) norm = nr.path;
    else if (nr.code === 2 && res === 'BLOCKED') {
      norm = art.startsWith(`.agents/runs/${id}/`) ? art.slice(`.agents/runs/${id}/`.length) : art;
      if (norm.startsWith('./')) norm = norm.slice(2);
      if (norm === '' || norm.startsWith('/') || norm.includes('..')) submitFail(`--artifact must be a run-relative path: ${art}`);
      norm = canonRel(norm);
      mkdirSync(path.dirname(`${d}/${norm}`), { recursive: true });
      writeFileSync(`${d}/${norm}`, `# BLOCKED\n\n${reason === '' ? 'no reason given' : reason}\n`, 'latin1');
    } else if (nr.code === 1) submitFail(`--artifact must be a path inside the run directory: ${art}`);
    else submitFail(`artifact not found in the run: ${art} (write the report there first; expected location for your role: ${artifactPaths(role, gaterole ? 'gate' : 'task', focus)})`);
    let questions = '';
    if (questionsSrc !== '') {
      if (questionsSrc === '-') questions = readStdin();
      else { const f = diskPath(ctx, questionsSrc); if (!isFileFollow(f)) submitFail(`questions file not found: ${questionsSrc}`); questions = readFileSync(f, 'latin1'); }
      writeFileSync(`${tmp}/questions.in`, questions, 'latin1');
    }
    forgetFiles(ctx);
    // A184: an explorer's DONE report is a claims table
    if (role === 'explorer' && res === 'DONE' && isFileFollow(`${d}/${norm}`)
      && !textLines(readFileSync(`${d}/${norm}`, 'latin1')).some((l) => new RegExp(`^\\|${WSC}*id${WSC}*\\|${WSC}*severity${WSC}*\\|${WSC}*path:line`).test(l))) {
      ctx.err(`NOTE: the explorer report ${norm} has no claims table (| id | severity | path:line | finding | evidence |, evidence-map's format). The lead must not turn it into EVIDENCE.md itself: send the SAME explorer (or the same assignment again) back to redo it as that table, one verified path:symbol per row\n`);
    }
    if (role === 'verifier' && res !== 'BLOCKED' && res !== 'NEEDS_INPUT') { const m = verifyDesignSync(ctx, id); if (m !== '') submitFail(m); }
    if (role === 'reviewer' && focus === 'tests' && res !== 'BLOCKED' && res !== 'NEEDS_INPUT') { const m = verifyTestsFindings(ctx, id); if (m !== '') submitFail(`findings.json of the tests review is not valid: ${m}`); }
    // A107: the skill's own validator is run here and its result is the one used
    let notRerun = '';
    if (gaterole && (res === 'PASS' || res === 'FAIL')) {
      const vr = skillValidator(ctx, id, role, focus, norm);
      if (vr.rc !== 0) submitFail(vr.text);
      const gl = `${gate !== '' ? gate : role}:${focus === '' ? '-' : focus}`;
      if (/^(PASS|FAIL) /.test(vr.text)) {
        const vs = vr.text.slice(0, 4);
        const vsn = vs.trim();
        const script = vr.text.slice(vr.text.indexOf(' ') + 1);
        if (vres !== '' && vres !== vsn) submitFail(`validator result mismatch: declared ${vres}, recomputed ${vsn} by ${script} (A107; the declared value is never trusted)`);
        if (res === 'PASS' && vsn === 'FAIL') submitFail(`validator result mismatch: declared PASS (no blocking finding), recomputed FAIL by ${script} (A107); report the failing check as a blocking finding`);
      } else if (vr.text.startsWith('UNRUN ')) {
        if (res === 'PASS') submitFail(`no validator run for ${gl}: ${vr.text.slice('UNRUN '.length)} (A107; a PASS of this focus needs the skill validator's own result)`);
      } else if (vr.text.startsWith('NOSKILL ')) {
        rows.push(`info|${norm}|NOT_VALIDATED: ${gl} skill ${vr.text.slice('NOSKILL '.length)} is not installed, so no validator ran; the result follows from the findings|agent.sh submit (A107)`);
      }
    }
    // cited evidence
    /** @type {string[]} */ let cites = [];
    if (res !== 'UNSUPPORTED') cites.push(...evlist.split('\n').filter((x) => x !== ''));
    const artText = readFileSync(`${d}/${norm}`, 'latin1');
    const rowsText = rows.map((r) => `${r}\n`).join('');
    for (const src of [rowsText, artText]) for (const m of src.matchAll(/[A-Za-z0-9_./-]+@[0-9a-f]{64}/g)) cites.push(m[0]);
    for (const src of [rowsText, artText]) for (const m of src.matchAll(/evidence:[A-Za-z0-9_./-]+/g)) cites.push(m[0].slice('evidence:'.length));
    cites = [...new Set(cites.map((c) => { const at = c.indexOf('@'); return `${at < 0 ? c : c.slice(0, at)} ${at < 0 ? '' : c.slice(at + 1)}`; }))].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    /** @type {string[]} */ const evlines = [];
    for (const c of cites) {
      const sp = c.indexOf(' ');
      const cp = c.slice(0, sp); const cs = c.slice(sp + 1);
      if (cp === '') continue;
      const cn = normalizeArtifact(ctx, id, cp);
      if (!('path' in cn)) submitFail(`cited evidence file not found or outside the run: ${cp} (A107)`);
      const ce = evidenceCiteCheck(ctx, id, role, focus, cn.path, cs);
      if ('err' in ce) submitFail(ce.err);
      evlines.push(ce.ok);
    }
    // A107: a PASS is re-derived
    if (gaterole && res === 'PASS') {
      const rq = role === 'verifier' && existsSync(`${ctx.root}/.agents/skills/verify-proof`);
      const rr = reproduceRecheck(ctx, id, role, `${d}/${norm}`, evlines, rq);
      if (rr.problems.length > 0) {
        for (const p of rr.problems) rows.push(`blocking|${norm}|${p}|agent.sh submit re-ran the recorded command (A107)`);
        res = 'FAIL'; blocking = countBlocking();
      } else if (rr.n === 0) notRerun = `${gate !== '' ? gate : role}:${focus === '' ? '-' : focus} no reproduced evidence; this gate is not reproduced proof`;
    }
    // A33: run artifacts are English
    writeFileSync(`${tmp}/rows`, rows.map((r) => `${r}\n`).join(''), 'latin1');
    const langFiles = [`${d}/${norm}`, `${tmp}/rows`];
    if (questionsSrc !== '') langFiles.push(`${tmp}/questions.in`);
    const hits = languageScanFiles(ctx, langFiles, `${d}/`);
    if (hits.length > 0) submitFail(languageFailText(hits.join(' ').split(`${tmp}/rows`).join('your findings')));
    // A43: the result cites an immutable copy of the artifact
    const kind = gaterole && res !== 'DONE' && res !== 'NEEDS_INPUT' ? 'gate' : 'task';
    if (!artifactAllowed(role, kind, focus, norm)) submitFail(`artifact ${norm} is outside the paths ${role}${focus !== '' ? ` (FOCUS ${focus})` : ''} reports in: ${artifactPaths(role, kind, focus)}`);
    if (role === 'explorer' && !norm.startsWith('reports/snapshots/') && norm !== alloc.p) submitFail(`${norm} was not assigned to this submission (A113): write your report to scratch/<your token>-report.md and pass it with --report <file>; the script assigns the numbered name`);
    if (!norm.startsWith('reports/snapshots/')) {
      const h = hashFile(`${d}/${norm}`);
      const sn = `reports/snapshots/${h.slice(0, 12)}-${role}-${norm.replace(/\//g, '_')}`;
      try { mkdirSync(`${d}/reports/snapshots`, { recursive: true }); copyFileSync(`${d}/${norm}`, `${d}/${sn}`); } catch { submitFail(`could not snapshot ${norm}`); }
      norm = sn;
    }
    // A102: the evidence of an UNSUPPORTED result is snapshotted the same way
    let ev = '';
    if (res === 'UNSUPPORTED' && evidence !== '') {
      const e = normalizeArtifact(ctx, id, evidence);
      if (!('path' in e)) submitFail(`--evidence must be an existing file inside the run directory: ${evidence}`);
      ev = e.path;
      if (!ev.startsWith('reports/snapshots/')) {
        const eh = hashFile(`${d}/${ev}`);
        const es = `reports/snapshots/${eh.slice(0, 12)}-${role}-${ev.replace(/\//g, '_')}`;
        if (new RegExp(`^reports/[0-9]{3}-${role}`).test(ev) || ev.startsWith(riskFocusReport(focus))) {
          try { copyFileSync(`${d}/${ev}`, `${d}/${es}`); } catch { submitFail(`could not snapshot ${ev}`); }
          ev = es;
        }
      }
    }
    forgetFiles(ctx);
    let raw = `ROLE: ${role}\nTASK: ${id}\n`;
    if (focus !== '') raw += `FOCUS: ${focus}\n`;
    raw += `RESULT: ${res}\nCONFIDENCE: ${conf}\nFINGERPRINT: ${gateFingerprint(ctx)}\nARTIFACT: ${norm} ${hashFile(`${d}/${norm}`)}\n\n`;
    raw += '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n';
    const prefix = findingPrefix(role, resultKind(role, res), gate);
    rows.forEach((r, i) => { const c = r.split('|'); raw += `| ${prefix}-${i + 1} | ${c[0]} | ${c[1]} | ${c[2]} | ${c[3]} |\n`; });
    if (evlines.length > 0) raw += `\n${evlines.map((l) => `EVIDENCE: ${l}\n`).join('')}`;
    if (notRerun !== '') raw += `\nNOT_RERUN: ${notRerun}\n`;
    if (res === 'BLOCKED') raw += `\nBLOCKED_REASON: ${oneLine(reason === '' ? `see ${norm}` : reason)}\n`;
    if (res === 'UNSUPPORTED') {
      raw += `\nUNSUPPORTED_REASON: ${oneLine(reason)}\n`;
      if (ev !== '') raw += `UNSUPPORTED_EVIDENCE: ${ev} ${hashFile(`${d}/${ev}`)}\n`;
    }
    if (res === 'NEEDS_INPUT') raw += `\nQUESTIONS:\n${questionsSrc !== '' ? questions : `${reason}\n`}`;
    // record, in process; its messages are those the shell child printed (stderr and stdout are not shown, only a refusal and the risk lines)
    const mark = ctx.chunks.length;
    let rec;
    try {
      // the gate number, the gate record and the hash-chain row are one transaction: the command locks are held for record only (the re-run phase above stays unlocked)
      if (ctx.locks) { takeCommandLocks(/** @type {import('./lock.mjs').LockSet} */ (ctx.locks), ctx, 'record', [id]); forgetFiles(ctx); ctx.forget('changed:'); }
      try { rec = recordText(ctx, id, raw, agent); } finally { ctx.locks?.releaseAll(); }
    } catch (e) {
      const errs = ctx.chunks.slice(mark).filter((c) => c[0] === 'err').map((c) => c[1].toString('latin1')).join('');
      ctx.chunks.length = mark;
      if (e instanceof ProoflineError && e.exitCode !== 0) {
        const text = `${errs}${e.message === '' ? '' : `${e.message}\n`}`;
        submitFail(text.replace(/^record rejected: /gm, '').replace(/\n/g, ' '));
      }
      throw e;
    }
    ctx.chunks.length = mark;
    for (const l of rec.risk) ctx.out(`${l}\n`);
    const final = rec.res;
    submitStatus(ctx, [agent, 'ok', id, role, final, gate, rec.raw, '']);
    ctx.out(`submitted: ${id} ${role} ${final}${gate !== '' ? ` gate=${gate}` : ''} (${rec.raw === '' ? 'no raw' : rec.raw})\n`);
    return 0;
  }

  /** `alloc_explorer_report` (A113): the next free reports/NNN-explorer.md, created with an exclusive create. */
  function allocExplorer() {
    alloc.p = ''; alloc.created = ''; alloc.owner = '';
    try { mkdirSync(`${d}/reports/.owners`, { recursive: true }); } catch { submitFail('cannot create reports/.owners in the run'); }
    if (agent !== '') {
      alloc.owner = `${d}/reports/.owners/${agent.replace(/[^A-Za-z0-9._-]/g, '_')}`;
      try {
        const cur = readFileSync(alloc.owner, 'latin1').replace(/\n$/, '');
        if (cur !== '' && isFileFollow(`${d}/${cur}`)) { alloc.p = cur; return; }
      } catch { /* none */ }
    }
    for (let n = 1; ; n++) {
      if (n > 1000) submitFail('could not allocate a report name under reports/ (is it writable?)');
      let max = 0;
      try { for (const f of readdirSync(`${d}/reports`)) if (/^[0-9]{3}/.test(f)) max = Math.max(max, Number(f.slice(0, 3))); } catch { /* none */ }
      const p = `reports/${String(max + 1).padStart(3, '0')}-explorer.md`;
      try { writeFileSync(`${d}/${p}`, '', { flag: 'wx' }); alloc.p = p; break; } catch { /* taken: try the next */ }
    }
    alloc.created = alloc.p;
    if (alloc.owner !== '') writeFileSync(alloc.owner, `${alloc.p}\n`, 'latin1');
  }
}
