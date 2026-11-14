// Builds installed throwaway projects stopped mid-run in known states, for the proofline-lead fixture.
// 
//   node setup.mjs <target-dir> [state]
// 
// Without a state every state is built into <target-dir>/<state>/; with one, that state is built into
// <target-dir> itself. States (run LK-7 in every project):
//   review-rules-fail     COMPLEX, tier full, every gate passes except REVIEW_RULES (fix round 1 not opened)
//   needs-input           STANDARD, the explorer returned NEEDS_INPUT; a question is pending
//   destructive-approval  CRITICAL plan with `destructive: yes`; plan approved and frozen, destructive approval missing
//   security-pass-low     COMPLEX, tier full, every gate passes, SECURITY passed with CONFIDENCE: low
//   fix-rounds-exhausted  COMPLEX, tier full, both fix rounds used, REVIEW_RULES fails again
// Everything goes through the real control plane (agent.sh, the Node core); verdicts enter
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Fx, cli, repoRoot } from '../../tests/lib/fixture.mjs';

const STATES = ['review-rules-fail', 'needs-input', 'destructive-approval', 'security-pass-low', 'fix-rounds-exhausted'];
const ID = 'LK-7';
const D = `.agents/runs/${ID}`;
const CP = path.join(repoRoot, 'control-plane');

/** The states are independent projects: build them in parallel (A76), output kept per state, any failure fails. @param {string} target @returns {Promise<number>} the exit status */
async function buildAll(target) {
  const f = new Fx(target);
  const results = await Promise.all(STATES.map((s) => new Promise((resolve) => {
    const c = spawn(process.execPath, [import.meta.filename, path.join(target, s), s], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout.on('data', (d) => { text += d; }); c.stderr.on('data', (d) => { text += d; });
    c.on('error', (e) => { text += `${e.message}\n`; resolve({ s, text, rc: 1 }); });
    c.on('close', (rc) => resolve({ s, text, rc: rc ?? 1 }));
  })));
  void f;
  let rc = 0;
  for (const r of /** @type {{ s: string, text: string, rc: number }[]} */ (results)) {
    process.stdout.write(r.text);
    if (r.rc !== 0) { console.error(`error: state ${r.s} failed`); rc = 1; }
  }
  return rc;
}

/** @param {string} target @param {string} state */
export function build(target, state) {
  if (!STATES.includes(state)) { console.error(`unknown state: ${state} (one of: ${STATES.join(' ')})`); process.exit(2); }
  const f = new Fx(target, { GIT_AUTHOR_NAME: 'fixture', GIT_COMMITTER_NAME: 'fixture', LC_ALL: 'C' });
  const sha = (/** @type {string} */ rel) => createHash('sha256').update(readFileSync(f.p(rel))).digest('hex');
  /** agent.sh through the real control plane; returns its stdout without trailing newlines (a `$(...)`). @param {string[]} args @param {string} [role] @param {string} [input] */
  const A = (args, role, input) => {
    const env = { ...process.env, ...f.env };
    delete env.AGENT_ROLE; if (role) env.AGENT_ROLE = role;
    const r = spawnSync('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: target, env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] });
    if (r.status !== 0) { process.stderr.write(r.stdout ?? ''); throw new Error(`agent.sh ${args.join(' ')} failed (${r.status})`); }
    return (r.stdout ?? '').replace(/\n+$/, '');
  };
  const q = A;   // `q A ...`: the output is discarded by the caller

  // --- installed project (the layout `proofline init` writes) ---------------------------------
  f.mkdir('.agents/scripts', '.agents/local', '.agents/tasks', '.agents/task-integrations', 'src', 'test');
  for (const n of ['config.yaml', 'roles.conf', ...readdirSync(path.join(CP, 'agents')).filter((x) => x.endsWith('.md')).sort()]) f.cp(path.join(CP, 'agents', n), `.agents/${n}`);
  for (const n of ['modes', 'templates', 'roles', 'githooks']) f.cp(path.join(CP, 'agents', n), `.agents/${n}`);
  for (const n of ['agent.sh', 'dispatch.sh', 'proofline-core.mjs']) f.cp(path.join(CP, 'agents/scripts', n), `.agents/scripts/${n}`);
  f.cp(path.join(CP, 'agents/scripts/core'), '.agents/scripts/core');   // the Node core runs the moved commands, the secret scan included
  for (const n of readdirSync(f.p('.agents/scripts'))) if (n.endsWith('.sh')) chmodSync(f.p(`.agents/scripts/${n}`), statMode(f.p(`.agents/scripts/${n}`)) | 0o111);
  for (const n of readdirSync(f.p('.agents/githooks'))) chmodSync(f.p(`.agents/githooks/${n}`), statMode(f.p(`.agents/githooks/${n}`)) | 0o111);
  f.cp(path.join(CP, 'AGENTS.md'), 'AGENTS.md'); f.cp(path.join(CP, 'CLAUDE.md'), 'CLAUDE.md');
  f.w('.gitignore', '.agents/runs/\n.agents/local/\n');
f.w(`package.json`, `{ "name": "lookup-fixture", "private": true, "type": "module", "scripts": { "test": "node --test" } }
`);
f.w(`src/store.js`, `export const store = new Map();
`);
f.w(`src/lookup.js`, `import { store } from "./store.js";

export function lookup(key) {
  return store.get(key);
}
`);
f.w(`test/lookup.test.js`, `import { test } from "node:test";
import assert from "node:assert/strict";
import { lookup } from "../src/lookup.js";
import { store } from "../src/store.js";

test("lookup returns the stored value", () => {
  store.set("a", 1);
  assert.equal(lookup("a"), 1);
});
`);
  const TASKFILE = `.agents/tasks/${ID}-empty-key-default.md`;
  f.w(TASKFILE, `# ${ID} empty key default

**Status:** in-progress

lookup("") must return the documented default instead of undefined.
`);
  f.init();
  f.commit('lookup: initial', '2026-01-01T10:00:00Z');
  f.git(['config', 'core.hooksPath', '.agents/githooks']);

  // --- run creation (as the lead does it: templates, ACTIVE_RUN, classify, branch, baseline) ----
  const [CLASS, AUTONOMY] = state === 'needs-input' ? ['STANDARD', 'autonomous'] : state === 'destructive-approval' ? ['CRITICAL', 'PENDING'] : ['COMPLEX', 'autonomous'];
  f.mkdir(D);
  // sed -e "s#<TASK-ID>#$ID#" -e "s#<REPOSITORY-RELATIVE-TASK-FILE.md>#$TASKFILE#" -e "s#^  autonomy: PENDING#  autonomy: $AUTONOMY#": the first match of each line
  f.w(`${D}/RUN.yaml`, f.read('.agents/templates/RUN.yaml').split('\n').map((l) => l
    .replace('<TASK-ID>', () => ID).replace('<REPOSITORY-RELATIVE-TASK-FILE.md>', () => TASKFILE).replace(/^ {2}autonomy: PENDING/, () => `  autonomy: ${AUTONOMY}`)).join('\n'));
  f.w('.agents/local/ACTIVE_RUN', `${ID}\n`);
  f.w(`${D}/TASK.md`, `# Task: ${ID} — empty key default

## Goal

lookup("") returns the documented default value.

## Context

Callers crash on undefined for an empty key.

## Acceptance criteria

- AC-1: lookup("") returns null
- AC-2: lookup of a stored key still returns its value

## Out of scope

- other keys

## Constraints

- none

## Risks

- callers that rely on undefined

## Suggested class

${CLASS} — see the run classification

## Verification commands

- \`npm test\`
`);
  q(['classify', ID, CLASS]);
  q(['branch', ID]);
  q(['baseline', ID]);

  // --- helpers --------------------------------------------------------------------------------
  /** A user-prompt capture as the UserPromptSubmit hook writes it. @param {string} text */
  const capture = (text) => {
    f.mkdir('.agents/local/prompts');
    f.w('.agents/local/cap.txt', text);
    f.w('.agents/local/prompts/fx.json', `{"session":"fx","time":${Math.floor(Date.now() / 1000) + 5},"sha256":"${sha('.agents/local/cap.txt')}","text":"${text}"}\n`);
    f.rm('.agents/local/cap.txt');
  };
  const grant = (/** @type {string} */ what, /** @type {string} */ text) => { q(['request-approval', ID, what]); capture(text); q(['approve', ID, what]); };
  const gateOwner = (/** @type {string} */ g) => (g.startsWith('REVIEW_') ? 'reviewer' : ({ SECURITY: 'security_reviewer', QA: 'qa', VERIFY: 'verifier' })[g] ?? '');
  const gateFocus = (/** @type {string} */ g) => ({ REVIEW_SMALL: 'rules+tests', REVIEW_PLAN: 'plan', REVIEW_RULES: 'rules', REVIEW_TESTS: 'tests', REVIEW_DATA: 'data' })[g] ?? '';
  const gateArt = (/** @type {string} */ g) => ({
    REVIEW_TESTS: 'reviews/test-trust/tests/REPORT.md', REVIEW_PLAN: 'reviews/proof-review/plan/REPORT.md', REVIEW_RULES: 'reviews/proof-review/rules/REPORT.md',
    REVIEW_SMALL: 'reviews/proof-review/small/REPORT.md', REVIEW_DATA: 'reviews/data-design/REVIEW.md', SECURITY: 'security/REPORT.md', QA: 'QA_REPORT.md', VERIFY: 'VERIFY.md',
  })[g] ?? '';
  /** A D12 result: rows are "id|severity|path:line|finding|evidence". @param {string} role @param {string} focus @param {string} res @param {string} conf @param {string} art @param {...string} rows */
  const result = (role, focus, res, conf, art, ...rows) => `ROLE: ${role}\nTASK: ${ID}\n${focus ? `FOCUS: ${focus}\n` : ''}RESULT: ${res}\nCONFIDENCE: ${conf}\nFINGERPRINT: ${A(['fingerprint', ID])}\nARTIFACT: ${art} ${sha(`${D}/${art}`)}\n\n`
    + `| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n${rows.map((r) => `| ${r.replaceAll('|', ' | ')} |\n`).join('')}`;
  /** @param {string} g gate @param {string} r result @param {string} [c] confidence @param {...string} rows */
  const gate = (g, r, c = 'high', ...rows) => {
    const a = gateArt(g);
    f.w(`${D}/${a}`, `# ${g} report\n\nVerdict: ${r}\n`);
    f.w('.agents/local/result.md', result(gateOwner(g), gateFocus(g), r, c, a, ...rows));
    A(['record', ID, '--file', '.agents/local/result.md'], gateOwner(g));
    f.rm('.agents/local/result.md');
  };
  /** secret-scan plus a high-confidence PASS for every other required gate @param {...string} except */
  const passExcept = (...except) => {
    for (const g of (A(['pipeline', ID]).split('\n').map((l) => /^gates=(.*)$/.exec(l)?.[1]).find((x) => x !== undefined) ?? '').split(/\s+/).filter(Boolean)) {
      if (except.includes(g)) continue;
      if (g === 'SECRETS') q(['secret-scan', ID]); else gate(g, 'PASS');
    }
  };
  const rulesFail = () => gate('REVIEW_RULES', 'FAIL', 'high', "REVIEW_RULES-1|blocking|src/lookup.js:4|empty key returns undefined, AC-1 requires null|traced: lookup('') -> store.get('') -> undefined; scan: grep -n store.get src/lookup.js; instances: single");
  /** One implementer window, as dispatch.sh brackets it. @param {string} phase @param {string} res @param {string} file @param {string} text */
  // the fixture's lookup code is a stand-in (its own `npm test` does not pass), so its GREEN record names a command that is neither configured nor in the plan: the IMPLEMENTED double run (A275) only notes it and runs nothing
  const worker = (phase, res, file, text) => {
    const before = A(['window-open', ID]);
    f.append(file, `${text}\n`);
    const ef = phase === 'RED' ? 'expected_failure: lookup("") returns undefined, the new test expects null' : '';
    A(['worker-evidence', ID, phase, res], 'implementer', `command: ${phase === 'GREEN' ? 'node --version' : 'npm test'}\ntarget: src/lookup.js,src/store.js,test/lookup.test.js\n${ef}\n`);
    q(['window-close', ID, before, '0']);
  };
  /** reopen, one FIX window, back to IMPLEMENTED */
  const fixRound = (/** @type {string} */ file, /** @type {string} */ text) => { q(['handoff', ID, 'IMPLEMENTING']); worker('FIX', 'pass', file, text); q(['handoff', ID, 'IMPLEMENTED']); };

  // --- needs-input: discovery stopped on an explorer question -----------------------------------
  if (state === 'needs-input') {
    f.mkdir(`${D}/reports/snapshots`);
    f.w(`${D}/reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md`, `# Explorer evidence: ${ID}\n\nState: waiting for the empty-key default.\n`);
    f.w('.agents/local/result.md', `${result('explorer', '', 'NEEDS_INPUT', 'medium', 'reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md')}\nQUESTIONS:\n1. Which value must lookup("") return?\n   options: null | empty string | throw\n   recommended: null\n   why: AC-1 and the QA scenarios depend on it\n`);
    A(['record', ID, '--file', '.agents/local/result.md'], 'explorer');
    f.rm('.agents/local/result.md');
    return;
  }

  // --- planning artifacts (EVIDENCE, PLAN, QA_PLAN) ----------------------------------------------
  f.w(`${D}/EVIDENCE.md`, `# Evidence: ${ID}\n\n- E-1 \`src/lookup.js:lookup\` reads the store directly\n\n## Assumptions\n\nnone\n`);
  const qaPlan = '# QA plan\n\n- QA-1 (AC-1): lookup("") returns null\n- QA-2 (AC-2): a stored key keeps its value\n';
  const destructive = state === 'destructive-approval';
  const plan = [
    '---', 'scope:', '  - path: src/lookup.js', '    criteria: [AC-1, AC-2]', '  - path: src/store.js', '    criteria: [AC-1]', '  - path: test/lookup.test.js', '    criteria: [AC-1, AC-2]',
    ...(destructive ? ['  - path: db/migrations/002_drop_legacy_keys.sql', '    new: true', '    criteria: [AC-1]'] : []),
    '---', `# Plan: ${ID}`, '', '## Architecture', '', '- one storage map; lookup maps a missing empty key to null', '',
    ...(destructive ? ['## Data', '', 'destructive: yes', '', '| step | phase | operation | object | destructive | reversible | rollback | lock |', '|---|---|---|---|---|---|---|---|',
      '| S1 | expand | switch_reads | legacy_keys | no | yes | redeploy the previous release | none |', '| S2 | deferred | drop_table | legacy_keys | yes | no | restore from the pre-drop backup | table drop |', ''] : []),
    '## Behavior', '', '- AC-1: `src/lookup.js:lookup` returns null for ""', '', '## Tests', '', '- AC-1: `test/lookup.test.js` "empty key"', '',
    '## Verification commands', '', '- `npm test`', '', '## Dependencies', '', 'none', '', '## Contracts', '', 'none', '', '## Assumptions', '', 'none',
  ].map((l) => `${l}\n`).join('');
  f.w(`${D}/PLAN.md`, plan);
  // The QA plan is derived from the final PLAN.md and cites its hash (A42).
  const qaLines = qaPlan.split('\n');   // `sed -n 1p`, the hash line, then `sed 1d`
  f.w(`${D}/QA_PLAN.md`, `${qaLines[0]}\n\nPlan sha256: ${sha(`${D}/PLAN.md`)}\n${qaLines.slice(1).join('\n')}`);

  if (destructive) {
    grant('plan', 'approve the plan');
    q(['freeze', ID]);
    return;
  }

  q(['freeze', ID]);
  q(['handoff', ID, 'IMPLEMENTING']);
  worker('RED', 'fail', 'test/lookup.test.js', 'test("empty key", () => assert.equal(lookup(""), null));');
  worker('GREEN', 'pass', 'src/lookup.js', 'export const EMPTY_DEFAULT = null;');
  worker('REFACTOR', 'pass', 'src/store.js', '// empty key handled in lookup');
  // A defect task needs the implementer's debug-proof result before IMPLEMENTED (A35, A47).
  f.mkdir(`${D}/reports/snapshots`);
  f.w(`${D}/reports/001-debug.md`, `# Debug: ${ID}\n\nReproduction: lookup("") returned undefined. Root cause: the store map had no default. Regression test: test/lookup.test.js "empty key".\n`);
  q(['handoff', ID, 'IMPLEMENTED']);

  switch (state) {
    case 'review-rules-fail': passExcept('REVIEW_RULES'); rulesFail(); break;
    case 'security-pass-low': passExcept('SECURITY'); gate('SECURITY', 'PASS', 'low'); break;
    case 'fix-rounds-exhausted':
      passExcept('REVIEW_RULES'); rulesFail();
      fixRound('src/lookup.js', '// round 1: map "" to null');
      passExcept('VERIFY');
      gate('VERIFY', 'FAIL', 'high', 'VERIFY-1|blocking|src/lookup.js:4|AC-1 has no passing test|reproduced: npm test, empty key test fails');
      fixRound('src/lookup.js', '// round 2: return null before the store read');
      passExcept('REVIEW_RULES'); rulesFail();
      break;
    default:
  }
}

const statMode = (/** @type {string} */ p) => /** @type {number} */ (statSync(p).mode);

// Without a state every state is built into <target-dir>/<state>/; with one, that state is built into <target-dir> itself.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) { console.error('usage: node setup.mjs <target-dir> [state]'); process.exit(2); }
  if (args.length === 1) { process.exitCode = await buildAll(args[0]); }
  else {
    if (!STATES.includes(args[1])) { console.error(`unknown state: ${args[1]} (one of: ${STATES.join(' ')})`); process.exit(2); }
    await cli(import.meta.url, (t, s) => build(t, s), { usage: 'node setup.mjs <target-dir> [state]', argc: 2 });
  }
}
