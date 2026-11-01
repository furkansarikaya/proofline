// @ts-check
// Scratch-space rules for shell commands (D10, A56, A52): scratch files go under .agents/runs/<ID>/scratch/ (before a run exists:
// .agents/local/scratch/), $TMPDIR only holds git worktrees. Port of tmp_is_scratch_root, stray_tmp_path, scratch_guard and lead_tmp_check.
import { cParts, deny, worktrees } from './kit.mjs';

/** true when $TMPDIR itself is /tmp (then /tmp is the scratch space and nothing is denied). @param {import('../lib/context.mjs').HookContext} ctx */
export function tmpIsScratchRoot(ctx) {
  const t = ctx.env.TMPDIR ?? '';
  return t === '' || t === '/tmp' || t.startsWith('/tmp/') || t === '/private/tmp' || t.startsWith('/private/tmp/');
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
      else if (v.startsWith('~/') || v.startsWith('$HOME/') || v.startsWith('${HOME}/')) v = `${ctx.env.HOME || '/nonexistent-home'}/${rest()}`;
      if (v.startsWith('/dev/')) continue;
      if (!v.startsWith('/')) continue;
      const n = v.replace(/^\/private/, '').replace(/\/+/g, '/');
      if (n === rootN || n.startsWith(`${rootN}/`)) continue;
      let inWt = false;
      for (const w of wts.join('\n').split(/[ \t\n]+/).filter((x) => x !== '')) {
        const wn = w.replace(/^\/private/, '');
        if (wn === rootN) continue;
        if (n.startsWith(`${wn}/`)) inWt = true;
      }
      if (!inWt) deny(`the command writes '${v}', outside the project. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); $TMPDIR is only for git worktrees. Create the folder there and write inside it`);
    } else if (rec.kind === 'C') {
      const { cw, rest } = cParts(rec);
      if (cw === 'mktemp') {
        const a = rest.replace(/\x03/g, ' ');
        if (!a.includes('scratch/')) deny('mktemp would create its file or folder under $TMPDIR. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); $TMPDIR is only for git worktrees: mkdir there and name the path');
      }
    }
  }
}

/** `lead_tmp_check`: the lead (and any session without a run) keeps scratch files out of /tmp too (A52). @param {import('../lib/context.mjs').HookContext} ctx @param {string} cmd @param {import('../command-scan.mjs').ScanResult} scan */
export function leadTmpCheck(ctx, cmd, scan) {
  if (tmpIsScratchRoot(ctx)) return;
  const p = strayTmpPath(ctx, cmd, scan);
  if (p !== '') deny(`${p} is outside the project. Scratch files go under .agents/runs/<ID>/scratch/ (before a run exists: .agents/local/scratch/); only git worktrees go under $TMPDIR (${ctx.env.TMPDIR || 'unset'})`);
}
