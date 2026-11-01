// @ts-check
// The stash guard (A71, A111) and the read role's tree-changing commands (A143): a specialist runs no `git stash` subcommand (list and show
// included) against the project's working tree; a registered evidence worktree is free. The target directory is the hook cwd moved by `cd` and
// `git -C` / --work-tree in the scanned commands, and it is the PROJECT whenever the text cannot say.
//   stashGuard(ctx, cmd, scan)    denies (throws) or returns
//   stashNetCount(cmd)            how many `git [options] stash` (or a `$`/backtick where the subcommand goes) sit in command position, not after a
//                                 printing or searching word. The awk of the shell hook matched with POSIX leftmost-longest; this is a matcher that
//                                 explores every path of the same expression and takes the longest (tests/hook/stash-net.test.mjs runs both)
import { cParts, deny, grepq, stashPath, worktrees } from './kit.mjs';
import { roTail } from './paths.mjs';

const S = ' \\t\\n\\v\\f\\r';
const RO_W = 'rm|mv|cp|tee|truncate|ed|ex|patch|install|dd|chmod|chown|ln|shred|unlink|rmdir|touch';
const RO_G = 'reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout|stash|rm|mv|pull';
const RO_I = '(sed|gsed|perl|ruby)( +[^ ]+)* +(-[A-Za-z0-9]*i[^ ]*|--in-place)( |$)';
const RO_FIND_WRITER = new RegExp(`(^| )-delete( |$)|(^| )-(exec|execdir|ok|okdir) +(/[^ ]*/)?((${RO_W})( |$)|${RO_I}|(awk|gawk)( .*)?inplace|git +(-C +[^ ]+ +)?(${RO_G})( |$))`);
const RO_XARGS_WRITER = new RegExp(`xargs[^;&|]* (/[^ ]*/)?((${RO_W})( |$)|${RO_I}|git +(-C +[^ ]+ +)?(${RO_G})( |$))`);

const MSG = 'git stash (every subcommand, list and show included) must not run in the project working tree from a specialist (A71). Use an evidence worktree: create it in its own call (git worktree add "$TMPDIR/<name>" HEAD), then run git -C "$TMPDIR/<name>" stash ... in a separate call with a literal path that exists (a variable, substitution, cd -, a missing directory, a cd inside a subshell or pipe, or a git stash behind a wrapper is read as the project)';

/** `set -- $x` with IFS=\003: empty fields stay, a trailing separator makes no field. @param {string} s */
function splitSep(s) {
  if (s === '') return [];
  const f = s.split('\x03');
  if (f[f.length - 1] === '') f.pop();
  return f;
}

/** @param {string} p @param {string[]} wts @param {string} root */
function inWorktree(p, wts, root) {
  if (p === '') return false;
  const rootN = root.replace(/^\/private/, '');
  for (const w of wts) {
    if (w === '') continue;
    const wn = w.replace(/^\/private/, '');
    if (wn === rootN) continue;
    if (`${p.replace(/^\/private/, '')}/`.startsWith(`${wn}/`)) return true;
  }
  return false;
}

const GIT_WRITERS = ['reset', 'clean', 'restore', 'switch', 'rebase', 'merge', 'cherry-pick', 'revert', 'am', 'apply', 'checkout', 'rm', 'mv', 'pull'];
const VALUE_OPTS = ['--namespace', '--config-env', '--super-prefix', '--git-dir', '--exec-path', '--attr-source', '--list-cmds', '--exec'];

/** @param {import('../lib/context.mjs').HookContext} ctx @param {string} cmd @param {import('../command-scan.mjs').ScanResult} scan */
export async function stashGuard(ctx, cmd, scan) {
  const wts = await worktrees(ctx);
  let cd = ctx.cwd;
  let cdseen = false; let ok = 0; let rok = 0; let force = false;
  const pre = cmd.includes('stash') ? cmd.slice(0, cmd.lastIndexOf('stash')) : cmd;
  const nl = pre.split('\n').map((l) => l.replace(/&&/g, '').replace(/[0-9]*>&[0-9-]*/g, '').replace(/&>/g, '')).join('\n');
  const nonlin = /[(|&{`]/.test(nl);
  if (grepq(new RegExp(`(^|[^A-Za-z0-9_.-])(env|sudo|doas)[${S}]+([^;&|]*[${S}])?(-[A-Za-z]*[CD]|--chdir|--chdir=)`), cmd)) cd = '';
  for (const rec of scan.records) {
    if (rec.kind !== 'C') continue;
    const { cw, rest } = cParts(rec);
    switch (cw) {
      case 'cd': {
        cdseen = true;
        const a = splitSep(rest);
        while (a.length > 0 && ['-P', '-L', '-e', '-@', '--'].includes(/** @type {string} */ (a[0]))) a.shift();
        cd = a.length === 0 ? '' : stashPath(ctx, /** @type {string} */ (a[0]), cd);
        break;
      }
      case 'pushd': case 'popd': cdseen = true; cd = ''; break;
      case 'find': {
        // a read role's `find -delete` or `find -exec <writer>` starts in an evidence worktree or is refused (A143)
        if (!ctx.ro) break;
        if (!grepq(RO_FIND_WRITER, rest.replace(/\x03/g, ' '))) break;
        let fd = cd;
        const f1 = rest.split('\x03')[0] ?? '';
        if (!(f1.startsWith('-') || f1 === '(' || f1 === '!' || f1 === '')) fd = stashPath(ctx, f1, cd);
        if (!inWorktree(fd, wts, ctx.root)) deny(`find with -delete or -exec of a command that writes starts outside an evidence worktree (or its start directory cannot be read from the command text)${roTail(ctx)}`);
        break;
      }
      case 'env': if (rest.startsWith('GIT_WORK_TREE=') || rest.startsWith('GIT_DIR=')) { cd = ''; force = true; } break;
      case 'git': {
        let dir = cd;
        if (cdseen && nonlin) dir = '';
        const a = splitSep(rest);
        let hit = false; let wtopt = force; let sub = 'stash';
        for (let i = 0; i < a.length; i++) {
          const w = /** @type {string} */ (a[i]);
          if (w === '-C') { if (a.length - i < 2) break; i++; dir = stashPath(ctx, /** @type {string} */ (a[i]), dir); continue; }
          if (w === '--work-tree') { if (a.length - i < 2) break; i++; wtopt = true; continue; }
          if (w.startsWith('--work-tree=')) { wtopt = true; continue; }
          if (w === '-c') {
            if (a.length - i < 2) break;
            i++;
            if (/^[Cc][Oo][Rr][Ee]\.[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee]=/.test(/** @type {string} */ (a[i]))) wtopt = true;
            continue;
          }
          if (VALUE_OPTS.includes(w)) { if (a.length - i < 2) break; i++; continue; }
          if (w.startsWith('-')) continue;
          if (w === 'stash') { hit = true; sub = 'stash'; break; }
          if (GIT_WRITERS.includes(w)) {
            // a read role changes no file of the project tree with git either (A143)
            if (ctx.ro) { hit = true; sub = w; }
            break;
          }
          // a first word that is not a plausible subcommand name (a value of an option this list does not know) followed by the word stash is read as a stash
          if (/[^a-z-]/.test(w)) { for (const x of a.slice(i + 1)) if (x === 'stash') hit = true; }
          break;
        }
        if (!hit) break;
        // --work-tree, core.worktree and GIT_WORK_TREE move the target away from what -C or cd says: the project
        if (wtopt) dir = '';
        if (!inWorktree(dir, wts, ctx.root)) {
          if (sub === 'stash') deny(`${MSG}${roTail(ctx)}`);
          deny(`git ${sub} changes the project working tree; its directory is not a registered evidence worktree (or cannot be read from the command text: a variable, substitution, cd -, a missing directory, a cd inside a subshell or pipe)${roTail(ctx)}`);
        }
        if (sub === 'stash') ok++; else rok++;
        break;
      }
      default: break;
    }
  }
  // `xargs <writer>` takes its files from stdin, so the directory the command ends in must be an evidence worktree.
  if (ctx.ro && RO_XARGS_WRITER.test(cmd.replace(/[\n\t]/g, ' '))) {
    if (!inWorktree(cd, wts, ctx.root)) deny(`xargs of a command that writes runs outside an evidence worktree (or the directory cannot be read from the command text)${roTail(ctx)}`);
  }
  // Safety net on the text: every `git ... stash` in command position that the records above did not resolve to an evidence worktree is refused
  if (stashNetCount(cmd) > ok) deny(`${MSG}${roTail(ctx)}`);
  // The same net for a read role's other tree-changing subcommands (wrappers such as find -exec hide them from the records).
  if (ctx.ro) {
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])git[${S}]+(-C[${S}]+[^${S}]+[${S}]+)?(reset|clean|restore|switch|rebase|merge|cherry-pick|revert|am|apply|checkout|rm|mv|pull)([${S}]|$)`, 'g');
    let rn = 0;
    for (const l of cmd.split('\n')) rn += l.match(re)?.length ?? 0;
    if (rn > rok) deny(`git changes the project working tree, or a wrapper hides which directory it runs in; use git -C <evidence worktree> or cd there with a literal path${roTail(ctx)}`);
  }
}

const VOPT = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--config-env', '--attr-source', '--list-cmds', '--exec'];
const PRINTERS = /^(echo|printf|grep|egrep|fgrep|rg|ag|ack|cat|less|more|man|sed|awk|head|tail|wc|tr|cut|sort|uniq|jq|diff|ls|test|type|which|true)$/;
/** @param {string | undefined} c a character of `[^ \t;&|"'`]` */
const NOSEP = (c) => c !== undefined && !' \t;&|"\'`'.includes(c);

/** The possible ends of one `val` at p: ("..."|'...'|$(...)|`...`|[^ \t;&|"'`]+). @param {string} s @param {number} p @returns {number[]} */
function valEnds(s, p) {
  /** @type {number[]} */ const out = [];
  const c = s[p];
  if (c === '"' || c === "'" || c === '`') { const j = s.indexOf(c, p + 1); if (j >= 0) out.push(j + 1); }
  if (c === '$' && s[p + 1] === '(') { const j = s.indexOf(')', p + 2); if (j >= 0) out.push(j + 1); }
  let e = p;
  while (e < s.length && NOSEP(s[e])) e++;
  if (e > p) out.push(e);
  return out;
}

/** The longest end of `([ \t]+(opt|-[^ \t;&|]+))*[ \t]+(stash([ \t;&|)$`{}]|$)|[$`])` starting right after the word git; -1 when none. @param {string} s @param {number} p0 */
function longestAfterGit(s, p0) {
  let best = -1;
  /** @param {number} p */
  const go = (p) => {
    let q = p;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
    if (q === p) return;
    if (s.startsWith('stash', q)) {
      const c = s[q + 5];
      if (c === undefined) best = Math.max(best, q + 5);
      else if (' \t;&|)$`{}'.includes(c)) best = Math.max(best, q + 6);
    }
    if (s[q] === '$' || s[q] === '`') best = Math.max(best, q + 1);
    for (const o of VOPT) {
      if (!s.startsWith(o, q)) continue;
      let r = q + o.length;
      const w = r;
      while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
      if (r === w) continue;
      for (const e of valEnds(s, r)) go(e);
    }
    if (s[q] === '-') {
      let e = q + 1;
      while (e < s.length && !' \t;&|'.includes(/** @type {string} */ (s[e]))) e++;
      if (e > q + 1) go(e);
    }
  };
  go(p0);
  return best;
}

/** `stash_net_count`. @param {string} text */
export function stashNetCount(text) {
  let n = 0;
  let s = text;
  let off = 0;
  for (;;) {
    // the leftmost match of (^|[^A-Za-z0-9_.-])git ..., the longest from there
    let st = -1; let ln = 0;
    for (let g = 0; g + 3 <= s.length; g++) {
      if (!s.startsWith('git', g)) continue;
      if (g > 0 && /[A-Za-z0-9_.-]/.test(/** @type {string} */ (s[g - 1]))) continue;
      const e = longestAfterGit(s, g + 3);
      if (e < 0) continue;
      st = g === 0 ? 0 : g - 1; ln = e - st;
      break;
    }
    if (st < 0) break;
    const gs = s[st] === 'g' ? st : st + 1;
    const before = text.slice(0, off + gs);
    let k = -1;
    for (let i = before.length - 1; i >= 0; i--) { const c = before[i]; if (c === ';' || c === '&' || c === '|' || c === '(' || c === '{' || c === '\n' || c === '`') { k = i; break; } }
    let t = before.slice(k + 1);
    for (;;) { const m = /^[ \t]*[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/.exec(t); if (!m) break; t = t.slice(m[0].length); }
    t = t.replace(/^[ \t]+/, '');
    const wd = t.split(/[ \t]+/);
    // `git -C $W status`: the `$` the pattern stopped at is the VALUE of a value-taking option, not a subcommand
    const m = s.slice(st, st + ln);
    let skip = false;
    if (new RegExp(`(^|[ \\t])(${VOPT.join('|')})[ \\t]+[$\`]$`).test(m)) {
      const mt = m.split(/[ \t]+/);
      const nt = mt.length;
      if (nt < 3 || !VOPT.includes(/** @type {string} */ (mt[nt - 3]))) {
        let rest = s.slice(st + ln);
        const lc = m[m.length - 1];
        if (lc === '`') { const j = rest.indexOf('`'); rest = j >= 0 ? rest.slice(j + 1) : ''; } else if (rest[0] === '(') { const j = rest.indexOf(')'); rest = j >= 0 ? rest.slice(j + 1) : ''; } else if (rest[0] === '{') { const j = rest.indexOf('}'); rest = j >= 0 ? rest.slice(j + 1) : ''; } else { let e = 0; while (e < rest.length && NOSEP(rest[e])) e++; rest = rest.slice(e); }
        if (/^[ \t]+[A-Za-z][A-Za-z0-9_-]*([ \t;&|)\n]|$)/.test(rest)) skip = true;
      }
    }
    if (!skip && !PRINTERS.test(wd[0] ?? '')) n++;
    off += st + ln;
    s = text.slice(off);
  }
  return n;
}
