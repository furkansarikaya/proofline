// @ts-check
// Stage 2, package C2: the READ-ONLY part of the approval and batch library of agent.sh (find_approval, safe_state_file, batch_approval,
// the DESIGN.md rationale lines). Nothing here writes an approval: consuming one (`consume_approval`, `approval-consume`) and the batch
// summary writer stay in the shell (stages 3-7); a path that needs them throws BridgeToShell in its command.
import { lstatSync, readdirSync, readdirSync as readDir, statSync } from 'node:fs';
import path from 'node:path';
import { boundNames } from './ledger.mjs';
import { sha256File } from './hash.mjs';
import * as proc from './proc.mjs';
import { isDir as isDirectory, isFile } from './paths.mjs';
import { captureField } from './capture.mjs';
import { WS, gateField, gatesEnforced, readBytes, textLines } from './records.mjs';
import { runDir } from './runs.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const SHARED_NAMES = ['batch', 'approvals', 'metrics', 'friction', 'prompts'];

/** `shared_dir NAME` @param {Context} ctx @param {string} name */
export function sharedDirOf(ctx, name) { return `${ctx.sharedMain()}/.agents/local/${name}`; }

/** `approvals_dir ID`: the shared folder for `-`, else the run's. @param {Context} ctx @param {string} id */
function approvalsDir(ctx, id) { return id === '-' ? sharedDirOf(ctx, 'approvals') : `${runDir(ctx, id)}/approvals`; }

/** `[ -L P ]` @param {string} p */
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

/**
 * `safe_state_file FILE`: a regular file with one hard link, no symlink on its folder chain below the project root (or, for the shared
 * state of a run worktree, below the main tree's shared folders).
 * @param {Context} ctx @param {string} file
 */
export function safeStateFile(ctx, file) {
  if (isLink(file) || !isFile(file)) return false;
  try { const st = statSync(file); if (!st.isFile() || st.nlink !== 1) return false; } catch { return false; }
  let d = path.dirname(file);
  let base = ctx.root;
  const main = ctx.sharedMain();
  const under = (/** @type {string} */ x, /** @type {string} */ r) => x === r || x.startsWith(`${r}/`);
  if (!under(d, ctx.root) && under(d, main)) {
    base = main;
    let ok = SHARED_NAMES.some((n) => under(d, `${main}/.agents/local/${n}`));
    const wp = `${main}/.agents/local/worktrees/`;
    if (d.startsWith(wp)) {
      const w = d.slice(wp.length).split('/')[0];
      const r = proc.run('git', ['-C', main, 'worktree', 'list', '--porcelain'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.stdout.toString('latin1').split('\n').some((l) => l === `worktree ${wp}${w}`)) ok = true;
    }
    if (!ok) return false;
  }
  while (d !== base) {
    if (!d.startsWith(`${base}/`)) return false;
    if (isLink(d)) return false;
    d = path.dirname(d);
  }
  return true;
}

/**
 * `find_approval ID KIND BOUND [DELIVERY]`: the newest unconsumed approval file bound to BOUND, or null. Inside a ledgered run only the
 * approvals the ledger names count.
 * @param {Context} ctx @param {string} id @param {string} kind @param {string} bound @param {string} [delivery]
 */
export function findApproval(ctx, id, kind, bound, delivery = '') {
  const dir = approvalsDir(ctx, id);
  const re = new RegExp(`^[0-9]{3}-${kind.replace(/:/g, '-')}\\.yaml$`);
  let all;
  try { all = readdirSync(dir).filter((n) => re.test(n)).sort().reverse(); } catch { all = []; }
  if (all.length > 0 && id !== '-' && gatesEnforced(ctx, runDir(ctx, id))) {
    all = boundNames(ctx, runDir(ctx, id), 'approvals', 'approval$', all).sort().reverse();
  }
  for (const n of all) {
    const f = `${dir}/${n}`;
    if (!safeStateFile(ctx, f)) continue;
    if (gateField(ctx, f, 'consumed') === 'false' && gateField(ctx, f, 'bound') === bound && (delivery === '' || gateField(ctx, f, 'delivery') === delivery)) return f;
  }
  return null;
}

/** `hash_file FILE` of a file that exists. @param {string} file */
export function hashOf(file) { return sha256File(file); }

/** `batch_approval`: the batch approval file, valid while SUMMARY.md has the hash it is bound to. @param {Context} ctx @returns {string | null} */
export function batchApproval(ctx) {
  const s = `${sharedDirOf(ctx, 'batch')}/SUMMARY.md`;
  if (!isFile(s)) return null;
  const f = findApproval(ctx, '-', 'batch', hashOf(s));
  if (f === null) return null;
  if (gateField(ctx, f, 'answered_by') !== 'user') return null;
  const src = gateField(ctx, f, 'source');
  return src === 'prompt_capture' || src === 'tty' ? f : null;
}

// ---- DESIGN.md pattern justifications (A200) ---------------------------------------------------------------------------------

/** `design_md_candidates` */
export const DESIGN_MD_CANDIDATES = ['DESIGN.md', 'docs/design/DESIGN.md', 'docs/DESIGN.md', 'design/DESIGN.md'];

const reHeading = new RegExp(`^${WS}?${WS}?${WS}?#+${WS}`);
const reItem = new RegExp(`^${WS}*[-*+]${WS}+\`?[a-z][a-z0-9-]*\`?${WS}*:`);

/** @param {string} line the heading is the "pattern justifications" one */
function isJustifications(line) {
  const h = line.replace(new RegExp(`^${WS}*#+${WS}*`), '').replace(new RegExp(`${WS}*#*${WS}*$`), '');
  return h.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) === 'pattern justifications';
}

/**
 * The lines of the "Pattern justifications" section that are `- id: reason` items.
 * @param {string} text @returns {string[]}
 */
function justificationItems(text) {
  /** @type {string[]} */ const out = [];
  let inside = false;
  for (const line of textLines(text)) {
    if (reHeading.test(line)) { inside = isJustifications(line); continue; }
    if (inside && reItem.test(line)) out.push(line);
  }
  return out;
}

/** The sorted unique pattern ids of a DESIGN.md. @param {string} text */
export function rationaleIds(text) {
  const ids = justificationItems(text).map((l) => l.replace(new RegExp(`^${WS}*[-*+]${WS}+`), '').replace(new RegExp(`${WS}*:[^]*$`), '').replace(/`/g, ''));
  return [...new Set(ids)].sort();
}

/** `rationale_line_in ID FILE`: "ID: reason" of the first non-empty justification of ID. @param {string} id @param {string} text */
export function rationaleLineIn(id, text) {
  for (const l0 of justificationItems(text)) {
    const l = l0.replace(new RegExp(`^${WS}*[-*+]${WS}+`), '');
    const k = l.replace(new RegExp(`${WS}*:[^]*$`), '').replace(/`/g, '');
    const v = l.replace(/^[^:]*:/, '').replace(new RegExp(`^${WS}*`), '').replace(new RegExp(`${WS}+$`), '');
    if (k === id && v !== '') return `${id}: ${v}`;
  }
  return '';
}

// ---- Stage 3: the approval grammar, the prompt captures and the kinds (agent.sh 0.0.42 lines 5428-5830) ------------------------------------
// The grammar is the specification of what the user's words approve (A108, A134, A202 item 31). Text is a byte string (latin1): every
// normalisation is ASCII only and locale independent, exactly as the `LC_ALL=C tr | sed` pipelines were.

export const APPROVAL_PHRASES_DEFAULT = 'approve, approved, yes, ok, okay, go ahead, lgtm, commit it, push it, onay, onaylıyorum, onayliyorum, onaylandı, onaylandi, onayladım, onayladim, evet, tamam, olur';
export const APPROVAL_FILLERS = 'the, a, an, it, this, please, for, with, to, and, lütfen, lutfen, bu, planı, plani, için, icin';
const FILLERS_BYTES = Buffer.from(APPROVAL_FILLERS, 'utf8').toString('latin1');

/** `approval_phrases`: approval.phrases, else the built-in English and Turkish list (as a byte string). @param {Context} ctx */
export function approvalPhrases(ctx) { return ctx.config().get('approval.phrases', Buffer.from(APPROVAL_PHRASES_DEFAULT, 'utf8').toString('latin1')); }

const bs = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1');
const PUNCT = /[!"#$%&()*+,./:;<=>?@[\\\]^`{|}~]/g;

/**
 * `approval_norm`: words separated by single spaces. ASCII case folding, apostrophes (' and U+2019) dropped, ASCII punctuation to a space
 * (hyphen and underscore stay), white space squeezed, one leading and one trailing space removed; every other byte passes unchanged.
 * `approval_norm_lines` is the same function applied to each line of a text.
 * @param {string} s a byte string
 */
export function approvalNorm(s) {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)).replace(/'/g, '').split('\xe2\x80\x99').join('')
    .replace(PUNCT, ' ').replace(/[ \t\n\v\f\r]+/g, ' ').replace(/^ /, '').replace(/ $/, '');
}

/** `kind_words KIND` (the words the kind is answered with, before the normalisation). @param {string} kind */
export function kindWords(kind) {
  switch (kind) {
    case 'destructive': return 'destructive migration delete drop';
    case 'single_step': return bs('single step single-step one step tek adım tek adim');
    case 'budget': return 'budget round rounds';
    case 'mutation_budget': return 'mutation budget mutants';
    case 'report': return bs('friction report sürtünme surtunme raporu raporunu');
    case 'pr': return 'pr pull request';
    case 'delivery': return bs('delivery teslimat teslimatı teslimati');
    case 'known-issue': return bs('known issue known issues known-issue bilinen sorun');
    default:
  }
  const low = (/** @type {string} */ x) => x.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  if (kind.startsWith('rule:')) return `rule ${kind.slice(5)}`;
  if (kind.startsWith('rationale:')) return `rationale ${low(kind.slice(10))}`;
  if (kind.startsWith('reopen:')) return `reopen ${low(kind.slice(7))}`;
  if (kind.startsWith('waive:')) return low(kind.slice(6));
  return kind;
}

/** `kind_slug` @param {string} kind */
export function kindSlug(kind) { return kind.replace(/:/g, '-'); }

/** `valid_approval_kind` @param {string} k */
export function validApprovalKind(k) {
  if (/^(plan|destructive|single_step|scope|budget|mutation_budget|tree|commit|push|pr|merge|cleanup|report|batch|commands|rename|known-issue|scale)$/.test(k)) return true;
  const m = /^(waive|rule|reopen|rationale):([^]*)$/.exec(k);
  return m !== null && /^[A-Za-z0-9_.+-]+$/.test(m[2]);
}

/**
 * `approval_sentences KIND [RUNID]`: the full approval sentences of a kind, English then Turkish (ASCII variants too), one entry each.
 * @param {string} kind @param {string} [runId] @returns {string[]}
 */
export function approvalSentences(kind, runId = '-') {
  let id = kind;
  for (const p of ['waive:', 'rule:', 'reopen:', 'rationale:']) if (id.startsWith(p)) id = id.slice(p.length);
  /** @type {string} */ let en; /** @type {string} */ let tr;
  switch (kind) {
    case 'plan': en = 'the plan'; tr = 'planı|plani'; break;
    case 'destructive': en = 'the destructive step|the destructive change'; tr = 'yıkıcı adımı|yikici adimi|yıkıcı değişikliği|yikici degisikligi'; break;
    case 'single_step': en = 'the single step'; tr = 'tek adımı|tek adimi'; break;
    case 'scope': en = 'the scope'; tr = 'kapsamı|kapsami'; break;
    case 'mutation_budget': en = 'the mutation budget'; tr = 'mutasyon bütçesini|mutasyon butcesini'; break;
    case 'tree': en = 'the tree|the working tree|the change in the tree'; tr = 'çalışma ağacını|calisma agacini|ağacı|agaci'; break;
    case 'budget': en = 'the budget|another round'; tr = 'bütçeyi|butceyi|bir round daha'; break;
    case 'cleanup': en = 'the cleanup'; tr = 'temizliği|temizligi'; break;
    case 'commands': en = 'the commands'; tr = 'komutları|komutlari'; break;
    case 'known-issue': en = 'the known issue|the known issues'; tr = 'bilinen sorunu|bilinen sorunları|bilinen sorunlari'; break;
    case 'rename': en = 'the renames|the rename'; tr = 'yeniden adlandırmayı|yeniden adlandirmayi'; break;
    case 'scale': en = 'the scale|the timeout scale'; tr = 'ölçeği|olcegi'; break;
    case 'report': en = 'the friction report'; tr = 'sürtünme raporunu|surtunme raporunu'; break;
    case 'commit': en = 'the commit'; tr = "commit'i"; break;
    case 'push': en = 'the push'; tr = "push'u"; break;
    case 'pr': en = 'the pull request'; tr = "pull request'i"; break;
    case 'merge': en = 'the merge'; tr = "merge'i"; break;
    case 'delivery': en = 'the delivery'; tr = 'teslimatı|teslimati'; break;
    default:
      if (kind.startsWith('waive:')) { en = `the waiver of ${id}`; tr = bs(`${id} feragatini`); break; }
      if (kind.startsWith('rule:')) { en = `the rule ${id}`; tr = bs(`${id} kuralını`); break; }
      if (kind.startsWith('rationale:')) { en = `the rationale ${id}`; tr = bs(`${id} gerekçesini|${id} gerekcesini`); break; }
      if (kind.startsWith('reopen:')) { en = `the reopen of ${id}`; tr = bs(`${id} yeniden açılışını|${id} yeniden acilisini`); break; }
      return [];
  }
  const run = /^(waive|rule|reopen|rationale):/.test(kind) || runId === '-' ? '' : runId;
  /** @type {string[]} */ const out = [];
  for (const o of bs(en).split('|')) {
    out.push(`i approve ${o}`, `i approved ${o}`);
    if (run !== '') out.push(`i approve ${o} for ${run}`, `i approved ${o} for ${run}`);
  }
  for (const o of bs(tr).split('|')) {
    out.push(bs(`${o} onaylıyorum`), bs(`${o} onayliyorum`), bs(`${o} onayladım`), bs(`${o} onayladim`));
    if (run !== '') out.push(bs(`${run} için ${o} onaylıyorum`), bs(`${run} icin ${o} onayliyorum`), bs(`${run} için ${o} onayladım`), bs(`${run} icin ${o} onayladim`));
  }
  return out;
}

/** `approval_example KIND`: `"English sentence" | "Turkish sentence"`, first letters upper case. @param {string} kind */
export function approvalExample(kind) {
  const cap = (/** @type {string} */ s) => (s === '' ? '' : s[0].replace(/[a-z]/, (c) => c.toUpperCase()) + s.slice(1));
  const all = approvalSentences(kind);
  const tr = all.find((l) => l.endsWith(bs(' onaylıyorum'))) ?? '';
  return `"${cap(all[0] ?? '')}" | "${cap(tr)}"`;
}

/**
 * `text_has_approval TEXTFILE KIND [RUNID]` on the text itself: a positive grammar (A108). After normalisation every word must be a word of an
 * allowlisted phrase, of the kind's own words or a filler; the reply holds a whole phrase and a kind word, and no question mark. Any other word
 * makes it ambiguous. A reply equal to a full approval sentence of the kind approves as it is.
 * @param {Context} ctx @param {string} rawText the text as read from the file (a byte string) @param {string} kind @param {string} [runId]
 */
export function textHasApproval(ctx, rawText, kind, runId = '') {
  const raw = rawText.replace(/\n+$/, '');
  if (raw.includes('?')) return false;
  const n = approvalNorm(`${raw}\n`);
  if (n === '') return false;
  const low = ` ${n} `;
  const full = approvalSentences(kind, runId === '' ? '-' : runId).map(approvalNorm);
  if (full.includes(n)) return true;
  const pl = approvalPhrases(ctx).split(',').map(approvalNorm);
  const kw = approvalNorm(`${kindWords(kind)}\n`);
  const ok = ` ${pl.join(' ').replace(/ +$/, '')} ${kw} ${approvalNorm(`${FILLERS_BYTES}\n`)} `;
  // `tha_pl` is a command substitution: trailing newlines are gone, so a trailing empty phrase vanishes with them
  const okWords = new Set(ok.split(' ').filter((w) => w !== ''));
  for (const t of n.split(' ')) if (!okWords.has(t)) return false;
  let hit = false;
  for (const p of pl) { if (p !== '' && low.includes(` ${p} `)) { hit = true; break; } }
  if (!hit) return false;
  return kw.split(' ').some((w) => w !== '' && low.includes(` ${w} `));
}

// ---- prompt captures -----------------------------------------------------------------------------------------------------------------

/** `shared_dir prompts` @param {Context} ctx */
export function promptsDir(ctx) { return sharedDirOf(ctx, 'prompts'); }

/**
 * `latest_capture`: the capture file with the greatest time, or null. Any unsafe capture file refuses every capture (the message goes to
 * stderr unless `quiet`). @param {Context} ctx @param {boolean} [quiet] @returns {string | null}
 */
export function latestCapture(ctx, quiet = false) {
  let best = ''; let bestT = -1n;
  /** @type {string[]} */ let names = [];
  try { names = readDir(promptsDir(ctx)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort(); } catch { names = []; }
  for (const n of names) {
    const f = `${promptsDir(ctx)}/${n}`;
    if (!safeStateFile(ctx, f)) {
      if (!quiet) ctx.err(`prompt capture ${f.startsWith(`${ctx.root}/`) ? f.slice(ctx.root.length + 1) : f} is not a regular single-link file on a symlink-free path; refusing every capture\n`);
      return null;
    }
    const buf = readBytes(f);
    const v = buf === null ? null : captureField(buf, 'time');
    if (v === null || !/^[0-9]+$/.test(v)) continue;
    if (BigInt(v) > bestT) { bestT = BigInt(v); best = f; }
  }
  return best === '' ? null : best;
}

/** `capture_field FILE KEY` @param {string} file @param {string} key @returns {string | null} */
export function captureFieldOf(file, key) { const b = readBytes(file); return b === null ? null : captureField(b, key); }

// ---- request files and the open requests ----------------------------------------------------------------------------------------------

/** `approvals_dir ID` @param {Context} ctx @param {string} id */
export function approvalsDirOf(ctx, id) { return id === '-' ? sharedDirOf(ctx, 'approvals') : `${runDir(ctx, id)}/approvals`; }

/** The names of a folder that match, sorted in byte order. @param {string} dir @param {RegExp} re */
export function sortedNames(dir, re) {
  try { return readDir(dir).filter((n) => re.test(n)).sort(); } catch { return []; }
}

/** `seq3 FILE [raw]`: the first three characters of the file's name. @param {string} file @param {boolean} [raw] */
export function seq3(file, raw = false) {
  const b = file.slice(file.lastIndexOf('/') + 1);
  const s = b.length >= 3 ? b.slice(0, 3) : b;
  return raw ? s : s.replace(/^0+/, '');
}

/** `latest_request ID KIND`: the newest request file, or null. @param {Context} ctx @param {string} id @param {string} kind */
export function latestRequest(ctx, id, kind) {
  const dir = approvalsDirOf(ctx, id);
  // the slug is inserted into an ERE unescaped, as agent.sh does (a `.` or `+` of a kind keeps its regular-expression meaning)
  const re = new RegExp(`^[0-9]{3}-request-${kindSlug(kind)}\\.yaml$`);
  const names = sortedNames(dir, re);
  return names.length === 0 ? null : `${dir}/${names[names.length - 1]}`;
}

/** The approval files of a kind (not requests): `NNN-<slug>.yaml`. @param {Context} ctx @param {string} id @param {string} kind */
export function approvalFiles(ctx, id, kind) {
  const dir = approvalsDirOf(ctx, id);
  const slug = kindSlug(kind);
  return sortedNames(dir, /^[0-9]{3}-/).filter((n) => n === `${n.slice(0, 3)}-${slug}.yaml`).map((n) => `${dir}/${n}`);
}

/**
 * `pending_request ID KIND`: the latest request file, only while no approval of that kind answers it (A155).
 * @param {Context} ctx @param {string} id @param {string} kind @returns {string | null}
 */
export function pendingRequest(ctx, id, kind) {
  const r = latestRequest(ctx, id, kind);
  if (r === null) return null;
  const n = Number(seq3(r) || '0');
  for (const f of approvalFiles(ctx, id, kind)) if (Number(seq3(f) || '0') >= n) return null;
  return r;
}

/**
 * `approval_pending_pairs [RUNID]`: [target, kind] of every open request of the run and of the no-run scope.
 * @param {Context} ctx @param {string} runId @returns {Array<[string, string]>}
 */
export function approvalPendingPairs(ctx, runId) {
  /** @type {Array<[string, string]>} */ const out = [];
  for (const t of [runId, '-']) {
    if (t === '') continue;
    if (t !== '-' && !isDirectory(runDir(ctx, t))) continue;
    const dir = approvalsDirOf(ctx, t);
    for (const n of sortedNames(dir, /^[0-9]{3}-request-.*\.yaml$/)) {
      const f = `${dir}/${n}`;
      if (!isFile(f)) continue;
      const k = gateField(ctx, f, 'kind');
      if (!validApprovalKind(k)) continue;
      if (pendingRequest(ctx, t, k) === null) continue;
      out.push([t, k]);
    }
  }
  return out;
}

/** `approval_words TARGET KIND`: the words the open request is answered with. @param {Context} ctx @param {string} target @param {string} kind */
export function approvalWords(ctx, target, kind) {
  const r = latestRequest(ctx, target, kind);
  if (r === null) return kind;
  let w = kind;
  if (gateField(ctx, r, 'delivery') !== '') w = 'delivery';
  const j = gateField(ctx, r, 'joint');
  if (j !== '') w = j;
  return w;
}

/** `approval_say TARGET KIND`: the exact phrase to type for that open request. @param {Context} ctx @param {string} target @param {string} kind */
export function approvalSay(ctx, target, kind) {
  const w = approvalWords(ctx, target, kind);
  if (/^(rule|reopen|rationale):/.test(w)) return `approve ${kindWords(w)}`;
  return `approve ${kindWords(w).split(' ')[0]}`;
}

/** `tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//'` @param {string} s */
export function approvalNormSpace(s) { return s.replace(/[ \t\n\v\f\r]+/g, ' ').replace(/^ /, '').replace(/ $/, ''); }

/** `quote_block` over a whole text: every line prefixed `> ` (an empty line `>`); a missing final newline stays missing, as sed leaves it. @param {string} text */
export function quoteLines(text) {
  if (text === '') return '';
  const lines = text.split('\n');
  const endsNl = text.endsWith('\n');
  if (endsNl) lines.pop();
  return lines.map((l) => (l === '' ? '>' : `> ${l}`)).join('\n') + (endsNl ? '\n' : '');
}
