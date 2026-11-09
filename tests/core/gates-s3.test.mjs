// @ts-check
// Slice S3 of the gates-test.sh port (176-D1): sc_decide, sc_design_surfaces, sc_config_scope_misc, sc_secret_scan, sc_provenance, sc_waiver_rebind, sc_report_finding_ids,
// sc_report_facts, sc_open_runs, sc_knowledge_*, sc_next_order, sc_qa_plan_bound, sc_artifact_snapshots as native Node tests against the real control plane. Every assertion, attack
// input and expected message of the shell scenario is kept. (sc_waiver_persists, sc_waiver_key_edges and sc_waiver_group are tests/core/legacy-waivers.test.mjs.)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { qaBind as qaBindHarness, A, AS, accepted, approveAsUser, cleanEnv, commitAll, expectFail, expectState, gateStatus, gfail, gpass, must, newRepo, project, refused, resultFor, sha256, tmp, toCodeDone, tsha, worker, writeReport } from '../lib/harness.mjs';
import { passAll as passAllHarness, appendFileSync, implementedProject, installSkill, installWikiLint, nGates, gateFocus, recEnv, repo, reportPath, required } from './gates-s3-lib.mjs';

const read = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(path.join(d, f), 'utf8');
const put = (/** @type {string} */ d, /** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); };
const count = (/** @type {string} */ d, /** @type {string} */ f) => readdirSync(path.join(d, f)).length;
const ledger = (/** @type {string} */ d) => read(d, '.agents/runs/LC/LEDGER.log');
const lineCount = (/** @type {string} */ d, /** @type {string} */ f) => read(d, f).split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).length;
/** sed -e s/RE/REPL/ per line (first match of every line). @param {string} text @param {RegExp} re @param {string} repl */
const sed = (text, re, repl) => text.split('\n').map((l) => l.replace(re, () => repl)).join('\n');

test('sc_decide: signals, overrides, escalations-used, persisted and ledgered; metrics on/off', () => {
  const d = implementedProject();
  const args = path.join(tmp('args'), 'args'); writeFileSync(args, '');
  const env = { STUB_ARGS: args };
  /** @param {string[]} a @param {string} [role] @param {Record<string, string>} [e] */
  const D = (a, role, e = {}) => A(d, a, { env: { ...env, ...e }, ...(role ? { role } : {}) });
  const decisions = () => readdirSync(path.join(d, '.agents/runs/LC/decisions')).sort();
  const lastArgs = () => readFileSync(args, 'utf8').trimEnd().split('\n').at(-1) ?? '';
  accepted(D(['decide', 'LC', 'reviewer', '--agent-path', '--focus', 'rules+tests']), 'decide');
  assert.ok(existsSync(path.join(d, '.agents/runs/LC/decisions/001-reviewer-rules-tests.decision')));
  const seen = readFileSync(args, 'utf8');
  assert.ok(seen.includes('--role reviewer --class COMPLEX --tier small --escalations-used 0'), `decide args: ${seen}`);
  assert.ok(!/--runtime|--profile/.test(seen), 'decide passed runtime/profile without an override');
  assert.match(ledger(d), /event=decide .*model=sonnet/);
  // A200: the Agent path is Claude Code's; a role on another runtime is refused there and sent to dispatch.sh. --dry still reads the decision.
  refused(D(['decide', 'LC', 'implementer', '--agent-path', '--runtime', 'codex']), 'A200: --agent-path accepted a role configured for Codex', 'has no Agent path');
  assert.ok(lastArgs().includes('--runtime codex'), '--runtime override not passed');
  assert.ok(!existsSync(path.join(d, '.agents/runs/LC/decisions/002-implementer.decision')), 'A200: the refused Agent-path decision was persisted');
  assert.match(D(['decide', 'LC', 'implementer', '--dry', '--runtime', 'codex']).out, /^runtime=codex/m, 'decide --dry --runtime codex does not read the codex decision');
  expectFail(D(['decide', 'LC', 'reviewer', '--agent-path', '--model', 'bogus']), 'an invalid override was accepted');
  assert.ok(!existsSync(path.join(d, '.agents/runs/LC/decisions/002-reviewer.decision')), 'a refused decision was persisted');
  expectFail(D(['decide', 'LC', 'reviewer', '--agent-path', '--turbo', 'yes']), 'an unknown decide flag was accepted');
  expectFail(D(['decide', 'LC', 'reviewer'], 'reviewer'), 'a reviewer called decide');
  refused(D(['decide', 'LC', 'reviewer', '--agent-path', '--runtime', 'codex', '--runtime-reason', 'AUTOMATIC_FAILOVER']), 'the lead labelled its own choice an automatic failover', "dispatch.sh's alone");
  refused(D(['decide', 'LC', 'reviewer', '--dry', '--runtime', 'codex', '--runtime-reason', 'AUTOMATIC_FAILOVER']), 'the lead labelled a dry decision an automatic failover', "dispatch.sh's alone");
  // A171: decide is not called ahead of a dispatch; --dry reads without writing; the output starts with a one-line summary
  const nd = decisions().length; const nl = lineCount(d, '.agents/runs/LC/LEDGER.log');
  refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests']), 'a bare decide (ahead of a dispatch) was accepted', 'not called ahead of one');
  assert.equal(decisions().length, nd, 'a refused decide persisted a decision');
  const dry = accepted(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--dry']), 'decide --dry').out;
  assert.equal(decisions().length, nd, 'decide --dry wrote a decision file');
  assert.equal(lineCount(d, '.agents/runs/LC/LEDGER.log'), nl, 'decide --dry wrote the ledger');
  assert.match(dry.split('\n')[0], /^decision: role=reviewer runtime=claude model=[a-z0-9.-]+ effort=[a-z]+ reason=[A-Za-z_,]+ \(dry run: nothing recorded\)$/, 'decide --dry: first line is not the summary');
  assert.match(dry, /^model=/m, 'decide --dry lost the key=value lines');
  refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--agent-path']), 'a repeated --agent-path was accepted before any result', 'no result has been recorded since');
  // a result of another role or another focus does not release the step; one of this role and focus does
  put(d, '.agents/runs/LC/results/098-security_reviewer.result.md', 'FOCUS: rules+tests\n'); put(d, '.agents/runs/LC/results/097-reviewer.result.md', 'FOCUS: plan\n');
  refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--agent-path']), 'a result of another role or focus released the step', 'no result has been recorded since');
  rmSync(path.join(d, '.agents/runs/LC/results/098-security_reviewer.result.md')); rmSync(path.join(d, '.agents/runs/LC/results/097-reviewer.result.md'));
  put(d, '.agents/runs/LC/results/099-reviewer.result.md', 'FOCUS: rules+tests\n');   // a result recorded since the first decision
  const real = accepted(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--agent-path']), 'decide --agent-path').out;
  assert.match(real.split('\n')[0], /^decision: role=reviewer runtime=claude model=[a-z0-9.-]+ effort=[a-z]+ reason=[A-Za-z_,]+$/, 'decide: first line is not the summary');
  assert.equal(decisions().length, nd + 1, 'decide --agent-path did not record one decision');
  refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--agent-path']), 'a second decide --agent-path for the same step was accepted', 'no result has been recorded since');
  assert.equal(decisions().length, nd + 1, 'a refused second --agent-path persisted a decision');
  rmSync(path.join(d, '.agents/runs/LC/decisions', decisions().at(-1) ?? '')); rmSync(path.join(d, '.agents/runs/LC/results/099-reviewer.result.md'));
  refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests'], undefined, { PROOFLINE_DISPATCH: '1' }), 'a hand-set PROOFLINE_DISPATCH=1 was accepted', 'not called ahead of one');
  // --redecide: the lead may decide again for the same step (another runtime or model), the earlier decision stays, a ledger note says so
  const ndr = decisions().length;
  refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--agent-path']), 'the refusal does not show --redecide', '--redecide');
  assert.notEqual(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--redecide'], 'reviewer').status, 0, 'a reviewer used --redecide');
  accepted(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests', '--redecide']), '--redecide');
  assert.equal(decisions().length, ndr + 1, '--redecide did not add a decision beside the earlier one');
  assert.ok(ledger(d).includes('detail=decide --redecide reviewer'), '--redecide is not in the ledger');
  // the dispatch nonce: pid-bound and one use
  mkdirSync(path.join(d, '.agents/local/dispatch'), { recursive: true }); const nn = '0123456789abcdef0123456789abcdef'; const nf = path.join(d, `.agents/local/dispatch/nonce-${nn}`);
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    writeFileSync(nf, `${sleeper.pid}\n`);
    refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests'], undefined, { PROOFLINE_DISPATCH: nn }), 'a nonce of a live process that is not an ancestor was accepted', 'not called ahead of one');
  } finally { sleeper.kill(); }
  writeFileSync(nf, `${process.pid}\n`);
  accepted(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests'], undefined, { PROOFLINE_DISPATCH: nn }), 'a nonce naming an ancestor was refused');
  assert.ok(!existsSync(nf), 'the nonce survived its use');
  refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests'], undefined, { PROOFLINE_DISPATCH: nn }), 'a replayed nonce was accepted', 'not called ahead of one');
  writeFileSync(nf, '1\n');
  refused(D(['decide', 'LC', 'reviewer', '--focus', 'rules+tests'], undefined, { PROOFLINE_DISPATCH: nn }), 'a nonce naming pid 1 was accepted', 'not called ahead of one');
  for (const n of readdirSync(path.join(d, '.agents/local/dispatch'))) if (n.startsWith('nonce-')) rmSync(path.join(d, '.agents/local/dispatch', n));
  rmSync(path.join(d, '.agents/runs/LC/decisions', decisions().at(-1) ?? ''));
  // A171: friction-note ledgers that the user was asked to run a command; wait-line is one line
  accepted(A(d, ['friction-note', 'LC', 'user-command']), 'friction-note');
  assert.match(ledger(d), /event=friction-note .*detail=user-command/, 'friction-note not in the ledger');
  accepted(A(d, ['friction-note', 'LC', 'proofline_bug']), 'A196 friction-note proofline_bug');
  assert.match(ledger(d), /event=friction-note .*detail=proofline_bug/, 'A196 proofline_bug not in the ledger');
  expectFail(A(d, ['friction-note', 'LC', 'run approve for me']), 'friction-note took a free-text kind');
  expectFail(AS(d, 'reviewer', ['friction-note', 'LC', 'user-command']), 'a reviewer wrote a friction note');
  const wl = accepted(A(d, ['wait-line', 'LC', 'CI of the pull request']), 'wait-line').out.replace(/\n$/, '');
  assert.match(wl, /^waiting: CI of the pull request, [0-9]+m[0-9]{2}s so far$/, `wait-line is not one line of the documented shape: ${wl}`);
  accepted(A(d, ['wait-line', 'LC', 'CI of the pull request', '--done']), 'wait-line --done');
  expectFail(A(d, ['wait-line', 'LC']), 'wait-line without a wait');
  const rowN = (/** @type {number} */ n) => `REVIEW_SMALL-${n}|blocking|impl.txt:${n}|wrong default|traced; scan: grep -n lookup impl.txt; instances: single`;
  must(d, ['record', 'LC', '--file', resultFor(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced; scan: grep -n lookup impl.txt; instances: single'])], { role: 'reviewer' });
  appendFileSync(path.join(d, '.agents/runs/LC/decisions/001-reviewer-rules-tests.decision'), 'escalated=yes\n');
  D(['decide', 'LC', 'reviewer', '--agent-path', '--focus', 'rules+tests']);
  assert.ok(lastArgs().includes('--signal recent_fail_same_focus --escalations-used 1'), `signals/escalations: ${lastArgs()}`);
  // metrics: one line per recorded specialist step with runtime and model from the decision
  assert.ok(read(d, '.agents/local/metrics/history.tsv').includes('\tLC\treviewer\tclaude\tsonnet\t'), 'metrics line missing');
  // A80: versioned JSON records; the step record carries the gate and result, tokens/turns stay null
  const mj = '.agents/local/metrics/records.jsonl';
  assert.match(read(d, mj), /^\{"schema":"proofline.metrics\/1","kind":"step","time":"[0-9T:Z-]*","task":"LC","role":"reviewer","focus":"rules\+tests"/m, 'step record missing/malformed');
  assert.ok(read(d, mj).split('\n').filter((l) => l.includes('"kind":"step"')).some((l) => l.includes('"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null')), 'step record invented token/turn data');
  const lastRec = () => read(d, mj).trimEnd().split('\n').at(-1) ?? '';
  // a Claude subagent's step tokens come from its session log: one count per message id (the last line of it), cache reads excluded
  const tr = path.join(tmp('t9'), 'agent-t9.jsonl');
  writeFileSync(tr, [
    '{"message":{"id":"msg_A","role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":5000,"output_tokens":3}}}',
    '{"message":{"id":"msg_A","role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":5000,"output_tokens":40}}}',
    '{"message":{"id":"msg_B","role":"assistant","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":6000,"output_tokens":10}}}', ''].join('\n'));
  put(d, '.agents/local/submissions/t9.started', `${tr}\n`);
  recEnv(d, 'REVIEW_SMALL', 'FAIL', [rowN(2)], { PROOFLINE_STEP_AGENT: 't9' });
  assert.match(lastRec(), /"kind":"step".*"tokens_in":103,"tokens_out":50,"tokens_total":153,/, "step record without the subagent's session-log tokens");
  // A200: a step is timed from the start of ITS attempt (marker line 2), not from the decision; a resumed subagent is not inflated
  put(d, '.agents/local/submissions/t9.started', `${tr}\n${Math.floor(Date.now() / 1000) - 40}\n`);
  recEnv(d, 'REVIEW_SMALL', 'FAIL', [rowN(3)], { PROOFLINE_STEP_AGENT: 't9' });
  const dur = Number(/"duration_s":([0-9]*),/.exec(lastRec())?.[1] ?? 0);
  assert.ok(dur >= 40 && dur <= 100, `step duration is not the time since the marker's start stamp (A200): ${lastRec()}`);
  // the runtime of the record is the one dispatch.sh says really ran the step (after a failover it is not the decision's)
  recEnv(d, 'REVIEW_SMALL', 'FAIL', [rowN(4)], { PROOFLINE_DISPATCH_RUNTIME: 'codex', PROOFLINE_DISPATCH_START: String(Math.floor(Date.now() / 1000) - 7) });
  assert.match(lastRec(), /"kind":"step".*"runtime":"codex".*"duration_s":([7-9]|[12][0-9]),/, "step record does not carry the runtime that really ran the step and its attempt's time (A200)");
  assert.ok(read(d, '.agents/local/metrics/history.tsv').includes('\tLC\treviewer\tcodex\t'), 'history line does not carry the real runtime (A200)');
  // dispatch record: numbers kept, strings sanitized (no free text, so no secret), non-lead refused
  accepted(A(d, ['metrics-dispatch', 'LC', 'reviewer', 'rules', 'claude', 'sonnet"; sk-LIVE secret', '12', '100', '50', '150', '3', '1', 'submitted']), 'metrics-dispatch');
  assert.ok(lastRec().includes('"kind":"dispatch","time":"') && /"kind":"dispatch","time":"[0-9T:Z-]*","task":"LC","role":"reviewer","focus":"rules","gate":"REVIEW_RULES","runtime":"claude","model":"sonnetsk-LIVEsecret","duration_s":12,"tokens_in":100,"tokens_out":50,"tokens_total":150,"turns":3,"retries":1,"delegations":null,"fix_rounds":null,"result":"submitted"/.test(lastRec()), `dispatch record shape: ${lastRec()}`);
  accepted(A(d, ['metrics-dispatch', 'LC', 'reviewer', 'rules', 'claude', 'sonnet', '12', '', '', '', 'abc', '0', 'submitted']), 'metrics-dispatch absent');
  assert.ok(lastRec().includes('"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null,"retries":0'), `absent/non-numeric usage must be null: ${lastRec()}`);
  expectFail(AS(d, 'reviewer', ['metrics-dispatch', 'LC', 'reviewer', 'rules', 'claude', 'sonnet', '1', '-', '-', '-', '-', '0', 'submitted']), 'a reviewer wrote a metrics record');
  put(d, '.agents/config.yaml', sed(read(d, '.agents/config.yaml'), /^metrics: on/, 'metrics: off')); rmSync(path.join(d, '.agents/local/metrics'), { recursive: true, force: true });
  const snap = '.agents/runs/LC/reports/snapshots/aaaaaaaaaaaa-explorer-reports_090-explorer.md';
  put(d, snap, '# e\n');
  const fp = A(d, ['fingerprint', 'LC']).out.replace(/\n+$/, '');
  const ef = path.join(tmp('e'), 'e.md');
  writeFileSync(ef, `ROLE: explorer\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: ${fp}\nARTIFACT: reports/snapshots/aaaaaaaaaaaa-explorer-reports_090-explorer.md ${tsha(path.join(d, snap))}\n`);
  accepted(AS(d, 'explorer', ['record', 'LC', '--file', ef]), 'explorer record with metrics off');
  assert.ok(!existsSync(path.join(d, '.agents/local/metrics/history.tsv')), 'metrics: off still wrote metrics');
  accepted(A(d, ['metrics-dispatch', 'LC', 'reviewer', 'rules', 'claude', 'sonnet', '1', '1', '1', '2', '1', '0', 'submitted']), 'metrics-dispatch off');
  const mdir = path.join(d, '.agents/local/metrics');
  assert.ok(!existsSync(path.join(mdir, 'records.jsonl')) && (!existsSync(mdir) || readdirSync(mdir).length === 0), `metrics: off still wrote records`);
});

/** Rewrite the design line of the config (ds_cfg of the shell scenario). @param {string} d @param {string} orig @param {boolean} shared @param {string} extra */
function dsCfg(d, orig, shared, extra) {
  const out = [];
  for (const l of orig.split('\n')) {
    if (l.startsWith('  design: ')) {
      out.push('  design:'); if (shared) out.push('    shared: docs/design/BASE.md'); out.push('    surfaces:',
        '      site:', '        doc: docs/design/SITE.md', '        paths: apps/web/** apps/landing/', '        mode: persuade',
        '      app:', '        doc: docs/design/APP.md', '        paths: apps/dashboard/**', '        mode: operate');
      if (extra !== '') out.push(extra);
    } else out.push(l);
  }
  put(d, '.agents/config.yaml', out.join('\n'));
}
/** @param {string} text @param {string} key */
const dsVal = (text, key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '';

test('sc_design_surfaces: single document unchanged, surface selected, overlap errors, no match falls to the shared document, config-check of surfaces', () => {
  const d = newRepo();
  const orig = read(d, '.agents/config.yaml');
  let out = accepted(A(d, ['design-surface', 'apps/web/a.tsx']), 'design-surface single').out;
  assert.ok(dsVal(out, 'mode') === 'single' && dsVal(out, 'doc') === 'docs/design/DESIGN.md' && dsVal(out, 'doc_exists') === 'no', `single-document mode changed: ${out}`);
  accepted(A(d, ['in-knowledge-scope', 'docs/design/DESIGN.md']), 'in-knowledge-scope single');
  dsCfg(d, orig, true, '');
  accepted(A(d, ['config-check']), 'config-check');
  put(d, 'docs/design/BASE.md', '# base\n');
  out = accepted(A(d, ['design-surface', 'apps/web/pages/a.tsx']), 'design-surface site').out;
  assert.ok(dsVal(out, 'surface') === 'site' && dsVal(out, 'doc') === 'docs/design/SITE.md' && dsVal(out, 'visitor_mode') === 'persuade' && dsVal(out, 'shared') === 'docs/design/BASE.md' && dsVal(out, 'status') === 'new-direction', `site surface not selected as a new direction: ${out}`);
  put(d, 'docs/design/SITE.md', '# site\n');
  assert.equal(dsVal(accepted(A(d, ['design-surface', 'apps/landing/x.css']), 'landing').out, 'status'), 'ok', 'a directory-prefix glob did not match');
  out = accepted(A(d, ['design-surface', './apps/dashboard/deep/b.tsx']), 'dashboard').out;
  assert.ok(dsVal(out, 'surface') === 'app' && dsVal(out, 'doc') === 'docs/design/APP.md' && dsVal(out, 'visitor_mode') === 'operate', `app surface not selected: ${out}`);
  for (const f of ['docs/design/SITE.md', 'docs/design/APP.md', 'docs/design/BASE.md']) accepted(A(d, ['in-knowledge-scope', f]), `in-knowledge-scope ${f}`);
  expectFail(A(d, ['in-knowledge-scope', 'apps/web/a.tsx']), 'a path outside every design document is knowledge scope');
  // no match: the shared document only; a warning without one
  out = A(d, ['design-surface', 'lib/util.js']).text;
  assert.ok(dsVal(out, 'status') === 'no-surface' && dsVal(out, 'shared') === 'docs/design/BASE.md' && dsVal(out, 'doc') === '-', `no match did not fall to the shared document: ${out}`);
  assert.ok(!/^warning/m.test(out), `a warning with a shared document: ${out}`);
  dsCfg(d, orig, false, '');
  out = A(d, ['design-surface', 'lib/util.js']).text;
  assert.ok(out.includes('warning: no design surface matches lib/util.js'), `no warning without a shared document: ${out}`);
  // overlap is an error
  dsCfg(d, orig, true, '      wide:\n        doc: docs/design/WIDE.md\n        paths: apps/web/pages/*');
  refused(A(d, ['design-surface', 'apps/web/pages/a.tsx']), 'two matching surfaces were accepted', 'matches more than one surface (site wide)');
  assert.equal(dsVal(A(d, ['design-surface', 'apps/dashboard/b.tsx']).out, 'surface'), 'app', 'a file matching one surface failed beside an overlap elsewhere');
  // `**/` matches zero directories
  dsCfg(d, orig, true, '      deep:\n        doc: docs/design/DEEP.md\n        paths: lib/**/x.ts');
  assert.ok(dsVal(A(d, ['design-surface', 'lib/x.ts']).out, 'surface') === 'deep' && dsVal(A(d, ['design-surface', 'lib/a/b/x.ts']).out, 'surface') === 'deep', 'lib/**/x.ts does not match zero or more directories');
  assert.equal(dsVal(A(d, ['design-surface', 'lib/xx.ts']).out, 'status'), 'no-surface', 'lib/**/x.ts matched lib/xx.ts');
  // config-check
  dsCfg(d, orig, true, '      broken:\n        doc: docs/design/B.md');
  refused(A(d, ['config-check']), 'a surface without paths was accepted', 'design surface broken has no paths');
  dsCfg(d, orig, true, ''); accepted(A(d, ['config-check']), 'config-check good');
  const good = read(d, '.agents/config.yaml'); const badf = path.join(tmp('ds'), 'bad.yaml');
  /** @param {string} what @param {string} from @param {string} to @param {string} msg */
  const bad = (what, from, to, msg) => {
    assert.ok(good.includes(from), `the sed expression for "${what}" matches nothing`);
    writeFileSync(badf, sed(good, new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), to));
    refused(A(d, ['config-check', badf]), `config-check accepted: ${what}`, msg);
  };
  bad('an absolute surface doc', 'doc: docs/design/SITE.md', 'doc: /etc/site.md', 'must be project-relative');
  bad('a surface doc with ..', 'doc: docs/design/SITE.md', 'doc: ../site.md', 'must be project-relative');
  bad('an absolute path glob', 'paths: apps/web/** apps/landing/', 'paths: /apps/web/**', 'must be project-relative globs');
  bad('a path glob with ..', 'paths: apps/web/** apps/landing/', 'paths: apps/../web', 'must be project-relative globs');
  bad('a backslash in paths', 'paths: apps/web/** apps/landing/', 'paths: apps\\web', 'may not contain');
  bad('two **/ in one glob', 'paths: apps/web/** apps/landing/', 'paths: a/**/b/**/c', 'allows one **/ per glob');
  bad('a pipe in paths', 'paths: apps/web/** apps/landing/', 'paths: apps/(a|b)', 'may not contain');
  bad('an absolute shared document', 'shared: docs/design/BASE.md', 'shared: /etc/base.md', 'design_docs.design.shared must be project-relative');
  bad('a bad surface name', '      site:', '      si te:', 'invalid surface name');
  bad('a bad visitor mode', 'mode: persuade', 'mode: Persuade', 'visitor mode');
  const o2 = []; let skip = false;
  for (const l of orig.split('\n')) {
    if (l.startsWith('  design:')) { o2.push(l, '    shared: docs/design/BASE.md'); skip = true; continue; }
    if (skip && l.startsWith('    ')) continue;
    skip = false; o2.push(l);
  }
  writeFileSync(badf, o2.join('\n'));
  refused(A(d, ['config-check', badf]), 'a shared document without surfaces was accepted', 'design_docs.design.shared needs design_docs.design.surfaces');
});

test('sc_config_scope_misc: config-check, config-get, scope new: true, ledger-note', () => {
  const d0 = newRepo();
  accepted(A(d0, ['config-check']), 'config-check');
  assert.equal(accepted(A(d0, ['config-get', 'review.max_fix_rounds']), 'config-get').out.trim(), '2');
  assert.equal(A(d0, ['config-get', 'git.branch_prefix']).out.trim(), 'proofline/');
  expectFail(A(d0, ['config-get', 'no.such.key']), 'config-get of a missing key');
  const cfg = read(d0, '.agents/config.yaml'); const badf = path.join(tmp('cm'), 'bad.yaml');
  const edits = [[/^profile: balanced/, 'profile: .*'], [/^failover: auto/, 'failover: a.*'], [/^ {2}claude_permission_mode: .*/, '  claude_permission_mode: yolo'], [/^profile: balanced/, 'profile: turbo'], [/^failover: auto/, 'failover: sometimes'],
    [/^ {2}max_fix_rounds: 2/, '  max_fix_rounds: two'], [/^metrics: on/, 'metrics: maybe'], [/^ {2}COMPLEX: supervised/, '  COMPLEX: lazy'], [/^ {4}opus: 3/, '    opus: 4'], [/^ {2}regression_pct: 10/, '  regression_pct: ten'],
    [/^ {2}profile: auto/, '  profile: loud'], [/^ {2}strictness: relaxed/, '  strictness: harsh']];
  for (const [re, to] of edits) {
    const bad = sed(cfg, /** @type {RegExp} */ (re), /** @type {string} */ (to));
    assert.notEqual(bad, cfg, `the edit ${re} matches nothing in the config`);
    writeFileSync(badf, bad);
    refused(A(d0, ['config-check', badf]), `config-check accepted: ${re}`, 'config invalid');
  }
  writeFileSync(badf, `${cfg}${cfg.endsWith('\n') ? '' : '\n'}surprise: 1\n`);
  refused(A(d0, ['config-check', badf]), 'config-check accepted an unknown top-level key', 'unknown top-level key: surprise');
  // scope `new: true` (unfrozen STANDARD: standalone, manual, not frozen)
  const d = project({ topology: 'standalone', cls: 'STANDARD', autonomy: 'manual' });
  const plan = (/** @type {string[]} */ scope) => put(d, '.agents/runs/LC/PLAN.md', `${['---', 'scope:', ...scope, '---', '# Plan', '', '## Assumptions', 'none', '', '## Behavior', 'unchanged'].join('\n')}\n`);
  plan(['  - path: impl.txt', '    criteria: [AC-1]', '  - path: impl.txt.new', '    criteria: [AC-1]']);
  refused(A(d, ['freeze', 'LC'], { bind: true }), 'a missing path without new: true', 'does not exist');
  plan(['  - path: impl.txt', '    criteria: [AC-1]', '    new: true']);
  refused(A(d, ['freeze', 'LC'], { bind: true }), 'an existing path marked new: true', 'already exists');
  plan(['  - path: impl.txt', '    criteria: [AC-1]', '  - path: src/new.txt', '    criteria: [AC-1]', '    new: true']);
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'handoff IMPLEMENTING'); accepted(A(d, ['verify-scope', 'LC']), 'verify-scope');
  accepted(A(d, ['ledger-note', 'LC', 'failover from=claude to=codex reason=limit']), 'ledger-note');
  assert.match(ledger(d), /event=note .*failover from=claude/);
  expectFail(AS(d, 'reviewer', ['ledger-note', 'LC', 'x']), 'a reviewer wrote a ledger note');
  accepted(A(d, ['verify-seal', 'LC']), 'verify-seal');
});

test('sc_secret_scan: error records nothing, lead only', () => {
  const d = implementedProject();
  const n = nGates(d);
  refused(A(d, ['secret-scan', 'LC'], { env: { STUB_SCAN_ERROR: '1' } }), 'a scanner error was recorded', 'secret scan error');
  assert.equal(nGates(d), n, 'a scanner error left a gate record');
  expectFail(AS(d, 'reviewer', ['secret-scan', 'LC']), 'a reviewer ran secret-scan');
  accepted(A(d, ['secret-scan', 'LC']), 'secret-scan');
  assert.equal(gateStatus(d, 'SECRETS'), 'pass');
});

test('sc_provenance: hand-written gate records, waivers (SECURITY included) and approvals are ignored; validate names them', () => {
  const d = implementedProject({ cls: 'CRITICAL' });
  for (const g of required(d)) {
    if (g === 'SECRETS') accepted(A(d, ['secret-scan', 'LC']), 'secret-scan');
    else if (g === 'SECURITY' || g === 'REVIEW_RULES') gfail(d, g, 'impl.txt');
    else gpass(d, g);
  }
  const gd = '.agents/runs/LC/gates'; const wd = '.agents/runs/LC/waivers'; mkdirSync(path.join(d, wd), { recursive: true });
  const ls = (/** @type {string} */ suffix) => readdirSync(path.join(d, gd)).filter((n) => n.endsWith(suffix)).sort().at(-1) ?? '';
  const sr = ls('SECURITY.yaml'); const rr = ls('REVIEW_RULES.yaml');
  put(d, `${wd}/001-SECURITY-1.yaml`, `finding: "SECURITY-1"\ngate_record: "${sr}"\ngate_record_sha256: "${tsha(path.join(d, gd, sr))}"\n`);
  put(d, `${wd}/002-REVIEW_RULES-1.yaml`, `finding: "REVIEW_RULES-1"\ngate_record: "${rr}"\ngate_record_sha256: "${tsha(path.join(d, gd, rr))}"\n`);
  assert.equal(gateStatus(d, 'SECURITY'), 'fail', `a hand-written SECURITY waiver counted: ${gateStatus(d, 'SECURITY')}`);
  assert.equal(gateStatus(d, 'REVIEW_RULES'), 'fail', `a hand-written waiver counted: ${gateStatus(d, 'REVIEW_RULES')}`);
  const v = ls('VERIFY.yaml');
  let t = read(d, `${gd}/${v}`); t = sed(sed(sed(t, /^gate: .*/, 'gate: "SECURITY"'), /^role: .*/, 'role: "security_reviewer"'), /^seq: .*/, 'seq: 90');
  put(d, `${gd}/090-SECURITY.yaml`, t); cpSync(path.join(d, gd, `${v.slice(0, -5)}.manifest`), path.join(d, gd, '090-SECURITY.manifest'));
  assert.equal(gateStatus(d, 'SECURITY'), 'fail', `a hand-written PASS record counted: ${gateStatus(d, 'SECURITY')}`);
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE over hand-written records', 'is fail for the current content');
  refused(A(d, ['validate', 'LC']), 'validate missed the hand-written records', 'gates/090-SECURITY.yaml');
  const fp = A(d, ['fingerprint', 'LC']).out.replace(/\n+$/, '');
  put(d, '.agents/runs/LC/approvals/050-commit.yaml', `kind: "commit"\nbound: "${fp}"\nconsumed: "false"\n`);
  expectFail(A(d, ['approval-consume', 'LC', 'commit', fp]), 'a hand-written commit approval was consumed');
});

test('sc_waiver_rebind: waiver approvals bind the failing gate record and finding; a later round never reuses them', () => {
  const d = implementedProject({ cls: 'STANDARD' });
  const run = (/** @type {string} */ g, /** @type {string} */ r, /** @type {string[]} */ rows) => must(d, ['record', 'LC', '--file', resultFor(d, g, r, rows)], { role: 'verifier' });
  run('VERIFY', 'FAIL', ['VERIFY-1|blocking|impl.txt:1|first problem: cache never invalidated|traced']);
  approveAsUser(d, 'waive:VERIFY-1', 'approve VERIFY-1');
  const ap = readdirSync(path.join(d, '.agents/runs/LC/approvals')).filter((n) => /-waive-VERIFY-1\.yaml$/.test(n));
  assert.ok(ap.length > 0 && ap.some((n) => /^bound: "[0-9]*-VERIFY\.yaml@[0-9a-f]*#VERIFY-1"/m.test(read(d, `.agents/runs/LC/approvals/${n}`))), 'the waiver approval is not bound to the gate record');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', 'impl: fix attempt'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  run('VERIFY', 'FAIL', ['VERIFY-1|blocking|impl.txt:2|different problem: data loss on concurrent write|traced']);
  refused(A(d, ['waive', 'LC', 'VERIFY-1', '--reason', 'the user approved waiving VERIFY-1 earlier on']), "a round-1 approval waived round 2's VERIFY-1", "needs the user's approval");
});

test('sc_report_finding_ids: A130 the completion report names every finding id of every gate; none is refused for a gate with an info row', () => {
  const d = implementedProject();
  const req = required(d); const rg = req.find((g) => g.startsWith('REVIEW_')) ?? '';
  assert.ok(rg, 'no review gate is required');
  for (const g of req) {
    if (g === 'SECRETS') accepted(A(d, ['secret-scan', 'LC']), 'secret-scan');
    else if (g === rg) {
      put(d, `.agents/runs/LC/${reportPath(rg)}`, '# review\n\nthe change was read.\n');
      const rows = path.join(tmp('ir'), 'ir.rows'); writeFileSync(rows, 'info|impl.txt:1|naming is terse but consistent across the module|read\n');
      accepted(AS(d, 'reviewer', ['submit', 'LC', '--focus', gateFocus(rg), '--artifact', reportPath(rg), '--findings', rows, '--confidence', 'high']), 'the info-row review');
    } else gpass(d, g);
  }
  for (const m of A(d, ['pipeline', 'LC']).out.matchAll(/^focus\.([A-Z_]*)\.([a-z]*)=.*$/gm)) gpass(d, m[1], { focus: m[2] });
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE'); accepted(A(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']), 'knowledge-done');
  const nr = `${rg}:${gateFocus(rg)}`;
  // every miss at once: the not-reproduced line AND the ids, with the line to add
  writeReport(d, '', `${rg}: none.`);
  const out = A(d, ['publish-completion-report', 'LC', 'markdown']);
  assert.notEqual(out.status, 0, 'a report with none for a gate with info rows was published');
  assert.ok(out.text.includes(`add the line '- ${nr}: not reproduced (NOT_RERUN)'`), `no not-reproduced line to add: ${out.text}`);
  assert.ok(out.text.includes(`gate ${rg}: name the finding id(s) ${rg}-1 ${rg}-2`), `the missing ids are not all named: ${out.text}`);
  // next lists what the report must carry
  assert.match(A(d, ['next', 'LC']).out, new RegExp(`gate ${rg} findings to name.*${rg}-1 ${rg}-2`), 'next does not list the finding ids');
  assert.ok(A(d, ['next', 'LC']).out.includes(`NOT_RERUN ${nr}: not reproduced proof`), 'next does not list the not-reproduced line');
  // the id of a gate is not named by a line that only has it inside another list (QA-1 in 'scenarios QA-1 to QA-9')
  writeReport(d, '', `scenarios ${rg}-1 to ${rg}-9 passed; ${rg}-2 too.`, `- ${nr}: not reproduced (NOT_RERUN)`);
  refused(A(d, ['publish-completion-report', 'LC', 'markdown']), 'an id inside a list that does not name the gate', `gate ${rg}: name the finding id(s) ${rg}-1 ${rg}-2`);
  writeReport(d, '', `${rg}: ${rg}-1 (info): naming is terse but consistent, no change needed; ${rg}-2 (info): no validator ran.`);
  refused(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a re-run-nothing gate without its own not reproduced line', `add the line '- ${nr}: not reproduced (NOT_RERUN)'`);
  writeReport(d, '', `${rg}: ${rg}-1, ${rg}-2 (info) noted. ${nr} was reproduced by the control plane.`, `- ${nr}: not reproduced (NOT_RERUN)`);
  refused(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a re-run-nothing gate described as reproduced', 'calls it reproduced: "');
  writeReport(d, '', `${rg}: ${rg}-1 (info): naming is terse but consistent, no change needed; ${rg}-2 (info): no validator ran.`, `- ${nr}: not reproduced (NOT_RERUN)`);
  accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a report naming the finding id and the not reproduced line');
});

test('sc_report_facts: A143 the completion report numbers must be the recorded ones; publish appends the Facts block generated from the records', () => {
  const d = project(); toCodeDone(d, 'orchestrated');
  accepted(A(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']), 'knowledge-done');
  const ng = required(d).length;
  const facts = accepted(A(d, ['report-facts', 'LC']), 'report-facts').out.replace(/\n+$/, '');
  for (const want of [`- Required gates: ${ng}`, '- Fix rounds: 0 of 2', '- Refreezes: 0', '- Files changed (task-owned paths): 2', '- Worker-evidence run records: total 2, ended pass 1, ended fail 1', '- Gate VERIFY: pass; findings: none']) {
    assert.ok(facts.includes(want), `Facts block lacks '${want}': ${facts}`);
  }
  const pub = (/** @type {string} */ what, /** @type {string} */ msg, /** @type {string[]} */ ...text) => { writeReport(d, '', ...text); refused(A(d, ['publish-completion-report', 'LC', 'markdown']), what, msg); };
  pub('a wrong test count was published', '"9 tests" (recorded: worker-evidence run records: total 2, ended pass 1, ended fail 1;', 'We ran 9 tests and all of them pass.');
  pub("a wrong 'tests: N' count was published", '"40 tests"', 'Tests: 40 passed.');
  pub('a wrong gate count was published', `"${ng + 3} gates" (recorded: required gates ${ng})`, `All ${ng + 3} required gates passed.`);
  pub('a wrong fix-round count was published', '"1 fix rounds" (recorded: used 0, maximum 2)', 'The change needed 1 fix round.');
  pub('a wrong refreeze count was published', '"1 refreezes"', 'The plan had 1 refreeze.');
  pub('a number word beside tests was published', '"5 tests"', 'Five regression tests cover the lookup.');
  pub('a number word beside gates was published', '"12 gates"', 'All Twelve gates passed.');
  // words without numbers, ids with digits, fenced output and the recorded numbers are fine; a hand-written block is replaced
  writeReport(d, '', `AC-1 tests: the lookup test passes. ${ng} gates passed, 0 fix rounds, 0 refreezes, 2 test runs recorded, one test run ended in a failure as planned (RED).`,
    'Step 3 tests the lookup. The 3 test files are small; 0 tests failed.', '```', '# tests 99', '```', '', '<!-- proofline:facts:begin -->', '- Required gates: 99', '<!-- proofline:facts:end -->');
  accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'a report with the recorded numbers');
  const rep = read(d, '.agents/runs/LC/COMPLETION_REPORT.md');
  assert.equal(rep.split('\n').filter((l) => l.includes('proofline:facts:begin')).length, 1, 'the report holds more or less than one Facts block');
  assert.ok(!rep.includes('- Required gates: 99'), 'a hand-written Facts block survived');
  const m = /^.*proofline:facts:begin.*$[\s\S]*?^.*proofline:facts:end.*$/m.exec(rep);
  assert.equal(m?.[0], facts, 'the published Facts block differs from the records read before publishing');
});

test('sc_open_runs: git hooks - every open run counts (ACTIVE_RUN emptied), terminated runs do not', () => {
  const d = project({ cls: 'STANDARD' });
  const run = (/** @type {string[]} */ a, /** @type {string} */ [input] = ['']) => spawnSync('git', a, { cwd: d, env: cleanEnv({ PROOFLINE_NO_TTY: '1' }), encoding: 'utf8', input });
  const inst = spawnSync(process.execPath, [path.join(repo, 'tests/legacy-githooks/install.mjs'), '.agents/githooks'], { cwd: d, encoding: 'utf8' });
  assert.equal(inst.status, 0, `install.mjs: ${inst.stderr}`);
  assert.equal(run(['config', 'core.hooksPath', '.agents/githooks']).status, 0);
  writeFileSync(path.join(d, '.agents/local/ACTIVE_RUN'), '');
  assert.equal(A(d, ['open-runs']).out.replace(/\n+$/, ''), 'LC -', `open-runs: ${A(d, ['open-runs']).out}`);
  writeFileSync(path.join(d, 'notes.md'), 'notes\n'); run(['add', 'notes.md']);
  const c = run(['commit', '-qm', 'docs: notes']);
  assert.notEqual(c.status, 0, 'emptying ACTIVE_RUN opened commits outside the run (the commit succeeded)');
  assert.ok((c.stdout + c.stderr).includes("commits only on a run's task branch"), `emptying ACTIVE_RUN opened commits outside the run: ${c.stderr}`);
  accepted(A(d, ['terminate', 'LC', 'BLOCKED'], { input: 'reason: the lookup backend is unreachable from this sandbox\nevidence: three connection attempts to the backend timed out\n' }), 'terminate');
  assert.equal(A(d, ['open-runs']).out.trim(), '', 'a terminated run is still open');
  const c2 = run(['commit', '-qm', 'docs: notes']);
  assert.equal(c2.status, 0, `a terminated run still blocks commits: ${c2.stderr}`);
});

test('sc_knowledge_secrets: knowledge-scope files are secret-scanned at DONE and delivery-check', () => {
  const d = project(); toCodeDone(d, 'orchestrated');
  put(d, 'docs/design/DESIGN.md', 'token: PLANTED_SECRET\n');
  refused(A(d, ['knowledge-done', 'LC']), 'A200: knowledge-done over a secret in a knowledge file', 'found secrets');
  put(d, 'docs/design/DESIGN.md', 'design notes\n'); accepted(A(d, ['knowledge-done', 'LC']), 'knowledge-done'); writeReport(d); accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'publish');
  put(d, 'docs/design/DESIGN.md', 'token: PLANTED_SECRET\n');   // written after the knowledge step: DONE and delivery still scan
  refused(A(d, ['delivery-check', 'LC']), 'delivery-check over a secret in a knowledge file', 'found secrets');
  refused(A(d, ['handoff', 'LC', 'DONE']), 'DONE over a secret in a knowledge file', 'found secrets');
  put(d, 'docs/design/DESIGN.md', 'design notes\n');
  accepted(A(d, ['handoff', 'LC', 'DONE']), 'handoff DONE');
});

test('sc_wiki_knowledge_scope: a path under docs/wiki/ is knowledge scope; a path outside stays implementation scope', () => {
  const d = project(); toCodeDone(d, 'orchestrated');
  assert.ok(A(d, ['config-get', 'knowledge_scope_root']).out.includes('docs/wiki/'), 'docs/wiki/ is not in the default knowledge_scope_root');
  assert.ok(A(d, ['config-get', 'knowledge_scope_root']).out.includes('docs/product/'), 'docs/product/ is not in the default knowledge_scope_root');
  put(d, 'notes/outside.txt', 'not a wiki page\n');
  refused(A(d, ['knowledge-done', 'LC']), 'a path outside the root counted as knowledge', 'no knowledge page was written');
  rmSync(path.join(d, 'notes'), { recursive: true });
  put(d, 'docs/wiki/concepts/retry-policy.md', '---\ntitle: retry-policy\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Retry policy\n');
  installWikiLint(d);   // the lint must be installed or knowledge-done refuses
  accepted(A(d, ['knowledge-done', 'LC']), 'knowledge-done');
  accepted(A(d, ['verify-knowledge-scope', 'LC']), 'verify-knowledge-scope');
});

test('sc_knowledge_done_needs_page_and_lint: A200 knowledge-done needs a written page and a wiki lint it ran itself without errors', () => {
  const d = project(); toCodeDone(d, 'orchestrated');
  refused(A(d, ['knowledge-done', 'LC']), 'A200: knowledge-done with no page written', 'no knowledge page was written');
  const good = '---\ntitle: good page\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Good\n';
  put(d, 'docs/wiki/good.md', good);
  refused(A(d, ['knowledge-done', 'LC']), 'A200: knowledge-done with the llm-wiki lint script missing refuses', 'validate-wiki.mjs is missing');
  rmSync(path.join(d, 'docs/wiki/good.md'));
  installWikiLint(d);
  put(d, 'docs/wiki/bad.md', '---\ntitle: bad page\nstatus: current\n---\n\n# No source\n');
  refused(A(d, ['knowledge-done', 'LC']), 'A200: knowledge-done over a wiki page the lint rejects', 'wiki lint of docs/wiki found errors');
  assert.ok(!/knowledge_state: "?KNOWLEDGE_DONE/.test(read(d, '.agents/runs/LC/RUN.yaml')), 'a refused knowledge-done recorded the state');
  put(d, 'docs/wiki/bad.md', good);
  const kd = A(d, ['knowledge-done', 'LC']); assert.equal(kd.status, 0, `knowledge-done refused a wiki page that passes the lint: ${kd.text}`);
  // A200: the proofline_bug friction note is reminded by next (report step) and counted in the report's Facts
  assert.match(A(d, ['next', 'LC']).out, /^note=FRICTION \(A200\): .*proofline_bug notes so far: 0\)/m, 'next does not remind of the friction note');
  accepted(A(d, ['friction-note', 'LC', 'proofline_bug']), 'friction-note');
  assert.ok(A(d, ['next', 'LC']).out.includes('proofline_bug notes so far: 1)'), 'next does not count the note');
  assert.ok(A(d, ['report-facts', 'LC']).out.includes('Friction notes recorded (A200): proofline_bug 1, user-command 0, user-shell 0'), 'the Facts block does not count the friction notes');
});

test('sc_knowledge_gates_fresh: gates do not go stale after the knowledge step writes its files', () => {
  const d = project(); toCodeDone(d, 'orchestrated');
  const gatesOf = () => A(d, ['pipeline', 'LC']).out.split('\n').filter((l) => l.startsWith('gate.')).join('\n');
  const before = gatesOf();
  assert.ok(!/gate\.[A-Z_]*=(stale|missing|fail)/.test(before), `gates are not fresh before the knowledge step: ${before}`);
  put(d, 'docs/wiki/concepts/retry-policy.md', '---\ntitle: retry-policy\nstatus: current\nsource: docs/design/DESIGN.md\n---\n\n# Retry policy\n');
  for (const f of ['docs/design', 'docs/adr', 'docs/product']) mkdirSync(path.join(d, f), { recursive: true });
  installWikiLint(d);
  put(d, 'docs/design/DESIGN.md', '# Design\n'); put(d, 'docs/adr/0001-x.md', '# ADR 1\n'); put(d, 'docs/product/PRD.md', '# PRD\n');
  accepted(A(d, ['knowledge-done', 'LC']), 'knowledge-done');
  const after = gatesOf();
  assert.equal(after, before, `the knowledge step's files changed the gate statuses: before [${before}] after [${after}]`);
  A(d, ['delivery-check', 'LC']);
  assert.ok(!gatesOf().includes('=stale'), 'a gate went stale after the knowledge step');
});

test('sc_knowledge_drift: design-sync drift in knowledge-scope documents is information before the knowledge step and blocks knowledge-done and delivery after it', () => {
  const d = implementedProject({ planExtra: '\n## Verification commands\n\n- `sh .agents/local/check.sh`\n- `sh .agents/local/quiet.sh`' });
  installSkill(d, 'verify-proof'); installSkill(d, 'plan-contract');
  appendFileSync(path.join(d, '.git/info/exclude'), '.agents/skills/\n');
  put(d, '.agents/local/check.sh', 'echo ok 3 tests\n'); put(d, '.agents/local/quiet.sh', ':\n');
  const rd = '.agents/runs/LC';
  /** vw VERDICT EXIT OUTPUT STATUS: a self-consistent VERIFY.md claiming check.sh ran with that exit and output. @param {string} verdict @param {number} exit @param {string} output @param {string} status */
  const vw = (verdict, exit, output, status) => put(d, `${rd}/VERIFY.md`, `${['# Verification: LC', '', '## Commands', '', `- \`sh .agents/local/check.sh\` | exit=${exit}`, `  output: ${output}`, '', '## AC coverage', '', '| AC | test or command | status | evidence |', '|---|---|---|---|',
    `| AC-1 | impl_test.txt::lookup | ${status} | \`sh .agents/local/check.sh\` exit=${exit} |`, '', '## Scope', '', 'verify-scope: exit=0', '', '## Design sync', '', 'design-sync: SKIPPED (no design documents)', '', '## Runtime', '', 'runtime: none (no runtime in this test)', '',
    '## Pre-existing failures', '', 'None', '', '## Failures', '', 'None', '', `Verdict: ${verdict}`].join('\n')}\n`);
  installSkill(d, 'design-sync');
  put(d, 'docs/design/DESIGN.md', '# Design\n\nThe widget lives in `src/missing.js`.\n'); appendFileSync(path.join(d, '.git/info/exclude'), 'docs/\n');
  put(d, `${rd}/design/SYNC.md`, `${['# Design sync: LC', '', 'Verdict: FAIL', '', '## Documents', '', '| Role | Path | Present |', '|---|---|---|', '| design | docs/design/DESIGN.md | yes |', '', '## Counts', '', 'matched: 0, unmatched (after review): 1, unverifiable: 0', '', '## Drift', '', '- docs/design/DESIGN.md:3 -> path src/missing.js: no such file or directory', '', '## Unverifiable', '', 'None.'].join('\n')}\n`);
  vw('PASS', 0, 'ok 3 tests', 'PASS');
  put(d, `${rd}/VERIFY.md`, sed(read(d, `${rd}/VERIFY.md`), /^design-sync: SKIPPED.*/, 'design-sync: PASS (knowledge-scope drift: 1 line handed to the knowledge step)'));
  const rows = path.join(tmp('kd'), 'rows');
  // a drift row on a code path stays blocking; the same row on a knowledge-scope document is information
  writeFileSync(rows, 'blocking|src/app.js:4|D-2: design-sync drift: route GET /x not found|design-sync exit=1\n');
  refused(AS(d, 'verifier', ['submit', 'LC', '--confidence', 'high', '--result', 'PASS', '--findings', rows, '--agent', 'kd0']), 'a drift row on a code path was not blocking', 'contradicts');
  writeFileSync(rows, 'blocking|docs/design/DESIGN.md:3|D-1: design-sync drift: path src/missing.js not found|design-sync exit=1\n');
  const out = AS(d, 'verifier', ['submit', 'LC', '--confidence', 'high', '--findings', rows, '--agent', 'kd1']);
  assert.equal(out.status, 0, `knowledge-scope drift failed the verifier: ${out.text}`);
  assert.ok(out.text.includes('submitted: LC verifier PASS'), `knowledge-scope drift was not information: ${out.text}`);
  /** @param {string} dir @returns {string} */
  const allText = (dir) => readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? allText(path.join(dir, e.name)) : readFileSync(path.join(dir, e.name), 'utf8'))).join('\n');
  assert.ok(allText(path.join(d, rd)).includes('KNOWLEDGE_DRIFT'), 'the drift row was not recorded as KNOWLEDGE_DRIFT information');
  passAllLocal(d);
  const cd = A(d, ['handoff', 'LC', 'CODE_DONE']); assert.equal(cd.status, 0, `CODE_DONE refused: ${cd.text}`);
  put(d, '.git/info/exclude', read(d, '.git/info/exclude').split('\n').filter((l) => l !== 'docs/').join('\n'));   // the knowledge step's files are visible from here on
  // before the knowledge step the drift is information in next
  assert.ok(A(d, ['next', 'LC']).out.includes('note=design-sync drift in knowledge-scope documents'), 'next does not show the drift as information');
  // after the knowledge step it still drifts: blocked, nothing to waive
  refused(A(d, ['knowledge-done', 'LC']), 'knowledge-done with drift left', 'design-sync drift in knowledge-scope documents is still there');
  expectState(d, 'execution', 'knowledge_state', 'not_started');
  // the knowledge step fixes the document: both pass
  put(d, 'docs/design/DESIGN.md', '# Design\n\nThe widget lives in `impl.txt`.\n');
  const kd = A(d, ['knowledge-done', 'LC']); assert.equal(kd.status, 0, `knowledge-done refused after the document was fixed: ${kd.text}`);
  expectState(d, 'execution', 'knowledge_state', 'KNOWLEDGE_DONE');
  put(d, 'docs/design/DESIGN.md', '# Design\n\nThe widget lives in `src/missing.js`.\n');
  refused(A(d, ['delivery-check', 'LC']), 'delivery with the drift back', 'design-sync drift in knowledge-scope documents is still there');
});

/** @param {string} d */
function passAllLocal(d) { passAllHarness(d); }

test('sc_knowledge_na: not_applicable needs a reason, is refused for user-visible behaviour, a contract and a design-document change, on a run without knowledge_reason and for a # in the reason; nothing is recorded', () => {
  const REASON = 'only an internal lookup fixture changed, no wiki page or design document describes it';
  let d = project(); toCodeDone(d, 'orchestrated');
  refused(A(d, ['knowledge-done', 'LC', 'not_applicable']), 'not_applicable without a reason was accepted', 'needs a reason');
  refused(A(d, ['knowledge-done', 'LC', 'not_applicable', '']), 'not_applicable with an empty reason was accepted', 'needs a reason');
  expectState(d, 'execution', 'knowledge_state', 'not_started');
  accepted(A(d, ['knowledge-done', 'LC', 'not_applicable', REASON]), 'knowledge-done not_applicable');
  expectState(d, 'execution', 'knowledge_state', 'not_applicable');
  assert.ok(A(d, ['report-facts', 'LC']).out.includes('Knowledge step: not_applicable; not_applicable reason: only an internal lookup fixture changed'), 'the Facts block does not show the reason');
  writeReport(d); accepted(A(d, ['publish-completion-report', 'LC', 'markdown']), 'publish');
  assert.ok(read(d, '.agents/runs/LC/COMPLETION_REPORT.md').includes('not_applicable reason: only an internal lookup fixture changed'), 'the published report does not show the reason');
  // user-visible behaviour in the acceptance criteria
  d = project({ taskExtra: '- AC-2: the lookup command prints the stored value' }); toCodeDone(d, 'orchestrated');
  refused(A(d, ['knowledge-done', 'LC', 'not_applicable', REASON]), 'not_applicable accepted for a task that changes a command', 'user-visible behaviour');
  expectState(d, 'execution', 'knowledge_state', 'not_started');
  // a contract in the frozen plan
  d = project({ planExtra: '## Contracts\n- lookup returns nil for an empty key' }); toCodeDone(d, 'orchestrated');
  refused(A(d, ['knowledge-done', 'LC', 'not_applicable', REASON]), 'not_applicable accepted for a task with a contract change', 'contract');
  // a design document changed by the task
  d = project({ topology: 'standalone', scopeNamed: 'docs/design/DESIGN.md' }); appendFileSync(path.join(d, 'docs/design/DESIGN.md'), 'new section\n'); toCodeDone(d, 'standalone');
  refused(A(d, ['knowledge-done', 'LC', 'not_applicable', REASON]), 'not_applicable accepted for a task that changed a design document', 'documentation path');
  // the step must write a page (A200) and the lint must be installed; the design document the task changed is plan scope, not a knowledge page
  installWikiLint(d);
  put(d, 'docs/wiki/lookup.md', '---\ntitle: lookup\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Lookup\n');
  accepted(A(d, ['knowledge-done', 'LC']), 'knowledge-done'); expectState(d, 'execution', 'knowledge_state', 'KNOWLEDGE_DONE');
  // a run from before 0.0.17 has no execution.knowledge_reason key: not_applicable is refused and nothing is recorded
  d = project(); toCodeDone(d, 'orchestrated');
  const ry = '.agents/runs/LC/RUN.yaml';
  assert.ok(/^ *knowledge_reason:/m.test(read(d, ry)), 'the fixture has no knowledge_reason line to delete');
  put(d, ry, read(d, ry).split('\n').filter((l) => !/^ *knowledge_reason:/.test(l)).join('\n'));
  assert.ok(!read(d, ry).includes('knowledge_reason'), 'the knowledge_reason line was not removed');
  refused(A(d, ['knowledge-done', 'LC', 'not_applicable', REASON]), 'not_applicable accepted on a run without knowledge_reason', 'predates 0.0.17');
  expectState(d, 'execution', 'knowledge_state', 'not_started');
  // a # in the reason would end the YAML value as a comment
  d = project(); toCodeDone(d, 'orchestrated');
  refused(A(d, ['knowledge-done', 'LC', 'not_applicable', 'only an internal lookup fixture changed, see issue #12 for the details of it']), 'not_applicable accepted with a # in the reason', 'must not contain');
  expectState(d, 'execution', 'knowledge_state', 'not_started');
});

test('sc_next_order: next names classify, branch, baseline in the order the commands accept', () => {
  const d = newRepo(); const nd = '.agents/runs/NB'; mkdirSync(path.join(d, nd), { recursive: true }); mkdirSync(path.join(d, 'tasks'), { recursive: true });
  put(d, `${nd}/RUN.yaml`, read(d, '.agents/templates/RUN.yaml').replace('<TASK-ID>', 'NB').replace('<REPOSITORY-RELATIVE-TASK-FILE.md>', 'tasks/NB-sample.md'));
  put(d, `${nd}/TASK.md`, '# Task: NB - sample\n'); put(d, 'tasks/NB-sample.md', '# NB sample\n'); commitAll(d, 'base');
  assert.match(A(d, ['next', 'NB']).out, /^next=agent\.sh classify NB/m, `next on a new run: ${A(d, ['next', 'NB']).text}`);
  accepted(A(d, ['classify', 'NB', 'STANDARD']), 'classify');
  assert.match(A(d, ['next', 'NB']).out, /^next=agent\.sh branch NB/m, `next after classify: ${A(d, ['next', 'NB']).text}`);
  accepted(A(d, ['branch', 'NB']), 'branch');
  assert.match(A(d, ['next', 'NB']).out, /^next=agent\.sh baseline NB/m, `next after branch: ${A(d, ['next', 'NB']).text}`);
});

test('sc_qa_plan_bound: stale hash, missing hash, unknown or uncovered criterion and a removed term are refused; an absence expectation passes', () => {
  const d = project(); const rd = '.agents/runs/LC';
  const bind = () => qaBindLocal(d);
  accepted(A(d, ['verify-qa-plan', 'LC']), 'a QA plan bound to its PLAN.md was refused');
  const planKeep = read(d, `${rd}/PLAN.md`); const qaKeep = read(d, `${rd}/QA_PLAN.md`);
  appendFileSync(path.join(d, `${rd}/PLAN.md`), 'contract changed after the QA plan\n');
  refused(A(d, ['verify-qa-plan', 'LC']), 'QA plan derived from another plan', 'derived from a different PLAN.md');
  put(d, `${rd}/PLAN.md`, planKeep);
  put(d, `${rd}/QA_PLAN.md`, qaKeep.split('\n').filter((l) => !l.startsWith('Plan sha256: ')).join('\n'));
  refused(A(d, ['verify-qa-plan', 'LC']), 'QA plan without the plan hash', 'must cite the plan');
  put(d, `${rd}/QA_PLAN.md`, `${qaKeep}- QA-9 (AC-7): a criterion the plan does not have\n  input: x\n`);
  refused(A(d, ['verify-qa-plan', 'LC']), 'scenario for a criterion the plan lacks', 'which PLAN.md does not contain');
  put(d, `${rd}/QA_PLAN.md`, qaKeep);
  put(d, `${rd}/PLAN.md`, planKeep.split('[AC-1]').join('[AC-1, AC-3]'));
  bind();
  refused(A(d, ['verify-qa-plan', 'LC']), 'plan criterion without an acceptance scenario', 'no acceptance scenario for AC-3');
  put(d, `${rd}/PLAN.md`, `${planKeep}\n## Contracts\n\n- the response no longer returns \`legacyNotes\` (removed)\n`);
  put(d, `${rd}/QA_PLAN.md`, `${qaKeep}  expected: the response has \`legacyNotes\` with the stored value\n`); bind();
  refused(A(d, ['verify-qa-plan', 'LC']), "scenario expects a term the plan's contracts remove", 'removes or renames');
  put(d, `${rd}/QA_PLAN.md`, `${qaKeep}  expected: the response has no \`legacyNotes\` key (absent)\n`); bind();
  accepted(A(d, ['verify-qa-plan', 'LC']), 'an absence expectation of a removed term was refused');
});

test('sc_artifact_snapshots: C-9 results of two rounds that wrote the same report path both cite an existing artifact with the stated sha256', () => {
  const d = implementedProject();
  const small = '.agents/runs/LC/reviews/proof-review/small';
  put(d, `${small}/REPORT.md`, 'round one report\n');
  accepted(AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--agent', 's1']), 'first submit');
  put(d, `${small}/REPORT.md`, 'round two report, same path\n');
  accepted(AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--agent', 's2']), 'second submit');
  let n = 0;
  for (const f of readdirSync(path.join(d, '.agents/runs/LC/results')).filter((x) => x.endsWith('-reviewer.result.md'))) {
    const m = /^ARTIFACT: (\S+) ([0-9a-f]*)$/m.exec(read(d, `.agents/runs/LC/results/${f}`));
    const p = m?.[1] ?? ''; const h = m?.[2] ?? '';
    assert.ok(p && existsSync(path.join(d, '.agents/runs/LC', p)) && tsha(path.join(d, '.agents/runs/LC', p)) === h, `C-9: ${f} cites ${p} with a stale or missing sha256`);
    n++;
  }
  assert.equal(n, 2, `expected two recorded reviewer results, saw ${n}`);
  assert.equal(count(d, '.agents/runs/LC/reports/snapshots'), 2, 'two different reports did not make two snapshots');
  const vs = A(d, ['verify-scope', 'LC']); assert.equal(vs.status, 0, `verify-scope refuses the snapshots: ${vs.text}`);
});

/** @param {string} d */
function qaBindLocal(d) { qaBindHarness(d, 'LC'); }

test('sc_waiver_cross_gate: a waiver of a VERIFY finding never waives the same location and text on another gate (fix round 1, B3)', () => {
  const d = implementedProject({ cls: 'CRITICAL' });
  const text = 'cache never invalidated on write';
  must(d, ['record', 'LC', '--file', resultFor(d, 'VERIFY', 'FAIL', [`VERIFY-1|blocking|impl.txt:1|${text}|traced`])], { role: 'verifier' });
  must(d, ['record', 'LC', '--file', resultFor(d, 'REVIEW_RULES', 'FAIL', [`REVIEW_RULES-1|blocking|impl.txt:1|${text}|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single`])], { role: 'reviewer' });
  // QA has no focus, like VERIFY: the persistent key of its finding differs from VERIFY's only by the gate name
  must(d, ['record', 'LC', '--file', resultFor(d, 'QA', 'FAIL', [`QA-1|blocking|impl.txt:1|${text}|traced`])], { role: 'qa' });
  for (const g of ['VERIFY', 'REVIEW_RULES', 'QA']) assert.equal(gateStatus(d, g), 'fail', g);
  approveAsUser(d, 'waive:VERIFY-1', 'approve VERIFY-1');
  accepted(A(d, ['waive', 'LC', 'VERIFY-1', '--reason', 'the user accepted the cache gap for this task']), 'waive VERIFY-1');
  assert.equal(gateStatus(d, 'VERIFY'), 'waived', 'the waiver does not apply to its own gate');
  assert.equal(gateStatus(d, 'REVIEW_RULES'), 'fail', 'a waiver of one gate waived the same location and text on another gate (rules)');
  assert.equal(gateStatus(d, 'QA'), 'fail', 'a waiver of one gate waived the same location and text on another gate (qa, same focus)');
});
