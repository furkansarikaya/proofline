// @ts-check
// B9 (A294 "not covered"): the export templates of the task trackers (github, jira, linear) and of the markdown task carry the optional `## Test exceptions` section, and an import reads it
// back as the very lines it holds. Round trip: a task that declares exceptions -> export (the template filled) -> import (the product engine and the skill's) -> the same lines; a task
// without the section stays without it. Hermetic: no network, no waits, no clock.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { importEngine } from '../../control-plane/agents/scripts/core/adapters/lib.mjs';
import { exceptionLineIssues, exceptionLines } from '../../control-plane/agents/scripts/core/testreview.mjs';
import { checkExport, importIssue, parseTemplate } from '../../skills/task-author/scripts/validate-task.mjs';
import { tempDir } from '../lib/tempdir.mjs';
import { repo } from './helpers.mjs';

const TARGETS = ['github', 'jira', 'linear', 'markdown'];
const SKILL = (/** @type {string} */ t) => readFileSync(path.join(repo, 'skills/task-author/assets/templates', `${t}.md`), 'utf8');
const PRODUCT = (/** @type {string} */ t) => readFileSync(path.join(repo, 'control-plane/agents/templates/tasks', `${t}.md`), 'utf8');
const L1 = '- wait: `tests/e2e/login.test.mjs` -- the test drives a real browser and waits for its load event, no clock or event of ours stands in for it';
const L2 = '- measure: `tests/perf/import.test.mjs` -- times a real import against the external service, a fake would measure nothing';
const FIELDS = {
  title: 'Rate limit login', goal: 'Limit failed logins per account.', context: 'Login lives in the auth module.', acceptance_criteria: '- AC-1: The sixth failed login within 10 minutes returns HTTP 429.',
  out_of_scope: 'Password reset flow.', constraints: 'None stated by the user.', risks: 'Shared IPs behind a proxy.', suggested_class: 'STANDARD', verification_commands: '- npm test', labels: 'auth', components: 'login',
};
/** The export an agent makes: every placeholder of the template replaced by the field (the optional section by its lines, or removed whole when the task declares none). @param {string} tpl @param {string[]} exc @param {boolean} keepComment */
function exportWith(tpl, exc, keepComment) {
  const out = [];
  const rows = tpl.replace(/^---\n[\s\S]*?\n---\n?/, '').split('\n');
  for (let i = 0; i < rows.length; i++) {
    const m = /\{\{(\w+)\}\}/.exec(rows[i]);
    if (rows[i] === '## Test exceptions') {
      if (exc.length === 0) { while (i + 1 < rows.length && !rows[i + 1].startsWith('## ')) i++; continue; }
      out.push(rows[i]); if (keepComment) out.push(rows[i + 1]); i++; continue;
    }
    if (rows[i].startsWith('<!--')) { out.push(rows[i]); continue; }
    if (m) { out.push(m[1] === 'test_exceptions' ? exc.join('\n') : /** @type {Record<string, string>} */ (FIELDS)[m[1]] ?? ''); continue; }
    out.push(rows[i]);
  }
  return out.join('\n');
}
/** A fake adapter whose project holds the product templates. */
function adapter() {
  const root = tempDir('tpl-');
  mkdirSync(`${root}/.agents`, { recursive: true });
  cpSync(path.join(repo, 'control-plane/agents/templates'), `${root}/.agents/templates`, { recursive: true });
  return /** @type {any} */ ({ root, cwd: root, env: {}, name: 'x adapter', tasksDir: '.agents/tasks', out: () => {}, err: () => {} });
}
const sectionLines = (/** @type {string} */ task) => exceptionLines(task);

test('tt-1: every export template carries the optional section, commented as such, and the product copy equals the skill copy', () => {
  for (const t of TARGETS) {
    const s = SKILL(t);
    assert.match(s, /^## Test exceptions\n<!-- Optional \(A294\): delete this whole section when the task declares none\./m, t);
    assert.match(s, /\n\{\{test_exceptions\}\}\n/, t);
    assert.deepEqual(parseTemplate(s).unknown, [], t);
    assert.ok(parseTemplate(s).sections.some((x) => x.field === 'test_exceptions'), t);
    if (t !== 'markdown') assert.equal(PRODUCT(t), s, `${t}: the project copy is the skill copy`);
    assert.ok(PRODUCT(t).includes('{{test_exceptions}}'), t);
  }
});

test('tt-2: round trip through the product import: a task that declares exceptions comes back with the same lines (comment kept or deleted); none declared stays none', () => {
  for (const t of TARGETS) {
    for (const keep of [false, true]) {
      const issue = exportWith(PRODUCT(t), [L1, L2], keep);
      const task = importEngine(adapter(), t, issue, 'T-9', '', 'github:acme/x#9');
      assert.deepEqual(sectionLines(task), [L1, L2], `${t} keep=${keep}`);
      assert.deepEqual(exceptionLineIssues(task), [], `${t}: every imported line is one the batch can list`);
      assert.ok(!task.includes('<!--'), `${t}: the template comment is not carried into the task`);
      assert.ok(!/^### Test exceptions/m.test(task), `${t}: not demoted to a Context subsection`);
    }
    const none = importEngine(adapter(), t, exportWith(PRODUCT(t), [], false), 'T-9', '', 's');
    assert.ok(!none.includes('Test exceptions'), `${t}: no section out when none was declared`);
    // the comment alone (section left in, nothing declared) is empty, not a malformed line
    const bare = importEngine(adapter(), t, exportWith(PRODUCT(t), [], false).replace('## Suggested class', '## Test exceptions\n<!-- Optional (A294): nothing -->\n\n## Suggested class'), 'T-9', '', 's');
    assert.ok(!bare.includes('Test exceptions'), t);
  }
});

test('tt-3: a CRLF issue gives the same bytes; text that is not a line is kept (the batch and the validator then refuse it), never made valid', () => {
  const crlf = exportWith(PRODUCT('github'), [L1, L2], true).replace(/\n/g, '\r\n');
  assert.deepEqual(sectionLines(importEngine(adapter(), 'github', crlf, 'T-9', '', 's')), [L1, L2]);
  const prose = importEngine(adapter(), 'github', exportWith(PRODUCT('github'), [L1, 'we think a wait is needed here'], false), 'T-9', '', 's');
  assert.equal(exceptionLineIssues(prose).length, 1, 'the prose line is reported, not repaired');
});

test('tt-4: the skill import reads the section back too, check-export does not demand it, and requires it only when the template says so', () => {
  for (const t of TARGETS) {
    const tpl = parseTemplate(SKILL(t));
    const full = exportWith(SKILL(t), [L1, L2], true);
    const r = importIssue(full, tpl);
    assert.equal(r.fields.test_exceptions, `${L1}\n${L2}`, t);
    assert.deepEqual(checkExport(full, tpl), [], t);
    const bare = exportWith(SKILL(t), [], false);
    assert.deepEqual(checkExport(bare, tpl), [], `${t}: an export without the optional section is complete`);
    assert.equal(importIssue(bare, tpl).fields.test_exceptions, undefined, t);
    assert.deepEqual(importIssue(bare, tpl).missing, [], t);
    // a template that lists it under required: asks for it
    const req = parseTemplate(SKILL(t).replace(/^required:(.*)$/m, 'required:$1 test_exceptions'));
    assert.deepEqual(importIssue(bare, req).missing, ['test_exceptions'], t);
    assert.deepEqual(checkExport(bare, req), ['section "Test exceptions" is missing or empty'], t);
  }
});
