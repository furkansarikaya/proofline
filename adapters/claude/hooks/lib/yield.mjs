// @ts-check
// The duplicate check (ADR 0001 section 9). One event must be handled once, whatever wiring the settings file holds:
//   - the project form (this file runs from <root>/.agents/hooks/) yields when the same settings file also wires the OLD shell hook
//     (`sh -c '... proofline-hook.sh ... <event> <runtime>'`), which a 0.0.40 to 0.0.42 `proofline upgrade` over a new project adds beside the new string;
//   - the plugin form yields when the project's settings wire the same event themselves, old shell string or new Node string (what `grep` did).
// Yielding only ever hands the event to a hook that is wired for it, so it cannot switch a guard off. An unreadable file means: do not yield.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { sameTree } from './tree.mjs';

/** SHA-256 of proofline-hook.sh in each release that wired the `sh -c` strings (the file a rollback `upgrade` puts back): 0.0.40 (bc072f3), 0.0.41 (06d4636b), 0.0.42 (9e10e5fc). An exact list. */
export const OLD_SHELL_HOOK_SHA256 = [
  'e91d39f792136d566af34ef1dea90f6ea5f8aa840085cf7d2b33822431a023ea',
  '801db174ded92523762bfbf8d4bbd511580af5139cce32747a8f703cc2e6ba1a',
  '075993b8b4c573c401d2e0185693e16f750f3c1995d5ddc1a9fc474c78d33bbc',
];
/** What the project's Node hook is made of, relative to .agents/hooks/: the entry, the scanner and the three folders it imports. */
const HOOK_TREE = ['proofline-hook.mjs', 'command-scan.mjs', 'events', 'guards', 'lib'];

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
  // the matcher of the entry in the wiring file: the set of tools the entry fires for
  const matcher = ev === 'pretool' ? (rt === 'codex' ? '.*' : 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob|Skill') : ev === 'posttool' ? (rt === 'codex' ? '.*' : '*') : undefined;
  return { old: rt === 'codex' ? [oldCodex] : [oldClaude], newProject: rt === 'codex' ? [] : [newClaude], matcher };
}

/**
 * The commands wired to an event: hooks.<EventName>[*].hooks[*].command, strings only, from an entry whose matcher is the template's and whose keys are
 * only `matcher` and `hooks` (an entry that fires for another tool set is not the wiring). The `timeout` of a hook is the user's config (hook-timeouts)
 * and is not compared. Anything else in the file (another key, another event, a non-array) counts for nothing.
 * @param {unknown} j @param {string} key @param {string | undefined} matcher @returns {string[]}
 */
function wiredCommands(j, key, matcher) {
  const hooks = j && typeof j === 'object' ? /** @type {any} */ (j).hooks : null;
  const groups = hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? hooks[key] : null;
  if (!Array.isArray(groups)) return [];
  /** @type {string[]} */ const out = [];
  for (const g of groups) {
    const hs = g && typeof g === 'object' ? g.hooks : null;
    if (!Array.isArray(hs) || g.matcher !== matcher || Object.keys(g).some((k) => k !== 'matcher' && k !== 'hooks')) continue;
    for (const h of hs) if (h && typeof h === 'object' && typeof h.command === 'string') out.push(h.command);
  }
  return out;
}

/** A regular file, not a link, whose SHA-256 is one of the list. @param {string} f @param {string[]} shas */
function isOneOfSha(f, shas) {
  try {
    if (!lstatSync(f).isFile()) return false;
    return shas.includes(createHash('sha256').update(readFileSync(f)).digest('hex'));
  } catch { return false; }
}

/**
 * The plugin yields to the project's Node hook only if that hook is the genuine one: the files it runs (the hook tree and the core it imports) are
 * byte-identical to the plugin's own copies, links never count. Any mismatch, missing file or read error: false, and the plugin stays active (an
 * event handled twice is harmless, an event handled by a stub is not). @param {string} here the plugin's hook folder @param {string} root the project
 */
function genuineProjectHook(here, root) {
  const mine = here.replace(/\/$/, '');
  for (const n of HOOK_TREE) if (!sameTree(`${mine}/${n}`, `${root}/.agents/hooks/${n}`)) return false;
  const coreSrc = `${mine}/../../../control-plane/agents/scripts`;
  return sameTree(`${coreSrc}/proofline-core.mjs`, `${root}/.agents/scripts/proofline-core.mjs`) && sameTree(`${coreSrc}/core`, `${root}/.agents/scripts/core`);
}

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
  const known = knownStrings(ev, rt);
  const cmds = wiredCommands(j, key, known.matcher);
  // the old shell wiring handles the event only if the hook file it starts is the released one (a stub or a modified copy handles nothing); the project's
  // Node string (plugin form) only if the project's hook is the plugin's own, byte for byte
  if (cmds.some((c) => known.old.includes(c)) && isOneOfSha(`${root}/.agents/hooks/proofline-hook.sh`, OLD_SHELL_HOOK_SHA256)) return true;
  return !project && cmds.some((c) => known.newProject.includes(c)) && genuineProjectHook(h, root);
}
