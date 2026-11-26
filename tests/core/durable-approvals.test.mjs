// @ts-check
// Durable approvals (A361, issue 338 C3): what the user approved ONCE is carried across tasks, batches and runs of the project, bound to what was approved, and it stays under the
// user's control. Invariant 3 is attempted here from every side: an agent role cannot list or revoke, a revocation needs the user's own message, a hand-edited row of another content
// carries nothing, a changed finding or a changed DESIGN.md line is asked again, SECRETS and SECURITY are never carried, and nothing is inferred from silence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { AS, resultFor, gpass } from '../lib/harness.mjs';
import { A, accepted, approveAsUser, gateStatus, project, refused, say, template, verbs } from './legacy-lib.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { standingWaiverKey } from '../../control-plane/agents/scripts/core/knownissues.mjs';
import { memoryIo } from './helpers.mjs';
import { AB, binstall, bnew, fakes, mktask, summaryOf } from './batch-lib.mjs';
import { repo } from './helpers.mjs';
import { RUN as RUNDIR, commitHead, frozen, implement, rrun, setBase, wr } from './risk-s2-lib.mjs';

const PLACE = '.gitignore:1';
const EVID = 'traced: the entry is missing from the list; scan: grep -n entry .gitignore; instances: single';
const LINT = 'lint mono-labels: file names are set in a monospace face';
const PRE = `mk_run() {
  mr_place=\${1:-${PLACE}} mr_text=\${2:-${LINT}} mr_gate=\${3:-QA}
  scaffold standalone no STANDARD autonomous
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null
  for mr_g in $(required); do case "$mr_g" in SECRETS|VERIFY|"$mr_gate") ;; *) gpass "$mr_g" ;; esac; done
  rec "$mr_gate" FAIL high "$mr_gate-1|blocking|$mr_place|$mr_text|${EVID}"
  gpass VERIFY
}
`;
const RUN_LINT = `${PRE}mk_run`;
const RUN_OTHER = `${PRE}mk_run '${PLACE}' 'lint hairline-newspaper: a hairline rule between columns'`;
const RUN_FREE = `${PRE}mk_run '${PLACE}' 'the legacy ignore list drops a documented entry'`;
const RUN_FAKE = `${PRE}mk_run '${PLACE}' 'lint made-up-rule: an agent invented a rule id'`;
const STORE = '.agents/local/standing/STANDING.tsv';
const DESIGN = '# Design\n\n## Pattern justifications\n\n- mono-labels: file names are the product here\n- numbered-steps: the steps are a real sequence\n- hairline-newspaper: the columns are a newspaper layout\n';

/** @param {string} d */
const store = (d) => (existsSync(path.join(d, STORE)) ? readFileSync(path.join(d, STORE), 'latin1').split('\n').filter((l) => l !== '') : []);
/** The visual-proof registry the control plane reads to tell a registry rule from a free-form finding (a project with the skill installed). @param {string} d */
function installRegistry(d) {
  mkdirSync(path.join(d, '.agents/skills/visual-proof/scripts'), { recursive: true });
  copyFileSync(path.join(repo, 'skills/visual-proof/scripts/patterns.mjs'), path.join(d, '.agents/skills/visual-proof/scripts/patterns.mjs'));
}
/** A project of a recipe with the registry installed. @param {string} recipe */
function proj(recipe) { const d = project(recipe); installRegistry(d); return d; }
/** Another run of the same project reads the same store and sees the same prompt history (both live in the shared .agents/local folder). @param {string} from @param {string} to */
function carryStore(from, to) {
  mkdirSync(path.dirname(path.join(to, STORE)), { recursive: true });
  copyFileSync(path.join(from, STORE), path.join(to, STORE));
  cpSync(path.join(from, '.agents/local/prompts/history'), path.join(to, '.agents/local/prompts/history'), { recursive: true });
}
/** The user approves the waiver of QA-1 (with the word standing unless told otherwise) and the lead records it. @param {string} d @param {string} [words] */
function waiveOnce(d, words = 'approve qa-1 standing', offered = true) {
  const req = accepted(A(d, ['request-approval', 'LC', 'waive:QA-1']), 'request the waiver');
  if (offered) {
    assert.match(req.out, /already existed on the unchanged base/);
    assert.match(req.out, /add the word standing: "approve QA-1 standing"/, 'the request does not tell the user the phrase that keeps the waiver');
  } else assert.doesNotMatch(req.out, /add the word standing/, 'a finding with no standing key offered to keep it');
  say(d, words);
  accepted(A(d, ['approve', 'LC', 'waive:QA-1']), 'approve the waiver');
  return accepted(A(d, ['waive', 'LC', 'QA-1', '--reason', 'the finding existed before this change on main']), 'waive');
}

before(() => { for (const r of [RUN_LINT, RUN_OTHER, RUN_FREE, RUN_FAKE]) template(r); });

describe('a pre-existing finding the user waived once is carried to the next run', () => {
  test('the waiver of an untouched file is also a standing waiver with its origin; another run of the project is not asked again', () => {
    const d = proj(RUN_LINT);
    assert.equal(gateStatus(d, 'QA'), 'fail');
    const w = waiveOnce(d);
    assert.match(w.out, /standing waiver recorded: mono-labels on \.gitignore/);
    const rows = store(d);
    assert.equal(rows.length, 1);
    const f = rows[0].split('\t');
    assert.deepEqual([f[0], f[1], f[2], f[6]], ['waiver', 'mono-labels', '.gitignore', 'user'], 'scope, rule, surface and answered_by');
    assert.match(f[3], /^[0-9a-f]{64}$/, 'the finding fingerprint');
    assert.match(f[4], /^s1:\d+:[0-9a-f]{64}$/, 'the id of the user message the approval came from');
    assert.match(f[5], /^\d{4}-\d\d-\d\dT/, 'the date');
    const d2 = proj(RUN_LINT);
    assert.equal(gateStatus(d2, 'QA'), 'fail', 'a fresh run starts failing');
    carryStore(d, d2);
    assert.equal(gateStatus(d2, 'QA'), 'waived', 'the same finding of the same file was asked again');
    assert.match(accepted(A(d2, ['standing', 'list']), 'list').out, /waiver mono-labels on \.gitignore/);
  });

  test('another rule, a changed finding text and a row that is not the user\'s carry nothing', () => {
    const d = proj(RUN_LINT); waiveOnce(d);
    const other = proj(RUN_OTHER); carryStore(d, other);
    assert.equal(gateStatus(other, 'QA'), 'fail', 'a waiver of one rule covered another rule');
    const changed = proj(RUN_LINT); carryStore(d, changed);
    verbs(changed, `rec QA FAIL high 'QA-1|blocking|${PLACE}|lint mono-labels: file names are set in a serif face|${EVID}'`);
    assert.equal(gateStatus(changed, 'QA'), 'fail', 'a changed finding was carried');
    const forged = proj(RUN_LINT);
    carryStore(d, forged);
    writeFileSync(path.join(forged, STORE), `${store(d)[0].replace(/\tuser\t/, '\tagent\t')}\n`);
    assert.equal(gateStatus(forged, 'QA'), 'fail', 'a row not answered by the user carried a finding');
    const noMessage = proj(RUN_LINT);
    mkdirSync(path.join(noMessage, path.dirname(STORE)), { recursive: true });
    copyFileSync(path.join(d, STORE), path.join(noMessage, STORE));   // the row only: the user's message it cites is not in this project's history
    assert.equal(gateStatus(noMessage, 'QA'), 'fail', 'a hand-written row without a captured user message carried a finding');
    assert.match(accepted(A(noMessage, ['standing', 'list']), 'list').out, /1 row\(s\) of the file do not verify/);
    const otherMsg = proj(RUN_LINT); carryStore(d, otherMsg);
    const other2 = say(otherMsg, 'approve numbered-steps standing');   // a real message of the user that does not name this finding
    writeFileSync(path.join(otherMsg, STORE), `${store(d)[0].split('\t').map((x, i) => (i === 4 ? other2.id : x)).join('\t')}\n`);
    assert.equal(gateStatus(otherMsg, 'QA'), 'fail', 'a row whose message does not name the finding carried it');
    const noStanding = proj(RUN_LINT); carryStore(d, noStanding);
    const plain = say(noStanding, 'approve qa-1');   // names the finding, does not say standing
    writeFileSync(path.join(noStanding, STORE), `${store(d)[0].split('\t').map((x, i) => (i === 4 ? plain.id : x)).join('\t')}\n`);
    assert.equal(gateStatus(noStanding, 'QA'), 'fail', 'a row whose message does not say standing carried a finding');
    const wrongFp = proj(RUN_LINT);
    carryStore(d, wrongFp);
    writeFileSync(path.join(wrongFp, STORE), `${store(d)[0].split('\t').map((x, i) => (i === 3 ? '0'.repeat(64) : x)).join('\t')}\n`);
    assert.equal(gateStatus(wrongFp, 'QA'), 'fail', 'a row of another fingerprint carried a finding');
  });

  test('a finding in a file the task changed is not carried and writes no standing row', () => {
    const d = proj(RUN_LINT);
    verbs(d, "rec QA FAIL high 'QA-1|blocking|impl.txt:1|lint mono-labels: file names are set in a monospace face|" + EVID + "'");
    const req = accepted(A(d, ['request-approval', 'LC', 'waive:QA-1']), 'request');
    assert.doesNotMatch(req.out, /unchanged base/, 'the request promised a standing waiver for a changed file');
    say(d, 'approve qa-1'); accepted(A(d, ['approve', 'LC', 'waive:QA-1']), 'approve');
    accepted(A(d, ['waive', 'LC', 'QA-1', '--reason', 'the finding is in a file this change touched']), 'waive');
    assert.deepEqual(store(d), [], 'a standing waiver was written for a file the task changed');
  });
});

describe('only the user\'s explicit decision and only a registry rule is kept', () => {
  test('without the word standing a waiver is for its run only (no row); the Turkish kalici and kalıcı keep it like standing', () => {
    const d = proj(RUN_LINT);
    waiveOnce(d, 'approve qa-1');
    assert.deepEqual(store(d), [], 'a plain approval of a pre-existing waiver was kept for the project');
    assert.equal(gateStatus(d, 'QA'), 'waived', 'the run itself is still waived');
    for (const word of ['kalici', 'kalıcı', 'KALICI', 'Standing']) {
      const e = proj(RUN_LINT);
      waiveOnce(e, `approve qa-1 ${word}`);
      assert.equal(store(e).length, 1, `${word} did not keep the waiver`);
    }
  });

  test('a free-form finding (a reviewer or QA text) in an untouched tracked file gets no standing key, even when it says lint', () => {
    const d = proj(RUN_FREE);
    waiveOnce(d, 'approve qa-1 standing', false);
    assert.deepEqual(store(d), [], 'a free-form finding was kept for the project');
    const e = proj(RUN_FAKE);
    waiveOnce(e, 'approve qa-1 standing', false);
    assert.deepEqual(store(e), [], 'a rule id that is not in the registry was kept for the project');
    const bare = project(RUN_LINT);   // the visual-proof registry is not installed here: nothing is a registry rule
    waiveOnce(bare, 'approve qa-1 standing', false);
    assert.deepEqual(store(bare), []);
  });
});

describe('SECRETS and SECURITY have no standing key', () => {
  for (const gate of ['SECRETS', 'SECURITY']) {
    test(`a ${gate} finding of an untouched tracked file is never keyed, so it can never be carried`, () => {
      const d = proj(RUN_LINT);
      const f = path.join(d, `.agents/runs/LC/gates/999-${gate}.yaml`);
      writeFileSync(f, `gate: "${gate}"\nfocus: "-"\nresult: "fail"\nfinding: ${gate}-1|blocking|${PLACE}|${LINT}|${EVID}\n`);
      const { io } = memoryIo(d);
      const ctx = new Context(io, io.scriptPath);
      assert.equal(standingWaiverKey(ctx, 'LC', f, `${gate}-1`), null);
      writeFileSync(f, `gate: "QA"\nfocus: "-"\nresult: "fail"\nfinding: QA-1|blocking|${PLACE}|${LINT}|${EVID}\n`);
      ctx.forget('file:');
      assert.notEqual(standingWaiverKey(ctx, 'LC', f, 'QA-1'), null, 'the control: the same finding of a QA record has a key');
    });
  }
});

describe('the user keeps control of what stands', () => {
  test('a role cannot list or revoke; revoke needs the user\'s own message that says revoke and names the rule; a question or another rule does not', () => {
    const d = proj(RUN_LINT); waiveOnce(d);
    refused(AS(d, 'qa', ['standing', 'list']), 'qa lists', 'command denied for qa');
    refused(AS(d, 'implementer', ['standing', 'revoke', 'mono-labels']), 'implementer revokes', 'command denied for implementer');
    refused(A(d, ['standing', 'revoke', 'mono-labels']), 'revoke with the approval message as the newest message', 'revoke refused');
    say(d, 'should I revoke mono-labels?');
    refused(A(d, ['standing', 'revoke', 'mono-labels']), 'a question', 'a question is not a revocation');
    say(d, 'revoke numbered-steps');
    refused(A(d, ['standing', 'revoke', 'mono-labels']), 'another rule named', 'must say "revoke mono-labels"');
    assert.equal(store(d).length, 1, 'a refused revoke removed the row');
    refused(A(d, ['standing', 'revoke', 'no-such-rule']), 'no such rule', 'no standing approval');
    say(d, 'revoke mono-labels');
    const r = accepted(A(d, ['standing', 'revoke', 'mono-labels']), 'revoke');
    assert.match(r.out, /revoked 1 standing approval/);
    assert.deepEqual(store(d), []);
    assert.match(readFileSync(path.join(d, '.agents/local/standing/REVOKED.tsv'), 'latin1'), /^waiver\tmono-labels\t\.gitignore\t/, 'the revocation is kept with the message that made it');
    const d2 = proj(RUN_LINT); carryStore(d, d2);
    writeFileSync(path.join(d2, STORE), '');
    assert.equal(gateStatus(d2, 'QA'), 'fail', 'a revoked waiver still carried');
  });

  test('the standing list shows what stands (scope, rule, surface, message, date)', () => {
    const d = proj(RUN_LINT);
    assert.match(accepted(A(d, ['standing']), 'list').out, /standing approvals: none/);
    waiveOnce(d);
    const out = accepted(A(d, ['standing', 'list']), 'list').out;
    assert.match(out, /standing approvals: 1\n- waiver mono-labels on \.gitignore .*approved by you in message .* on \d{4}-/);
    assert.match(out, /revoke one with the message "revoke <rule>"/);
  });
});

describe('a rationale the user approved once is carried while its DESIGN.md line stays', () => {
  test('approved in one run, approved for the project (no run) and for another run; an edited line, another document and a revocation ask again', () => {
    const d = proj(RUN_LINT);
    writeFileSync(path.join(d, 'DESIGN.md'), DESIGN);
    assert.equal(accepted(A(d, ['design-rationales', '-']), 'list').out.split('\n')[0].split('\t')[1], 'unapproved');
    const req = accepted(A(d, ['request-approval', 'LC', 'rationale:mono-labels']), 'request');
    assert.match(req.out, /add the word standing: "approve rationale mono-labels standing"/);
    say(d, 'approve rationale mono-labels');
    accepted(A(d, ['approve', 'LC', 'rationale:mono-labels']), 'approve without standing');
    assert.deepEqual(store(d), [], 'a plain approval was kept for the project');
    assert.equal(accepted(A(d, ['design-rationales', '-']), 'list').out.split('\n')[0].split('\t')[1], 'unapproved', 'a plain approval is for its run only');
    accepted(A(d, ['request-approval', 'LC', 'rationale:mono-labels']), 'request again');
    say(d, 'approve rationale mono-labels standing');
    assert.match(accepted(A(d, ['approve', 'LC', 'rationale:mono-labels']), 'approve').out, /standing rationale recorded: mono-labels on DESIGN\.md/);
    const f = store(d)[0].split('\t');
    assert.deepEqual([f[0], f[1], f[2], f[6]], ['rationale', 'mono-labels', 'DESIGN.md', 'user']);
    // no run at all (the batch plan asks that way), and the JSON the lint takes
    const rows = accepted(A(d, ['design-rationales', '-']), 'list').out.split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, 2).join(' '));
    assert.deepEqual(rows, ['hairline-newspaper unapproved', 'mono-labels approved', 'numbered-steps unapproved']);
    assert.match(accepted(A(d, ['design-rationales', 'LC', '--json']), 'json').out, /"mono-labels": "[0-9a-f]{64}"/);
    // another run of the project: the store is shared
    const d2 = proj(RUN_LINT); writeFileSync(path.join(d2, 'DESIGN.md'), DESIGN); carryStore(d, d2);
    assert.match(accepted(A(d2, ['design-rationales', 'LC', '--json']), 'json').out, /"mono-labels"/, 'a later run asked again');
    // the line changed: asked again
    writeFileSync(path.join(d2, 'DESIGN.md'), DESIGN.replace('the product here', 'decoration'));
    assert.equal(accepted(A(d2, ['design-rationales', 'LC']), 'list').out.split('\n').find((l) => l.startsWith('mono-labels'))?.split('\t')[1], 'unapproved', 'an edited line was carried');
    // the same line in another document is another surface
    rmSync(path.join(d2, 'DESIGN.md'));
    mkdirSync(path.join(d2, 'docs/design'), { recursive: true });
    writeFileSync(path.join(d2, 'docs/design/DESIGN.md'), DESIGN);
    assert.equal(accepted(A(d2, ['design-rationales', 'LC']), 'list').out.split('\n').find((l) => l.startsWith('mono-labels'))?.split('\t')[1], 'unapproved', 'a rationale of one document was carried to another');
    // a revocation by the user's message
    say(d, 'revoke mono-labels'); accepted(A(d, ['standing', 'revoke', 'mono-labels']), 'revoke');
    assert.equal(accepted(A(d, ['design-rationales', '-']), 'list').out.split('\n')[1].split('\t')[1], 'unapproved', 'a revoked rationale still stood');
  });

  test('the QA role builds the approved-rationales file with the control plane, not by hand: a path outside reviews/visual-proof is refused, and it lists the task\'s own files', () => {
    const d = proj(RUN_LINT);
    writeFileSync(path.join(d, 'DESIGN.md'), DESIGN);
    approveAsUser(d, 'rationale:mono-labels', 'approve rationale mono-labels standing');
    const out = accepted(AS(d, 'qa', ['design-rationales', 'LC', '--json', '--out', 'reviews/visual-proof/approved-rationales.json']), 'the QA role builds the file').out;
    assert.match(out, /^approved-rationales: \.agents\/runs\/LC\/reviews\/visual-proof\/approved-rationales\.json \(1 approved, 0 of them carried from standing approvals\)\nlint-paths: /);
    const json = JSON.parse(readFileSync(path.join(d, RUNDIR, 'reviews/visual-proof/approved-rationales.json'), 'utf8'));
    assert.deepEqual(Object.keys(json.approved), ['mono-labels']);
    refused(AS(d, 'qa', ['design-rationales', 'LC', '--json', '--out', '../../../../outside.json']), 'a path outside', 'must be reviews/visual-proof/approved-rationales.json');
    refused(AS(d, 'qa', ['design-rationales', 'LC', '--json', '--out', 'reviews/visual-proof/sub/x.json']), 'a deeper path', 'must be reviews/visual-proof/approved-rationales.json');
    refused(AS(d, 'qa', ['design-rationales', 'LC', '--out', 'reviews/visual-proof/x.json']), 'without --json', '--out writes the --json object');
    refused(AS(d, 'qa', ['design-rationales', '-', '--json', '--out', 'reviews/visual-proof/x.json']), 'without a run', '--out writes the --json object');
  });

  test('the approved-rationales file is the one name, never another file of the run, and never through a link', () => {
    const d = proj(RUN_LINT);
    writeFileSync(path.join(d, 'DESIGN.md'), DESIGN);
    const vp = path.join(d, RUNDIR, 'reviews/visual-proof');
    mkdirSync(vp, { recursive: true });
    writeFileSync(path.join(vp, 'lint.json'), '{"evidence":"of another role"}\n');
    refused(AS(d, 'qa', ['design-rationales', 'LC', '--json', '--out', 'reviews/visual-proof/lint.json']), 'another file of the run', 'must be reviews/visual-proof/approved-rationales.json');
    assert.equal(readFileSync(path.join(vp, 'lint.json'), 'utf8'), '{"evidence":"of another role"}\n', 'the evidence of another role was overwritten');
    // a link planted at the target is replaced, never followed
    const victim = path.join(d, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    symlinkSync(victim, path.join(vp, 'approved-rationales.json'));
    refused(AS(d, 'qa', ['design-rationales', 'LC', '--json', '--out', 'reviews/visual-proof/approved-rationales.json']), 'a link at the target', 'not a plain single-link file');
    assert.equal(readFileSync(victim, 'utf8'), 'untouched\n', 'a link at the target was followed');
    rmSync(path.join(vp, 'approved-rationales.json'));
    // a link as the folder
    rmSync(vp, { recursive: true, force: true });
    const elsewhere = path.join(d, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, vp);
    refused(AS(d, 'qa', ['design-rationales', 'LC', '--json', '--out', 'reviews/visual-proof/approved-rationales.json']), 'a linked folder', 'not a plain folder');
    assert.equal(existsSync(path.join(elsewhere, 'approved-rationales.json')), false, 'the file was written through a linked folder');
    rmSync(vp, { force: true });
    accepted(AS(d, 'qa', ['design-rationales', 'LC', '--json', '--out', 'reviews/visual-proof/approved-rationales.json']), 'the plain case');
    accepted(AS(d, 'qa', ['design-rationales', 'LC', '--json', '--out', 'reviews/visual-proof/approved-rationales.json']), 'the same file again');
  });
});

describe('several approvals in one message', () => {
  /** @param {string} d */
  function requestAll(d) { for (const r of ['numbered-steps', 'hairline-newspaper', 'mono-labels']) accepted(A(d, ['request-approval', 'LC', `rationale:${r}`]), `request ${r}`); }

  test('"approve rationale a b c" approves the three named rationales from one message', () => {
    const d = proj(RUN_LINT); writeFileSync(path.join(d, 'DESIGN.md'), DESIGN); requestAll(d);
    say(d, 'approve rationale numbered-steps hairline-newspaper mono-labels standing');
    accepted(A(d, ['approve', 'LC', 'rationale:numbered-steps', 'rationale:hairline-newspaper', 'rationale:mono-labels']), 'one message, three rationales');
    assert.deepEqual(accepted(A(d, ['design-rationales', 'LC']), 'list').out.split('\n').filter(Boolean).map((l) => l.split('\t')[1]), ['approved', 'approved', 'approved']);
    assert.equal(store(d).length, 3, 'each rationale is its own standing row');
  });

  test('"approve a rationale" (the article a) does not name the rationale a; "approve rationale a" does, and a per-segment standing word keeps only the segment that has it', () => {
    const d = proj(RUN_LINT);
    writeFileSync(path.join(d, 'DESIGN.md'), '# Design\n\n## Pattern justifications\n\n- a: the first reason\n- b: the second reason\n');
    for (const r of ['a', 'b']) accepted(A(d, ['request-approval', 'LC', `rationale:${r}`]), `request ${r}`);
    const state = () => Object.fromEntries(accepted(A(d, ['design-rationales', 'LC']), 'list').out.split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, 2)));
    say(d, 'approve a rationale');
    refused(A(d, ['approve', 'LC', 'rationale:a', 'rationale:b']), 'the article reply', 'no approval phrase');
    assert.deepEqual(state(), { a: 'unapproved', b: 'unapproved' }, '"approve a rationale" approved the rationale named a');
    say(d, 'approve rationale a standing; approve rationale b');
    accepted(A(d, ['approve', 'LC', 'rationale:a', 'rationale:b']), 'two segments');
    assert.deepEqual(state(), { a: 'approved', b: 'approved' });
    assert.deepEqual(store(d).map((l) => l.split('\t')[1]), ['a'], 'the word standing of one segment kept the other rationale too');
  });

  test('a message that names only one rationale approves only that one (an unnamed open rationale is never approved by silence or by the kind word)', () => {
    const d = proj(RUN_LINT); writeFileSync(path.join(d, 'DESIGN.md'), DESIGN); requestAll(d);
    say(d, 'approve rationale numbered-steps');
    accepted(A(d, ['approve', 'LC', 'rationale:numbered-steps', 'rationale:hairline-newspaper', 'rationale:mono-labels']), 'one named');
    const st = Object.fromEntries(accepted(A(d, ['design-rationales', 'LC']), 'list').out.split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, 2)));
    assert.deepEqual(st, { 'hairline-newspaper': 'unapproved', 'mono-labels': 'unapproved', 'numbered-steps': 'approved' });
  });
});

describe('the QA visual lint reads the task\'s own files', () => {
  const VISUAL_UI = '\n## UI\n\none status badge\nvisual_writes: DB_PATH=:memory:';
  const BAIT = '<style>.eyebrow{font-family:ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}\n.box{border:1px solid #ccc;padding:12px}\n.panel{border:1px solid #ddd;padding:12px}\n.tile{border:1px solid #ddd;padding:12px}</style>\n';

  /** A COMPLEX run whose base already holds a committed page with lint findings; the task adds a clean page. @param {string} d */
  function withCommittedBait(d) {
    wr(d, 'web/old.html', BAIT);
    setBase(d, commitHead(d, 'an old page with findings'));
  }
  /** @param {string} d */
  function toVisualRecord(d) {
    frozen(d); implement(d, 'web/index.html', '<main></main>');
    accepted(A(d, ['secret-scan', 'LC']), 'secret-scan');
    for (const g of ['REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_TESTS', 'SECURITY', 'QA']) gpass(d, g);
    wr(d, `${RUNDIR}/reviews/visual-proof/report.json`, '{"schema":"visual-proof/1","result":"PASS"}\n');
    return resultFor(d, 'QA', 'PASS', [], { focus: 'visual' });
  }

  test('a finding in an untouched committed page is not a finding of this change; the same finding in a file the task changed still blocks', () => {
    const d = rrun('COMPLEX', 'web/index.html', VISUAL_UI);
    withCommittedBait(d);
    toVisualRecord(d);
    wr(d, 'web/old.html', `${BAIT}<!-- touched by this task -->\n`);
    refused(AS(d, 'qa', ['record', 'LC', '--file', resultFor(d, 'QA', 'PASS', [], { focus: 'visual' })]), 'a page the task changed', 'blocking finding');
    wr(d, 'web/old.html', BAIT);   // put back: the page is again as committed, untouched by the task
    accepted(AS(d, 'qa', ['record', 'LC', '--file', resultFor(d, 'QA', 'PASS', [], { focus: 'visual' })]), 'a visual PASS refused for a finding of a page the task did not touch');
  });
});

describe('the batch summary shows what stands', () => {
  test('a batch summary lists the standing approvals in force and does not offer a carried rationale again; without any it has no such section', () => {
    const F = fakes(); const dir = bnew();
    mktask(dir, 'T-1', 'COMPLEX'); binstall(dir, { remote: false });
    writeFileSync(`${dir}/DESIGN.md`, DESIGN);
    assert.equal(AB(F, dir, ['batch-plan', 'all']).status, 0);
    assert.doesNotMatch(summaryOf(dir), /## Standing approvals in force/);
    assert.match(summaryOf(dir), /- accept R mono-labels: file names are the product here/, 'an unapproved rationale is offered');
    // the user approved the rationale and a waiver once (the rows are what approve and waive wrote)
    const fp = createHash('sha256').update('mono-labels: file names are the product here', 'latin1').digest('hex');
    mkdirSync(`${dir}/.agents/local/standing`, { recursive: true });
    const m1 = say(dir, 'approve rationale mono-labels standing').id;
    const m2 = say(dir, 'approve qa-1 standing').id;
    writeFileSync(`${dir}/${STORE}`, `rationale\tmono-labels\tDESIGN.md\t${fp}\t${m1}\t2026-11-26T10:00:00Z\tuser\tLC 001-rationale-mono-labels.yaml\tmono-labels\nwaiver\thairline-newspaper\tweb/old.html\t${'b'.repeat(64)}\t${m2}\t2026-11-26T11:00:00Z\tuser\tLC 002-waive-QA-1.yaml\tqa-1\nrationale\tnumbered-steps\tDESIGN.md\t${'d'.repeat(64)}\t${m2}\t2026-11-26T12:00:00Z\tuser\tLC 003-x.yaml\tnumbered-steps\n`);
    assert.equal(AB(F, dir, ['batch-plan', '--replace', 'all']).status, 0);
    const sum = summaryOf(dir);
    assert.match(sum, /## Standing approvals in force \(A361\)\n\n[^\n]*\n\n- standing rationale mono-labels on DESIGN\.md .*approved by you in message .* on 2026-11-26T10:00:00Z, from LC 001-rationale-mono-labels\.yaml\n- standing waiver hairline-newspaper on web\/old\.html /);
    assert.doesNotMatch(sum, /standing rationale numbered-steps/, 'a row whose message does not name it was listed');
    assert.doesNotMatch(sum, /- accept R mono-labels/, 'a carried rationale is offered again');
  });
});
