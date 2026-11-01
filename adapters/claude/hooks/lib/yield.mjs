// @ts-check
// The duplicate check (ADR 0001 section 9). One event must be handled once, whatever wiring the settings file holds:
//   - the project form (this file runs from <root>/.agents/hooks/) yields when the same settings file also wires the OLD shell hook
//     (`sh -c '... proofline-hook.sh ... <event> <runtime>'`), which a 0.0.40-0.0.42 `proofline upgrade` over a new project adds beside the new string;
//   - the plugin form yields when the project's settings wire the same event themselves, old shell string or new Node string (what `grep` did).
// Yielding only ever hands the event to a hook that is wired for it, so it cannot switch a guard off. An unreadable file means: do not yield.
import { readFileSync, statSync } from 'node:fs';

/** @param {unknown} v @param {string[]} out */
function commands(v, out) {
  if (Array.isArray(v)) { for (const x of v) commands(x, out); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'command' && typeof x === 'string') out.push(x); else commands(x, out);
    }
  }
}

/** @param {string} here the directory of proofline-hook.mjs, with a trailing slash @param {string} ev @param {string} rt @param {Record<string, string | undefined>} env */
export function yieldsToOtherWiring(here, ev, rt, env) {
  const project = /\/\.agents\/hooks\/$/.test(here.replaceAll('\\', '/'));
  const root = project ? here.replaceAll('\\', '/').replace(/\/\.agents\/hooks\/$/, '') : (rt === 'claude' ? (env.CLAUDE_PROJECT_DIR ?? '') : '');
  if (root === '') return false;
  const file = `${root}/${rt === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'}`;
  let text;
  try { if (statSync(file).size > 4 << 20) return false; text = readFileSync(file, 'utf8'); } catch { return false; }
  /** @type {string[]} */ const cmds = [];
  try { commands(JSON.parse(text), cmds); } catch { return false; }
  const tail = new RegExp(`(?:^|\\s)${ev.replace(/[^a-z-]/g, '')} ${rt}(?:['"\\s]|$)`);
  const oldShell = /proofline-hook(?:\.|\[\.\])sh/;
  const newNode = /\.agents\/hooks\/proofline-hook\.mjs/;
  return cmds.some((c) => tail.test(c) && (oldShell.test(c) || (!project && newNode.test(c))));
}
