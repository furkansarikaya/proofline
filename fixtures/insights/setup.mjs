// Builds the insights fixture in <target-dir>: an installed-looking project (config + stub agent.sh, not a working
// control plane) holding planted metrics records and three runs whose ledgers and gate records contain known
// patterns and traps. `proofline insights` only reads these files. Deterministic and offline (the one `init` commit
// takes the clock's date, as the shell builder's did: nothing reads it).
// usage: node setup.mjs <target-dir>
import path from 'node:path';
import { Fx, cli } from '../../tests/lib/fixture.mjs';

const fxScripts = path.join(import.meta.dirname, '../../control-plane/agents/scripts');

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init({ config: [['commit.gpgsign', 'false']] });
  f.w('README.md', '# app\n');
  f.git(['add', 'README.md']);
  f.git(['commit', '-q', '-m', 'init']);
  f.mkdir('.agents/scripts', '.agents/local/metrics');
  f.w('.agents/config.yaml', 'proofline_version: 0.0.99\nmetrics: on\n');
  f.w('.agents/scripts/agent.sh', '#!/bin/sh\nexit 0\n');
  // the Node core beside it: `proofline insights` and `queue` run in it
  f.cp(path.join(fxScripts, 'proofline-core.mjs'), '.agents/scripts/proofline-core.mjs');
  f.cp(path.join(fxScripts, 'core'), '.agents/scripts/core');

  const H = '0'.repeat(64);
  let SEQ = 1;
  // row RUN SEQ EVENT DETAIL -> one ledger row (the chain fields are placeholders: insights does not verify the chain)
  const row = (/** @type {string} */ run, /** @type {number | string} */ seq, /** @type {string} */ event, /** @type {string} */ detail) =>
    f.append(`.agents/runs/${run}/LEDGER.log`, `seq=${seq} prev=${H} event=${event} role=lead from=- to=- digest=${H} ts=2026-10-13T10:00:00Z epoch=1760349600 detail=${detail}\n`);
  /** gate record file plus the ledger row that binds it @param {string} run @param {string} name @param {string} g @param {string} res @param {string[]} findings */
  const gate = (run, name, g, res, ...findings) => {
    f.w(`.agents/runs/${run}/gates/${name}-${g}.yaml`, `task_id: "${run}"\ngate: "${g}"\nresult: "${res}"\n${findings.map((x) => `finding: ${x}\n`).join('')}`);
    row(run, SEQ, `gate:${g}:${res}`, `gates/${name}-${g}.yaml@${H} by reviewer`); SEQ++;
  };
  const mk = (/** @type {string} */ run) => { f.mkdir(`.agents/runs/${run}/gates`, `.agents/runs/${run}/results`); f.w(`.agents/runs/${run}/LEDGER.log`, ''); SEQ = 1; };
  const next = (/** @type {string} */ run, /** @type {string} */ event, /** @type {string} */ detail) => { row(run, SEQ, event, detail); SEQ++; };

  mk('RUN-A');
  row('RUN-A', 1, 'start', 'task=TASK.md adapter=markdown'); SEQ = 2;
  next('RUN-A', 'approval-request', 'plan bound=x');
  next('RUN-A', 'approval-request', 'plan bound=x');
  next('RUN-A', 'approval-request', 'plan bound=y');
  next('RUN-A', 'approval', `approvals/001-plan.yaml@${H} plan source=prompt_capture answered_by=user bound=y`);
  gate('RUN-A', '001', 'REVIEW_RULES', 'fail',
    'REVIEW_RULES-1|blocking|src/a.go:10|Error from Close is ignored|rules-1',
    'REVIEW_RULES-2|blocking|src/a.go:20|Error from Open is ignored|rules-1',
    'REVIEW_RULES-3|blocking|src/z.go:1|src/z.go changed outside the frozen scope|diff',
    'REVIEW_RULES-4|info|src/a.go:1|Consider a doc comment|style');
  gate('RUN-A', '002', 'REVIEW_RULES', 'fail',
    'REVIEW_RULES-1|blocking|src/a.go:14|Error from Close is ignored|rules-1',
    'REVIEW_RULES-2|info|src/a.go:1|Consider a doc comment|style');
  gate('RUN-A', '003', 'REVIEW_RULES', 'pass');
  f.w('.agents/runs/RUN-A/results/001-reviewer.result.md', '| REVIEW-1 | blocking | - | UNSUPPORTED: no benchmark tool in the project | none |\nprose line without the keyword\n');
  next('RUN-A', 'record:reviewer:FAIL', `results/001-reviewer.result.md sha256=${H} gate=REVIEW_RULES`);

  mk('RUN-B');
  row('RUN-B', 1, 'start', 'task=TASK.md adapter=markdown'); SEQ = 2;
  next('RUN-B', 'approval-request', 'destructive bound=x');
  next('RUN-B', 'approval', `approvals/001-destructive.yaml@${H} destructive source=tty answered_by=user bound=x`);
  gate('RUN-B', '001', 'REVIEW_RULES', 'fail', 'REVIEW_RULES-1|blocking|src/a.go:33|Error from Close is ignored|rules-1');
  gate('RUN-B', '002', 'SECURITY', 'fail', 'SECURITY-1|blocking|src/b.go:5|Edit of src/b.go is out of scope for this plan|diff');
  // trap: a gate record no ledger row binds (hand-written); it must not be counted
  f.w('.agents/runs/RUN-B/gates/009-QA.yaml', 'task_id: "RUN-B"\ngate: "QA"\nresult: "fail"\nfinding: QA-1|blocking|src/a.go:40|Error from Close is ignored|x\n');
  f.w('.agents/runs/RUN-B/results/001-reviewer.result.md', '| REVIEW-1 | blocking | - | UNSUPPORTED: no benchmark tool in the project | none |\n');
  next('RUN-B', 'record:reviewer:FAIL', `results/001-reviewer.result.md sha256=${H} gate=REVIEW_RULES`);

  mk('RUN-C');
  row('RUN-C', 1, 'start', 'task=TASK.md adapter=markdown');
  f.w('.agents/runs/RUN-C/results/001-qa.result.md', '| QA-1 | blocking | - | UNSUPPORTED: no headless browser installed | none |\n');
  row('RUN-C', 2, 'record:qa:BLOCKED', `results/001-qa.result.md sha256=${H} gate=QA`);

  const R = '.agents/local/metrics/records.jsonl';
  // KIND TASK ROLE FOCUS GATE MODEL DUR TIN TOUT TOTAL RETRIES DELEG FIX RESULT  (null is the word null; strings are bare words)
  const rec = (/** @type {string[]} */ ...a) => {
    const s = (/** @type {string} */ v) => (v === 'null' ? 'null' : `"${v}"`);
    const [kind, task, role, focus, g, model, dur, tin, tout, total, retries, deleg, fix, result] = a;
    f.append(R, `{"schema":"proofline.metrics/1","kind":"${kind}","time":"2026-10-13T10:00:00Z","task":"${task}","role":${s(role)},"focus":${s(focus)},"gate":${s(g)},"runtime":"claude","model":${s(model)},"duration_s":${dur},"tokens_in":${tin},"tokens_out":${tout},"tokens_total":${total},"turns":null,"retries":${retries},"delegations":${deleg},"fix_rounds":${fix},"result":${s(result)}}\n`);
  };
  // Claude-style records carry in, out and total = in + out; a Codex-style record carries only tokens_total
  rec('dispatch', 'RUN-A', 'reviewer', 'rules', 'REVIEW_RULES', 'sonnet', '100', '1000', '200', '1200', '0', 'null', 'null', 'submitted');
  rec('dispatch', 'RUN-A', 'reviewer', 'rules', 'REVIEW_RULES', 'sonnet', '120', 'null', 'null', 'null', '1', 'null', 'null', 'submitted');
  rec('dispatch', 'RUN-A', 'implementer', 'null', 'null', 'gpt-5', '300', '5000', '800', '5800', '0', 'null', 'null', 'submitted');
  rec('step', 'RUN-A', 'reviewer', 'rules', 'REVIEW_RULES', 'sonnet', '110', 'null', 'null', 'null', 'null', 'null', 'null', 'fail');
  rec('run', 'RUN-A', 'lead', 'null', 'null', 'null', '900', 'null', 'null', 'null', 'null', '4', '1', 'done');
  rec('dispatch', 'RUN-B', 'reviewer', 'rules', 'REVIEW_RULES', 'sonnet', '80', '2000', '300', '2300', '0', 'null', 'null', 'submitted');
  rec('dispatch', 'RUN-B', 'security_reviewer', 'null', 'SECURITY', 'opus', '60', 'null', 'null', 'null', '0', 'null', 'null', 'submitted');
  rec('dispatch', 'RUN-B', 'implementer', 'null', 'null', 'gpt-5', '50', 'null', 'null', '4000', '0', 'null', 'null', 'submitted');
  rec('run', 'RUN-B', 'lead', 'null', 'null', 'null', '500', 'null', 'null', 'null', 'null', '2', '0', 'failed');
  // trap: a second run record for the same run (a retried write); only the first counts
  rec('run', 'RUN-B', 'lead', 'null', 'null', 'null', '777777', 'null', 'null', 'null', 'null', '9', '9', 'done');
  rec('dispatch', 'RUN-C', 'explorer', 'null', 'null', 'null', '40', 'null', 'null', 'null', '0', 'null', 'null', 'blocked');
  // a record of another schema version is skipped, not guessed at
  f.append(R, '{"schema":"proofline.metrics/9","kind":"dispatch","task":"RUN-A","role":"reviewer","duration_s":999999}\n');
  // a blank line and a non-JSON line are ignored and not called an unknown schema
  f.append(R, '\nnot json at all\n');
}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });
