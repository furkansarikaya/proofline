// @ts-check
// The kill guard (A156, A161): port of proofline-hook.sh `kill_guard` (lines 1668-2160).
//
// A process is stopped only by the PID of one the agent started itself. Denied for every caller, a run open or not, proofline installed or not:
// pkill, killall, skill, slay, fuser -k, `kill` aimed at everything (-1, 0 in any spelling) and `kill` whose PIDs come from pgrep / pidof / ps / lsof /
// fuser (substitution, xargs, variable, loop, find -exec); also the text of interpreter code, here-documents and script files the command runs
// (A161). A tripwire against an honest mistake, not a security boundary.
//
//   killGuard(ctx, cmd, scan)   scan = scanCommand(cmd); calls deny(reason) (throws Deny) with the shell's text; returns undefined to allow.
//
// The shell ran every nested text in a $(...) subshell: KgNo is its `exit 1` with the printed reason, KgPass its `exit 0` (the time budget is spent
// and the text holds no kill word: that subshell, and only it, passes).
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { cmdSubst } from '../lib/text.mjs';
import { scanText } from '../command-scan.mjs';
import { bn, dn, deny, globMatch, grepq } from './kit.mjs';

const KG_MSG = 'kill only a process you started yourself, by its PID (kill <pid>, kill $!); pkill, killall and kill by pattern, by name, by port or by a process search are forbidden (A156, A161)';
const KG_TXT = 'Text in code or a script that contains a kill-by-name word (pkill, killall, slay, fuser -k) cannot be told from a command the code runs, so it is denied even when the code only prints or matches it; if the user really wants this command, the user can run it themselves with the ! prefix in the terminal';
const NAMECH = 'A-Za-z0-9_';
const KG_VERB = /(^|[^A-Za-z0-9_.$-])(pkill|killall5?|slay)([^A-Za-z0-9_-]|$)/;
const KG_LIT = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;
const SEARCH_RE = /(^|[^A-Za-z0-9_.$-])(pgrep|pidof|ps|lsof|fuser|pkill)([^A-Za-z0-9_-]|$)/;

class KgNo extends Error { /** @param {string} m */ constructor(m) { super(m); this.msg = m; } }
class KgPass extends Error {}

/** @param {string} why @returns {never} */
function kgNo(why) { throw new KgNo(`${why}: ${KG_MSG}`); }

/** @param {string} w */
function isSearch(w) { return ['pgrep', 'pidof', 'ps', 'lsof', 'fuser', 'pkill', 'netstat', 'ss', 'pstree', 'jps'].includes(w); }

/** Lines the way a here-document feeds `read`: the text split at newlines (an empty text is one empty line). @param {string} s */
const argLines = (s) => s.split('\n');

/** @param {string} s */
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Does STR mention the variable T as `$T` (not followed by a name character) or `${T` followed by anything but a name character? @param {string} str @param {string} t */
function refsVar(str, t) {
  const e = reEsc(t);
  return new RegExp(`\\$${e}($|[^${NAMECH}])`).test(str) || new RegExp(`\\$\\{${e}[^${NAMECH}]`).test(str);
}

// ---- shell arithmetic for kg_num: constants only ----

/** `$(( EXPR ))` of constants as the shell computes it; null when the shell would fail. @param {string} src @returns {string | null} */
function arith(src) {
  /** @type {Array<{ t: string, v?: bigint }>} */
  const toks = [];
  for (let i = 0; i < src.length;) {
    const c = /** @type {string} */ (src[i]);
    if (c === ' ') { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < src.length && /[0-9]/.test(/** @type {string} */ (src[j]))) j++;
      const lit = src.slice(i, j);
      let v;
      if (lit.length > 1 && lit[0] === '0') { if (/[89]/.test(lit)) return null; v = BigInt(`0o${lit.slice(1)}`); } else v = BigInt(lit);
      toks.push({ t: 'n', v }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<<', '>>', '&&', '||'].includes(two)) { toks.push({ t: two }); i += 2; continue; }
    if ('+-*/%<>&|^~!()'.includes(c)) { toks.push({ t: c }); i++; continue; }
    return null;
  }
  let p = 0;
  const wrap = (/** @type {bigint} */ v) => BigInt.asIntN(64, v);
  const peek = () => toks[p]?.t;
  /** @returns {bigint} */
  const prim = () => {
    const k = toks[p];
    if (!k) throw new Error('syntax');
    if (k.t === 'n') { p++; return /** @type {bigint} */ (k.v); }
    if (k.t === '(') { p++; const v = lor(); if (peek() !== ')') throw new Error('syntax'); p++; return v; }
    if (k.t === '+') { p++; return prim(); }
    if (k.t === '-') { p++; return wrap(-prim()); }
    if (k.t === '~') { p++; return wrap(~prim()); }
    if (k.t === '!') { p++; return prim() === 0n ? 1n : 0n; }
    throw new Error('syntax');
  };
  /** @param {() => bigint} next @param {string[]} ops @param {(op: string, a: bigint, b: bigint) => bigint} f */
  const level = (next, ops, f) => () => {
    let a = next();
    while (ops.includes(/** @type {string} */ (peek()))) { const op = /** @type {string} */ (peek()); p++; a = wrap(f(op, a, next())); }
    return a;
  };
  const mul = level(prim, ['*', '/', '%'], (op, a, b) => { if (op === '*') return a * b; if (b === 0n) throw new Error('div'); return op === '/' ? a / b : a % b; });
  const add = level(mul, ['+', '-'], (op, a, b) => (op === '+' ? a + b : a - b));
  const shf = level(add, ['<<', '>>'], (op, a, b) => { if (b < 0n || b > 63n) throw new Error('shift'); return op === '<<' ? a << b : a >> b; });
  const cmp = level(shf, ['<', '>'], (op, a, b) => (op === '<' ? (a < b ? 1n : 0n) : (a > b ? 1n : 0n)));
  const band = level(cmp, ['&'], (_o, a, b) => a & b);
  const bxor = level(band, ['^'], (_o, a, b) => a ^ b);
  const bor = level(bxor, ['|'], (_o, a, b) => a | b);
  const land = level(bor, ['&&'], (_o, a, b) => (a !== 0n && b !== 0n ? 1n : 0n));
  const lor = level(land, ['||'], (_o, a, b) => (a !== 0n || b !== 0n ? 1n : 0n));
  try {
    const v = lor();
    if (p !== toks.length) return null;
    return v.toString();
  } catch { return null; }
}

/** `kg_num WORD`: the integer a literal (00, +0, -01) or constant arithmetic ($((1-1))) stands for; '' otherwise. @param {string} word */
function kgNum(word) {
  let kn = word;
  if (kn.startsWith('$((') && kn.endsWith('))') && kn.length >= 5) {
    const e = kn.slice(3, -2);
    if (e === '' || /[^0-9+*/%\\ ()<>&|^~!-]/.test(e)) return '';
    const v = arith(e.replace(/\\/g, ''));
    if (v === null) return '';
    kn = v;
  }
  let s = ''; let d = kn;
  if (d.startsWith('+') || d.startsWith('-')) { s = d[0] ?? ''; d = d.slice(1); }
  if (d === '' || /[^0-9]/.test(d)) return '';
  d = d.replace(/^0+/, '');
  if (d === '') d = '0';
  if (s === '-' && d !== '0') d = `-${d}`;
  return d;
}

/**
 * @param {import('../lib/context.mjs').HookContext} ctx
 * @param {string} cmd the command text @param {import('../command-scan.mjs').ScanResult} scan
 */
export async function killGuard(ctx, cmd, scan) {
  const k = new Kill(ctx);
  try { k.run(scan, 0, false); } catch (e) {
    if (e instanceof KgNo) deny(e.msg);
    if (e instanceof KgPass) return;
    throw e;
  }
  void cmd;
}

class Kill {
  /** @param {import('../lib/context.mjs').HookContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    const b = Number(ctx.env.PROOFLINE_KG_BUDGET ?? '20');
    this.budget = /^[0-9]+$/.test(ctx.env.PROOFLINE_KG_BUDGET ?? '20') && Number.isFinite(b) ? b : 20;
    this.t0 = Math.floor(ctx.t0 / 1000);
  }

  /** `kg_check_time`: after the budget the guard decides itself: a kill word is denied, anything else passes (this subshell). @param {string} text */
  checkTime(text) {
    if (Math.floor(Date.now() / 1000) - this.t0 < this.budget) return;
    if (/kill|slay|fuser/.test(text)) kgNo(`the guard ran out of time (${this.budget}s) reading a command or script that names a kill verb, and cannot clear it; split the command or run it from a short script`);
    throw new KgPass();
  }

  /** `kg_text` (inside its own subshell). @param {string} text @param {number} depth */
  text(text, depth) {
    if (depth >= 5) return;
    try {
      const t = `${text}\n`;
      this.checkTime(t);
      this.run(scanText(t), depth + 1, true);
    } catch (e) { if (!(e instanceof KgPass)) throw e; }
  }

  /** `kg_sub`: a nested text; a refusal passes up unchanged. @param {string} text @param {number} depth */
  sub(text, depth) { this.text(text, depth); }

  /** `kg_file_ok PATH`: the resolved path of a text file the guard may read, else ''. @param {string} p */
  fileOk(p) {
    let kf = p.startsWith('/') ? p : `${this.ctx.cwd}/${p}`;
    try { const st = lstatSync(kf); if (st.isSymbolicLink() || !st.isFile()) return ''; } catch { return ''; }
    try { if (!statSync(kf).isFile()) return ''; } catch { return ''; }
    let d;
    try { d = realpathSync.native(dn(kf)); } catch { return ''; }
    kf = `${d}/${bn(kf)}`;
    if (kf.includes('/node_modules/') || kf.startsWith(`${this.ctx.root}/.git/`)) return '';
    let kt = '/nonexistent';
    try { kt = realpathSync.native(this.ctx.env.TMPDIR || '/nonexistent'); } catch { /* keep */ }
    if (!(kf.startsWith(`${this.ctx.root}/`) || kf.startsWith(`${kt}/`) || /^\/(tmp|private\/tmp|var\/folders|private\/var\/folders)\//.test(kf))) return '';
    try {
      const st = statSync(kf);
      if (st.size > 262144) return '';
      const buf = readFileSync(kf);
      if (buf.includes(0) || !buf.some((b) => b !== 10)) return '';
    } catch { return ''; }
    return kf;
  }

  /** @param {string} p @param {string} cd */
  rp(p, cd) { return p.startsWith('/') || p.startsWith('~') || p === '' ? p : (cd !== '' ? `${cd}/${p}` : p); }

  /** `kg_has_words`: could TEXT hold a kill rule at all? @param {string} t */
  hasWords(t) { return grepq(/kill|slay|fuser|(^|[;&|({]|then|do|else)[ \t\n\v\f\r]*\$[A-Za-z_{(]/, t.replace(/['"\\]/g, '')); }

  /** `kg_script LANG TEXT` @param {string} lang @param {string} text @param {string} spath @param {boolean} searched @param {number} depth */
  script(lang, text, spath, searched, depth) {
    if (!this.hasWords(text)) return;
    let l = lang;
    if (l === 'auto') {
      const h = text.split('\n')[0] ?? '';
      if (/^#!.*python/.test(h)) l = 'python';
      else if (/^#!.*(node|deno|bun)/.test(h)) l = 'node';
      else if (/^#!.*perl/.test(h)) l = 'perl';
      else if (/^#!.*ruby/.test(h)) l = 'ruby';
      else if (/^#!.*php/.test(h)) l = 'php';
      else if (h.startsWith('#!')) l = 'sh';
      else if (spath.endsWith('.py')) l = 'python';
      else if (/\.(js|mjs|cjs)$/.test(spath)) l = 'node';
      else if (spath.endsWith('.pl')) l = 'perl';
      else if (spath.endsWith('.rb')) l = 'ruby';
      else l = 'sh';
    }
    if (l === 'sh') this.sub(text, depth); else this.chkCode(l, text, searched, depth);
  }

  /** `kg_chk_code` @param {string} lang @param {string} text @param {boolean} searched @param {number} depth */
  chkCode(lang, text, searched, depth) {
    try { this.code(lang, text, searched, depth); } catch (e) {
      if (e instanceof KgNo) throw new KgNo(e.msg.includes(KG_TXT) ? e.msg : `${e.msg}. ${KG_TXT}`);
      throw e;
    }
  }

  /** `kg_code LANG TEXT` @param {string} l @param {string} t @param {boolean} searched @param {number} depth */
  code(l, t, searched, depth) {
    if (depth >= 5) return;
    const g = (/** @type {RegExp} */ re) => grepq(re, t);
    // awk is denied only where it can run a command
    if (l === 'awk' && !g(/system[ \t\n\v\f\r]*\(|\|&|\|[ \t\n\v\f\r]*getline|(print|printf)[^/]*\|[ \t\n\v\f\r]*["A-Za-z_$]/)) return;
    if (g(KG_VERB)) kgNo(`${l} code runs pkill, killall or slay`);
    if (g(/(^|[^A-Za-z0-9_$-])fuser[^A-Za-z0-9]+-[A-Za-z]*k/)) kgNo(`${l} code runs fuser -k`);
    const z = '([+-]?0+|-[ \\t\\n\\v\\f\\r]*0*1)';
    /** @type {string} */ let re = '';
    switch (l) {
      case 'python': re = `os\\.kill(pg)?\\([ \\t\\n\\v\\f\\r]*${z}[ \\t\\n\\v\\f\\r]*[,)]|os\\.killpg\\([ \\t\\n\\v\\f\\r]*os\\.getpgrp\\(`; break;
      case 'node': re = `process\\.kill\\([ \\t\\n\\v\\f\\r]*${z}[ \\t\\n\\v\\f\\r]*[,)]`; break;
      case 'ruby': re = `Process\\.kill[ \\t\\n\\v\\f\\r(][^,)]*,[ \\t\\n\\v\\f\\r]*${z}[ \\t\\n\\v\\f\\r]*([,)]|$)`; break;
      case 'perl': re = `(^|[^A-Za-z0-9_$.>-])kill[ \\t\\n\\v\\f\\r(]*[^,;)]*,[ \\t\\n\\v\\f\\r]*${z}[ \\t\\n\\v\\f\\r]*([,;)]|$)`; break;
      default: re = '';
    }
    if (re !== '' && g(new RegExp(re))) kgNo(`${l} code signals every process (pid 0 or -1)`);
    if (g(/process_iter/) && g(/\.(kill|terminate)\(/)) kgNo(`${l} code kills processes it finds by listing them`);
    const killCall = /(os|process|Process|signal)\.(kill|killpg)|(^|[^A-Za-z0-9_$.])kill([^A-Za-z0-9_]|$)/;
    if (g(killCall) && g(/(^|[^A-Za-z0-9_.$-])(pgrep|pidof|lsof)([^A-Za-z0-9_-]|$)/)) kgNo(`${l} code kills PIDs it takes from pgrep, pidof or lsof`);
    if (searched && g(killCall) && !g(/(^|[^A-Za-z0-9_])(Popen|spawn|spawnSync|fork|execFile|subprocess\.run|child_process)|\.pid([^A-Za-z0-9_]|$)/)) kgNo(`${l} code kills PIDs a process search earlier in the command produced`);
    // string literals are command lines
    const lits = t.split('\n').flatMap((ln) => ln.match(KG_LIT) ?? []).slice(0, 60);
    let kk = '';
    for (const lit of lits) {
      const s = lit.slice(1, -1);
      if (s === '') continue;
      if (/kill|slay|fuser/.test(s)) this.sub(s, depth + 1);
      if (s === 'kill') kk = 'kill'; else if (kk !== '' && kk.length < 80) kk = `${kk} ${s}`;
    }
    if (kk !== '') this.sub(kk, depth + 1);
  }

  /**
   * `kg_run`: the scan records of one text. @param {import('../command-scan.mjs').ScanResult} scan @param {number} depth
   * @param {boolean} nested
   */
  run(scan, depth, nested) {
    void nested;
    const dec = scan.records.map((r) => ({ kind: r.kind, s: `${r.kind}\t${Buffer.from(r.raw, 'latin1').toString('utf8')}` }));
    /** @type {Array<[string, string]>} */ const runs = [];
    /** @type {Array<[string, string, string]>} */ const hdoc = [];
    /** @type {string[]} */ const kge = [];
    // variables the command assigns (env export local declare readonly typeset)
    /** @type {Map<string, string>} */ const tbl = new Map();
    for (const r of scan.records) {
      if (r.kind !== 'C') continue;
      const raw = Buffer.from(r.raw, 'latin1').toString('utf8');
      const t = raw.indexOf('\t');
      if (t < 0) continue;
      if (!['env', 'export', 'local', 'declare', 'readonly', 'typeset'].includes(raw.slice(0, t))) continue;
      for (const a of raw.slice(t + 1).split('\x03')) if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && !a.includes('\x02')) tbl.set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
    }
    let prev = ''; let pend = false; let searched = false; let find = false; let cand = ''; let taint = ''; let fpath = ''; let stdin = '';
    let w1 = ''; let viax = false; let cwdv = ''; let nrec = 0;
    let psub = false;
    if (dec.some((r) => r.s.startsWith('V\tpsub')) && dec.some((r) => r.kind === 'C' && /^(pgrep|pidof|ps|lsof|fuser|netstat|ss|pstree|jps)(\t|$)/.test(r.s.slice(2)))) psub = true;
    const rdr = dec.some((r) => r.kind === 'C' && /^(sh|bash|dash|zsh|ksh|ash|mksh|posh|yash|python[0-9.]*|pypy3?|node|nodejs|deno|bun|perl|ruby|php|lua|osascript|awk|gawk|mawk|nawk)(\t|$)/.test(r.s.slice(2)));
    const raw = scan.raw;
    const taintWords = () => taint.split(/[ \t\n]+/).filter((x) => x !== '');
    const anyTaintRef = (/** @type {string} */ s) => taintWords().some((t) => refsVar(s, t));
    for (const rec of dec) {
      nrec++;
      if (nrec % 20 === 0) this.checkTime(raw);
      const s = rec.s;
      const after = s.slice(2);
      if (s.startsWith('F\t')) { fpath = after; continue; }
      if (s === 'V\txargs') { viax = true; continue; }
      if (s.startsWith('V\tcwd\t')) { cwdv = s.slice(6); continue; }
      if (s.startsWith('W\t')) { w1 = after; continue; }
      if (s.startsWith('H\t')) {
        const a = after.split('\x03');
        hdoc.push([a[0] ?? '', a[1] ?? '', a.slice(2).join('\x03')]);
        continue;
      }
      if (!s.startsWith('C\t')) continue;
      const fp = fpath; fpath = ''; const wp = w1; w1 = ''; const vx = viax; viax = false; const cd = cwdv;
      const rest = after;
      const ti = rest.indexOf('\t');
      let cw = ti < 0 ? rest : rest.slice(0, ti);
      /** @type {boolean} */ let full = false;
      if (['busybox', 'kill', 'pkill', 'killall', 'killall5', 'skill', 'slay', 'fuser', 'eval', 'find', 'fd', 'fdfind', 'setsid', 'caffeinate', 'unbuffer', 'watch', 'flock', 'taskset', 'chrt', 'nsenter', 'strace', 'ltrace', 'runuser', 'su', 'systemd-run', 'script', 'sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'mksh', 'posh', 'yash', 'source', '.', 'python', 'pypy', 'pypy3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript', 'awk', 'gawk', 'mawk', 'nawk', 'read', 'mapfile', 'readarray', 'for'].includes(cw) || cw.startsWith('$') || /^python[0-9]/.test(cw)) full = true;
      else if (['echo', 'printf', '<', 'cat'].includes(cw)) {
        if (/kill|slay|fuser/.test(rest)) full = true;
        if (cw === 'cat' && find) full = true;
        if (cw === 'cat' && rdr) full = true;
      } else if (['env', 'export', 'local', 'declare', 'readonly', 'typeset'].includes(cw)) {
        if (/kill|slay|fuser|pgrep|pidof|lsof|ps/.test(rest) || rest.endsWith('=') || rest.endsWith('$') || rest.includes('=\x03') || rest.includes('$\x03')) full = true;
        if (taint !== '' && rest.includes('$')) full = true;
      }
      if (fp !== '') full = true;
      let args = ''; let joined = ''; let srch = false;
      if (full) {
        if (ti >= 0) args = cmdSubst(rest.slice(ti + 1).replace(/[\x03\x02]/g, '\n'));
        if (cw === 'busybox') {
          const ls = argLines(args);
          cw = ls[0] ?? '';
          args = cmdSubst(ls.slice(1).join('\n'));
        }
        joined = args.replace(/\n/g, ' ');
        if (SEARCH_RE.test(joined)) srch = true;
      }
      const was = pend; if (cw !== 'env') pend = false;
      if (was && isSearch(cw)) kgNo('kill with PIDs taken from a process search (pgrep, pidof, ps, lsof, fuser)');
      if (cand !== '' && cw !== 'env' && cw !== '$') {
        if (isSearch(cw)) taint = `${taint} ${cand}`;
        cand = '';
      }
      if (isSearch(cw)) searched = true;
      if (!full) { prev = `${prev} ${cw}`; continue; }
      const al = argLines(args);
      switch (cw) {
        case 'env': case 'export': case 'local': case 'declare': case 'readonly': case 'typeset':
          for (const a of al) {
            if (!/^[A-Za-z_]/.test(a) || !a.includes('=')) continue;
            const n = a.slice(0, a.indexOf('=')); const v = a.slice(a.indexOf('=') + 1);
            const ref = taintWords().some((t) => new RegExp(`\\$${reEsc(t)}$`).test(v) || new RegExp(`\\$${reEsc(t)}[^${NAMECH}]`).test(v) || new RegExp(`\\$\\{${reEsc(t)}[^${NAMECH}]`).test(v));
            if (ref || SEARCH_RE.test(v)) { taint = `${taint} ${n}`; searched = true; } else if (v === '' || v.endsWith('$')) cand = `${cand} ${n}`;
          }
          break;
        case 'for': {
          const n = al[0] ?? '';
          const ref = taintWords().some((t) => refsVar(joined, t));
          if (srch || ref) { taint = `${taint} ${n}`; searched = true; } else { const last = al[al.length - 1] ?? ''; if (last === 'in' || last.endsWith('$')) cand = `${cand} ${n}`; }
          break;
        }
        case 'read': case 'mapfile': case 'readarray':
          if (searched || psub) { for (const a of al) if (!a.startsWith('-') && a !== '') taint = `${taint} ${a}`; } else cand = `${cand} ${al.filter((a) => !a.startsWith('-')).join('\n')}${al.some((a) => !a.startsWith('-')) ? '\n' : ''}`.replace(/\n/g, ' ');
          break;
        default:
      }
      if (cw.startsWith('$') || cw === 'eval' || cw === 'kill') {
        if (tbl.size > 0) {
          let x = `${cw} ${joined}`;
          for (let i = 0; i < 3; i++) x = x.replace(/\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (m, nm) => { const name = nm.replace(/[{}]/g, ''); return tbl.has(name) ? /** @type {string} */ (tbl.get(name)) : m; });
          x = x.replace(/\n+$/, '');
          if (x !== `${cw} ${joined}` && x !== `${cw} ${joined} `) this.sub(x, depth);
        }
      }
      switch (/^python[0-9]/.test(cw) ? 'python' : cw) {
        case 'pkill': case 'killall': case 'killall5': case 'skill': case 'slay': {
          const f = al[0] ?? '';
          if (f === '') { if (vx) kgNo(`${cw} under xargs kills by the patterns that arrive on stdin`); } else if (!['--help', '-h', '--version', '-V'].includes(f)) kgNo(`${cw} kills by name or pattern`);
          break;
        }
        case 'fuser':
          if (al.some((a) => /^-[A-Za-z]*k/.test(a))) kgNo('fuser -k kills whatever uses a file or port');
          break;
        case 'eval': this.sub(joined, depth); break;
        case 'kill': {
          let ops = 0; let dd = false; let skip = false; let dl = false;
          for (const a of al) {
            if (a.includes('$')) dl = true;
            if (skip) { skip = false; continue; }
            if (!dd) {
              if (a === '--') { dd = true; continue; }
              if (a === '-s' || a === '-n' || a === '--signal') { skip = true; continue; }
              if (/^-[0-9]/.test(a)) { if (kgNum(a) === '-1') kgNo('kill -1 signals every process'); continue; }
              if (a.startsWith('-')) continue;
            }
            if (a === '') continue;
            if (a !== '{}') ops++;
            const v = /^[0-9+-]/.test(a) || a.startsWith('$((') ? kgNum(a) : '';
            if (v === '0') kgNo(`kill ${a} signals the whole process group`);
            if (v === '-1') kgNo(`kill ${a} signals every process`);
            for (const t of taintWords()) if (refsVar(a, t)) kgNo(`kill $${t}: the variable holds PIDs from a process search (pgrep, pidof, ps, lsof, fuser)`);
            if (searched && ['$@', '$*', '${@}', '${*}', '$1', '$0', '${1}', '${0}'].includes(a) || (searched && a.startsWith('$@'))) kgNo('kill of the arguments of a command fed by a process search');
            if (a.includes('$(') || a.endsWith('$')) pend = true;
          }
          if (ops === 0) pend = true;
          if (ops === 0 && !dl) {
            if ([' pgrep ', ' pidof ', ' ps ', ' lsof ', ' fuser ', ' pkill ', ' netstat ', ' ss ', ' pstree ', ' jps '].some((w) => ` ${prev} `.includes(w))) kgNo('kill fed from a process search (pgrep, pidof, ps, lsof, fuser)');
            if (find) kgNo('kill fed from find: PIDs chosen by file name are a kill by pattern');
          }
          break;
        }
        case 'find': case 'fd': case 'fdfind': {
          let fx = false; let fn = ''; let fb = ''; let fl = '';
          for (const a of al) {
            if (fx) {
              if (fn === '') { fn = a.slice(a.lastIndexOf('/') + 1); fl = fn; }
              if (a === ';' || a === '+') { fx = false; fn = ''; } else fb = `${fb} ${a}`;
              if (['kill', 'pkill', 'killall', 'killall5', 'skill', 'slay', 'fuser'].includes(fn)) kgNo(`${cw} -exec ${fn} acts on what find matched, a kill by pattern`);
              if (['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash'].includes(fn) && (/[^A-Za-z0-9_.$-]kill[^A-Za-z0-9_-]/.test(fb) || /[^A-Za-z0-9_.$-]pkill/.test(fb) || /[^A-Za-z0-9_.$-]killall/.test(fb) || fb.endsWith(' kill'))) kgNo(`${cw} -exec ${fn} -c runs kill on what find matched`);
              continue;
            }
            if (['-exec', '-execdir', '-ok', '-okdir', '-x', '--exec', '-X', '--exec-batch'].includes(a)) { fx = true; fn = ''; fb = ''; }
          }
          if (!['cat', 'head', 'tail', 'grep'].includes(fl)) find = true;
          break;
        }
        case 'cat': {
          find = false;
          let n = 0;
          for (const a of al) {
            if (a.startsWith('-') || a === '') continue;
            n++; if (n > 3) break;
            const fo = this.fileOk(this.rp(a, cd));
            if (fo !== '') kge.push(readFileSync(fo).subarray(0, 262144).toString('utf8').replace(/\n/g, '\x02'));
          }
          break;
        }
        case 'setsid': case 'caffeinate': case 'unbuffer': case 'watch': case 'flock': case 'taskset': case 'chrt': case 'nsenter': case 'strace': case 'ltrace': case 'runuser': case 'su': case 'systemd-run': case 'script': {
          let wr = '';
          for (const a of al) {
            if (wr !== '') { wr = `${wr} ${a}`; continue; }
            if (['pkill', 'killall', 'killall5', 'skill', 'slay', 'kill', 'fuser'].includes(a) || globMatch('/*/pkill', a) || globMatch('/*/killall', a) || globMatch('/*/kill', a)) wr = a;
            else if (a.includes(' ')) this.sub(a, depth);
          }
          if (wr !== '') this.sub(wr, depth);
          break;
        }
        case 'sh': case 'bash': case 'dash': case 'zsh': case 'ksh': case 'ash': case 'mksh': case 'posh': case 'yash': {
          let c = false; let o = ''; let skip = false; let sflag = false;
          for (const a of al) {
            if (skip) { skip = false; continue; }
            if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(a)) skip = true;
            else if (a === '--' || a.startsWith('--')) { /* a long option is not -c or -s */ } else if (a.startsWith('-') || a.startsWith('+')) { if (a.startsWith('-') && a.includes('c')) c = true; if (a.startsWith('-') && a.includes('s')) sflag = true; } else { o = a; break; }
          }
          if (c) { /* the -c string is scanned as a nested command */ } else if (o !== '' && !sflag) runs.push(['sh', this.rp(o, cd)]); else stdin = `${stdin} sh`;
          break;
        }
        case 'source': case '.': { const a = al[0] ?? ''; if (a !== '') runs.push(['sh', this.rp(a, cd)]); break; }
        case 'python': case 'pypy': case 'pypy3': this.interp('python', al, cd, searched, depth, runs, (v) => { stdin = `${stdin} ${v}`; }); break;
        case 'node': case 'nodejs': case 'deno': case 'bun': this.interp('node', al, cd, searched, depth, runs, (v) => { stdin = `${stdin} ${v}`; }); break;
        case 'perl': case 'ruby': case 'php': case 'lua': case 'osascript': this.interp(cw, al, cd, searched, depth, runs, (v) => { stdin = `${stdin} ${v}`; }); break;
        case 'awk': case 'gawk': case 'mawk': case 'nawk': this.interp('awk', al, cd, searched, depth, runs, (v) => { stdin = `${stdin} ${v}`; }); break;
        case 'echo': case 'printf': {
          const et = cmdSubst(al.filter((a) => !/^-[neE]+$/.test(a)).map((a) => a.replace(/\\n/g, '\n')).join('\n'));
          const ej = `${et}\n`.replace(/\n/g, ' ');
          kge.push(`${et.replace(/\n/g, '\x02')}\x02`);
          if (cw === 'echo') kge.push(ej);
          if (wp !== '') {
            const ec = cw === 'echo' ? ej : `${et.replace(/\n/g, '\x02')}\x02`;
            hdoc.push([cw, wp, ec]);
          }
          break;
        }
        case '<': {
          const a = al[0] ?? '';
          const fo = this.fileOk(a);
          if (fo !== '') kge.push(readFileSync(fo).subarray(0, 262144).toString('utf8').replace(/\n/g, '\x02')); else kge.push(a);
          break;
        }
        default:
          if (cw.startsWith('$')) break;
          if (fp !== '') runs.push(['auto', fp]);
      }
      prev = `${prev} ${cw}`;
    }
    // script files the command runs (a file the same command writes with a here-document is read from the command)
    for (const [l, p] of runs) {
      if (p === '') continue;
      const np = p.replace(/^\.\//, '');
      let body = ''; let got = false;
      for (const [, hp, hb] of hdoc) {
        if (hp === '') continue;
        if (hp.replace(/^\.\//, '') === np) { body = cmdSubst(hb.replace(/\x02/g, '\n')); got = true; }
      }
      if (!got) {
        const fo = this.fileOk(p);
        if (fo !== '') { body = cmdSubst(readFileSync(fo, 'utf8').replace(/\0/g, '')); got = true; }
      }
      if (!got) continue;
      try { this.script(l, body, p, searched, depth); } catch (e) { if (e instanceof KgNo) throw new KgNo(`the script ${p}: ${e.msg}`); throw e; }
    }
    // a shell or interpreter that reads its program from stdin: here-documents, echo/printf text and files fed to it
    for (const l of stdin.split(/[ \t\n]+/).filter((x) => x !== '')) {
      for (const [hc, , hb] of hdoc) {
        if (!(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'perl', 'ruby', 'php', 'lua', 'awk', 'cat', 'tee', 'echo', 'printf', 'osascript', 'deno', 'bun'].includes(hc) || hc.startsWith('python') || hc.startsWith('node'))) continue;
        try { this.script(l, cmdSubst(hb.replace(/\x02/g, '\n')), '', searched, depth); } catch (e) { if (e instanceof KgNo) throw new KgNo(`the here-document: ${e.msg}`); throw e; }
      }
      for (const hb of kge) {
        if (hb === '') continue;
        try { this.script(l, cmdSubst(hb.replace(/\x02/g, '\n')), '', searched, depth); } catch (e) { if (e instanceof KgNo) throw new KgNo(`the text piped or redirected into ${l}: ${e.msg}`); throw e; }
      }
    }
  }

  /**
   * `kg_interp LANG`: an interpreter command: its code operands are checked now, its script operand is queued, no code and no script means it
   * reads its program from stdin. @param {string} l @param {string[]} al @param {string} cd @param {boolean} searched @param {number} depth
   * @param {Array<[string, string]>} runs @param {(lang: string) => void} addStdin
   */
  interp(l, al, cd, searched, depth, runs, addStdin) {
    let nx = ''; let dd = false; let sc = ''; let code = false;
    for (const a of al) {
      if (nx !== '') {
        if (nx === 'code') { code = true; this.chkCode(l, a, searched, depth); } else if (nx === 'file') sc = a;
        nx = ''; continue;
      }
      if (!dd) {
        if (a === '--') { dd = true; continue; }
        if (a === '-') { code = true; addStdin(l); continue; }
        if (l === 'python') {
          if (a === '-m') { code = true; nx = 'skip'; continue; }
          if (a === '-W' || a === '-X') { nx = 'skip'; continue; }
          if (a === '-c' || /^-[A-Za-z]c$/.test(a)) { nx = 'code'; continue; }
        } else if (l === 'node') {
          if (['-e', '--eval', '-p', '--print', '-pe', '-ep'].includes(a)) { nx = 'code'; continue; }
          if (['-r', '--require', '--import', '--loader'].includes(a)) { nx = 'skip'; continue; }
          if (a === 'eval') { nx = 'code'; continue; }
        } else if (l === 'perl' || l === 'ruby') {
          if (/^-[^]*[^A-Za-z0-9]/.test(a) || a.startsWith('--')) { if (a === '-I' || a === '-r') { nx = 'skip'; continue; } } else if (/^-[^]*[eE]$/.test(a)) { nx = 'code'; continue; }
        } else if (l === 'php') {
          if (a === '-r') { nx = 'code'; continue; }
          if (a === '-d') { nx = 'skip'; continue; }
          if (a === '-f') { nx = 'file'; continue; }
        } else if (l === 'lua' || l === 'osascript') {
          if (a === '-e') { nx = 'code'; continue; }
        } else if (l === 'awk') {
          if (a === '-f') { nx = 'file'; continue; }
          if (a === '-F' || a === '-v' || a === '-e') { nx = 'skip'; continue; }
        }
        if (a.startsWith('-')) continue;
      }
      // the first operand: awk's program text, else the script file
      if (l === 'awk' && !code) { code = true; this.chkCode('awk', a, searched, depth); break; }
      sc = a; break;
    }
    if (sc !== '') runs.push([l, this.rp(sc, cd)]);
    else if (!code) addStdin(l);
  }
}
