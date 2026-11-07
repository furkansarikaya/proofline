// @ts-check
// `agent.sh lessons derive|write|validate|count|bound|text|promote` (A229, the former scripts/lessons.sh and lessons-test.sh; tests/legacy-port-map.tsv names the
// rows): candidates need a source that resolves to a gate record of the run, the repeat count is over different runs, a promotion needs the user's approval and
// reaches AGENTS.md once. Absolute expectations; the real control plane in a throwaway project.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { git, newProject } from './helper-lib.mjs';
import { A, accepted, refused, say } from './legacy-lib.mjs';

const PAGE = 'docs/wiki/lessons/observations.md';
const sha = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
/** A failing gate record as the protocol lays it out. @param {string} d @param {string} run @param {string} name @param {string} gate @param {string} focus @param {string[]} rows */
function gateRec(d, run, name, gate, focus, rows) {
  mkdirSync(`${d}/.agents/runs/${run}/gates`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/${run}/gates/${name}.yaml`, `task_id: "${run}"\ngate: "${gate}"\nresult: "fail"\nfocus: "${focus}"\n${rows.map((r) => `finding: ${r}\n`).join('')}`);
}
/** The project of the shell suite: run LC with a REVIEW_SMALL record of two blocking findings and one info. */
function withGate() {
  const d = newProject();
  gateRec(d, 'LC', '001-REVIEW_SMALL', 'REVIEW_SMALL', 'rules+tests', ['REVIEW_SMALL-1|blocking|impl.txt:1|empty key returns nil|traced', 'REVIEW_SMALL-2|info|impl.txt:2|style note|none', 'REVIEW_SMALL-3|blocking|impl.txt:3|second finding|traced']);
  const g1 = sha(`${d}/.agents/runs/LC/gates/001-REVIEW_SMALL.yaml`);
  return { d, g1, src: `gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1@${g1}` };
}
const L = (/** @type {string} */ d, /** @type {string[]} */ args, /** @type {string} */ role = 'lead') => A(d, ['lessons', ...args], { role });

test('derive lists the non-info findings with their source and kind; no run is a failure', () => {
  const { d, g1, src } = withGate();
  const r = accepted(L(d, ['derive', 'LC']), 'derive');
  assert.equal(r.out, [
    `${src} | kind=REVIEW_SMALL:rules+tests | empty key returns nil`,
    `gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-3@${g1} | kind=REVIEW_SMALL:rules+tests | second finding`,
    '',
  ].join('\n'));
  refused(L(d, ['derive', 'NOPE']), 'no run', 'lessons: no run NOPE');
  assert.equal(L(d, ['derive']).status, 2);
});

test('a candidate without a valid source is refused by write, whatever is wrong with the source; a refused candidate creates no page', () => {
  const { d, g1 } = withGate();
  const w = (/** @type {string} */ s) => L(d, ['write', 'LC', s, 'always check the empty key']);
  refused(w(''), 'no source', 'lessons: candidate refused: no valid source');
  refused(w('REVIEW_SMALL-1'), 'not a gate source', "source 'REVIEW_SMALL-1' is not gate:<RUN>/<NNN-GATE>[#<FINDING-ID>]@<sha256 of the record>");
  refused(w(`gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-9@${g1}`), 'a finding the record lacks', 'gate record 001-REVIEW_SMALL has no non-info finding REVIEW_SMALL-9');
  refused(w(`gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-2@${g1}`), 'an info finding', 'has no non-info finding REVIEW_SMALL-2');
  refused(w(`gate:LC/009-QA@${g1}`), 'a record the run lacks', 'run LC has no gate record 009-QA');
  refused(w('gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1'), 'no hash', 'is not gate:');
  refused(w(`gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1@${'0'.repeat(64)}`), 'wrong hash', "the gate record's hash differs");
  refused(w(`gate:INVENTED/001-REVIEW_SMALL#REVIEW_SMALL-1@${g1}`), 'an invented run', 'lessons: candidate refused: source is run INVENTED (not LC) or has no gate record now');
  refused(w(`gate:LC/001 REVIEW@${g1}`), 'a space in the source', 'is not gate:');
  refused(L(d, ['write', 'LC', `gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1@${g1}`, '  ']), 'empty text', 'lessons: a candidate needs text');
  refused(L(d, ['write', 'LC', `gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-1@${g1}`, 'two\nlines']), 'two lines', 'lessons: a candidate is one line');
  assert.ok(!existsSync(`${d}/${PAGE}`), 'a refused candidate created the page');
});

test('a sourced candidate is written once to the page, validates, and a hand-added row without source or with an invented run is caught', () => {
  const { d, g1, src } = withGate();
  const w = accepted(L(d, ['write', 'LC', src, 'Check the empty key before the lookup.']), 'write');
  const cand = (/^candidate written: (lc-[0-9a-f]{8}) \(REVIEW_SMALL:rules\+tests\)$/m.exec(w.out) ?? [])[1];
  assert.ok(cand);
  assert.equal(readFileSync(`${d}/${PAGE}`, 'utf8'), `---\ntitle: lesson-observations\nstatus: current\nsource: .agents/KNOWLEDGE.md\n---\n\n# Lesson observations\n\nCandidates derived from run evidence. A candidate is a rule only after the user approved it (\`agent.sh lessons promote\`).\n\n- ${cand} | kind=REVIEW_SMALL:rules+tests | run=LC | source=${src} | status=candidate | Check the empty key before the lookup.\n`);
  assert.equal(L(d, ['validate']).out, 'lessons valid\n');
  refused(L(d, ['write', 'LC', src, 'Check the empty key before the lookup.']), 'twice', `lessons: candidate ${cand} is already written`);
  refused(L(d, ['write', 'LC', src, 'x'], 'reviewer'), 'a reviewer', 'command denied for reviewer');
  const page = `${d}/${PAGE}`;
  const base = readFileSync(page, 'utf8');
  writeFileSync(page, `${base}- lc-deadbeef | kind=REVIEW_SMALL:rules+tests | run=LC | source= | status=candidate | invented lesson\n`);
  refused(L(d, ['validate']), 'sourceless row', 'lc-deadbeef: no source');
  writeFileSync(page, `${base}- lc-cafe0000 | kind=QA:- | run=LC | source=gate:LC/004-QA#QA-1@${g1} | status=candidate | no such record\n`);
  refused(L(d, ['validate']), 'a row whose record does not exist', 'lc-cafe0000: invalid source');
  writeFileSync(page, `${base}- lc-1ee70000 | kind=REVIEW_SMALL:rules+tests | run=GHOST | source=gate:GHOST/001-REVIEW_SMALL#REVIEW_SMALL-1@${g1} | status=candidate | invented run\n`);
  refused(L(d, ['validate']), 'an invented run', 'lc-1ee70000: run GHOST is gone and its record hash is neither seen by write nor in the committed page');
  writeFileSync(page, `${base}- not a row\n`);
  refused(L(d, ['validate']), 'a foreign list item', 'page holds a list item that is not a candidate row');
  writeFileSync(page, `${base}- lc-aaaaaaaa | kind=OTHER:- | run=LC | source=${src} | status=candidate | wrong kind\n`);
  refused(L(d, ['validate']), 'a wrong kind', 'lc-aaaaaaaa: kind=OTHER:- does not match its gate record (REVIEW_SMALL:rules+tests)');
  writeFileSync(page, base);
  assert.equal(L(d, ['validate']).status, 0);
});

test('the repeat count is per distinct run; the first repeat proposes promotion; a cleaned run is still counted from its page row', () => {
  const { d, src } = withGate();
  accepted(L(d, ['write', 'LC', src, 'Check the empty key before the lookup.']), 'write');
  gateRec(d, 'LC2', '001-REVIEW_SMALL', 'REVIEW_SMALL', 'rules+tests', ['REVIEW_SMALL-1|blocking|other.txt:3|same kind again|traced']);
  gateRec(d, 'LC2', '002-QA', 'QA', '', ['QA-1|blocking|-|different kind|traced']);
  assert.equal(L(d, ['count', 'REVIEW_SMALL:rules+tests']).out, 'REVIEW_SMALL:rules+tests | runs=2 | repeats=1 | propose=yes\n');
  assert.equal(L(d, ['count', 'QA:-']).out, 'QA:- | runs=1 | repeats=0 | propose=no\n');
  gateRec(d, 'LC2', '003-REVIEW_SMALL', 'REVIEW_SMALL', 'rules+tests', ['REVIEW_SMALL-1|blocking|other.txt:4|again, same run|traced']);
  assert.equal(L(d, ['count', 'REVIEW_SMALL:rules+tests']).out, 'REVIEW_SMALL:rules+tests | runs=2 | repeats=1 | propose=yes\n', 'a second record of one run counts once');
  assert.equal(L(d, []).status, 2);
  rmSync(`${d}/.agents/runs/LC2`, { recursive: true });
  assert.equal(L(d, ['count', 'REVIEW_SMALL:rules+tests']).out, 'REVIEW_SMALL:rules+tests | runs=1 | repeats=0 | propose=no\n');
  gateRec(d, 'LC3', '001-REVIEW_SMALL', 'REVIEW_SMALL', 'rules+tests', ['REVIEW_SMALL-1|blocking|a.txt:1|third run|traced']);
  gateRec(d, 'LC4', '001-REVIEW_SMALL', 'REVIEW_SMALL', 'rules+tests', ['REVIEW_SMALL-1|blocking|a.txt:1|fourth run|traced']);
  const all = L(d, ['count']).out;
  assert.equal(all, 'REVIEW_SMALL:rules+tests | runs=3 | repeats=2 | propose=yes\n');
  // a cleaned run's row stays valid through the hash write recorded
  gateRec(d, 'LC5', '001-QA', 'QA', '', ['QA-1|blocking|-|a cleaned run|traced']);
  accepted(L(d, ['write', 'LC5', `gate:LC5/001-QA#QA-1@${sha(`${d}/.agents/runs/LC5/gates/001-QA.yaml`)}`, 'Cleaned-run lesson.']), 'write LC5');
  rmSync(`${d}/.agents/runs/LC5`, { recursive: true });
  assert.equal(L(d, ['validate']).status, 0);
  assert.match(L(d, ['count', 'QA:-']).out, /^QA:- \| runs=1 \| repeats=0 \| propose=no$/m);
});

test('a row of a cleaned run is also trusted when the committed page holds it', () => {
  const { d, src } = withGate();
  accepted(L(d, ['write', 'LC', src, 'Check the empty key before the lookup.']), 'write');
  git(d, ['add', '-A']); git(d, ['commit', '-q', '-m', 'page']);
  rmSync(`${d}/.agents/local/lessons-sources`, { force: true });
  rmSync(`${d}/.agents/runs/LC`, { recursive: true });
  assert.equal(L(d, ['validate']).status, 0, 'the committed page vouches for the row');
  git(d, ['rm', '-q', '--cached', PAGE]); git(d, ['commit', '-q', '-m', 'unpage']);
  refused(L(d, ['validate']), 'the page is not committed any more', 'is gone and its record hash is neither seen by write nor in the committed page');
});

/** The user's approval of a rule, in the user's own words. @param {string} d @param {string} cand */
function approveRule(d, cand) {
  accepted(A(d, ['request-approval', 'LC', `rule:${cand}`]), 'request');
  say(d, `I approve the rule ${cand}`);
  accepted(A(d, ['approve', 'LC', `rule:${cand}`]), 'approve');
}

test('promotion needs the user\'s approval: the request shows the rule text, an unasked or unanswered or other-kind approval promotes nothing, AGENTS.md is untouched until the approved promotion, which happens once', () => {
  const { d, src } = withGate();
  const cand = (/lc-[0-9a-f]{8}/.exec(accepted(L(d, ['write', 'LC', src, 'Check the empty key before the lookup.']), 'write').out) ?? [])[0] ?? '';
  writeFileSync(`${d}/AGENTS.md`, '# Project\n\n## Boot\n\ntext\n');
  refused(L(d, ['promote', 'LC', cand]), 'no approval', `lessons: promotion refused: no unconsumed user approval 'rule:${cand}' bound to this candidate`);
  assert.ok(!readFileSync(`${d}/AGENTS.md`, 'utf8').includes('empty key'));
  refused(L(d, ['promote', 'LC', 'lc-00000000']), 'unknown candidate', 'lessons: no candidate lc-00000000');
  refused(A(d, ['request-approval', 'LC', 'rule:lc-00000000']), 'request for an unknown candidate', 'no candidate lc-00000000');
  const rq = accepted(A(d, ['request-approval', 'LC', `rule:${cand}`]), 'request');
  assert.ok(rq.out.includes('Check the empty key before the lookup.'), rq.out);
  refused(L(d, ['promote', 'LC', cand]), 'asked but unanswered', 'promotion refused');
  say(d, 'approve the plan');
  refused(A(d, ['approve', 'LC', `rule:${cand}`]), 'another kind\'s approval word');
  say(d, `I approve the rule ${cand}`);
  accepted(A(d, ['approve', 'LC', `rule:${cand}`]), 'the approval sentence');
  refused(L(d, ['promote', 'LC', cand], 'reviewer'), 'a reviewer promoted', 'command denied for reviewer');
  assert.ok(!readFileSync(`${d}/AGENTS.md`, 'utf8').includes('empty key'));
  const r = accepted(L(d, ['promote', 'LC', cand]), 'promote');
  assert.equal(r.out, `promoted: ${cand} -> AGENTS.md\n`);
  assert.equal(readFileSync(`${d}/AGENTS.md`, 'utf8'), `# Project\n\n## Boot\n\ntext\n\n## Project rules\n\n- Check the empty key before the lookup. (lesson ${cand})\n`);
  assert.match(readFileSync(`${d}/${PAGE}`, 'utf8'), /\| status=promoted \| Check the empty key/);
  refused(L(d, ['promote', 'LC', cand]), 'single use', `lessons: candidate ${cand} is already promoted`);
  assert.equal(L(d, ['validate']).status, 0);
  // the next promotion goes first into an existing section, after its blank line
  const cand2 = (/lc-[0-9a-f]{8}/.exec(accepted(L(d, ['write', 'LC', `gate:LC/001-REVIEW_SMALL#REVIEW_SMALL-3@${sha(`${d}/.agents/runs/LC/gates/001-REVIEW_SMALL.yaml`)}`, 'Escape \\n as \\\\n in paths like C:\\tmp.']), 'write 2').out) ?? [])[0] ?? '';
  assert.equal(L(d, ['bound', 'LC', cand2]).out.length, 65, 'the approval binding is a full sha256');
  const before = readFileSync(`${d}/AGENTS.md`, 'utf8');
  refused(L(d, ['promote', 'LC', cand2]), 'no approval for the second', 'promotion refused');
  assert.equal(readFileSync(`${d}/AGENTS.md`, 'utf8'), before, 'AGENTS.md changed although the approval was missing');
  assert.deepEqual(readdirSync(d).filter((n) => n.startsWith('AGENTS.md.lessons.')), [], 'a temp file was left behind');
  approveRule(d, cand2);
  accepted(L(d, ['promote', 'LC', cand2]), 'promote 2');
  assert.equal(readFileSync(`${d}/AGENTS.md`, 'utf8'), `# Project\n\n## Boot\n\ntext\n\n## Project rules\n\n- Escape \\n as \\\\n in paths like C:\\tmp. (lesson ${cand2})\n- Check the empty key before the lookup. (lesson ${cand})\n`);
});

test('bound is the sha256 of the candidate row and text its text; both fail for an unknown candidate', () => {
  const { d, src } = withGate();
  const cand = (/lc-[0-9a-f]{8}/.exec(accepted(L(d, ['write', 'LC', src, 'Check the empty key.']), 'write').out) ?? [])[0] ?? '';
  const row = readFileSync(`${d}/${PAGE}`, 'utf8').split('\n').find((l) => l.startsWith(`- ${cand} `)) ?? '';
  assert.equal(L(d, ['bound', 'LC', cand]).out, `${createHash('sha256').update(row).digest('hex')}\n`);
  assert.equal(L(d, ['text', cand]).out, 'Check the empty key.\n');
  refused(L(d, ['bound', 'LC', 'lc-00000000']), 'unknown', 'lessons: no candidate lc-00000000');
  refused(L(d, ['text', 'lc-00000000']), 'unknown', 'lessons: no candidate lc-00000000');
});

test('an unknown operation prints the usage and exits 2', () => {
  const { d } = withGate();
  const r = L(d, ['frob']);
  assert.equal(r.status, 2);
  assert.equal(r.err, 'usage: agent.sh lessons <derive ID|write ID SOURCE TEXT|validate|count [KIND]|bound ID CAND|text CAND|promote ID CAND>\n');
});
