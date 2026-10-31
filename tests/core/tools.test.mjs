// @ts-check
// Package TOOLS (stage 2): the leaf commands give the same stdout, stderr and exit status through the Node core and through the shell code
// (PROOFLINE_ENGINE=sh), on many argument shapes, task files, plans and configs. The shell is the specification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOLS_HANDLERS } from '../../control-plane/agents/scripts/core/commands/tools.mjs';
import { caseMatch, expandWords } from '../../control-plane/agents/scripts/core/shellglob.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fx = mkdtempSync(path.join(tmpdir(), 'pl-tools-'));
mkdirSync(path.join(fx, '.agents'), { recursive: true });
cpSync(path.join(repo, 'control-plane', 'agents'), path.join(fx, '.agents'), { recursive: true });
const git = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', fx, '-c', 'gc.auto=0', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
spawnSync('git', ['init', '-q', fx]);
git('config', 'gc.auto', '0');
const agent = path.join(fx, '.agents', 'scripts', 'agent.sh');
const cfgPath = path.join(fx, '.agents', 'config.yaml');
const realConfig = readFileSync(cfgPath, 'latin1');
after(() => rmSync(fx, { recursive: true, force: true }));

const w = (/** @type {string} */ rel, /** @type {string} */ text) => { mkdirSync(path.dirname(path.join(fx, rel)), { recursive: true }); writeFileSync(path.join(fx, rel), text, 'latin1'); };

/** @param {string[]} args @param {Record<string, string>} [env] @param {string} [engine] @param {string} [input] */
function exec(args, env = {}, engine = 'node', input = '') {
  const e = { ...process.env };
  delete e.PROOFLINE_ENGINE; delete e.PROOFLINE_ENGINE_SH; delete e.AGENT_ROLE;
  Object.assign(e, env);
  if (engine === 'sh') e.PROOFLINE_ENGINE = 'sh';
  const r = spawnSync(process.env.PL_TEST_SH ?? 'sh', [agent, ...args], { cwd: fx, env: e, encoding: 'latin1', input });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

/** @param {string[]} args @param {Record<string, string>} [env] @param {string} [input] */
function same(args, env = {}, input = '') {
  const a = exec(args, env, 'node', input);
  const b = exec(args, env, 'sh', input);
  assert.deepEqual(a, b, `agent.sh ${args.join(' ')} ${JSON.stringify(env)}`);
}

const TASK = [
  '---', 'type: Bug   # a comment', 'id: T-1', '---', '# Task: T-1 x', '', '## Allowed scope', '', '<!-- hidden `a/b.js` -->', '- `src/a.js`, `src/b/`', '- docs/readme.md src/**/*.ts',
  '- none', '- a sentence is not a path', '1. `lib/x.py`;', '* `./rel/p.txt`', '', 'prose line', '', '## Forbidden scope (do not touch)', '- `secret/`', '- `/abs/y.env`', '', '### Existing pattern references', '- `src/ok.js`', '- (bad)',
  '<!-- start', '- `in/comment.js`', 'end -->', '- `after.js`', '', '## Notes', '- `not/this.js`', '',
].join('\n');

function setup() {
  w('.agents/config.yaml', realConfig);
  w('t/task.md', TASK);
  w('t/bug.md', '---\ntype: defect\n---\n# x\n');
  w('t/dup.md', '---\ntype: bug\ntype: docs\n---\n');
  w('t/inv.md', '---\nTYPE : "Refactor"\n---\n');
  w('t/inv2.md', '---\ntype: nonsense\n---\n');
  w('t/empty.md', '---\ntype:\n---\n');
  w('t/crlf.md', '---\r\ntype: content\r\n---\r\n');
  w('t/none.md', '# no front matter\ntype: bug\n');
  w('t/late.md', '# Title\n---\ntype: chore\n---\n');
  w('t/stop.md', '---\n## head\ntype: bug\n---\n');
  w('.agents/runs/T-1/QA_REPORT.md', '# r\n\n## Human checks\n- first  \n* second\n-nope\n- third\n- fourth\n\n## Other\n- x\n## Human checks   \n- again\n');
  w('.agents/runs/T-1/PLAN.md', '---\nscope:\n  - path: src/a.test.js\n    criteria: [AC-1]\n    kind: test\n  - path: README.md\n    criteria: [AC-2]\n    kind: doc\n    tdd_exemption: because the text only changes\n  - path: src/b.js\n    criteria: [AC-3]\n    kind: test\n  - path: package.json\n    criteria: [AC-4]\n  - path: docs/x.md\n    criteria: [AC-5]\n    kind: "code"\n---\n# Plan\n');
  w('.agents/runs/T-2/QA_REPORT.md', '');
  w('.agents/runs/T-1/questions/001.md', 'from: lead\nasked_at: 1\n---\n1. Q one?\n   options: a | b\n');
  w('.agents/runs/T-1/questions/002.md', 'from: "qa"\n---\n1. second\n');
  w('.agents/runs/T-1/questions/002.answer.md', 'x\n');
  w('.agents/runs/T-1/questions/003.md', 'no front matter at all\nfrom: late\n');
  w('.agents/runs/T-2/questions/001.md', 'from: a\n---\nbody\n');
  mkdirSync(path.join(fx, '.agents/runs/T-3'), { recursive: true });
  w('src/a.js', 'x\n'); w('src/a.test.js', 'x\n'); w('src/b.js', 'x\n');
  w('src/code.py', '# shortcut: reads all rows, stream it when >1M rows\nx = 1  # shortcut: no retry; add retry when flaky\n');
  w('src/web.js', '// shortcut: sync I/O\n/* shortcut: a | pipe, later */\n  ; shortcut: semi,  trailing  \t\n');
  w('docs/note.md', '# shortcut: ignored markdown\n');
  w('b.sql', '-- shortcut: raw sql;\tmove to ORM */\n');
  w('c.html', '<!-- shortcut: inline, extract -->\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  w('untracked.go', '// shortcut: untracked file, still found\n');
}
setup();

const ROLES = ['', 'lead', 'reviewer', 'implementer', 'independent_qa', 'full_lifecycle', 'bogus'];

describe('package TOOLS: parity with the shell code', () => {
  test('task-type on many task files and shapes', () => {
    for (const f of ['t/task.md', 't/bug.md', 't/dup.md', 't/inv.md', 't/inv2.md', 't/empty.md', 't/crlf.md', 't/none.md', 't/late.md', 't/stop.md', 'nope.md', '.', 't']) same(['task-type', f]);
    same(['task-type']); same(['task-type', 'a', 'b']); same(['task-type', '']);
  });

  test('task-scope-entries on headings, prefixes, comments and shapes', () => {
    for (const h of ['Allowed scope', 'allowed scope', 'Forbidden scope', 'Existing pattern references', 'Notes', 'Nope', 'allowed', 'Forbidden', 'Allowed scope ', ' Allowed scope'])
      same(['task-scope-entries', 't/task.md', h]);
    same(['task-scope-entries', 'nope.md', 'Allowed scope']); same(['task-scope-entries', 't/task.md']); same(['task-scope-entries']); same(['task-scope-entries', 't/task.md', '']);
    same(['task-scope-entries', 't/task.md', 'a\\tb']);
  });

  test('scope-covers on entries, globs, dots and bracket shapes', () => {
    const entries = ['src/', './src//a.js', 'src/*.js', 'src/**/*.ts', '*.md', 'a/../src', '', 'a?c', '[!a]c', 'x[', 'a[]b]', '[z-a]', '[^a]', '[[:alpha:]]', 'a\\*'];
    const paths = ['src/a.js', 'src/x/y.ts', 'a.md', 'abc', 'bc', 'x[', 'a]b', '', 'a\\*'];
    for (const e of entries) for (const p of paths) same(['scope-covers', e, p]);
    same(['scope-covers']); same(['scope-covers', 'a']); same(['scope-covers', 'a', 'b', 'c']); same(['scope-covers', 'a\nb', 'a']);
  });

  test('human-checks and questions', () => {
    for (const id of ['T-1', 'T-2', 'T-3', 'T-9', '', 'bad id', '../x']) same(['human-checks', id]);
    same(['human-checks']);
    for (const id of ['T-1', 'T-2', 'T-3', 'T-9', 'bad/id', '']) same(['questions', id]);
    same(['questions']);
  });

  test('repro-normalize on timestamps, durations and the build line', () => {
    const input = [
      '2026-10-31T12:34:56.789Z started', 'at 2026-10-31 12:34:56+02:00 end', 'x 12:34:56 y', '12:34:56.5', '9:05:07', 'a1:22:33', 'took 3 seconds', 'Done in 3s', 'Built in 3s.', 'in 1.5 min!',
      'Duration: 20ms', 'elapsed = 5m', 'time 7 s', 'time 7 sec.', 'tests (12ms) passed', '(1.5 s)', '(3m)', '12:00:00 [build] Complete! in 3s', '[build] Complete! (5s)', '[build] Complete!',
      '12:00:00 [build] Complete!', '3 passed', '4 failed in 2.31s', 'main in main()', 'login 10:20:30:40', '', 'plain', 'tool took 2secs ago', 'in 5 minutes',
    ].join('\n') + '\n';
    same(['repro-normalize'], {}, input);
    same(['repro-normalize'], {}, '');
    same(['repro-normalize', 'extra'], {}, input);
    same(['repro-normalize'], {}, 'no newline at the end');
  });

  test('test-path, path-kind, scope-kinds on paths and plans', () => {
    const paths = ['src/a.test.js', 'src/a.js', 'tests/x.py', 'test/y.go', 'a/__tests__/z.ts', 'package.json', 'tests/package.json', 'tests/config.js', 'tests/data.json', 'tests/Dockerfile', 'foo_test.go', 'test_x.py', 'README.md', 'docs/a.txt', 'docs/x.md',
      'x.md', 'a.sh', 'tests/x.sh', 'tests/.envrc', 'tests/lock.js', 'a.sql', 'src/Foo.test.tsx', 'tests/helper', '', 'src/FooTest.java', 'tests/yarn.lock', 'a/b.c', 'bin/tool', 'docs/', 'lib.rs', 'x.vue'];
    same(['test-path', ...paths]); same(['path-kind', ...paths]);
    for (const p of paths) { same(['test-path', p]); same(['path-kind', p]); }
    same(['test-path']); same(['path-kind']); same(['test-path', 'a\nb']); same(['path-kind', 'a\nb']);
    same(['scope-kinds', 'T-1']); same(['scope-kinds', 'T-2']); same(['scope-kinds', 'T-9']); same(['scope-kinds']);
  });

  test('path classification under config shapes (executable code, doc paths, risky paths, knowledge scope)', () => {
    const base = realConfig;
    const shapes = [
      '', 'review:\n  executable_code: "*.py"\n', 'verification:\n  doc_paths: "notes/ *.txt README.md"\n', 'review:\n  risky_paths: "src/**"\n', 'knowledge_scope_root: "src/ extra.md"\n',
      'design_docs:\n  adr_dir: docs/decisions\n  architecture: docs/ARCH.md\n', 'verification:\n  doc_paths: "*.md *.nope"\n',
    ];
    for (const extra of shapes) {
      w('.agents/config.yaml', `${base}\n${extra}`);
      same(['path-kind', 'src/a.js', 'src/code.py', 'README.md', 'notes/x', 'a.txt', 'extra.md', 'docs/decisions/0001.md', 'docs/ARCH.md', 'docs/x.md', 'x.nope', 'src/a.test.js', '']);
      same(['test-path', 'src/a.test.js', 'tests/x.py', 'a/b.spec.ts']);
      same(['scope-kinds', 'T-1']);
    }
    w('.agents/config.yaml', realConfig);
    rmSync(path.join(fx, '.agents', 'config.yaml'));
    same(['path-kind', 'a.js', 'README.md', 'docs/x']); same(['test-path', 'a.test.js']); same(['scope-kinds', 'T-1']);
    w('.agents/config.yaml', realConfig);
  });

  test('design-surface in single and surface modes, with overlap and warnings', () => {
    const modes = [
      '', 'design_docs:\n  design: docs/design/OTHER.md\n',
      'design_docs:\n  design:\n    shared: docs/design/BASE.md\n    surfaces:\n      site:\n        doc: docs/design/SITE.md\n        paths: apps/web/** ./apps/landing/\n        mode: persuade\n      app:\n        doc: docs/design/APP.md\n        paths: apps/app/**/x.ts apps/app/*\n        mode: operate\n      lone:\n        paths: lone/*\n',
      'design_docs:\n  design:\n    surfaces:\n      a:\n        paths: x/**\n      b:\n        paths: x/y/**\n',
    ];
    w('docs/design/SITE.md', '# s\n'); w('docs/design/BASE.md', '# b\n');
    for (const m of modes) {
      w('.agents/config.yaml', `${realConfig}\n${m}`);
      for (const p of ['apps/web/a.css', './apps/web/a.css', 'apps/landing/i.html', 'apps/app/x.ts', 'apps/app/sub/x.ts', 'apps/app/q', 'lone/z', 'x/y/z', 'x/a', 'other', 'weird[', 'a b'])
        same(['design-surface', p]);
      same(['design-surface']); same(['design-surface', '']);
    }
    w('.agents/config.yaml', realConfig);
  });

  test('debt list and page, with the role rules', () => {
    for (const role of ROLES) { same(['debt'], role === '' ? {} : { AGENT_ROLE: role }); same(['debt', 'list'], role === '' ? {} : { AGENT_ROLE: role }); same(['debt', 'bogus'], role === '' ? {} : { AGENT_ROLE: role }); }
    same(['debt', '']); same(['debt', 'list', 'extra']);
    for (const role of ['reviewer', 'implementer', 'bogus', 'full_lifecycle']) same(['debt', 'page'], { AGENT_ROLE: role });
  });

  test('debt page writes the same page and messages', () => {
    const page = path.join(fx, 'docs', 'wiki', 'concepts', 'shortcut-debt.md');
    const run = (/** @type {string} */ engine) => { rmSync(path.join(fx, 'docs', 'wiki'), { recursive: true, force: true }); return exec(['debt', 'page'], {}, engine); };
    // no wiki folder
    assert.deepEqual(run('node'), run('sh'));
    mkdirSync(path.join(fx, 'docs', 'wiki'), { recursive: true });
    const a = exec(['debt', 'page'], {}, 'node'); const pa = readFileSync(page);
    rmSync(page);
    const b = exec(['debt', 'page'], {}, 'sh'); const pb = readFileSync(page);
    assert.deepEqual(a, b); assert.ok(pa.equals(pb));
    assert.match(a.out, /wrote docs\/wiki\/concepts\/shortcut-debt.md \(\d+ shortcut\(s\)\)/);
    // an existing page is replaced
    same(['debt', 'page']);
    rmSync(path.join(fx, 'docs', 'wiki'), { recursive: true, force: true });
  });

  test('debt outside a git repository', () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'pl-tools-nogit-'));
    mkdirSync(path.join(plain, '.agents'), { recursive: true });
    cpSync(path.join(repo, 'control-plane', 'agents'), path.join(plain, '.agents'), { recursive: true });
    const run = (/** @type {string} */ engine) => {
      const e = { ...process.env }; delete e.PROOFLINE_ENGINE; if (engine === 'sh') e.PROOFLINE_ENGINE = 'sh';
      e.GIT_CEILING_DIRECTORIES = path.dirname(plain);
      const r = spawnSync('sh', [path.join(plain, '.agents', 'scripts', 'agent.sh'), 'debt'], { cwd: plain, env: e, encoding: 'latin1' });
      return { out: r.stdout, err: r.stderr, code: r.status };
    };
    try { assert.deepEqual(run('node'), run('sh')); assert.equal(run('node').code, 1); } finally { rmSync(plain, { recursive: true, force: true }); }
  });
});

describe('package TOOLS: the string rules', () => {
  test('caseMatch equals the shell case on a pattern x string corpus', () => {
    const pats = ['*', '?', 'a*', '*a', 'a*b', '*.js', 'src/*', '[ab]', '[!ab]', '[a-c]x', 'a[', ']', 'a[]b]', '[]]', '[!]]', '*a*b*', '**', 'a?c', '', '.*', '*/x'];
    const strs = ['', 'a', 'b', 'ab', 'abc', 'x.js', 'src/', 'src/a/b', 'cx', 'a[', 'a]', 'a]b', ']', '.a', 'a/x', 'ab/x', '/x'];
    const lines = [];
    for (const p of pats) for (const s of strs) lines.push(`${p}\t${s}`);
    const script = 'while IFS="	" read -r p s; do case "$s" in $p) echo 1 ;; *) echo 0 ;; esac; done';
    const r = spawnSync('sh', ['-c', script], { input: `${lines.join('\n')}\n`, encoding: 'latin1' });
    const got = r.stdout.trim().split('\n');
    let bridged = 0;
    lines.forEach((l, i) => {
      const [p, s] = l.split('\t');
      let m;
      try { m = caseMatch(p, s ?? ''); } catch (e) { assert.equal(/** @type {Error} */ (e).name, 'BridgeToShell'); bridged++; return; }
      assert.equal(m ? '1' : '0', got[i], `${JSON.stringify(p)} ${JSON.stringify(s)}`);
    });
    assert.ok(bridged > 0 && bridged < lines.length / 4, `bridged ${bridged}`);
  });

  test('expandWords expands only in the working folder and leaves unmatched words', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'pl-tools-glob-'));
    try {
      writeFileSync(path.join(d, 'b.md'), ''); writeFileSync(path.join(d, 'a.md'), ''); writeFileSync(path.join(d, '.h.md'), '');
      assert.deepEqual(expandWords('docs/ *.md *.zz x', d), ['docs/', 'a.md', 'b.md', '*.zz', 'x']);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('the handlers of this package are exactly the commands the preamble delegates', () => {
    const agentSh = readFileSync(path.join(repo, 'control-plane/agents/scripts/agent.sh'), 'latin1');
    const m = /case "\$\{1:-\}" in\n((?:  [^\n]*\\\n)*  [^\n]*\))\n/.exec(agentSh);
    assert.ok(m);
    const listed = m[1].replace(/\\\n/g, '').trim().replace(/\)$/, '').split('|').map((s) => s.trim());
    for (const c of Object.keys(TOOLS_HANDLERS)) assert.ok(listed.includes(c), c);
  });
});
