// @ts-check
// command-scan: the shell-command tokenizer of the hook (Node form of the 290-line awk `scan_cmd` of proofline-hook.sh).
//
// WHAT IT IS. A heuristic tokenizer, not a parser: quotes are removed (agent.s""h = agent.sh), backslashes escape, words are split on
// blanks, commands on `; && || | & newline`, subshells and `$(...)` / backticks inside double quotes are scanned as nested commands,
// `sh|bash -c STRING` is scanned as a nested command, here-document bodies are skipped (and returned), redirections are recognised,
// env prefixes and wrappers (sudo env nice timeout xargs ...) are skipped to find the command word. It produces RECORDS, one per finding.
// The shell hook is the specification: for the same input bytes this module produces the same output bytes as the awk program
// (tests/enforcement/command-scan.test.mjs runs both over a corpus and a fuzz and compares byte for byte).
//
// BYTES. The awk works on bytes (the hook runs it under the shell's locale; every rule is ASCII). This module therefore works on
// "binary strings" (one JS char per byte, latin1) internally: a string argument is encoded as UTF-8 first, a Uint8Array is used as is.
// ASCII-only case folding, `.` matches a newline (as in awk), `$` matches only at the end of the string.
//
// INPUT. The hook feeds the awk `printf '%s\n' "$cmd"`: call `scanCommand(cmd)` for that (it appends the newline). `scanBytes` /
// `scanRaw` take the text exactly as given. The awk reads records separated by \001 (RS) and keeps its state (the `cd` directory, an
// IFS assignment, the last `cd`) across them; so does this module, per call; nothing is kept between calls.
//
// PUBLIC API (stable)
//   scanBytes(input: string|Uint8Array): Buffer       the exact bytes the awk would print (records, each "<K>\t<value>\n")
//   scanRaw(input): string                            the same as a binary string
//   scanCommand(cmd: string): ScanResult              the hook's call: scanText(cmd + "\n")
//   scanText(input): ScanResult                       { raw, records, commands }
//   ScanResult.records: Rec[]    { kind, raw, value }  value = UTF-8 text with the \002 line marks turned back into newlines
//   ScanResult.commands: Cmd[]   { word, args }        from the C records (every simple command: command word, arguments)
//   kindOf(result, kind): Rec[]                        the records of one kind
//   parseRecordLine(line): Rec                         one output line ("K\tvalue") as a record
//   parseCommandRecord(rec): Cmd
//   parseAgentRecord(rec): { literal, sub }           an `A` record: the agent.sh subcommand word and whether it is literal (1)
//   parseHeredocRecord(rec): { cmd, path, body }       an `H` record
//   decodeBinary(s): string                            binary string -> JS text (UTF-8)
//
// RECORD KINDS (the same letters as the awk; "literal" = the normalised literal flag: no $ expansion or substitution in the word)
//   W path   the command writes path (redirection, tee, sed -i, perl -i, cp/mv/install/rsync/ln target, mv sources, touch/rm/truncate/
//            unlink/rmdir/shred, chmod/chown/chgrp operands, dd of=)
//   E path   for each operand of rm and unlink: the command deletes path
//   P word   an operand of a command that edits files in place (sed -i, perl/ruby -i, awk -i inplace, patch)
//   Q word   an operand of an editor run from a script (ed, ex, vi, vim)
//   L arg    an ln operand
//   A l sub  an agent.sh invocation; l = 1 when the subcommand word is literal, 0 when not
//   R value  an AGENT_ROLE=value assignment (anywhere)
//   N word   a nested headless runtime (claude -p/--print, codex exec|e)
//   S what   an in-place sed whose flags hide a backup suffix (sed -i.bak style) the guards want to see
//   X why    refused while a run is active (non-literal command word or script, eval, env -S, a shell reading stdin, indirect
//            AGENT_ROLE, nesting beyond one level, copies of agent.sh)
//   B why    a git hook bypass; refused always
//   C word args   every simple command: its command word and its arguments joined with \003
//   F path   the command word is a literal path (./x, scripts/run)
//   V what   a fact about the next C record: `xargs`, `psub`, `cwd\tDIR`
//   H cmd\003path\003body   a here-document: the command it feeds, the file that command writes, the body (newlines as \002, at most
//            200000 characters, a body of an unquoted delimiter is also scanned for $(...) and backtick commands)
// A relative path in W E P Q F is prefixed with the directory of an earlier `cd DIR` of the same text (heuristic, like the rest).
//
// Plain ESM, Node built-ins only.

/** @typedef {{ kind: string, raw: string, value: string }} Rec */
/** @typedef {{ word: string, args: string[] }} Cmd */
/** @typedef {{ raw: string, records: Rec[], commands: Cmd[] }} ScanResult */

const PATH_KINDS = new Set(['W', 'E', 'P', 'Q', 'F']);

/** awk substr(s, m, n): 1-based, chars from m for n (all the rest without n), clamped like POSIX awk. @param {string} s @param {number} m @param {number} [n] */
function substr(s, m, n) {
  const len = s.length;
  const begin = m < 1 ? 1 : m;
  let end = n === undefined ? len + 1 : m + n;
  if (end > len + 1) end = len + 1;
  if (end <= begin) return '';
  return s.slice(begin - 1, end - 1);
}
/** awk index(s, t): 1-based position or 0. @param {string} s @param {string} t */
const index = (s, t) => s.indexOf(t) + 1;
/** ASCII-only tolower. @param {string} s */
const lower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
/** @param {string} x */
function base(x) { return x.replace(/^[^]*\//, ''); }
/** @param {string} x */
const isassign = (x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x);
/** @param {string} v */
const vsafe = (v) => v !== '' && /^[A-Za-z0-9_./:@%+,=-]+$/.test(v);

const CASE_LABEL = /[^ \t\n;&|()<>]*(?:\|[^ \t\n;&|()<>]*)*\)/y;
const WRAPPERS = /^(sudo|doas|env|command|builtin|exec|nohup|time|nice|ionice|stdbuf|timeout|xargs|then|do|else|elif|if|while|until|!|\{|\})$/;

/**
 * The whole scanner, state included. One call scans one input (the awk's one run).
 * @param {string} input binary string
 * @returns {string} binary string
 */
function scan(input) {
  /** @type {string[]} */ const res = [];
  // global state of the awk program (kept across records and nested commands, like the awk's globals)
  /** @type {string[]} */ const w = [];
  /** @type {number[]} */ const L = [];
  /** @type {number[]} */ const L0 = [];
  /** @type {number[]} */ const dynw = [];
  /** @type {string[]} */ const op = [];
  /** @type {string[]} */ const hdw = [];
  /** @type {number[]} */ const hdq = [];
  /** @type {number[]} */ const hdt = [];
  /** @type {string[]} */ const hdc = [];
  /** @type {string[]} */ const hdp = [];
  /** @type {Map<string, string>} */ const kvs = new Map();
  /** @type {string[]} */ const qs = [];
  /** @type {number[]} */ const qd = [];
  let qn = 0, dep = 0, cwdp = '', lastcd = '', ifsset = 0, xfail = 0;
  let cur = '', have = 0, lit = 1, quo = 0, dyn = 0, redir = 0, inredir = 0, dup = 0, nw = 0;
  let hdn = 0, hdfirst = 1, hdbody = 0, hdd = 0, pd = 0, lastw = '', sep = 'p', prevsep = 'p', cc = '';

  /** @param {number} j */ const W = (j) => w[j] ?? '';

  /** @param {string} k @param {string} v */
  function out(k, v) {
    if (PATH_KINDS.has(k) && cwdp !== '' && substr(v, 1, 1) !== '/' && substr(v, 1, 1) !== '~') v = `${cwdp}/${v}`;
    res.push(`${k}\t${v.replace(/\n/g, '\x02')}\n`);
  }
  /** @param {string} t @param {number} d */
  function push(t, d) {
    if (d > 4) { out('B', 'commands nested more than four levels deep'); return; }
    if (d > 1) out('X', 'a nested shell command inside a nested shell command');
    qs[++qn] = t; qd[qn] = d;
  }
  /** a command inside a here-document body: no nesting complaint, only the depth limit @param {string} t @param {number} d */
  function pushraw(t, d) {
    if (d > 4) { out('B', 'commands nested more than four levels deep'); return; }
    qs[++qn] = t; qd[qn] = d;
  }
  /** @param {string} s @param {number} p */
  function mparen(s, p) {
    let d = 0; const m = s.length;
    for (; p <= m; p++) {
      const c2 = s[p - 1];
      if (c2 === '(') d++;
      else if (c2 === ')') { d--; if (!d) return p; }
    }
    return m;
  }
  /** $(...) and backtick commands in an unquoted here-document body @param {string} b */
  function hdsubs(b) {
    const m = b.length; let p = 1;
    while (p <= m) {
      const ch = b[p - 1];
      if (ch === '\\') { p += 2; continue; }
      if (ch === '$' && b[p] === '(') { const e = mparen(b, p + 1); pushraw(substr(b, p + 2, e - p - 2), dep + 1); p = e + 1; continue; }
      if (ch === '`') {
        let e = index(substr(b, p + 1), '`'); if (!e) e = m - p + 1;
        pushraw(substr(b, p + 1, e - 1), dep + 1); p += e + 1; continue;
      }
      p++;
    }
  }
  function endword() {
    if (!have) return;
    if (redir) {
      out('W', cur); lastw = (substr(cur, 1, 1) !== '/' && cwdp !== '') ? `${cwdp}/${cur}` : cur; redir = 0;
    } else if (inredir) {
      if (inredir === 2) { hdn++; hdw[hdn] = cur; hdq[hdn] = quo; hdt[hdn] = hdd; } else out('C', `<\t${cur}`);
      inredir = 0;
    } else if (dup) {
      dup = 0;
    } else {
      w[++nw] = cur; L[nw] = lit; L0[nw] = lit; dynw[nw] = dyn;
    }
    cur = ''; have = 0; lit = 1; quo = 0; dyn = 0;
  }
  /** @param {string} wr @param {string} x */
  function takesval(wr, x) {
    if (wr === 'env') return /^(-u|--unset|-C|--chdir)$/.test(x);
    if (wr === 'sudo' || wr === 'doas') return /^-[ugCDhpRrTt]$/.test(x);
    if (wr === 'nice') return x === '-n';
    if (wr === 'xargs') return /^-[IiLlnPsdEa]$/.test(x);
    if (wr === 'timeout') return /^(-s|-k|--signal|--kill-after)$/.test(x);
    if (wr === 'stdbuf') return /^-[ioe]$/.test(x);
    if (wr === 'ionice') return /^-[cnp]$/.test(x);
    if (wr === 'exec') return x === '-a';
    return false;
  }
  /** @param {string} v */
  function gitcfg(v) { v = lower(v); if (/hookspath/.test(v) || /^include/.test(v) || /^alias\./.test(v)) out('B', `git -c ${v}`); }
  /** @param {number} k */
  function gitchk(k) {
    let sc = '';
    for (let j = k + 1; j <= nw; j++) {
      const x = W(j); const lx = lower(x);
      if (sc === '') {
        if (x === '-c' || lx === '--config-env') { gitcfg(W(j + 1)); j++; continue; }
        if (/^-c[^]/.test(x)) { gitcfg(substr(x, 3)); continue; }
        if (/^--config-env=/.test(lx)) { gitcfg(substr(x, 14)); continue; }
        if (/^--(git-dir|exec-path)/.test(lx)) { out('B', `git ${x}`); continue; }
        if (x === '-C' || lx === '--namespace' || lx === '--work-tree' || lx === '--super-prefix') { j++; continue; }
        if (/^-/.test(x)) continue;
        sc = lx; continue;
      }
      if (/^--no-v/.test(lx)) out('B', `git ${sc} ${x}`);
      if (sc === 'commit') {
        if (/^(-m|-F|-C|-c|-t|--author|--date|--file|--message|--template|--reuse-message|--reedit-message|--fixup|--squash|--trailer|--cleanup|--pathspec-from-file)$/.test(x)) { j++; continue; }
        if (/^-[A-Za-z]/.test(x) && !/^--/.test(x)) {
          for (let m = 2; m <= x.length; m++) {
            const ch = substr(x, m, 1);
            if (/[mFCct]/.test(ch)) break;
            if (ch === 'n' || ch === 'N') { out('B', `git commit ${x}`); break; }
          }
        }
      }
      if (sc === 'config' && (/^(core|include|includeif|alias)(\.|$)/.test(lx) || /hookspath/.test(lx) || x === '-e' || lx === '--edit')) out('B', `git config ${x}`);
    }
  }
  /** operand j of sh/bash/./source is the script path @param {number} j */
  function script(j) {
    if (!L0[j]) out('X', `the script path ${W(j)} is not literal`);
    else if (base(W(j)) === 'agent.sh' && j + 1 <= nw) out('A', `${L[j + 1]}\t${W(j + 1)}`);
  }
  /** t with every $NAME / ${NAME} replaced by a known literal value; sets xfail on anything else @param {string} t */
  function vexpand(t) {
    xfail = 0; let o = '';
    if (ifsset) { xfail = 1; return t; }
    let p;
    while ((p = index(t, '$')) > 0) {
      o += substr(t, 1, p - 1); t = substr(t, p + 1);
      let nm;
      if (substr(t, 1, 1) === '{') {
        const e = index(t, '}'); if (!e) { xfail = 1; return t; }
        nm = substr(t, 2, e - 2); t = substr(t, e + 1);
      } else {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(t);
        if (m) { nm = m[0]; t = t.slice(nm.length); } else { xfail = 1; return t; }
      }
      const val = kvs.get(nm);
      if (val === undefined) { xfail = 1; return t; }
      o += val;
    }
    return o + t;
  }
  function endcmd() {
    cc = ''; endcmd0();
    for (let h = hdfirst; h <= hdn; h++) { hdc[h] = cc; hdp[h] = lastw; }
    hdfirst = hdn + 1; lastw = ''; prevsep = sep;
  }
  function endcmd0() {
    if (nw === 0) return;
    let k = 1, wr = '', tdone = 0, viax = 0, j, x, c;
    while (k <= nw) {
      x = W(k);
      if (isassign(x)) { k++; continue; }
      if (wr !== '' && /^-/.test(x)) {
        if (wr === 'env' && /^(-[A-Za-z]*S|--split-string)/.test(x)) out('X', 'env -S runs a split string');
        if (takesval(wr, x)) k++;
        k++; continue;
      }
      if (wr === 'timeout' && !tdone) { tdone = 1; k++; continue; }
      if (WRAPPERS.test(base(x))) { wr = base(x); tdone = 0; if (wr === 'xargs') viax = 1; k++; continue; }
      break;
    }
    // A171: literal variables (see the shell hook): an assignment-only command first in its list, ended by `;`, newline or `&&`, outside
    // parentheses, records NAME = value when the value is plain and literal; any other way a variable can change forgets it.
    let allas = nw > 0;
    for (j = 1; j <= nw; j++) if (!isassign(W(j))) allas = false;
    for (j = 1; j <= nw; j++) if (/^IFS\+?=/.test(W(j))) { ifsset = 1; kvs.clear(); }
    if (allas) {
      for (j = 1; j <= nw; j++) {
        const nm = W(j).replace(/=[^]*/, ''); let vv = W(j).replace(/^[^=]*=/, '');
        if (!L[j]) { vv = vexpand(vv); if (xfail || dynw[j]) vv = ''; }
        if (prevsep === 'p' && (sep === 'p' || sep === 'a') && pd <= 0 && vsafe(vv)) kvs.set(nm, vv); else kvs.delete(nm);
      }
    } else {
      for (j = 1; j <= nw; j++) {
        if (isassign(W(j))) kvs.delete(W(j).replace(/=[^]*/, ''));
        else if (/^[A-Za-z_][A-Za-z0-9_]*\+=/.test(W(j))) kvs.clear();
      }
    }
    // k is the command word (nw + 1 when there is none).
    if (k <= nw) {
      c = base(W(k));
      if (/^(read|unset|getopts|mapfile|readarray|declare|typeset|local|set|shift|select|for|case|wait|trap|eval|source|\.|let)$/.test(c)) kvs.clear();
      if (c === 'printf') for (j = k + 1; j <= nw; j++) if (/^-v/.test(W(j))) kvs.clear();
      for (j = k + 1; j <= nw; j++) if (!L[j] && !dynw[j]) { const vv = vexpand(W(j)); if (!xfail) { w[j] = vv; L[j] = 1; } }
    }
    for (j = 1; j <= nw; j++) {
      x = W(j);
      if (isassign(x)) {
        c = x.replace(/=[^]*/, '');
        if (j < k) out('C', `env\t${x}`);
        if (c === 'AGENT_ROLE') out('R', substr(x, 12));
        if (/^GIT_CONFIG/.test(c) || c === 'GIT_DIR' || c === 'GIT_COMMON_DIR' || c === 'GIT_EXEC_PATH') out('B', `setting ${c} can disable or redirect the git hooks`);
        continue;
      }
      if (!/AGENT_ROL/.test(x)) continue;
      c = x.replace(/\$\{?AGENT_ROLE/g, ''); if (!/AGENT_ROL/.test(c)) continue;
      if (x === 'AGENT_ROLE' && (base(W(1)) === 'export' || base(W(1)) === 'unset')) continue;
      out('X', `AGENT_ROLE is set or named indirectly (${x})`);
    }
    if (k > nw) { nw = 0; return; }
    if (!L[k]) out('X', `the command word ${W(k)} is not literal`);
    c = base(W(k)); cc = c;
    let ca = ''; for (j = k + 1; j <= nw; j++) ca = ca + (j > k + 1 ? '\x03' : '') + W(j);
    if (L[k] && /\//.test(W(k))) out('F', W(k));
    if (viax) out('V', 'xargs');
    if (cwdp !== '') out('V', `cwd\t${cwdp}`);
    out('C', `${c}\t${ca}`);
    // cd: later relative write targets in this command line resolve against it (heuristic, like the rest)
    if (c === 'cd') {
      const cdkey = [qn, k, nw, W(k + 1)].join('\x1c');
      if (cdkey !== lastcd) {
        lastcd = cdkey;
        if (k + 1 <= nw && L[k + 1] && W(k + 1) !== '-') { const d0 = W(k + 1); cwdp = (substr(d0, 1, 1) === '/' || cwdp === '') ? d0 : `${cwdp}/${d0}`; } else cwdp = '';
      }
    }
    let hasc, hass;
    if (c === 'eval') out('X', 'eval runs an unparsed string');
    else if (/^(sh|bash|dash|zsh|ksh|ash|mksh|posh|yash)$/.test(c)) {
      hasc = 0; hass = 0;
      for (j = k + 1; j <= nw; j++) {
        x = W(j);
        if (/^[-+][oO]$/.test(x) || x === '--rcfile' || x === '--init-file') { j++; continue; }
        if (x === '--') { j++; break; }
        if (/^--/.test(x)) continue;
        if (/^[-+][A-Za-z]+$/.test(x)) { if (/^-[A-Za-z]*c/.test(x)) hasc = 1; if (/^-[A-Za-z]*s/.test(x)) hass = 1; continue; }
        break;
      }
      if (hasc) { if (j <= nw) push(W(j), dep + 1); } else if (hass || j > nw) out('X', 'a shell reading its commands from stdin');
      else script(j);
    } else if (c === '.' || c === 'source') { if (k + 1 <= nw) script(k + 1); }
    else if (c === 'agent.sh') { if (k + 1 <= nw) out('A', `${L[k + 1]}\t${W(k + 1)}`); }
    else if (c === 'claude') { for (j = k + 1; j <= nw; j++) if (W(j) === '-p' || W(j) === '--print') { out('N', `claude ${W(j)}`); break; } }
    else if (c === 'codex') { for (j = k + 1; j <= nw; j++) if (!/^-/.test(W(j))) { if (W(j) === 'exec' || W(j) === 'e') out('N', `codex ${W(j)}`); break; } }
    else if (c === 'git') gitchk(k);
    else if (c === 'tee') {
      for (j = k + 1; j <= nw; j++) if (!/^-/.test(W(j))) { out('W', W(j)); if (lastw === '') lastw = (substr(W(j), 1, 1) !== '/' && cwdp !== '') ? `${cwdp}/${W(j)}` : W(j); }
    } else if (/^(touch|rm|truncate|unlink|rmdir|shred)$/.test(c)) {
      for (j = k + 1; j <= nw; j++) {
        if (/^-/.test(W(j))) { if ((c === 'truncate' && /^-[sr]$/.test(W(j))) || (c === 'touch' && /^-[tdr]$/.test(W(j)))) j++; continue; }
        out('W', W(j)); if (/^(rm|unlink)$/.test(c)) out('E', W(j));
      }
    } else if (/^(chmod|chown|chgrp)$/.test(c)) {
      let first = 1, refm = 0;
      for (j = k + 1; j <= nw; j++) {
        x = W(j);
        if (/^--reference/.test(x)) { refm = 1; continue; }
        if (/^--/.test(x) || /^-[RfvchHLP]+$/.test(x)) continue;
        if (first && !refm) { first = 0; continue; }   // mode / owner operand
        out('W', x);
      }
    } else if (/^(ed|ex|vi|vim|view|nvim)$/.test(c)) {
      for (j = k + 1; j <= nw; j++) {
        if (/^(-c|-S|-u|-U|-i|-w|-W|--cmd)$/.test(W(j))) { j++; continue; }
        if (!/^[-+]/.test(W(j)) && W(j) !== '') out('Q', W(j));
      }
    } else if (/^(patch|gpatch)$/.test(c)) {
      out('P', '.'); for (j = k + 1; j <= nw; j++) if (!/^-/.test(W(j)) && W(j) !== '') out('P', W(j));
    } else if (/^(ruby|awk|gawk|mawk)$/.test(c)) {
      hasc = 0;
      for (j = k + 1; j <= nw; j++) {
        const wj = W(j);
        // eco-ok: ruby here is the interpreter whose -i edits a file in place, not an ecosystem
        if (c === 'ruby' ? /^-[0adlnpsSwWxXvuT]*i/.test(wj) : (/^-i?inplace/.test(wj) || wj === '--include=inplace' || ((wj === '-i' || wj === '--include') && /^inplace/.test(W(j + 1))))) hasc = 1;
      }
      if (hasc) { for (j = k + 1; j <= nw; j++) if (!/^-/.test(W(j)) && W(j) !== '') out('P', W(j)); if (nw > k + 1) out('W', W(nw)); }
    } else if (c === 'sed' || c === 'gsed' || c === 'perl') {
      for (j = k + 1; j <= nw; j++) {
        if (/^-[0adlnpsSwWxXvuTEe]*i/.test(W(j)) || /^--in-place/.test(W(j))) {
          for (j = k + 1; j <= nw; j++) if (!/^-/.test(W(j)) && W(j) !== '') out('P', W(j));
          break;
        }
      }
      if (c === 'sed') {
        for (j = k + 1; j <= nw; j++) {
          if (/^-[A-Za-z]*i[A-Za-z-]+$/.test(W(j))) { out('S', `sed ${W(j)}`); break; }
          if (j < nw && /^-[A-Za-z]*i$/.test(W(j)) && /^-[A-Za-z-]/.test(W(j + 1))) { out('S', `sed ${W(j)} ${W(j + 1)}`); break; }
        }
      }
      for (j = k + 1; j <= nw; j++) if (/^-[A-Za-z]*i/.test(W(j)) || /^--in-place/.test(W(j))) { if (nw > k + 1) out('W', W(nw)); break; }
    } else if (/^(cp|mv|install|ln|rsync)$/.test(c)) {
      let nopt = 0, tgt = '';
      for (j = k + 1; j <= nw; j++) {
        x = W(j);
        if (x === '-t' || x === '--target-directory') { tgt = W(++j); continue; }
        if (/^--target-directory=/.test(x)) { tgt = substr(x, 20); continue; }
        if (/^-/.test(x)) { if ((c === 'install' && /^-[mogS]$/.test(x)) || (c === 'rsync' && /^-[ef]$/.test(x))) j++; continue; }
        op[++nopt] = x;
        if (base(x) === 'agent.sh') out('X', `${c} of agent.sh`);
      }
      if (c === 'ln') for (j = 1; j <= nopt; j++) out('L', op[j]);
      if (c === 'mv') for (j = 1; j < nopt + (tgt !== '' ? 1 : 0); j++) out('W', op[j]);
      if (tgt !== '') out('W', tgt); else if (nopt >= 2) out('W', op[nopt]); else if (c === 'ln' && nopt === 1) out('W', base(op[1]));
    } else if (c === 'dd') { for (j = k + 1; j <= nw; j++) if (/^of=/.test(W(j))) out('W', substr(W(j), 4)); }
    nw = 0;
  }

  /** @param {string} s */
  function parse(s) {
    const n = s.length; let i = 1; let q = '';
    cur = ''; have = 0; lit = 1; hdn = 0; hdfirst = 1; hdbody = 0; pd = 0; quo = 0; hdd = 0; lastw = ''; nw = 0; redir = 0; inredir = 0; dup = 0;
    kvs.clear(); prevsep = 'p'; sep = 'p'; dyn = 0;
    while (i <= n) {
      const ch = s[i - 1];
      if (q === "'") { if (ch === "'") q = ''; else cur += ch; i++; continue; }
      if (q === '"') {
        if (ch === '\\' && i < n) { cur += s[i]; i += 2; continue; }
        if (ch === '"') { q = ''; i++; continue; }
        if (ch === '$' && s[i] === '(') { const e = mparen(s, i + 1); push(substr(s, i + 2, e - i - 2), dep + 1); cur += substr(s, i, e - i + 1); lit = 0; i = e + 1; continue; }
        if (ch === '`') {
          let e = index(substr(s, i + 1), '`'); if (!e) e = n - i + 1;
          push(substr(s, i + 1, e - 1), dep + 1); lit = 0; dyn = 1; i += e + 1; continue;
        }
        if (ch === '$') lit = 0;
        cur += ch; i++; continue;
      }
      if (ch === "'" || ch === '"') { q = ch; have = 1; quo = 1; i++; continue; }
      if (ch === '\\' && i < n) { if (s[i] !== '\n') { cur += s[i]; have = 1; quo = 1; } i += 2; continue; }
      if (ch === '#' && !have && cur === '') { const e = s.indexOf('\n', i - 1) + 1; i = e ? e : n + 1; continue; }   // a comment runs to the end of the line
      if (ch === ' ' || ch === '\t') { endword(); i++; continue; }
      if (ch === '\n') {
        sep = 'p'; endword(); endcmd(); i++;
        for (let hi = hdbody + 1; hi <= hdn; hi++) {   // the bodies follow the line, in order, up to their delimiter line
          let body = '';
          while (i <= n) {
            const e = s.indexOf('\n', i - 1) + 1;
            let line = e ? s.slice(i - 1, e - 1) : s.slice(i - 1);
            i = e ? e + 1 : n + 1;
            if (hdt[hi]) line = line.replace(/^\t+/, '');   // only <<- ignores leading tabs of the delimiter line
            if (line === hdw[hi]) break;
            if (body.length < 200000) body = `${body}${line}\n`;
          }
          out('H', `${hdc[hi]}\x03${hdp[hi]}\x03${body}`);
          if (!hdq[hi]) hdsubs(body);
        }
        hdbody = hdn;
        continue;
      }
      if (ch === '|' && nw === 0 && pd <= 0) {   // a case label with alternatives (kill|pkill)
        CASE_LABEL.lastIndex = i;
        const m = CASE_LABEL.exec(s);
        if (m) { i += m[0].length + 1; cur = ''; have = 0; continue; }
      }
      if (ch === ')' && pd <= 0) { cur = ''; have = 0; nw = 0; i++; continue; }   // a case label (stop|kill) is not a command
      if (ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '`') { if (ch === '(') pd++; else if (ch === ')') pd--; sep = (ch === ';') ? 'p' : 'o'; endword(); endcmd(); i++; continue; }
      if (ch === '&') {
        if (s[i] === '>') { endword(); i += 2; if (s[i - 1] === '>') i++; redir = 1; continue; }
        if (s[i] === '&') { sep = 'a'; endword(); endcmd(); i += 2; continue; }
        sep = 'o'; endword(); endcmd(); i++; continue;
      }
      if (ch === '>') {
        if (have && /^[0-9]+$/.test(cur)) { cur = ''; have = 0; } else endword();
        i++; if (s[i - 1] === '>' || s[i - 1] === '|') i++;
        if (s[i - 1] === '&') { i++; dup = 1; continue; }
        if (s[i - 1] === '(') continue;
        redir = 1; continue;
      }
      if (ch === '<') {
        if (have && /^[0-9]+$/.test(cur)) { cur = ''; have = 0; } else endword();
        let k2 = 0; while (s[i - 1] === '<') { i++; k2++; }
        hdd = (s[i - 1] === '-') ? 1 : 0; if (hdd) i++;
        if (s[i - 1] === '&') { i++; dup = 1; continue; }
        if (s[i - 1] === '(') { inredir = 0; out('V', 'psub'); continue; }   // < <(cmd): a process substitution, not a file
        inredir = (k2 === 2) ? 2 : 1; continue;
      }
      if (ch === '$' && s[i] === '(' && s[i + 1] === '(') { const e = mparen(s, i + 1); cur += substr(s, i, e - i + 1); have = 1; lit = 0; i = e + 1; continue; }
      if (ch === '$') lit = 0;
      cur += ch; have = 1; i++;
    }
    sep = 'p'; endword(); endcmd();
  }

  // the awk reads records separated by \001; an empty input has no record, a final separator does not start another one
  if (input !== '') {
    const recs = input.split('\x01');
    if (recs.length > 1 && recs[recs.length - 1] === '') recs.pop();
    for (const rec of recs) {
      qn = 1; qs[1] = rec; qd[1] = 0;
      for (let qi = 1; qi <= qn; qi++) { dep = qd[qi]; parse(qs[qi]); }
    }
  }
  return res.join('');
}

/** @param {string|Uint8Array} input @returns {string} binary string */
function toBinary(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8').toString('latin1');
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('latin1');
}
/** Binary string (one char per byte) to JS text. @param {string} s */
export function decodeBinary(s) { return Buffer.from(s, 'latin1').toString('utf8'); }

/** The exact output of the awk scanner as a binary string. @param {string|Uint8Array} input */
export function scanRaw(input) { return scan(toBinary(input)); }
/** The exact bytes the awk scanner prints. @param {string|Uint8Array} input @returns {Buffer} */
export function scanBytes(input) { return Buffer.from(scan(toBinary(input)), 'latin1'); }

/** One output line ("K\tvalue", no newline) as a record. @param {string} line binary string @returns {Rec} */
export function parseRecordLine(line) {
  const t = line.indexOf('\t');
  const kind = t < 0 ? line : line.slice(0, t);
  const rest = t < 0 ? '' : line.slice(t + 1);
  return { kind, raw: rest, value: decodeBinary(rest.replace(/\x02/g, '\n')) };
}
/** @param {Rec} rec a C record @returns {Cmd} */
export function parseCommandRecord(rec) {
  const t = rec.raw.indexOf('\t');
  const word = t < 0 ? rec.raw : rec.raw.slice(0, t);
  const args = t < 0 ? [] : rec.raw.slice(t + 1).split('\x03').map((a) => decodeBinary(a.replace(/\x02/g, '\n')));
  return { word: decodeBinary(word), args: t >= 0 && rec.raw.slice(t + 1) === '' ? [] : args };
}
/** @param {Rec} rec an A record @returns {{ literal: boolean, sub: string }} */
export function parseAgentRecord(rec) {
  const t = rec.raw.indexOf('\t');
  return { literal: rec.raw.slice(0, t) === '1', sub: decodeBinary(rec.raw.slice(t + 1)) };
}
/** @param {Rec} rec an H record @returns {{ cmd: string, path: string, body: string }} */
export function parseHeredocRecord(rec) {
  const a = rec.raw.split('\x03');
  const body = a.slice(2).join('\x03');
  return { cmd: decodeBinary(a[0] ?? ''), path: decodeBinary(a[1] ?? ''), body: decodeBinary(body.replace(/\x02/g, '\n')) };
}

/** Scan text exactly as given. @param {string|Uint8Array} input @returns {ScanResult} */
export function scanText(input) {
  const raw = scan(toBinary(input));
  /** @type {Rec[]} */ const records = [];
  /** @type {Cmd[]} */ const commands = [];
  if (raw !== '') {
    for (const line of raw.slice(0, -1).split('\n')) {
      const rec = parseRecordLine(line);
      records.push(rec);
      if (rec.kind === 'C') commands.push(parseCommandRecord(rec));
    }
  }
  return { raw, records, commands };
}
/** The hook's call: the command text and a newline (`printf '%s\n' "$cmd" | scan_cmd`). @param {string} cmd */
export function scanCommand(cmd) { return scanText(`${cmd}\n`); }
/** The records of one kind. @param {ScanResult} result @param {string} kind */
export function kindOf(result, kind) { return result.records.filter((r) => r.kind === kind); }
