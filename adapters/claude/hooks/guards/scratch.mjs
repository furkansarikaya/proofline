// @ts-check
// Scratch-space rules for shell commands (D10, A56, A52): scratch files go under .agents/runs/<ID>/scratch/ (before a run exists:
// .agents/local/scratch/), $TMPDIR only holds git worktrees. Port of tmp_is_scratch_root, stray_tmp_path, scratch_guard and lead_tmp_check.
import { lstatSync, realpathSync } from 'node:fs';
import { cParts, deny, worktrees } from './kit.mjs';
import { isAbsPath, isWin, pathKey, winSpell } from '../lib/text.mjs';

/** true when $TMPDIR itself is /tmp (then /tmp is the scratch space and nothing is denied). @param {import('../lib/context.mjs').HookContext} ctx */
export function tmpIsScratchRoot(ctx) {
  const t = ctx.env.TMPDIR ?? '';
  return t === '' || t === '/tmp' || t.startsWith('/tmp/') || t === '/private/tmp' || t.startsWith('/private/tmp/');
}

/** The scratch folder named with the run id, so the next call can use it as written (A257). @param {import('../lib/context.mjs').HookContext} ctx */
export function scratchDir(ctx) {
  return ctx.act !== '' ? `.agents/runs/${ctx.act}/scratch/` : '.agents/local/scratch/';
}

const TASK_OUT = /^(\/private)?\/tmp\/claude-[0-9]+\/[^/]+\/[^/]+\/tasks\/[^/]+\.output$/;

/** The first /tmp (or /private/tmp) path in TEXT that is not inside the project root. @param {import('../lib/context.mjs').HookContext} ctx @param {string} text @param {import('../command-scan.mjs').ScanResult} scan */
export function strayTmpPath(ctx, text, scan) {
  const re = /(\/private)?\/tmp(\/[^ \t\n\v\f\r"';|&)<>]*)?/g;
  const r = ctx.root.replace(/^\/private/, '');
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(re)) {
      const p = m[0];
      const q = p.replace(/^\/private/, '');
      if (q === r || q.startsWith(`${r}/`)) continue;
      // A171: the runtime's own background task output is read-only evidence the lead is told to read; allowed unless the same command writes to it
      // or runs it: exactly /tmp/claude-<uid>/<project>/<session>/tasks/<file>.output, only as the operand of a read-only reader
      if (TASK_OUT.test(p) && !p.includes('..')) {
        let bad = false;
        for (const rec of scan.records) {
          const f = rec.raw.split('\t');
          if (/^[WEPQL]$/.test(rec.kind) && f[0] === p) bad = true;
          if (rec.kind === 'C') {
            const cw = f[0] ?? ''; const args = f[1] ?? '';
            if (args.includes(p)) {
              if (!/^(cat|head|tail|grep|wc|sed)$/.test(cw)) bad = true;
              else if (cw === 'sed') { const a = args.split('\x03'); if (!(a.length === 3 && a[0] === '-n' && /^([0-9]+(,[0-9]+)?|\$)p$/.test(a[1] ?? '') && a[2] === p)) bad = true; }
            }
          }
        }
        if (!bad) continue;
      }
      return p;
    }
  }
  return '';
}

/** Windows spellings of `$HOME` that name a folder outside the project: %NAME%, $NAME, ${NAME}, $env:NAME. */
const WIN_VARS = /^(?:%([A-Za-z_]{1,24})%|\$env:([A-Za-z_]{1,24})|\$\{([A-Za-z_]{1,24})\}|\$([A-Za-z_]{1,24}))(?=[\\/]|$)/;
const WIN_VAR_NAMES = new Set(['userprofile', 'appdata', 'localappdata', 'temp', 'tmp', 'programdata', 'programfiles', 'systemroot', 'windir', 'homepath', 'public', 'allusersprofile']);

/**
 * The place a write target lands (A271): a relative target is taken from the working directory and `..` is resolved before anything is compared,
 * so `../x`, `<root>/../x` and `a/../../x` are judged where they land. POSIX: a name followed by `..` that is a symbolic link makes the result
 * unknowable (the OS goes to the parent of the link target): null. Windows resolves `..` in the text, as winSpell does. null: cannot be placed.
 * @param {string} cwd @param {string} v
 * @returns {string | null}
 */
export function landing(cwd, v) {
  const full = isAbsPath(v) ? v : `${cwd}/${v}`;
  if (isWin()) { const w = winSpell(full); return w.bad ? null : w.p; }
  /** @type {string[]} */ const stack = [];
  for (const seg of full.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const top = stack.length > 0 ? `/${stack.join('/')}` : '';
      if (top !== '') { try { if (lstatSync(top).isSymbolicLink()) return null; } catch { /* not there */ } }
      stack.pop();
    } else stack.push(seg);
  }
  return `/${stack.join('/')}`;
}

/** @param {string} p the physical form of a working directory in forward slashes, else the text */
function posixPhys(p) { try { return realpathSync.native(p).replace(/\\/g, '/'); } catch { return p; } }

/** `scratch_guard`: a write whose target is under $TMPDIR or /tmp and not inside a registered worktree is refused, and so is `mktemp` without a template. @param {import('../lib/context.mjs').HookContext} ctx @param {import('../command-scan.mjs').ScanResult} scan */
export async function scratchGuard(ctx, scan) {
  let sgT = ctx.env.TMPDIR ?? '';
  if (sgT.endsWith('/')) sgT = sgT.slice(0, -1);
  if (sgT === '') sgT = '/tmp';
  const wts = await worktrees(ctx);
  const rootN = ctx.root.replace(/^\/private/, '');
  for (const rec of scan.records) {
    if (rec.kind === 'W') {
      let v = rec.value.replace(/\n+$/, '');
      const rest = () => v.slice(v.indexOf('/') + 1);
      if (v.startsWith('$TMPDIR/') || v.startsWith('${TMPDIR}/')) v = `${sgT}/${rest()}`;
      else if (v === '$PWD' || v === '${PWD}') v = '.';
      else if (v.startsWith('$PWD/') || v.startsWith('${PWD}/')) v = `./${rest()}`; // the scanner knows what $PWD is: the working directory, so the target is relative to it
      else if (v.startsWith('~/') || v.startsWith('$HOME/') || v.startsWith('${HOME}/')) v = `${ctx.env.HOME || '/nonexistent-home'}/${rest()}`;
      const climbs = `/${isWin() ? v.replace(/\\/g, '/') : v}/`.includes('/../');
      if (!climbs && v.startsWith('/dev/')) continue;
      const shown = v;
      let viaVar = false; // the target was spelled with a variable: the written text is no second opinion
      if (isWin()) {
        // the Windows analogues of $HOME: a variable that names a folder outside the project, an unset one is outside too
        const vm = WIN_VARS.exec(v);
        if (vm) {
          const name = (vm[1] ?? vm[2] ?? vm[3] ?? vm[4] ?? '').toLowerCase();
          if (WIN_VAR_NAMES.has(name)) {
            const key = Object.keys(ctx.env).find((k) => k.toLowerCase() === name);
            v = `${(key ? ctx.env[key] : '') || 'C:/__unset_variable__'}${v.slice(vm[0].length)}`; viaVar = true;
          }
        }
        // A271: a drive (`C:\x`, `D:/x`), UNC (`\\srv\share\x`), `\\?\C:\x` or Git Bash (`/c/x`) spelling is an absolute path like `/etc/x`, never a relative one;
        // one that cannot be placed (`C:x`, a device such as CON or `\\.\NUL`) is refused like an outside path. A bare NUL is the null device (the /dev/null above).
        const sp = winSpell(v);
        if (sp.nul) continue;
        if (sp.bad) deny(`the command writes '${shown}', a Windows path that cannot be placed inside the project (a drive-relative, device or malformed path). Scratch files go under ${scratchDir(ctx)} (mkdir -p it, then write inside it, for example > ${scratchDir(ctx)}out.txt); $TMPDIR is only for git worktrees`);
        v = sp.p;
      }
      if (isAbsPath(v) ? climbs : (ctx.cwd ?? '') !== '') {
        // a relative target, or one that climbs, is judged where it lands
        // POSIX: the kernel resolves `..` from the PHYSICAL working directory; Windows resolves it in the text (the physical form is the second chance below)
        const phys = () => { try { return realpathSync.native(ctx.cwd ?? ''); } catch { return ctx.cwd ?? ''; } };
        const at = landing(isWin() ? (ctx.cwd ?? '') : phys(), v);
        if (at === null) deny(`the command writes '${shown}', a path that cannot be resolved to a place inside the project (a link followed by .., or a Windows path that cannot be placed). Scratch files go under ${scratchDir(ctx)} (mkdir -p it, then write inside it, for example > ${scratchDir(ctx)}out.txt); $TMPDIR is only for git worktrees`);
        v = at;
        if (!isWin() && v.startsWith('/dev/')) continue;
        if (isWin() && !viaVar && !isAbsPath(shown.replace(/\\/g, '/'))) {
          // a relative target from a working directory spelled another way (8.3, case): the physical form decides when the written one says outside
          const n0 = pathKey(v.replace(/\/+/g, '/'));
          if (!(n0 === pathKey(rootN) || n0.startsWith(`${pathKey(rootN)}/`))) { const p2 = landing(posixPhys(ctx.cwd ?? ''), winSpell(shown).p); if (p2 !== null) v = p2; }
        }
      }
      if (!isAbsPath(v)) continue;
      const n = pathKey(v.replace(/^\/private/, '').replace(/\/+/g, '/'));
      if (n === pathKey(rootN) || n.startsWith(`${pathKey(rootN)}/`)) continue;
      let inWt = false;
      for (const w of wts.join('\n').split(/[ \t\n]+/).filter((x) => x !== '')) {
        const wn = pathKey(w.replace(/^\/private/, ''));
        if (wn === pathKey(rootN)) continue;
        if (n.startsWith(`${wn}/`)) inWt = true;
      }
      if (!inWt) deny(`the command writes '${shown}', outside the project. Scratch files go under ${scratchDir(ctx)} (mkdir -p it, then write inside it, for example > ${scratchDir(ctx)}out.txt); $TMPDIR is only for git worktrees`);
    } else if (rec.kind === 'C') {
      const { cw, rest } = cParts(rec);
      if (cw === 'mktemp') {
        const a = rest.replace(/\x03/g, ' ');
        if (!a.includes('scratch/')) deny(`mktemp would create its file or folder under $TMPDIR. Scratch files go under ${scratchDir(ctx)} ($TMPDIR is only for git worktrees): mkdir -p ${scratchDir(ctx)} && mktemp ${scratchDir(ctx)}XXXXXX`);
      }
    }
  }
}

/** `lead_tmp_check`: the lead (and any session without a run) keeps scratch files out of /tmp too (A52). @param {import('../lib/context.mjs').HookContext} ctx @param {string} cmd @param {import('../command-scan.mjs').ScanResult} scan */
export function leadTmpCheck(ctx, cmd, scan) {
  if (tmpIsScratchRoot(ctx)) return;
  const p = strayTmpPath(ctx, cmd, scan);
  if (p !== '') deny(`${p} is outside the project. Scratch files go under ${scratchDir(ctx)} (mkdir -p it first); only git worktrees go under $TMPDIR (${ctx.env.TMPDIR || 'unset'})`);
}
