// @ts-check
// Known answer of the refusal classifier (A257) on a fixed synthetic transcript: every cause once or twice in an old and in the new wording, a duplicated entry (the log holds a
// request copy of a call), a result that is no refusal, a malformed line, and the array form of a result. No clock, no network, nothing outside the process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, count } from './refusal-causes.mjs';

const H = 'PreToolUse:Bash hook error: [hook]: proofline: ';
/** @type {[string, string][]} */
const REFUSALS = [
  ['unresolved-write', `${H}the command writes '$O/x', which cannot be resolved; while run T-1 is active the lead and read-only roles write only their run artifacts`],
  ['tmpdir-scratch', `${H}mktemp would create its file or folder under $TMPDIR. Scratch files go under .agents/runs/T-1/scratch/ ($TMPDIR is only for git worktrees)`],
  ['tmpdir-scratch', `${H}scratch files and worktrees go under $TMPDIR (/x never /tmp directly`],
  ['dispatch-nonce', `${H}PROOFLINE_DISPATCH and the dispatch nonce are dispatch.sh's alone (A171)`],
  ['node-control-plane', `${H}a model command never starts Node on the control plane (the core under .agents/scripts)`],
  ['node-control-plane', `${H}a model command runs node only on a script path written out literally`],
  ['agent-command-by-role', `${H}role verifier runs only the read-only agent.sh status pipeline fingerprint next verify-* (not plan-section); state changes belong to the lead`],
  ['agent-command-by-role', `${H}the implementer runs only agent.sh worker-evidence status pipeline fingerprint verify-* (not diff-digest)`],
  ['command-word-not-literal', `${H}the command word $A is not literal is not allowed while run T-1 is active; write agent.sh, AGENT_ROLE and shell commands literally`],
  ['write-outside-role-paths', `${H}the command writes 'a.md': .agents/x is outside the paths role qa owns`],
  ['git-live-tree', `${H}git stash (every subcommand, list and show included) must not run in the project working tree`],
  ['database-file', `${H}the command names the database file 'x.db'. No agent reads it`],
  ['other', `${H}something no rule of the classifier knows`],
];

/** @param {string} id @param {string} text @param {boolean} asArray */
const result = (id, text, asArray) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: asArray ? [{ type: 'text', text }] : text }] } });
/** @param {string} id */
const use = (id) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'x' } }] } });

const lines = [];
REFUSALS.forEach(([, text], i) => { lines.push(use(`t${i}`), result(`t${i}`, text, i % 2 === 1)); });
lines.push(use('ok'), result('ok', 'fine, exit 0', false));
lines.push(use('t0'), result('t0', REFUSALS[0][1], false)); // the request copy of the first call: counted once
lines.push('{not json');
const log = lines.join('\n');

test('the classifier puts each refusal text in its cause, in the old and the new wording', () => {
  for (const [cause, text] of REFUSALS) assert.equal(classify(text), cause, text);
  assert.equal(classify('exit 0'), null);
  assert.equal(classify('the command writes x, which cannot be resolved'), null, 'not a hook refusal without the PreToolUse prefix');
});

test('the counts on the fixed log: calls once by id, refusals once by call, per cause and per family of the issue', () => {
  const r = count([log]);
  assert.equal(r.calls, REFUSALS.length + 1);
  assert.equal(r.refused, REFUSALS.length);
  assert.deepEqual(r.causes, { 'unresolved-write': 1, 'tmpdir-scratch': 2, 'dispatch-nonce': 1, 'node-control-plane': 2, 'agent-command-by-role': 2, 'command-word-not-literal': 1, 'write-outside-role-paths': 1, 'git-live-tree': 1, 'database-file': 1, other: 1 });
  assert.deepEqual(r.families, { 'shell-write': 2, 'tmpdir-scratch': 2, 'dispatch-nonce': 1, 'node-control-plane': 2, 'agent-command': 3, git: 1, database: 1, other: 1 });
});
