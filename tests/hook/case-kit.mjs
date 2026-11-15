// @ts-check
// Shared pieces of the A278 case tests (case-paths.test.mjs, case-world.test.mjs): the in-process verdict of the PreToolUse hook on an injected volume, the roles, a seeded generator.
// The verdicts are asked in process (the same buildContext and PreToolUse handler the hook runs). A guard asks `agent.sh summary` (the core fingerprints the work tree: five git processes) once per verdict; a table of
// hundreds of verdicts would spend its time there. THE TEST SEAM: `pre` answers `summary` once per project and run from a cache (the fixture's state never changes inside a table). Production code has no such seam.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeHook, cleanEnv } from './harness.mjs';
import { createFsCase, useFsCase } from '../../adapters/claude/hooks/lib/fscase.mjs';

export const hookDir = dirname(nodeHook);
export const { buildContext, finish } = await import(pathToFileURL(join(hookDir, 'lib/context.mjs')).href);
export const { handle } = await import(pathToFileURL(join(hookDir, 'events/pretool.mjs')).href);

export const FOLDS = () => createFsCase({ probe: () => true });
export const KEEPS = () => createFsCase({ probe: () => false });
/** @template T @param {ReturnType<typeof createFsCase>} inst @param {() => Promise<T>} fn @returns {Promise<T>} */
export async function onVolume(inst, fn) { const prev = useFsCase(inst); try { return await fn(); } finally { useFsCase(prev); } }

/** [name, who (agent fields), env (AGENT_ROLE), project] */
export const WHO = /** @type {Array<[string, Record<string, string>, Record<string, string>, 'run' | 'norun']>} */ ([
  ['lead', {}, {}, 'run'],
  ['lead without a run', {}, {}, 'norun'],
  ['implementer', { agent_type: 'proofline-implementer', agent_id: 'f1' }, { AGENT_ROLE: 'implementer' }, 'run'],
  ['designer', { agent_type: 'proofline-designer', agent_id: 'f1' }, { AGENT_ROLE: 'designer' }, 'run'],
  ['reviewer', { agent_type: 'proofline-reviewer', agent_id: 'f1' }, { AGENT_ROLE: 'reviewer' }, 'run'],
  ['qa', { agent_type: 'proofline-qa', agent_id: 'f1' }, { AGENT_ROLE: 'qa' }, 'run'],
]);
/** The lead and four other roles, the set of the tables. */
export const FIVE = [WHO[0], WHO[2], WHO[3], WHO[4], WHO[5]];

/** @type {Map<string, Promise<unknown>>} */
const summaries = new Map();

/** The refusal text, or null when allowed. @param {string} tool @param {Record<string, unknown>} input @param {Record<string, string>} who @param {Record<string, string>} env @param {string} proj */
export async function pre(tool, input, who, env, proj, cwd = proj) {
  const raw = Buffer.from(JSON.stringify({ cwd, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...who }));
  const c = await buildContext('pretool', 'claude', raw, cleanEnv({ CLAUDE_PROJECT_DIR: proj, TMPDIR: '/var/proofline-case-tmp', ...env }));
  assert.ok(c, 'no hook context');
  const agent = c.agent.bind(c);
  c.agent = (/** @type {string[]} */ argv, /** @type {any} */ opt) => {
    if (argv[0] !== 'summary') return agent(argv, opt);
    const key = `${c.sroot}\0${argv.join(' ')}`;
    let hit = summaries.get(key);
    if (!hit) { hit = agent(argv, opt); summaries.set(key, hit); }
    return hit;
  };
  try {
    const out = await handle(c);
    if (typeof out !== 'string' || out === '') return null;
    return /** @type {string} */ (JSON.parse(out).hookSpecificOutput.permissionDecisionReason);
  } finally { finish(c); }
}

/** The marker `@` is removed at run time: a script file that names a process killer fed by a search, or a push to the protected branch, is refused by the author's own hook when node starts it. @param {string} t */
export const U = (t) => t.replaceAll('@', '');

/** a small seeded generator (mulberry32) @param {number} seed */
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
