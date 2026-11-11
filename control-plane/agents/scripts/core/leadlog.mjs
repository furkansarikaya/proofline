// @ts-check
// A258 (#181 item 3, second half): the lead's own session log. `tools.jsonl` covers the specialists at `submit`; the lead's calls were invisible to `proofline insights`.
// When a run ends (handoff DONE, terminate) the control plane finds the lead's own session log and appends ONE snapshot record (`kind: lead`, role `lead`) with the same
// counts the step records have. Nothing is copied from the log; a log that cannot be used is recorded as `unreadable` with a reason, never as zero.
// Where the log is, by runtime (the runtime's own directory only):
//   claude: <CLAUDE_CONFIG_DIR or $HOME/.claude>/projects/<project folder>/<CLAUDE_CODE_SESSION_ID>.jsonl; the project folder is the working directory of the session with every
//           character outside [A-Za-z0-9] replaced by `-`; the candidates are this tree, the main tree and the working directory. The session id must be a UUID (so it cannot
//           carry a path), the folder name is made of [A-Za-z0-9-] only, a symbolic link (file or folder) and a non-regular file are refused.
//   codex:  findCodexRollout (A255): CODEX_THREAD_ID, UUID, exact name in the day folders of the last 4 days.
import { lstatSync, realpathSync } from 'node:fs';
import { now } from './clock.mjs';
import { UUID, findCodexRollout, toolsRecord } from './toolstats.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The folder name Claude Code gives a working directory. @param {string} cwd */
export const claudeProjectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

/**
 * @param {Record<string, string | undefined>} env @param {string[]} cwds the working directories the session may have started in
 * @returns {{ file: string, reason: string | null }}
 */
export function findClaudeLead(env, cwds) {
  const sid = env.CLAUDE_CODE_SESSION_ID ?? '';
  if (!UUID.test(sid)) return { file: '', reason: 'no-session-id' };
  const cfg = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.startsWith('/') ? env.CLAUDE_CONFIG_DIR : (env.HOME ? `${env.HOME}/.claude` : '');
  if (!cfg.startsWith('/')) return { file: '', reason: 'no-claude-home' };
  let refused = false;
  for (const cwd of [...new Set(cwds)]) {
    const dir = `${cfg}/projects/${claudeProjectDir(cwd)}`;
    const file = `${dir}/${sid}.jsonl`;
    try {
      if (lstatSync(dir).isSymbolicLink()) { refused = true; continue; }
      const st = lstatSync(file);
      if (st.isFile()) return { file, reason: null };
      refused = true;
    } catch { /* not here */ }
  }
  return { file: '', reason: refused ? 'not-a-file' : 'no-transcript' };
}

/**
 * Append the snapshot of the lead's session for run ID. Best effort: it never throws and never changes the result of the command that calls it.
 * @param {Context} ctx @param {string} id
 */
export function leadToolsRecord(ctx, id) {
  try {
    if (ctx.role !== 'lead') return;
    const env = ctx.env;
    // the runtime is the one whose session variable is set; with neither, the configured lead runtime (the record then says `no-session-id`)
    const claude = (env.CLAUDE_CODE_SESSION_ID ?? '') !== '' || ((env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || '') === '' && ctx.config().get('runtime.lead', 'claude') !== 'codex');
    const sid = claude ? (env.CLAUDE_CODE_SESSION_ID ?? '') : (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || '');
    const found = claude ? findClaudeLead(env, [ctx.root, ctx.sharedMain(), ctx.cwd].flatMap((p) => { try { return [p, realpathSync(p)]; } catch { return [p]; } })) : findCodexRollout(env, now().epoch);
    toolsRecord(ctx, { task: id, role: 'lead', focus: '', gate: '', runtime: claude ? 'claude' : 'codex', log: found.file, reason: found.reason, kind: 'lead', session: UUID.test(sid) ? sid : '' });
  } catch { /* a metrics side effect */ }
}
