// @ts-check
// PreToolUse guard of the file-writing tools (Write, Edit, MultiEdit, NotebookEdit) and, through fileTool, of Codex's patch tools. The non-Bash
// part of the `pretool)` case of proofline-hook.sh, in its order: the git-hook files, the database guard, the lead's ban on product files
// without a run (A169), then with a run: links and hard links, the role's paths, the copy's boundary (A120), the language of run files (A171).
// Returns null (allow) or { decision: 'deny', reason }. The router renders the JSON.
import {
  alwaysProtected, baseline, dbGuardFiles, deny, erasable, guarded, nrPathOk, outsideOk, relpath, roTail, targetOk,
} from './policy.mjs';
import { jget } from '../lib/text.mjs';

/** @typedef {import('../lib/context.mjs').HookContext} Ctx */

/** @param {unknown} input @param {Ctx} ctx */
export async function writeGuard(input, ctx) {
  const tool = jget(input ?? ctx.input, 'tool_name');
  return fileTool(ctx, tool);
}

/** The targets a tool names: the path of a file tool, the file headers of a Codex patch. @param {Ctx} ctx @param {string} tool @returns {{ targets: string[], erase: string[] } | null} null: no target path while nothing is active (the shell exits there) */
function collectTargets(ctx, tool) {
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = ctx.get('tool_input.file_path', 'tool_input.notebook_path', 'tool_input.path');
    if (p === '') {
      if (ctx.act !== '') deny(ctx, `${tool} without a target path`);
      return null;
    }
    const t = p.split('\n');
    if (t.length > 1) t.push(p); // a path with a newline is also one whole path
    return { targets: t, erase: [] };
  }
  if (/[Pp]atch/.test(tool)) {
    const text = ctx.get('tool_input');
    /** @type {string[]} */ const targets = []; /** @type {string[]} */ const erase = [];
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(/\*\*\* (Add|Update|Delete) File: [^\\"]+|\*\*\* Move to: [^\\"]+/g)) {
        const t = m[0].replace(/^\*\*\* [A-Za-z ]*: /, '');
        targets.push(t);
        if (m[1] === 'Delete') erase.push(m[0].replace(/^\*\*\* Delete File: /, ''));
      }
    }
    return { targets, erase };
  }
  return { targets: [], erase: [] };
}

/**
 * The pipeline of a tool that names files (or none: Read, Grep, Glob).
 * @param {Ctx} ctx @param {string} tool @returns {Promise<{ decision: 'deny' | 'ask', reason: string } | null>}
 */
export async function fileTool(ctx, tool) {
  if (!ctx.installed) return null;
  return guarded(ctx, async () => {
    await baseline(ctx);
    const got = collectTargets(ctx, tool);
    if (!got) return;
    const { targets, erase } = got;
    for (const tg of targets) if (alwaysProtected((await relpath(ctx, tg)).rel)) deny(ctx, `${tool} ${tg} wires the git hooks; it is never changed by an agent`);
    if (/^(Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob)$/.test(tool) || /[Pp]atch/.test(tool)) await dbGuardFiles(ctx, tool, targets);
    if (ctx.act === '') { // A169: no run, the lead's main session: the ban on product files holds here too
      if (ctx.role === 'lead' && !ctx.sub) {
        for (const tg of targets) {
          const why = await nrPathOk(ctx, (await relpath(ctx, tg)).rel);
          if (why !== '') deny(ctx, `${tool} ${tg}: ${why}`);
        }
      }
      return;
    }
    for (const tg of targets) {
      let why = await targetOk(ctx, tg);
      if (why !== '') {
        // a patch that only deletes a file the run created (see erasable)
        if (targets.filter((x) => x === tg).length === 1 && erase.includes(tg) && await erasable(ctx, tg)) continue;
        deny(ctx, `${tool} ${tg}: ${why}${roTail(ctx)}`);
      }
      // A120: the file tools write nothing outside the copy (the shell guard handles shell writes, A97)
      if ((await relpath(ctx, tg)).rel === '@outside') {
        why = await outsideOk(ctx, tg);
        if (why !== '') deny(ctx, `${tool} ${tg}: ${why}`);
      }
    }
    // A171: run files are English; the text about to be written goes through `agent.sh language-check`
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') await languageCheck(ctx, tool);
  });
}

/** @param {Ctx} ctx @param {string} tool */
async function languageCheck(ctx, tool) {
  const lp = (await relpath(ctx, ctx.get('tool_input.file_path', 'tool_input.path'))).rel;
  // A178: exactly .agents/runs/<ID>/questions/NNN.md (the question block for the user, in the user's language) is not checked
  if (lp.startsWith('.agents/runs/') && lp.indexOf('/', 13) >= 0) {
    const lq = lp.slice(lp.indexOf('/', 13) + 1);
    if (/^questions\/[0-9][0-9][0-9]\.md$/.test(lq)) return;
  }
  const g = (/** @type {string} */ s) => new RegExp(`^${s.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`, 's').test(lp);
  if (['.agents/runs/*/dispatch/*', '.agents/runs/*/scratch/*', '.agents/runs/*/gates/*', '.agents/runs/*/LEDGER.log', '.agents/runs/*/HOOKS.log', '.agents/runs/*/reviews/visual-proof/*', '.agents/runs/*/reports/qa-evidence/*'].some(g)) return;
  if (!['.agents/runs/*/*.md', '.agents/runs/*/*.yaml', '.agents/runs/*/*.json'].some(g)) return;
  let text;
  if (tool === 'MultiEdit') { // the new_string of every edit, as text (a JSON array would hide the line starts)
    const edits = /** @type {any} */ (ctx.input)?.tool_input?.edits;
    text = '';
    if (Array.isArray(edits)) for (const e of edits) if (e && typeof e.new_string === 'string') text += `${e.new_string}\n`;
  } else text = `${ctx.get('tool_input.content', 'tool_input.new_string')}\n`;
  const r = await ctx.agent(['language-check', '-', lp], { input: text });
  if (r.status !== 0) deny(ctx, `${tool} ${lp}: ${(r.stdout + r.stderr).replace(/\n+$/, '')}`);
}
