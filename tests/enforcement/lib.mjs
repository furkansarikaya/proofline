// @ts-check
// The Node form of the helper block at the top of tests/enforcement/*-test.sh (176-C): H, pre_edit, pre_bash, pre_raw, sub_start, sub_stop, post,
// prompt, denied, allowed and fixture. Every call runs the REAL hook (adapters/claude/hooks/proofline-hook.mjs, or HOOK_UNDER_TEST) in a child
// process with the hook JSON on stdin, in the project, with a hardened environment (no real HOME, gh or git configuration).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { cleanEnv } from '../lib/harness.mjs';
import { project } from '../core/legacy-lib.mjs';
import { repo } from '../hook/harness.mjs';

export const hookFile = process.env.HOOK_UNDER_TEST || path.join(repo, 'adapters/claude/hooks/proofline-hook.mjs');
/** A loaded runner must not expire the approval step of the hook mid-test: tests that exercise the budget set their own. */
const HOOK_ENV = { PROOFLINE_HOOK_APPROVE_BUDGET: '300', PROOFLINE_HOOK_LOCK_WAIT: '120' };

/**
 * `H EVENT JSON [RUNTIME]`: the hook's stdout. @param {string} dir @param {string} event @param {string} json
 * @param {{ runtime?: string, env?: Record<string, string>, hook?: string, timeout?: number }} [o]
 */
export function H(dir, event, json, o = {}) { return Hr(dir, event, json, o).stdout; }
/** Like H with the whole result. @param {string} dir @param {string} event @param {string} json @param {{ runtime?: string, env?: Record<string, string>, hook?: string, timeout?: number }} [o] */
export function Hr(dir, event, json, o = {}) {
  const r = spawnSync(process.execPath, [o.hook ?? hookFile, event, o.runtime ?? 'claude'], { cwd: dir, input: json, encoding: 'utf8', env: cleanEnv({ ...HOOK_ENV, ...(o.env ?? {}) }), timeout: o.timeout ?? 120000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
/** @param {string} [type] @param {string} [id] */
const who = (type, id) => (type ? { agent_type: type, agent_id: id || 'a1' } : {});

/** PreToolUse of a file tool. @param {string} dir @param {string} tool @param {string} file @param {string} [type] @param {string} [id] @param {{ env?: Record<string, string> }} [o] */
export const preEdit = (dir, tool, file, type, id, o = {}) => H(dir, 'pretool', JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: dir, tool_name: tool, tool_input: { file_path: file }, ...who(type, id) }), o);
/** PreToolUse of Bash. @param {string} dir @param {string} command @param {string} [type] @param {string} [id] @param {{ env?: Record<string, string> }} [o] */
export const preBash = (dir, command, type, id, o = {}) => H(dir, 'pretool', JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command }, ...who(type, id) }), o);
/** TOOL KEY VALUE [RUNTIME]: no agent identity (the lead). @param {string} dir @param {string} tool @param {string} key @param {string} value @param {string} [runtime] */
export const preRaw = (dir, tool, key, value, runtime = 'claude') => H(dir, 'pretool', JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: tool, tool_input: { [key]: value } }), { runtime });
/** @param {string} dir @param {string} type @param {string} [id] */
export const subStart = (dir, type, id) => H(dir, 'subagent-start', JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 's1', cwd: dir, ...who(type, id) }));
/** The final message is never read; the hook reads the submission status. @param {string} dir @param {string} type @param {string} id @param {boolean} [stopHookActive] */
export const subStop = (dir, type, id, stopHookActive = false) => H(dir, 'subagent-stop', JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 's1', cwd: dir, stop_hook_active: stopHookActive, ...who(type, id), last_assistant_message: 'done' }));
/** @param {string} dir */
export const post = (dir) => H(dir, 'posttool', JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: dir, tool_name: 'Agent', tool_input: {}, tool_response: {} }));
/** @param {string} dir @param {string} text @param {string} [session] */
export const prompt = (dir, text, session = 's1') => H(dir, 'prompt', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: dir, prompt: text }));

/** `denied LABEL OUT [SUBSTRING]`: the hook denied (and, when given, for this reason). @param {string} label @param {string} out @param {string} [sub] */
export function denied(label, out, sub) {
  assert.ok(out.includes('"permissionDecision":"deny"'), `${label} (not denied): ${out.slice(0, 300)}`);
  if (sub !== undefined) assert.ok(out.includes(sub), `${label} (denied for another reason, wanted ${JSON.stringify(sub)}): ${out.slice(0, 400)}`);
}
/** `allowed LABEL OUT`. @param {string} label @param {string} out */
export function allowed(label, out) { assert.ok(!out.includes('"permissionDecision":"deny"'), `${label} (denied): ${out.slice(0, 400)}`); }

/** The recipe of the suites' `fixture`: an orchestrated run at IMPLEMENTING with the git hooks and (hook: true) the runtime hook installed. @param {{ klass?: string, auto?: string, extra?: string, hook?: boolean }} [o] */
export function fixtureRecipe(o = {}) {
  const hook = o.hook === false ? '' : `; cp -R "$tl_agents/../../adapters/claude/hooks/." .agents/hooks/; cp "$tl_agents/scripts/proofline-core.mjs" .agents/scripts/; cp -R "$tl_agents/scripts/core" .agents/scripts/core; printf '.agents/scripts/proofline-core.mjs\\n.agents/scripts/core/\\n' >> .git/info/exclude`;
  return `scaffold orchestrated no ${o.klass ?? 'COMPLEX'} "${o.auto ?? ''}"; node "$tl_agents/../../tests/legacy-githooks/install.mjs" .agents/githooks; mkdir -p .agents/hooks src${hook}; `
    + "printf '.agents/githooks/\\n.agents/hooks/\\n' >> .git/info/exclude; git config core.hooksPath .agents/githooks; git config commit.gpgsign false" + (o.extra ? `; ${o.extra}` : '');
}
/** A fresh fixture project (a copy of the cached template). @param {Parameters<typeof fixtureRecipe>[0]} [o] */
export const fixture = (o) => project(fixtureRecipe(o));
export { cpSync, mkdirSync, appendFileSync };
