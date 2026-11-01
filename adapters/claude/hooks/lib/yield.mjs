// @ts-check
// The duplicate check (ADR 0001 section 9). One event must be handled once, whatever wiring the settings file holds:
//   - the project form (this file runs from <root>/.agents/hooks/) yields when the same settings file also wires the OLD shell hook
//     (`sh -c '... proofline-hook.sh ... <event> <runtime>'`), which a 0.0.40-0.0.42 `proofline upgrade` over a new project adds beside the new string;
//   - the plugin form yields when the project's settings wire the same event themselves, old shell string or new Node string (what `grep` did).
// Yielding only ever hands the event to a hook that is wired for it, so it cannot switch a guard off. An unreadable file means: do not yield.
import { readFileSync, statSync } from 'node:fs';

const KEY = { session: 'SessionStart', prompt: 'UserPromptSubmit', pretool: 'PreToolUse', posttool: 'PostToolUse', 'subagent-start': 'SubagentStart', 'subagent-stop': 'SubagentStop', stop: 'Stop' };
const MSG = 'echo "proofline: the hook did not start (node 22.13 or newer must be on PATH); failing closed" >&2; exit 2;';

/**
 * The strings a wiring file can hold for an event, written out the way the installers wrote them. A command is a wiring only when it EQUALS one of
 * these (S3-4): a decoy that merely contains the file name or ends in `<event> <runtime>` is not.
 * OLD (0.0.40 to 0.0.42, `sh -c`): the project form of Claude Code and the Codex form. The plugin form's old string is not listed: in a settings file it
 * would grep itself and do nothing, so it handles no event.
 * @param {string} ev @param {string} rt
 */
export function knownStrings(ev, rt) {
  const pre = ev === 'pretool';
  const oldClaude = pre
    ? `sh -c 'r=$CLAUDE_PROJECT_DIR; h=$r/.agents/hooks/proofline-hook.sh; [ -f "$h" ] || { [ -f "$r/.agents/config.yaml" ] || exit 0; echo "proofline: $h is missing; failing closed" >&2; exit 2; }; exec sh "$h" ${ev} claude'`
    : `sh -c 'r=$CLAUDE_PROJECT_DIR; h=$r/.agents/hooks/proofline-hook.sh; [ -f "$h" ] || exit 0; exec sh "$h" ${ev} claude'`;
  const oldCodex = pre
    ? `sh -c 'r=$(git rev-parse --show-toplevel 2>/dev/null) || r=$PWD; h=$r/.agents/hooks/proofline-hook.sh; [ -f "$h" ] || { [ -f "$r/.agents/config.yaml" ] || exit 0; echo "proofline: $h is missing; failing closed" >&2; exit 2; }; exec sh "$h" ${ev} codex'`
    : `sh -c 'r=$(git rev-parse --show-toplevel 2>/dev/null) || r=$PWD; h=$r/.agents/hooks/proofline-hook.sh; [ -f "$h" ] || exit 0; exec sh "$h" ${ev} codex'`;
  const newClaude = `node "$CLAUDE_PROJECT_DIR/.agents/hooks/proofline-hook.mjs" ${ev} claude${pre ? ` || test ! -f "$CLAUDE_PROJECT_DIR/.agents/config.yaml" || { ${MSG} }` : ''}`;
  return { old: rt === 'codex' ? [oldCodex] : [oldClaude], newProject: rt === 'codex' ? [] : [newClaude] };
}

/**
 * The commands wired to an event: hooks.<EventName>[*].hooks[*].command, strings only. Anything else in the file (another key, another event, a
 * non-array) counts for nothing.
 * @param {unknown} j @param {string} key @returns {string[]}
 */
function wiredCommands(j, key) {
  const hooks = j && typeof j === 'object' ? /** @type {any} */ (j).hooks : null;
  const groups = hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? hooks[key] : null;
  if (!Array.isArray(groups)) return [];
  /** @type {string[]} */ const out = [];
  for (const g of groups) {
    const hs = g && typeof g === 'object' ? g.hooks : null;
    if (!Array.isArray(hs)) continue;
    for (const h of hs) if (h && typeof h === 'object' && typeof h.command === 'string') out.push(h.command);
  }
  return out;
}

/** @param {string} f */
function isFile(f) { try { return statSync(f).isFile(); } catch { return false; } }

/**
 * @param {string} here the directory of proofline-hook.mjs, with a trailing slash @param {string} ev @param {string} rt @param {Record<string, string | undefined>} env
 * @returns {boolean} true: another real wiring of this event in the same settings file handles it, so this process does nothing. Unreadable, unparsable or oversized settings: false (stay active).
 */
export function yieldsToOtherWiring(here, ev, rt, env) {
  const key = /** @type {Record<string, string>} */ (KEY)[ev];
  if (!key) return false;
  const h = here.replaceAll('\\', '/');
  const project = /\/\.agents\/hooks\/$/.test(h);
  const root = project ? h.replace(/\/\.agents\/hooks\/$/, '') : (rt === 'claude' ? (env.CLAUDE_PROJECT_DIR ?? '') : '');
  if (root === '') return false;
  const file = `${root}/${rt === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'}`;
  let j;
  try { if (statSync(file).size > 4 << 20) return false; j = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  const cmds = wiredCommands(j, key);
  const known = knownStrings(ev, rt);
  // the old shell wiring handles the event only if its hook file is there; the project's Node string (plugin form) likewise
  if (isFile(`${root}/.agents/hooks/proofline-hook.sh`) && cmds.some((c) => known.old.includes(c))) return true;
  return !project && isFile(`${root}/.agents/hooks/proofline-hook.mjs`) && cmds.some((c) => known.newProject.includes(c));
}
