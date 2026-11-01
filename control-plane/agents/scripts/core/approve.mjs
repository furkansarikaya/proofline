// @ts-check
// Stage 3: the approval engine of agent.sh 0.0.42 (request_approval, approve, approve_kinds, approve_pending, approval_consume and what
// they need). Invariant 3: an approval is recorded only by `approve`, only from a user message the prompt hook captured (or typed at a
// terminal), only when that message is newer than the request (and, for a waiver, than the failing gate record), only when its words pass the
// grammar of approvals.mjs, and each captured message grants a kind at most once. Nothing here lets a model produce an approval: a refusal
// keeps its text, and an input whose shell behaviour is a shell error text throws BridgeToShell before anything is written.
import { appendFileSync, mkdirSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import { now, sleepSync } from './clock.mjs';
import { captureField } from './capture.mjs';
import { BridgeToShell, ProoflineError, fail } from './errors.mjs';
import { contentFingerprint } from './fingerprint.mjs';
import {
  approvalExample, approvalFiles, approvalNorm, approvalPendingPairs, approvalPhrases, approvalSay, approvalSentences, approvalWords, approvalsDirOf, captureFieldOf,
  findApproval, kindSlug, kindWords, latestCapture, latestRequest, promptsDir, safeStateFile, seq3, sharedDirOf, sortedNames, textHasApproval, validApprovalKind,
  APPROVAL_FILLERS, rationaleLineIn, DESIGN_MD_CANDIDATES,
} from './approvals.mjs';
import { blockingFindingIds, gateFocusStatus, gateLatestFile, requiredGates, taskPatchFingerprint } from './gates.mjs';
import { gateFingerprint } from './fingerprint.mjs';
import { sha256, sha256File } from './hash.mjs';
import { ledgerIf } from './lifecycle.mjs';
import * as proc from './proc.mjs';
import { Context } from './context.mjs';
import { LockSet, takeCommandLocks } from './lock.mjs';
import { isDir, isFile } from './paths.mjs';
import { WS, fileLines, gateField, readBytes, sectionValue, textLines } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { riskGateFocuses } from './signals.mjs';
import { asciiLower } from './shellglob.mjs';


const bs = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1');
const TAB = '\t';

/** `require_lead` @param {Context} ctx */
export function requireLead(ctx) { if (ctx.role !== 'lead') fail(`command denied for ${ctx.role} (lead only)`); }

/** `require_open_run ID` @param {Context} ctx @param {string} id */
export function requireOpenRun(ctx, id) {
  const st = sectionValue(ctx, runDir(ctx, id), 'execution', 'state');
  if (st === 'FAILED' || st === 'BLOCKED') fail(`run ${id} is ${st} (terminal); it accepts no further lifecycle commands`);
}

/** Everything a writer changed is read again afterwards. @param {Context} ctx */
export function forgetFiles(ctx) { ctx.forget('file:'); ctx.forget('ledger-bound:'); ctx.forget('patch:'); ctx.forget('fp:'); }

/** `next_num DIR`: the next NNN over the files whose name starts with three digits. @param {string} dir */
export function nextNum(dir) {
  let max = 0;
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^[0-9]{3}/.test(n)); } catch { names = []; }
  for (const n of names) { const v = Number(seq3(n) || '0'); if (v > max) max = v; }
  return String(max + 1).padStart(3, '0');
}

// ---- kinds and targets ---------------------------------------------------------------------------------------------------------------

const KINDS_TEXT = 'plan|destructive|single_step|scope|budget|mutation_budget|tree|commit|push|pr|merge|cleanup|report|batch|commands|rename|known-issue|scale|waive:<FINDING-ID>|rule:<LESSON-ID>|reopen:<ID>|rationale:<PATTERN-ID>';

/** `approval_target ID KIND` @param {Context} ctx @param {string} id @param {string} kind */
export function approvalTarget(ctx, id, kind) {
  if (!validApprovalKind(kind)) fail(`invalid approval kind: ${kind} (want ${KINDS_TEXT})`);
  if (id === '-') {
    if (/^(commit|push|pr|merge|cleanup|report|batch|commands|rename|known-issue|scale)$/.test(kind)) return;
    fail(`approval kind ${kind} needs a run`);
  }
  requireRun(ctx, id);
  const st = sectionValue(ctx, runDir(ctx, id), 'execution', 'state');
  if (kind.startsWith('reopen:')) {
    if (kind.slice(7) !== id) fail(`approval kind ${kind} names another run; the kind for ${id} is reopen:${id}`);
    if (st === 'FAILED' || st === 'BLOCKED') return;
    fail(`approval kind ${kind} is for a FAILED or BLOCKED run; ${id} is ${st}`);
  }
  if (kind === 'mutation_budget') return;
  requireOpenRun(ctx, id);
}

// ---- waivers -------------------------------------------------------------------------------------------------------------------------

/** `id_key` @param {string} s */
function idKey(s) { return s.replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/-0+([0-9])/g, '-$1'); }

/**
 * `waive_target ID FINDING-ID [FINGERPRINT]`: the gate record holding that open blocking finding on the current content; SECRETS and SECURITY
 * findings are refused. @param {Context} ctx @param {string} id @param {string} fid @param {string} [nowFp]
 */
export function waiveTarget(ctx, id, fid, nowFp) {
  const dir = runDir(ctx, id);
  const fp = nowFp ?? gateFingerprint(ctx);
  let rec = '';
  for (const g of requiredGates(ctx, dir)) {
    for (const fc of ['-', ...riskGateFocuses(ctx, dir, g)]) {
      if (gateFocusStatus(ctx, dir, id, g, fc, 'strict', fp) !== 'fail') continue;
      const f = gateLatestFile(ctx, dir, g, fc);
      if (blockingFindingIds(ctx, f).includes(fid)) rec = f;
    }
  }
  if (rec === '') fail(`no open blocking finding ${fid} on the current content of ${id}`);
  const gate = gateField(ctx, rec, 'gate');
  if (gate === 'SECRETS' || gate === 'SECURITY') fail(`${gate} findings are never waivable`);
  return rec;
}

/** `waive_canon ID FINDING-ID`: the finding id in the spelling of the gate record. @param {Context} ctx @param {string} id @param {string} fid */
function waiveCanon(ctx, id, fid) {
  let rec;
  try { rec = waiveTarget(ctx, id, fid); } catch (e) { if (e instanceof ProoflineError) return fid; throw e; }
  return blockingFindingIds(ctx, rec).find((x) => idKey(x) === idKey(fid)) ?? fid;
}

/** `canon_kind ID KIND` @param {Context} ctx @param {string} id @param {string} kind */
export function canonKind(ctx, id, kind) {
  if (!kind.startsWith('waive:') || id === '-') return kind;
  return `waive:${waiveCanon(ctx, id, kind.slice(6))}`;
}

/** `finding_rule_key RECORD FINDING-ID` @param {Context} ctx @param {string} rec @param {string} fid */
function findingRuleKey(ctx, rec, fid) {
  for (const l of fileLines(ctx, rec)) {
    if (!l.startsWith('finding: ')) continue;
    const p = l.slice('finding: '.length).split('|');
    if (p[0] === fid) return asciiLower(p[3] ?? '').replace(/#[0-9a-f]{3,8}/g, '').replace(/[0-9]+/g, '').replace(/[^a-z]+/g, ' ').replace(/^ /, '').replace(/ $/, '');
  }
  return '';
}

/** `waive_group_ids RECORD FINDING-ID`: FINDING-ID first, then the open blocking findings of the same rule. @param {Context} ctx @param {string} rec @param {string} fid */
export function waiveGroupIds(ctx, rec, fid) {
  const k = findingRuleKey(ctx, rec, fid);
  const out = [fid];
  if (k === '') return out;
  for (const x of blockingFindingIds(ctx, rec)) if (x !== fid && findingRuleKey(ctx, rec, x) === k) out.push(x);
  return out;
}

// ---- what an approval is bound to ----------------------------------------------------------------------------------------------------

/** `hash_file FILE` of a file that must exist: a missing file is a shell redirect error. @param {string} file */
function hashFileOrBridge(file) {
  const t = readBytes(file);
  if (t === null) throw new BridgeToShell(`cannot open ${file}`);
  return sha256(t);
}

/** `rationale_line ID`: the justification line of the first DESIGN.md candidate that has it. @param {Context} ctx @param {string} id */
function rationaleLine(ctx, id) {
  for (const c of DESIGN_MD_CANDIDATES) {
    const f = `${ctx.root}/${c}`;
    if (!isFile(f)) continue;
    const t = readBytes(f);
    const line = t === null ? '' : rationaleLineIn(id, t);
    if (line !== '') return line;
  }
  return '';
}

/**
 * `approval_bound ID KIND`: the value an approval of that kind is bound to. `fp` is the content fingerprint approve_kinds computed once for
 * all the kinds of one reply (never read from the environment).
 * @param {Context} ctx @param {string} id @param {string} kind @param {string} [fp]
 */
export function approvalBound(ctx, id, kind, fp = '') {
  if (/^(commit|push|pr|merge|cleanup)$/.test(kind)) return fp !== '' ? fp : ctx.once('fp:full', () => contentFingerprint(ctx, ''));
  switch (kind) {
    case 'report': return hashFileOrBridge(`${sharedDirOf(ctx, 'friction')}/latest.md`);
    case 'batch': return hashFileOrBridge(`${sharedDirOf(ctx, 'batch')}/SUMMARY.md`);
    case 'commands': return hashFileOrBridge(`${sharedDirOf(ctx, 'commands')}/PROPOSAL.tsv`);
    case 'known-issue': return hashFileOrBridge(`${sharedDirOf(ctx, 'known-issues')}/PROPOSAL.tsv`);
    case 'scale': return hashFileOrBridge(`${sharedDirOf(ctx, 'scale')}/PROPOSAL.tsv`);
    case 'rename': return hashFileOrBridge(`${sharedDirOf(ctx, 'rename')}/PROPOSAL.tsv`);
    case 'plan': case 'destructive': case 'single_step': case 'scope': case 'budget': case 'mutation_budget':
      return hashFileOrBridge(`${runDir(ctx, id)}/PLAN.md`);
    case 'tree': return taskPatchFingerprint(ctx, runDir(ctx, id));
    default:
  }
  if (kind.startsWith('reopen:')) return hashFileOrBridge(`${runDir(ctx, id)}/PLAN.md`);
  if (kind.startsWith('rule:')) {
    const r = proc.run('sh', [`${ctx.scripts}/lessons.sh`, 'bound', id, kind.slice(5)], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new BridgeToShell('lessons.sh bound failed');
    return r.stdout.toString('latin1').replace(/\n+$/, '');
  }
  if (kind.startsWith('rationale:')) {
    const t = rationaleLine(ctx, kind.slice(10));
    if (t === '') fail(`DESIGN.md has no non-empty '- ${kind.slice(10)}: <reason>' line under '## Pattern justifications': write the reason first, then ask the user`);
    return sha256(t);
  }
  if (kind.startsWith('waive:')) {
    const fid = kind.slice(6);
    const f = waiveTarget(ctx, id, fid);
    return `${f.slice(f.lastIndexOf('/') + 1)}@${sha256File(f)}#${fid}`;
  }
  return '';
}

// ---- the run's language ------------------------------------------------------------------------------------------------------------

const TR_WORDS = ' ve bir icin bu ile mi degil olarak lutfen yap gerekiyor kadar sonra ama cok var yok ben bunu sunu nasil neden evet hayir onay tamam '.split(' ').filter((w) => w !== '');
const TR_LETTERS = /\xc3[\xa7\xb6\xbc]|\xc4[\x9f\xb1]|\xc5\x9f|\xc3[\x87\x96\x9c]|\xc4[\x9e\xb0]|\xc5\x9e/g;

/** `rl_detect`: `tr` or `en` for a text. @param {string} text a byte string */
export function detectLanguage(text) {
  let a = 0; let b = 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    let l = asciiLower(line);
    a += (l.match(TR_LETTERS) ?? []).length;
    l = ` ${l} `.replace(/[^a-z]+/g, ' ');
    for (const t of TR_WORDS) {
      for (let k = l.indexOf(` ${t} `); k >= 0; k = l.indexOf(` ${t} `)) { b++; l = l.slice(0, k + 1) + l.slice(k + t.length + 2); }
    }
  }
  return a >= 2 || b >= 2 ? 'tr' : 'en';
}

/** `wc -w` @param {string} s */
function wordCount(s) { return s.split(/[ \t\n\v\f\r]+/).filter((w) => w !== '').length; }

/** `run_language [ID]`: `tr` or `en`, the language the script's own questions are printed in (A99, A103). @param {Context} ctx @param {string} id */
export function runLanguage(ctx, id) {
  const taskFile = id === '-' || id === '' ? '' : `${runDir(ctx, id)}/TASK.md`;
  const text = taskFile === '' ? null : readBytes(taskFile);
  if (text !== null) {
    let v = '';
    for (const l of textLines(text)) { const m = new RegExp(`^[Ll]anguage:${WS}*([A-Za-z]*)`).exec(l); if (m) { v = asciiLower(m[1]); break; } }
    if (v === 'tr' || v === 'turkish' || v === 'turkce') return 'tr';
    if (v === 'en' || v === 'english') return 'en';
    const q = textLines(text).filter((l) => new RegExp(`^${WS}*>`).test(l));
    if (wordCount(q.join('\n')) >= 3) return detectLanguage(`${q.join('\n')}\n`);
  }
  for (const n of sortedNames(`${promptsDir(ctx)}/history`, /\.txt$/)) {
    const t = readBytes(`${promptsDir(ctx)}/history/${n}`);
    if (t === null || wordCount(t) < 6) continue;
    return detectLanguage(t);
  }
  return 'en';
}

// ---- several approvals in one message (A202 item 31) ---------------------------------------------------------------------------------

const HEDGE = ' not no never dont cant wont if unless but maybe wait hold however hayir degil yok ama eger ancak fakat sonra bekle emin cancel undo stop ignore nope nah revoke reject withdraw abort halt disregard cannot isnt shouldnt negative refuse deny denied oppose jk iptal vazgectim hmm ';

/** The trimmed text of awk's `trim`. @param {string} s */
const trimSp = (s) => s.replace(/^ +| +$/g, '');

/**
 * `approval_multi_scan TEXTFILE RUNID SHA`: one line per segment, tab separated (`S ok "T|KIND ..." SEGMENT`, `S no REASON SEGMENT`), then `M yes|no SHA [quiet]`.
 * @param {Context} ctx @param {string} text the message (a byte string) @param {string} runId @param {string} sha
 */
export function approvalMultiScan(ctx, text, runId, sha) {
  let max = ctx.config().get('approval.max_per_message', '8');
  if (!/^[0-9]+$/.test(max) || max === '') max = '8';
  let maxN = Number(max.length > 6 ? '8' : max);
  if (!(maxN >= 1 && maxN <= 16)) maxN = 8;
  // constant size: the first 8 KB and 64 lines only (what is beyond is never read as an approval)
  const head = text.slice(0, 8192).split('\n').slice(0, 64).join('\n').replace(/[\t\r]/g, ' ');
  /** @type {Array<[string, string]>} */ const seg = [];
  let fence = false;
  const hl = head.split('\n');
  if (hl[hl.length - 1] === '' && head.endsWith('\n')) hl.pop();
  for (const line of hl) {
    const t = trimSp(line);
    if (/^(```|~~~)/.test(t)) { if (!fence) { fence = true; seg.push(['Q', t.slice(0, 40)]); } else fence = false; continue; }
    if (fence) continue;
    if (t.startsWith('>')) { seg.push(['Q', t.slice(0, 40)]); continue; }
    for (const part of line.split(',')) {
      const s = trimSp(part);
      if (s === '') continue;
      seg.push([s.split(/ +/).filter((w) => w !== '').length > 16 ? 'L' : 'T', s.slice(0, 200)]);
    }
  }
  const no = `M${TAB}no${TAB}${sha}\n`;
  if (seg.length < 2) return no;
  /** @type {string[]} */ const pg = [];
  const pairs = [...new Set(approvalPendingPairs(ctx, runId).map(([t, k]) => `${t} ${k}`))].sort();
  for (const p of pairs) { const [t, k] = [p.slice(0, p.indexOf(' ')), p.slice(p.indexOf(' ') + 1)]; if (k !== '') pg.push(`${t}|${approvalWords(ctx, t, k)}|${k}`); }
  if (pg.length === 0) return no;
  const first = pg[0];
  const ex = approvalSay(ctx, first.slice(0, first.indexOf('|')), first.slice(first.lastIndexOf('|') + 1));
  const pl = approvalPhrases(ctx).split(',').map(approvalNorm);
  let i = 0; let nok = 0; let nnop = 0; let over = 0; let out = ''; let acc = ''; let rj = ''; let veto = false;
  const parse = (/** @type {string} */ p) => { const pt = p.slice(0, p.indexOf('|')); const pr = p.slice(p.indexOf('|') + 1); return { pt, pw: pr.slice(0, pr.indexOf('|')), pk: pr.slice(pr.indexOf('|') + 1) }; };
  for (const [ty, s] of seg) {
    if (ty === 'Q') { out += `S${TAB}no${TAB}quoted or pasted text is never an approval${TAB}${s}\n`; continue; }
    i++;
    if (i > maxN) { over++; continue; }
    let hit = '';
    /** @type {Map<string, boolean>} */ const cache = new Map();
    if (ty === 'T') {
      for (const p of pg) {
        const { pt, pw, pk } = parse(p);
        const key = `${pt}|${pw}`;
        let r = cache.get(key);
        if (r === undefined) { r = textHasApproval(ctx, `${s}\n`, pw, pt); cache.set(key, r); }
        if (r) hit += ` ${pt}|${pk}`;
      }
    }
    if (hit !== '') { nok++; acc += hit; out += `S${TAB}ok${TAB}${hit.slice(1)}${TAB}${s}\n`; continue; }
    const n = approvalNorm(`${s}\n`);
    const neg = n.split(' ').some((w) => w !== '' && HEDGE.includes(` ${w} `));
    const low = ` ${n} `;
    const has = pl.some((w) => w !== '' && low.includes(` ${w} `));
    if (!has) nnop++;
    if (ty === 'T' && (neg || s.includes('?'))) {
      let nm = '';
      for (const p of pg) {
        const { pt, pw, pk } = parse(p);
        for (const w of kindWords(pw).split(/[ \t\n]+/).filter((x) => x !== '')) if (low.includes(` ${w} `)) { nm += ` ${pt}|${pk}`; break; }
      }
      if (nm === '') veto = true; else rj += `${nm}\n`;
    }
    let why;
    if (ty === 'L') why = 'too long to be one approval';
    else if (s.includes('?')) why = 'a question is not an approval';
    else if (neg) why = 'negated, conditional or hedged';
    else if (has) why = `not one exact approval of an open request (type e.g. "${ex}")`;
    else why = 'no approval phrase in it';
    out += `S${TAB}no${TAB}${why}${TAB}${s}\n`;
  }
  if (over > 0) out += `S${TAB}no${TAB}more than ${maxN} approvals in one message (limit ${maxN})${TAB}${over} extra segment(s)\n`;
  let mode = 'no'; let quiet = '';
  for (const a of acc.split(/[ \t\n]+/).filter((x) => x !== '')) if (`\n${rj}`.includes(` ${a}`) || `\n${rj}`.includes(`\n${a}`)) veto = true;
  if (veto) { /* no */ } else if (nok >= 2 || (nok >= 1 && nnop === 0)) mode = 'yes';
  if (mode === 'yes' && nok <= 1) {
    for (const p of pg) { const { pt, pw } = parse(p); if (textHasApproval(ctx, text, pw, pt)) { quiet = 'quiet'; break; } }
  }
  return `${out}M${TAB}${mode}${TAB}${sha}${TAB}${quiet}\n`;
}

/** `approval_scan_latest [RUNID]`: the scan of the newest user prompt capture (its text checked against its hash), or null. @param {Context} ctx @param {string} runId */
export function approvalScanLatest(ctx, runId) {
  const cap = latestCapture(ctx, true);
  if (cap === null) return null;
  const buf = readBytes(cap);
  const text = buf === null ? null : captureField(buf, 'text');
  if (text === null) return null;
  const h = sha256(text);
  if (h !== (captureField(buf ?? '', 'sha256') ?? '')) return null;
  return approvalMultiScan(ctx, text, runId, h);
}

/** `approval_scan_report SCAN NRECORDED`: the user-facing lines of a multi-approval message. @param {string | null} scan @param {number} nrec */
export function approvalScanReport(scan, nrec) {
  if (scan === null || !scan.includes(`M${TAB}yes${TAB}`) || scan.includes(`${TAB}quiet`)) return '';
  let t = 0; let k = 0;
  /** @type {string[]} */ const m = [];
  for (const l of scan.split('\n')) {
    const f = l.split(TAB);
    if (f[0] !== 'S') continue;
    t++;
    if (f[1] === 'ok') k++; else m.push(`multi: not recorded: ${(f[3] ?? '').slice(0, 60)}: ${f[2] ?? ''}`);
  }
  return `multi: ${k} of ${t} segments read as approvals, ${nrec} approval record(s) written\n${m.slice(0, 10).map((x) => `${x}\n`).join('')}`;
}

// ---- the reasons shown with a question -------------------------------------------------------------------------------------------------

/** @param {Context} ctx @param {string} rule */
function lessonText(ctx, rule) {
  const r = proc.run('sh', [`${ctx.scripts}/lessons.sh`, 'text', rule], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.stderr.length) ctx.err(r.stderr.toString('latin1'));
  return r.stdout.toString('latin1').replace(/\n+$/, '');
}

/** `approval_why KIND BOUND [tr]` @param {Context} ctx @param {string} kind @param {string} bound @param {boolean} turkish */
function approvalWhy(ctx, kind, bound, turkish) {
  if (turkish) {
    switch (kind) {
      case 'plan': return bs('denetimli özerklik: plan yalnızca kullanıcı onayından sonra dondurulur');
      case 'destructive': return bs('plan yıkıcı bir veri değişikliği bildiriyor');
      case 'single_step': return bs('yıkıcı değişiklikte expand/contract adımı yok: okuma ile silme arasında durulacak nokta olmadan tek adımda çalışır');
      case 'scope': return bs('değişiklik kapsama yol ekliyor veya görev kimsenin istemediği mevcut bir kusuru düzeltiyor');
      case 'budget': return bs('düzeltme turları bitti: yeniden dondurma yeni bir düzeltme bütçesi başlatır');
      case 'mutation_budget': return bs('test_trust.mutation_budget planın ## Tests ölçütlerinden az: ölçüt başına bir mutant gerekir; bütçe yalnızca bu koşuda artar');
      case 'tree': return bs('çalışma ağacına bu koşunun hiçbir işçi penceresinin kaydetmediği bir değişiklik girdi: onaylarsanız koşu korunur ama bütün kapılar yeni içerik üzerinde yeniden çalışır');
      case 'commit': case 'push': case 'pr': case 'merge': return bs(`içerik ${bound} için teslim açık onay gerektirir`);
      case 'cleanup': return bs('birleştirmeden sonra koşu kanıtı silinir');
      case 'report': return bs('anonim sürtünme raporu GitHub issue olarak yalnızca onayınızla gönderilir');
      case 'known-issue': return bs('bu bulgu, görevin dokunmadığı bir yerde zaten var ve bir takip görevi var: onayınızla bilinen sorun olur ve görevi durdurmaz; yeni bir bulgu ya da dokunulan yer yine engeller; SECRETS ve SECURITY hiçbir zaman listelenmez');
      case 'rename': return bs('sıradaki görev dosyaları yalnızca sizin onayınızla <ID>-<slug>.md adına taşınır; başlamış ya da raporu yayınlanmış görevlere dokunulmaz');
      case 'scale': return bs('bu makine için önerilen timeouts.scale değeri yalnızca sizin onayınızla .agents/config.yaml dosyasına yazılır; bütün süreler birlikte uzar, hiçbir denetim kapanmaz');
      case 'commands': return bs('boş commands.build|test|lint anahtarları için önerilen komutlar yalnızca sizin onayınızla .agents/config.yaml dosyasına yazılır');
      case 'batch': return bs('gece modu: bu tek özet, listelenen görevlerin plan, teslimat ve mutasyon bütçesi onaylarının yerine geçer; başka hiçbir şeyin yerine geçmez');
      default:
    }
    if (kind.startsWith('reopen:')) return bs('başarısız veya engellenmiş koşu yalnızca kullanıcı onayıyla yeniden açılır; plan değişmez, geçmeyen kapılar yeniden çalışır');
    if (kind.startsWith('rule:')) return bs(`kanıttan çıkan ders proje kuralı olur: ${lessonText(ctx, kind.slice(5))}`);
    if (kind.startsWith('rationale:')) return bs('DESIGN.md gerekçesi yalnızca sizin onayınızla bir desen bulgusunu engelleyici olmaktan çıkarır; ajanın yazdığı gerekçe bulguyu geçirmez');
    return bs('bir FAIL bulgusu yalnızca kullanıcının açık talimatıyla feragat edilir');
  }
  switch (kind) {
    case 'plan': return 'supervised autonomy: the plan freezes only after user approval';
    case 'destructive': return 'the plan declares a destructive data change';
    case 'single_step': return 'the destructive change has no expand/contract steps: it would run as one step, with no point to stop between reading and dropping';
    case 'scope': return 'the amendment adds scope paths, or the task fixes a pre-existing defect nobody asked about';
    case 'budget': return 'the fix rounds are exhausted: a refreeze would start a fresh fix budget';
    case 'mutation_budget': return 'test_trust.mutation_budget is below the criteria of PLAN ## Tests (one mutant each is the minimum): the budget is raised for this run only, .agents/config.yaml is not edited';
    case 'tree': return 'a change entered the working tree that no worker window of this run recorded (a failover worker, an editor, another process): you inspect it (agent.sh tree-inspect); accepting it keeps the run, but every gate runs again on the new content; declining leaves the run as it is';
    case 'commit': case 'push': case 'pr': case 'merge': return `delivery of content ${bound} needs explicit approval`;
    case 'cleanup': return 'after the merge the run evidence is deleted';
    case 'report': return 'the anonymous friction report (.agents/local/friction/latest.md) is sent as a GitHub issue only with your approval';
    case 'known-issue': return 'this finding already exists where the task does not touch, and a follow-up task owns it: with your approval it becomes a known issue and stops no task; a new finding or a touched place still blocks; SECRETS and SECURITY are never listed';
    case 'rename': return 'queued task files are renamed to <ID>-<slug>.md only with your approval; a started task or one with a published report is never touched';
    case 'scale': return 'the proposed timeouts.scale for this machine is written into .agents/config.yaml only with your approval; every duration grows together, no check is switched off';
    case 'commands': return 'the proposed commands.build|test|lint are written into .agents/config.yaml only with your approval';
    case 'batch': return 'night mode: this one summary stands in for the plan, delivery and mutation budget approvals of the listed tasks, and for nothing else';
    default:
  }
  if (kind.startsWith('reopen:')) return 'a FAILED or BLOCKED run is reopened only with your approval: the plan stays frozen, only gates that did not pass or whose inputs changed run again, and the fix-round allowance restarts';
  if (kind.startsWith('rule:')) return `a lesson from run evidence becomes a project rule: ${lessonText(ctx, kind.slice(5))}`;
  if (kind.startsWith('rationale:')) return 'a DESIGN.md pattern rationale downgrades a design finding from blocking to info only with your approval; a rationale an agent wrote does not pass the finding';
  return 'a FAIL finding is waived only on explicit user instruction';
}

// ---- request-approval ---------------------------------------------------------------------------------------------------------------

/** The destructive steps of the plan's `## Data` table. @param {string} plan @param {boolean} tr */
function destructiveSteps(plan, tr) {
  /** @type {string[]} */ const out = [];
  let inside = false;
  for (const line of textLines(plan)) {
    if (line.startsWith('## ')) { inside = new RegExp(`^## Data${WS}*$`).test(line); continue; }
    if (!inside || !line.startsWith('|')) continue;
    const f = line.split('|');
    if (f.length < 7) continue;
    const t = (/** @type {number} */ i) => (f[i - 1] ?? '').replace(new RegExp(`^${WS}+|${WS}+$`, 'g'), '');
    if (asciiLower(t(6)) !== 'yes') continue;
    out.push(tr ? bs(`   yıkıcı adım ${t(2)} (${t(3)}): ${t(4)}, hedef ${t(5)}; geri alma: ${t(8)}`) : `   destructive step ${t(2)} (${t(3)}): ${t(4)} on ${t(5)}; rollback: ${t(8)}`);
  }
  return out.join('\n');
}

/** The `rows:` line of the plan's `## Data` (the data at risk). @param {string} plan @param {boolean} tr */
function dataRows(plan, tr) {
  let inside = false;
  for (const line of textLines(plan)) {
    if (line.startsWith('## ')) { inside = new RegExp(`^## Data${WS}*$`).test(line); continue; }
    if (inside && new RegExp(`^${WS}*rows:${WS}*[^ \\t\\n\\v\\f\\r]`).test(line)) {
      return `${tr ? bs('   risk altındaki veri: ') : '   data at risk: '}${line.replace(new RegExp(`^${WS}*`), '').slice(5)}`;
    }
  }
  return '';
}

/** Rows of a one-record TSV proposal. @param {string} file @param {(f: string[]) => string | null} fmt */
function tsvRows(file, fmt) {
  const t = readBytes(file);
  if (t === null) return '';
  return textLines(t).map((l) => fmt(l.split(TAB))).filter((x) => x !== null).join('\n');
}

/** `plan_test_acs FILE`: the number of distinct AC ids of PLAN `## Tests`. @param {string} plan */
export function planTestAcs(plan) {
  const seen = new Set();
  let inside = false;
  for (const line of textLines(plan)) {
    if (line.startsWith('## ')) { inside = line.startsWith('## Tests'); continue; }
    if (!inside) continue;
    const up = line.replace(/[a-z]/g, (c) => c.toUpperCase());
    const m = /^[ \t]*[-*][ \t]+AC-[0-9]+:/.exec(up);
    if (m) seen.add(m[0].replace(/^[^A]*/, '').replace(/-0+/, '-'));
  }
  return seen.size;
}

/** `mutation_budget ID` @param {Context} ctx @param {string} id */
export function mutationBudget(ctx, id) {
  let b = ctx.config().get('test_trust.mutation_budget', '20');
  if (!/^[0-9]+$/.test(b)) b = '20';
  let o = (readBytes(`${runDir(ctx, id)}/mutation_budget`) ?? '').replace(/\n+$/, '');
  if (!/^[0-9]+$/.test(o)) o = '0';
  o = o.replace(/^0+/, '');
  if (o === '') o = '0';
  const led = readBytes(`${runDir(ctx, id)}/LEDGER.log`) ?? '';
  if (!led.split('\n').some((l) => new RegExp(`event=raise-budget .*test_trust.mutation_budget ${o} for this run`).test(l))) o = '0';
  return BigInt(o) > BigInt(b) ? o : b;
}

/** `request_approval ID KIND` @param {Context} ctx @param {string} id0 @param {string} kind0 */
export function requestApproval(ctx, id0, kind0) {
  const id = id0;
  requireLead(ctx);
  approvalTarget(ctx, id, kind0);
  const kind = canonKind(ctx, id, kind0);
  const ad = approvalsDirOf(ctx, id);
  mkdirSync(ad, { recursive: true });
  const n = nextNum(ad);
  const bound = approvalBound(ctx, id, kind);
  const { epoch } = now();
  writeFileSync(`${ad}/${n}-request-${kindSlug(kind)}.yaml`, Buffer.from(`kind: "${kind}"\nbound: "${bound}"\nrequested_at: ${epoch}\n`, 'latin1'));
  forgetFiles(ctx);
  ledgerIf(ctx, id, 'approval-request', '-', '-', `${kind} bound=${bound}`);
  const tr = runLanguage(ctx, id) === 'tr';
  const plan = id === '-' ? null : readBytes(`${runDir(ctx, id)}/PLAN.md`);
  let steps = '';
  let rows = '';
  if (kind === 'destructive') { steps = plan === null ? '' : destructiveSteps(plan, tr); rows = plan === null ? '' : dataRows(plan, tr); }
  if (kind === 'commands') rows = tsvRows(`${sharedDirOf(ctx, 'commands')}/PROPOSAL.tsv`, (f) => (f[0].startsWith('#') ? null : `   commands.${f[0]}: ${f[1] ?? ''}`));
  if (kind === 'known-issue') rows = tsvRows(`${sharedDirOf(ctx, 'known-issues')}/PROPOSAL.tsv`, (f) => `   known issue: ${f[0]} ${f[1] ?? ''}: ${f[2] ?? ''} (follow-up task ${f[3] ?? ''})`);
  if (kind === 'scale') rows = tsvRows(`${sharedDirOf(ctx, 'scale')}/PROPOSAL.tsv`, (f) => `   timeouts.${f[0]}: ${f[1] ?? ''}`);
  if (kind === 'rename') rows = tsvRows(`${sharedDirOf(ctx, 'rename')}/PROPOSAL.tsv`, (f) => `   rename: ${f[0]} -> ${f[1] ?? ''}`);
  if (kind.startsWith('rationale:')) rows = `   rationale line of DESIGN.md: ${rationaleLine(ctx, kind.slice(10))}`;
  if (kind.startsWith('waive:') && id !== '-') {
    let wr = '';
    try { wr = waiveTarget(ctx, id, kind.slice(6)); } catch (e) { if (!(e instanceof ProoflineError)) throw e; }
    if (wr !== '') {
      const wg = waiveGroupIds(ctx, wr, kind.slice(6));
      if (wg.length > 1) rows = `   this one decision covers ${wg.length} findings of the same rule in ${wr.slice(wr.lastIndexOf('/') + 1)}: ${wg.slice(0, 3).join(' ')} ... (detail: that gate record and the report); the lead records it with: agent.sh waive ${id} ${kind.slice(6)} --group --reason TEXT`.replace(' ... (detail', '... (detail');
    }
  }
  if (kind === 'mutation_budget') rows = `   mutation budget: ${mutationBudget(ctx, id)}, PLAN ## Tests criteria: ${planTestAcs(plan ?? '')}`;
  let out = '';
  if (kind === 'batch') out += `QUESTIONS:\n1. Approve the night batch shown above (batch ${bound.slice(0, 12)})?\n`;
  else if (tr) out += bs(`QUESTIONS:\n1. ${id} için ${kind} onaylansın mı?\n`);
  else out += `QUESTIONS:\n1. Approve ${kind} for ${id}?\n`;
  if (steps !== '') out += `${steps}\n`;
  if (rows !== '') out += `${rows}\n`;
  const first = kindWords(kind).split(' ')[0];
  if (tr) {
    out += bs(`   seçenekler: approve | reject (onay için "approve ${first}" yazın, vazgeçmek için "reject")\n   kabul edilen onay sözcükleri: ${bytesBack(approvalPhrases(ctx))} (tür sözcüğüyle birlikte, örn. "approve ${first}"; bunlardan başka yalnızca şu sözcükler: ${APPROVAL_FILLERS}); ya da yanıtın tamamı tek bir tam cümle: ${bytesBack(approvalExample(kind))}; başka herhangi bir sözcük yanıtı belirsiz yapar: onay sayılmaz ve soru yeniden sorulur\n   önerilen: yok (karar kullanıcıya ait)\n   neden: ${bytesBack(approvalWhy(ctx, kind, bound, true))}\n`);
  } else {
    out += `   options: approve | reject\n   accepted answers: ${approvalPhrases(ctx)} (with the kind word, for example "approve ${first}"; besides those only the words: ${bs(APPROVAL_FILLERS)}); or the whole reply as one full sentence: ${approvalExample(kind)}; any other word makes the reply ambiguous: it is not an approval and the question is asked again\n   recommended: none (the user decides)\n   why: ${approvalWhy(ctx, kind, bound, false)}\n`;
  }
  // A202 item 31: several open requests are answered by one message, one exact phrase per comma or line
  const says = [...new Set(approvalPendingPairs(ctx, id).map(([t, k]) => `${t} ${k}`))].sort()
    .map((p) => approvalSay(ctx, p.slice(0, p.indexOf(' ')), p.slice(p.indexOf(' ') + 1)));
  const sy = [...new Set(says)].slice(0, 8).join(',').replace(/,/g, ', ');
  if (sy.includes(',')) out += `   several open requests: one message answers them, one phrase per comma or line: ${sy}\n`;
  ctx.out(out);
  return 0;
}

/** A byte string that is already UTF-8 bytes, taken back to text so that bs() can convert the whole template once. @param {string} s */
function bytesBack(s) { return Buffer.from(s, 'latin1').toString('utf8'); }

// ---- approve -------------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {object} ApproveState
 * @property {string} [multiSha] the capture hash of a prompt that held several approvals
 * @property {string} [multiOk] " TARGET|KIND ..." the segments of it that approve
 * @property {string} [fp] the content fingerprint computed once for a reply with several kinds
 * @property {boolean} tty
 */

/** `quote_block` of `head -n 20`: every line prefixed with `> ` (an empty line `>`). @param {string} text */
function quoteBlock(text) {
  const lines = text.split('\n');
  const endsNl = text.endsWith('\n');
  if (endsNl) lines.pop();
  const first = lines.slice(0, 20);
  const body = first.map((l) => `  ${l === '' ? '>' : `> ${l}`}`).join('\n');
  // `head` and `sed` keep a missing final newline missing (head cutting lines ends the last kept line with one)
  const cut = lines.length > 20;
  return first.length === 0 ? '' : body + (cut || endsNl ? '\n' : '');
}

/**
 * `IFS= read -r line` from the terminal: one line, a blocking read. Node puts descriptor 0 in non-blocking mode as soon as `process.stdin` is
 * touched on a terminal (the entry hands it to the context), so a read can answer EAGAIN while the user is still typing: it waits 25 ms and
 * asks again, never spinning, and gives up (as end of input) after ten minutes. End of input or any other error ends the line.
 */
function readLineFromTty() {
  const buf = Buffer.alloc(1);
  const chunks = [];
  let waited = 0;
  for (;;) {
    let n = 0;
    try { n = readSync(0, buf, 0, 1, null); } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EAGAIN' && waited < 600000) { sleepSync(25); waited += 25; continue; }
      break;
    }
    if (n === 0 || buf[0] === 10) break;
    chunks.push(buf[0]);
  }
  return Buffer.from(chunks).toString('latin1');
}

/**
 * `approve ID KIND`: records ONE approval from the user's newest captured message (or the line typed at a terminal).
 * @param {Context} ctx @param {string} id @param {string} kind0 @param {ApproveState} st
 */
export function approveOne(ctx, id, kind0, st) {
  requireLead(ctx);
  approvalTarget(ctx, id, kind0);
  const kind = canonKind(ctx, id, kind0);
  const req = latestRequest(ctx, id, kind);
  if (req === null) fail(`no approval request for ${kind}: run 'agent.sh request-approval ${id} ${kind}' and relay it to the user first`);
  if (!safeStateFile(ctx, req)) fail(`approval request ${req.slice(req.lastIndexOf('/') + 1)} is not a regular single-link file on a symlink-free path`);
  const reqn = seq3(req, true);
  const slug = kindSlug(kind);
  const ad = approvalsDirOf(ctx, id);
  for (const f of approvalFiles(ctx, id, kind)) {
    if (!(Number(seq3(f) || '0') < Number(seq3(reqn) || '0'))) fail(`request ${req.slice(req.lastIndexOf('/') + 1)} is already approved; request again for a new approval`);
  }
  const bound = approvalBound(ctx, id, kind, st.fp ?? '');
  if (bound !== gateField(ctx, req, 'bound')) fail('the content changed since the approval request; request again');
  const dlv = gateField(ctx, req, 'delivery');
  let words = dlv === '' ? kind : 'delivery';
  const jt = gateField(ctx, req, 'joint');
  if (jt !== '') words = jt;
  let text; let src; let session; let time;
  if (st.tty) {
    ctx.err(`Approve ${kind} for ${id}? Type an approval phrase (${approvalPhrases(ctx)}; for example "approve ${kindWords(kind).split(' ')[0]}"): `);
    ctx.flush();
    text = readLineFromTty();
    src = 'tty'; session = 'tty'; time = String(now().epoch);
  } else {
    const cap = latestCapture(ctx);
    if (cap === null) fail('approval refused: no interactive terminal and no user prompt capture in .agents/local/prompts/');
    const buf = readBytes(cap) ?? '';
    time = captureField(buf, 'time') ?? '';
    session = captureField(buf, 'session') ?? 'unknown';
    const t = captureField(buf, 'text');
    if (t === null) fail('approval refused: capture has no text');
    text = t;
    if (sha256(text) !== (captureField(buf, 'sha256') ?? '')) fail('approval refused: capture sha256 does not match its text');
    if (!(BigInt(time) > BigInt(/^[0-9]+$/.test(gateField(ctx, req, 'requested_at')) ? gateField(ctx, req, 'requested_at') : '0'))) fail('approval refused: the latest user prompt is older than the approval request (stale capture)');
    if (kind.startsWith('waive:')) {
      const rec = bound.slice(0, bound.indexOf('@'));
      let ge = gateField(ctx, `${runDir(ctx, id)}/gates/${rec}`, 'epoch');
      if (!/^[0-9]+$/.test(ge)) ge = String(now().epoch);
      if (!(BigInt(time) > BigInt(ge))) fail(`approval refused: the latest user prompt is older than the failing gate record ${rec}`);
    }
    src = 'prompt_capture';
  }
  const csha = sha256(text);
  // A106: single-use is per capture event (session + time + hash), never per text: the same words answer a later request.
  const cid = `${session}:${time}:${csha}`;
  const multi = st.multiSha === csha && ` ${st.multiOk ?? ''} `.includes(` ${id}|${kind} `);
  if (!textHasApproval(ctx, text, words, id) && !multi) {
    fail(`approval refused: the user's words contain no approval phrase for ${words} (an explicit approval phrase from approval.phrases and the kind word '${kindWords(words)}', and no other word; the question stays pending)`);
  }
  if (src === 'prompt_capture') {
    const re = new RegExp(`^capture_id: "${cid}"`);
    for (const f of approvalFiles(ctx, id, kind)) if (fileLines(ctx, f).some((l) => re.test(l))) fail(`approval refused: this user prompt already granted a ${kind} approval (single-use)`);
  }
  const n = nextNum(ad);
  const file = `${ad}/${n}-${slug}.yaml`;
  const { epoch } = now();
  let body = `kind: "${kind}"\nbound: "${bound}"\nsource: "${src}"\nsession: "${session}"\ncapture_sha256: "${csha}"\ncapture_id: "${cid}"\ncapture_time: ${time}\nrequest: "${req.slice(req.lastIndexOf('/') + 1)}"\nanswered_by: "user"\napproved_at: ${epoch}\nconsumed: "false"\n`;
  if (dlv !== '') body += `delivery: "${dlv}"\n`;
  const ref = gateField(ctx, req, 'ref');
  if (ref !== '') body += `ref: "${ref}"\n`;
  // A171: the user's reply, verbatim, as a quote block (the language check exempts it; the first 20 lines)
  body += `reply: |\n${quoteBlock(text)}`;
  writeFileSync(file, Buffer.from(body, 'latin1'));
  forgetFiles(ctx);
  const tok = id === '-' ? '' : `approvals/${n}-${slug}.yaml@${sha256File(file)} `;
  ledgerIf(ctx, id, 'approval', '-', '-', `${tok}${kind} source=${src} answered_by=user bound=${bound}`);
  ctx.out(`approval recorded: ${id} ${kind} (${src})\n`);
}

/** Is stdin and stdout a terminal (the interactive path of `approve`)? @param {Context} ctx */
export function isTerminal(ctx) { return ctx.io.isProcess === true && isatty(0) && isatty(1); }

/**
 * `approve_kinds ID KIND...`: the user's one reply answers several open requests. A kind that is refused changes nothing and does not stop
 * the next. @param {Context} ctx @param {string} id @param {string[]} kinds
 */
export function approveKinds(ctx, id, kinds) {
  /** @type {ApproveState} */ const st = { tty: isTerminal(ctx) };
  if (!st.tty) {
    const scan = approvalScanLatest(ctx, id);
    if (scan !== null && scan.includes(`M${TAB}yes${TAB}`)) {
      const lines = scan.split('\n').map((l) => l.split(TAB));
      st.multiSha = lines.find((f) => f[0] === 'M')?.[2] ?? '';
      st.multiOk = lines.filter((f) => f[0] === 'S' && f[1] === 'ok').map((f) => `${f[2] ?? ''} `).join('');
    }
  }
  if (kinds.length === 1) { approveOne(ctx, id, kinds[0], st); return 0; }
  requireLead(ctx);
  // everything that can hand the command to the shell code is decided before the first record is written
  for (const k of kinds) {
    if (!validApprovalKind(k) || (id === '-' ? false : !isDir(runDir(ctx, id)))) continue;
    try { approvalBound(ctx, id, canonKind(ctx, id, k), ''); } catch (e) { if (!(e instanceof ProoflineError)) throw e; }
  }
  if (kinds.some((k) => /^(commit|push|pr|merge|cleanup)$/.test(k))) st.fp = ctx.once('fp:full', () => contentFingerprint(ctx, ''));
  let ok = false;
  for (const k of kinds) {
    try { approveOne(ctx, id, k, st); ok = true; } catch (e) {
      if (e instanceof ProoflineError) { ctx.err(`${e.message}\n`); continue; }
      throw e;
    }
  }
  if (!ok) fail(`no approval was recorded: none of the open requests (${kinds.join(' ')}) is answered by the user's latest message`);
  return 0;
}

// ---- consume -------------------------------------------------------------------------------------------------------------------------

/** `consume_approval ID FILE` @param {Context} ctx @param {string} id @param {string} file */
export function consumeApproval(ctx, id, file) {
  const text = readBytes(file) ?? '';
  const lines = text === '' ? [] : text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out = lines.map((l) => (l.startsWith('consumed:') ? 'consumed: "true"' : l));
  writeFileSync(`${file}.tmp`, Buffer.from(`${out.map((l) => `${l}\n`).join('')}consumed_at: ${now().epoch}\n`, 'latin1'));
  renameSync(`${file}.tmp`, file);
  forgetFiles(ctx);
  ledgerIf(ctx, id, 'approval-consumed', '-', '-', `${file.slice(file.lastIndexOf('/') + 1)} ${gateField(ctx, file, 'kind')}`);
}

/** `approval_consume ID KIND [FINGERPRINT [REF...]]` @param {Context} ctx @param {string[]} args */
export function approvalConsume(ctx, args) {
  const [id, kind0, fp = '', ...refs] = args;
  requireLead(ctx);
  approvalTarget(ctx, id, kind0);
  const bound = fp !== '' ? fp : approvalBound(ctx, id, kind0);
  const f = findApproval(ctx, id, kind0, bound);
  if (f === null) fail(`no unconsumed ${kind0} approval bound to ${bound} for ${id}`);
  // A169: an approval that names a ref (a delivery's push, a CI-fix push) covers a push to that ref and to nothing else
  const ref = gateField(ctx, f, 'ref');
  if (ref !== '') {
    if (refs.length === 0) fail(`the ${kind0} approval is for ${ref}; the refs of this push were not given, so it cannot be used`);
    for (const r of refs) if (r !== ref) fail(`the ${kind0} approval is for ${ref}, not for a push to ${r}`);
  }
  consumeApproval(ctx, id, f);
  ctx.out(`approval consumed: ${id} ${kind0} ${f.slice(f.lastIndexOf('/') + 1)}\n`);
  return 0;
}

/**
 * One `agent.sh approve TARGET KIND...` the way approve-pending ran it: its own context and locks, stdin not a terminal, stdout and stderr
 * merged. @param {Context} parent @param {string} target @param {string[]} kinds @returns {{ rc: number, output: string }}
 */
export function approveInChild(parent, target, kinds) {
  /** @type {Buffer[]} */ const sink = [];
  const io = { env: parent.env, cwd: parent.cwd, stdout: { write: (/** @type {Buffer} */ b) => sink.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => sink.push(b) }, scriptPath: parent.scriptPath, isProcess: false, promptCapture: /** @type {{ promptCapture?: unknown }} */ (parent.io).promptCapture };
  const child = new Context(io, parent.scriptPath);
  const locks = new LockSet(child);
  let rc = 0;
  try {
    child.fpMode = 'refresh';
    takeCommandLocks(locks, child, 'approve', [target, ...kinds]);
    rc = approveKinds(child, target, kinds);
    child.flush();
  } catch (e) {
    if (e instanceof BridgeToShell) {
      child.discard();
      locks.releaseAll();
      const r = proc.run('sh', [`${parent.scripts}/agent.sh`, 'approve', target, ...kinds], { cwd: parent.cwd, env: { ...parent.env, PROOFLINE_ENGINE: 'sh' }, stdio: ['ignore', 'pipe', 'pipe'] });
      return { rc: r.status, output: Buffer.concat([r.stdout, r.stderr]).toString('latin1') };
    }
    if (e instanceof ProoflineError) { child.flush(); sink.push(Buffer.from(`${e.message}\n`, 'latin1')); rc = e.exitCode; } else throw e;
  } finally {
    locks.releaseAll();
  }
  return { rc, output: Buffer.concat(sink).toString('latin1') };
}


/**
 * `approval_wait_o REQFILE KIND ID`: the `next` line of a pending approval request. A newer user prompt that is no approval leaves the request
 * pending and the lead asks again (A108); a newer prompt that approves but was not recorded (the hook was cut off) is recorded now (A171).
 * @param {Context} ctx @param {string} req @param {string} kind @param {string} id @param {(m: string) => void} o
 */
export function approvalWaitO(ctx, req, kind, id, o) {
  /** The newest capture when it is newer than the request: its text and whether it approves. */
  const newest = () => {
    const cap = latestCapture(ctx, true);
    if (cap === null) return null;
    const buf = readBytes(cap) ?? '';
    const t = captureField(buf, 'time');
    const asked = gateField(ctx, req, 'requested_at');
    if (t === null || !/^[0-9]+$/.test(t) || !/^[0-9]+$/.test(asked) || !(BigInt(t) > BigInt(asked))) return null;
    return { approves: textHasApproval(ctx, captureField(buf, 'text') ?? '', kind, id) };
  };
  const n = newest();
  if (n !== null && !n.approves) {
    o(`the user's last reply is not an explicit approval (an answer that is ambiguous or a refusal never approves): relay the question again verbatim with its accepted answers: agent.sh request-approval ${id} ${kind} (relay verbatim), then wait for the reply and: agent.sh next ${id}`);
    return;
  }
  if (n !== null) {
    // Stage 3 hardening (deliberately unlike the shell): this reads the newest capture FILE, which a file written by anything that can write
    // .agents/local looks exactly like, so `next` never records an approval from it. The prompt hook records an approval from the prompt event it
    // is handling; a reply it missed is asked for again.
    o(`the user's last reply approves ${kind}, but the prompt hook did not record it (it was cut off, or the reply did not come through the runtime). The lead never records an approval from a file: ask the user to send the approval again (the runtime records it from the reply), then: agent.sh next ${id}`);
    return;
  }
  o(`wait for the user's answer (the runtime records it from their reply; the lead never runs approve), then: agent.sh next ${id}`);
}
