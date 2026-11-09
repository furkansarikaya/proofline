// @ts-check
// Node form of the enforcement-test.sh scenarios subagent_guard and verdicts (176-C1, A239): the real hook fed with hostile subagent inputs.
// Every denied/allowed case of the shell scenarios is kept, with the same text and the same reason fragment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { allowed, H, Hr, post } from './lib.mjs';
import { A, AS, V, chomp, expectMsg, gitR, hookTmpdir, ls, matches, sleep, tmp, tmpdirOwn, denied, fixture, preBash, preEdit, subStart, subStop } from './enforcement-a-lib.mjs';

test('subagent_guard: subagent roles are held to what they own; windows, markers, stop and post events', () => {
  const d = fixture();
  const E = (/** @type {string} */ t, /** @type {string} */ f, ty = undefined, id = undefined) => preEdit(d, t, f, ty, id);
  const B = (/** @type {string} */ c, ty = undefined, id = undefined) => preBash(d, c, ty, id);
  denied("subagent spoofs another role's AGENT_ROLE", B('AGENT_ROLE=reviewer sh .agents/scripts/agent.sh fingerprint LC', 'proofline-explorer'), 'does not match');
  allowed('subagent read-only agent.sh without a role', B('sh .agents/scripts/agent.sh fingerprint LC', 'proofline-explorer'));
  denied('subagent state command without its role', B('sh .agents/scripts/agent.sh freeze LC', 'proofline-explorer'), 'read-only agent.sh');
  denied('subagent runs agent.sh record', B('AGENT_ROLE=reviewer sh .agents/scripts/agent.sh record LC', 'proofline:proofline-reviewer'), 'SubagentStop hook');
  denied('subagent approves', B('AGENT_ROLE=reviewer sh .agents/scripts/agent.sh approve LC commit', 'proofline-reviewer'), 'no model runs');
  denied('subagent waives', B('AGENT_ROLE=reviewer sh .agents/scripts/agent.sh waive LC REVIEW_RULES-1 --reason x', 'proofline-reviewer'));
  denied('subagent answers', B('printf nil | sh .agents/scripts/agent.sh answer LC 1', 'proofline-explorer'));
  denied('non-proofline subagent edits product code', E('Edit', 'impl.txt', 'general-purpose', 'g1'));
  denied('non-proofline subagent state command', B('sh .agents/scripts/agent.sh handoff LC IMPLEMENTED', 'Explore', 'g2'));
  denied('read-only role writes product code', E('Write', 'impl.txt', 'proofline-explorer'), 'outside the paths role explorer owns');
  denied('read-only role writes a gate record', E('Write', '.agents/runs/LC/gates/009-VERIFY.yaml', 'proofline-verifier'));
  allowed('read-only role may write a run path (the hook allows it; submit refuses a self-named explorer report, A113)', E('Write', '.agents/runs/LC/reports/001-explorer.md', 'proofline-explorer'));
  // owned paths (.agents/owns.conf) and hyphenated agent names
  mkdirSync(path.join(d, '.agents'), { recursive: true });
  writeFileSync(path.join(d, '.agents/owns.conf'), 'reviewer reviews/proof-review/ reviews/test-trust/\nsecurity_reviewer security/\ndesigner design/ /docs/design/DESIGN.md\nimplementer PRODUCT_SCOPE\n');
  allowed('reviewer writes its report (owns.conf)', E('Write', '.agents/runs/LC/reviews/proof-review/rules/REPORT.md', 'proofline-reviewer'));
  allowed('reviewer writes its report after cd into the run (relative path)', B('cd .agents/runs/LC && printf x > reviews/proof-review/rules/REPORT.md', 'proofline-reviewer'));
  denied('reviewer cannot write product code after cd (relative path)', B('cd src && printf x > app.js', 'proofline-reviewer'));
  denied('reviewer writes product code', E('Write', 'src/app.js', 'proofline-reviewer'), 'outside the paths role reviewer owns');
  denied("reviewer writes another role's artifact", E('Write', '.agents/runs/LC/security/REPORT.md', 'proofline-reviewer'));
  allowed('security-reviewer (hyphenated, plugin prefix) writes security/', E('Write', '.agents/runs/LC/security/REPORT.md', 'proofline:proofline-security-reviewer'));
  denied('designer writes docs/design/DESIGN.md without a window (project-relative token)', E('Write', 'docs/design/DESIGN.md', 'proofline-designer'), 'no designer window');
  denied('designer writes product code', E('Write', 'src/app.js', 'proofline-designer'));
  denied('implementer edits without an open window', E('Edit', 'impl.txt', 'proofline-implementer', 'a7'), 'no implementer window');
  let out = subStart(d, 'proofline:proofline-implementer', 'a7');
  assert.ok(existsSync(path.join(d, '.agents/local/windows/a7')) && readFileSync(path.join(d, '.agents/local/windows/a7')).length > 0 && out.includes('AGENT_ROLE=implementer'), 'SubagentStart did not open the implementer window');
  assert.ok(existsSync(path.join(d, '.agents/local/submissions/a7.started')), 'SubagentStart did not register the subagent id (A127)');
  H(d, 'subagent-start', JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 's1', cwd: d, transcript_path: '/x/s1.jsonl', agent_type: 'proofline:proofline-explorer', agent_id: 'e9' }));
  assert.equal(readFileSync(path.join(d, '.agents/local/submissions/e9.started'), 'utf8').split('\n')[0], '/x/s1/subagents/agent-e9.jsonl', "SubagentStart did not record the subagent's session log path for its token metrics");
  // A200: a busy lock cannot hold a hook until the runtime stops it: every agent.sh the hook starts gives up after PROOFLINE_HOOK_LOCK_WAIT
  const holder = spawn('sleep', ['40'], { stdio: 'ignore' });
  mkdirSync(path.join(d, '.agents/local/locks/shared.lock'), { recursive: true });
  writeFileSync(path.join(d, '.agents/local/locks/shared.lock/pid'), `${holder.pid}\n`);
  const t0 = Date.now();
  Hr(d, 'subagent-start', JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 's1', cwd: d, agent_type: 'proofline:proofline-implementer', agent_id: 'b8' }), { env: { PROOFLINE_HOOK_LOCK_WAIT: '2' } });
  const waited = Math.round((Date.now() - t0) / 1000);
  holder.kill(); rmSync(path.join(d, '.agents/local/locks/shared.lock'), { recursive: true, force: true });
  assert.ok(waited < 20, `a hook waited ${waited}s for a busy lock (PROOFLINE_HOOK_LOCK_WAIT=2): it would be stopped at the runtime's 30 s limit (A200)`);
  rmSync(path.join(d, '.agents/local/windows/b8'), { force: true }); rmSync(path.join(d, '.agents/local/submissions/b8.started'), { force: true });
  assert.match(readFileSync(path.join(d, '.agents/local/submissions/e9.started'), 'utf8').split('\n')[1] ?? '', /^[0-9]+$/, 'SubagentStart did not stamp the start time on line 2 of the marker (A200)');
  // A132: each explorer is told its own token-derived scratch report path
  const out1 = subStart(d, 'proofline:proofline-explorer', 'e1'); const out2 = subStart(d, 'proofline:proofline-explorer', 'e2');
  assert.ok(out1.includes('scratch/e1-report.md') && out2.includes('scratch/e2-report.md') && !out2.includes('scratch/e1-report.md'), 'SubagentStart did not name a per-token explorer scratch report');
  allowed('implementer edits an in-scope file inside its window', E('Edit', 'impl.txt', 'proofline:proofline-implementer', 'a7'));
  denied('implementer edits an out-of-scope file', E('Write', 'src/app.js', 'proofline-implementer', 'a7'), 'outside the paths role implementer owns');
  denied('implementer shell write out of scope', B('echo x > src/app.js', 'proofline-implementer', 'a7'));
  rmSync(path.join(d, '.agents/owns.conf'));
  denied('without owns.conf a reviewer is limited to the run dir', E('Write', 'src/app.js', 'proofline-reviewer'));
  allowed('without owns.conf a reviewer writes in the run dir', E('Write', '.agents/runs/LC/reviews/proof-review/x.md', 'proofline-reviewer'));
  denied('without owns.conf the implementer stays in PLAN scope', E('Write', 'src/app.js', 'proofline-implementer', 'a7'));
  allowed('implementer records evidence as itself', B('AGENT_ROLE=implementer sh .agents/scripts/agent.sh worker-evidence LC RED fail', 'proofline-implementer', 'a7'));
  denied('implementer writes worker evidence files directly', E('Write', '.agents/runs/LC/worker-evidence/RED-9.yaml', 'proofline-implementer', 'a7'));
  denied('implementer writes a ci-fix record directly (A169)', E('Write', '.agents/runs/LC/ci-fix/001.yaml', 'proofline-implementer', 'a7'));
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: lookup returns the stored value\n'); V(d, 'wev RED fail');
  // no submission: the first stop is sent back (window stays open), the second is accepted and reported
  out = subStop(d, 'proofline:proofline-implementer', 'a7');
  assert.ok(out.includes('"decision":"block"') && out.includes('submit'), `a stop without a submission was not sent back: ${out}`);
  assert.ok(!existsSync(path.join(d, '.agents/runs/LC/worker-evidence/WINDOW-1.yaml')), 'the window closed while the specialist was sent back');
  assert.ok(existsSync(path.join(d, '.agents/local/submissions/a7.started')), 'the marker was removed while the specialist was sent back');
  subStop(d, 'proofline:proofline-implementer', 'a7', true);
  assert.ok(!existsSync(path.join(d, '.agents/local/submissions/a7.started')), 'SubagentStop left the subagent marker behind (A127)');
  assert.ok(existsSync(path.join(d, '.agents/runs/LC/worker-evidence/WINDOW-1.yaml')) && !existsSync(path.join(d, '.agents/local/windows/a7')), 'SubagentStop did not close the window');
  out = post(d);
  assert.ok(out.includes('additionalContext') && out.includes('without a recorded result'), `PostToolUse did not relay the outcome: ${out}`);
  assert.equal(post(d), '', 'outcome relayed twice');
  // A headless specialist started by dispatch.sh carries AGENT_ROLE in the hook environment.
  allowed('dispatched implementer (env AGENT_ROLE) edits product code', preEdit(d, 'Edit', 'impl.txt', undefined, undefined, { env: { AGENT_ROLE: 'implementer' } }));
  denied('dispatched reviewer (env AGENT_ROLE) edits product code', preEdit(d, 'Edit', 'impl.txt', undefined, undefined, { env: { AGENT_ROLE: 'reviewer' } }));
  // Failover codex -> claude: agent_type AND AGENT_ROLE, no SubagentStart, so no windows/<id> file; dispatch.sh holds the window.
  allowed('failover claude -p implementer (agent_type + env AGENT_ROLE, no SubagentStart) edits an in-scope file', preEdit(d, 'Edit', 'impl.txt', 'proofline-implementer', 'f1', { env: { AGENT_ROLE: 'implementer' } }));
  denied('the same agent_type without env AGENT_ROLE and without a window stays denied', E('Edit', 'impl.txt', 'proofline-implementer', 'f1'), 'no implementer window');
  Hr(d, 'prompt', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's9', cwd: d, prompt: 'approve commit' }), { env: { AGENT_ROLE: 'reviewer' } });
  assert.ok(!existsSync(path.join(d, '.agents/local/prompts/s9.json')), "a dispatched specialist's prompt was captured");
});

test('verdicts: lead-authored verdicts, role-bound submits, worktree and scratch rules for specialists (A97, A111, A120, A132), SubagentStop', () => {
  const d = fixture();
  const base = tmp('vd');
  const B = (/** @type {string} */ c, ty = undefined, id = undefined) => preBash(d, c, ty, id);
  V(d, "worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null");
  V(d, `f=$(result_for VERIFY PASS); cp "$f" "${base}/verify.md"`);
  expectMsg('lead records a PASS in a shell (AGENT_ROLE=lead)', 'ROLE verifier does not match AGENT_ROLE lead', A(d, ['record', 'LC', '--file', `${base}/verify.md`]));
  writeFileSync(`${base}/lead.md`, readFileSync(`${base}/verify.md`, 'utf8').replace(/^ROLE: verifier/m, 'ROLE: lead'));
  expectMsg('lead records a PASS under its own role', 'the lead can never record a PASS verdict', A(d, ['record', 'LC', '--file', `${base}/lead.md`]));
  denied('an explorer submits as the verifier', B('AGENT_ROLE=verifier sh .agents/scripts/agent.sh submit LC --agent e1 --confidence high', 'proofline-explorer', 'e1'), "does not match the caller's role");
  denied('a submit without the agent token', B('AGENT_ROLE=verifier sh .agents/scripts/agent.sh submit LC --confidence high', 'proofline-verifier', 'v1'), '--agent v1');
  denied("a submit with another agent's token", B('AGENT_ROLE=verifier sh .agents/scripts/agent.sh submit LC --agent e1 --confidence high', 'proofline-verifier', 'v1'), '--agent v1');
  denied('a submit without the role prefix', B('sh .agents/scripts/agent.sh submit LC --agent v1 --confidence high', 'proofline-verifier', 'v1'), 'prefix AGENT_ROLE');
  denied('a specialist stashes the live tree', B('git stash -q -- src/service.js; git stash pop -q', 'proofline-reviewer', 'r1'), 'evidence worktree');
  denied('a specialist resets the live tree', B('git reset --hard HEAD', 'proofline-implementer', 'a7'), 'separate worktree');
  const T = hookTmpdir.replace(/\/$/, '');
  if (tmpdirOwn) {
    // the worktree must exist and be registered: a directory the hook cannot resolve is read as the project (A111, A143)
    assert.equal(gitR(d, ['worktree', 'add', '-q', `${T}/wt`, 'HEAD']).status, 0, 'fixture worktree');
    allowed('a specialist mutates inside its own worktree', B('git -C "$TMPDIR/wt" checkout -- src/service.js', 'proofline-reviewer', 'r1'));
    gitR(d, ['worktree', 'remove', '--force', `${T}/wt`]);
    denied('a specialist writes scratch under /tmp', B('git worktree add /tmp/t1-base-wt HEAD', 'proofline-reviewer', 'r1'), 'TMPDIR');
    allowed('a specialist writes under its own project path', B(`cat ${d}/src/service.js`, 'proofline-reviewer', 'r1'));
  }
  // A97 (C-18): a shell write outside the project, scratch folder and registered worktrees is refused, whatever the spelling
  for (const c of ['cat > /tmp/x', 'npm test > /tmp/x 2>&1; rm -f /tmp/x', 'echo x > $TMPDIR/foo', 'echo x >> "$TMPDIR/foo"',
    'printf x | tee /tmp/t1-findings.txt', 'cp impl.txt /tmp/copy.txt', `echo x > ${base}/outside.txt`,
    "cat > /var/folders/zz/T/qa-t1.mjs <<'EOF'\nx\nEOF"]) {
    denied(`A97 a specialist runs: ${c}`, B(c, 'proofline-qa', 'q1'), '.agents/runs/<ID>/scratch/');
  }
  for (const c of ['echo x > ~/x', 'echo x > $HOME/x', 'mv impl.txt ~/impl.txt']) denied(`A97 a specialist runs: ${c}`, B(c, 'proofline-qa', 'q1'));
  denied('A97 mktemp without a template', B('mktemp', 'proofline-qa', 'q1'), 'mktemp would create');
  for (const c of ['npm test > /dev/null 2>&1', 'ls /nope 2>&1 >/dev/null', 'echo x > /dev/stderr', 'echo x >&2', 'printf x > .agents/runs/LC/scratch/f.txt',
    'echo "a > ~/x" ; echo \'b >> $HOME/y\'', "cat <<'EOF' > .agents/runs/LC/scratch/h.txt\necho hello > ~/x\nEOF", 'mktemp -d .agents/runs/LC/scratch/q.XXXXXX']) {
    allowed(`A97 a specialist may run: ${c}`, B(c, 'proofline-qa', 'q1'));
  }
  const wt = (/** @type {string} */ p, /** @type {string} */ what) => assert.equal(gitR(d, ['worktree', 'add', '-q', p, 'HEAD']).status, 0, what);
  wt(`${base}/wt-a97`, 'A97 fixture worktree');
  allowed('A97 a write inside a registered worktree', B(`echo x > ${base}/wt-a97/notes.txt`, 'proofline-qa', 'q1'));
  wt(`${base}/wt a120 sp`, 'A120 spaced fixture worktree');
  allowed('A120 a Write tool inside a registered worktree with a space in its path', preEdit(d, 'Write', `${base}/wt a120 sp/notes.txt`, 'proofline-qa', 'q1'));
  allowed('DB-7 (A120) a scratch .db written by the Write tool inside a registered worktree', preEdit(d, 'Write', `${base}/wt-a97/own2.db`, 'proofline-qa', 'q1'));
  gitR(d, ['worktree', 'remove', '--force', `${base}/wt a120 sp`]);
  const home = { env: { HOME: `${base}/home` } };
  for (const c of ['settings.json', 'hooks/x', 'rules/x', 'CLAUDE.md', 'agents/x', 'skills/x', 'commands/x']) {
    denied(`A120 a Write to ~/.claude/${c}`, preEdit(d, 'Write', `${base}/home/.claude/${c}`, 'proofline-qa', 'q1', home), 'is outside the project');
  }
  for (const c of ['projects/p/memory/m.md', 'plans/p.md', 'projects/p/tool-results/r.txt']) {
    allowed(`A120 a Write to ~/.claude/${c}`, preEdit(d, 'Write', `${base}/home/.claude/${c}`, 'proofline-qa', 'q1', home));
  }
  allowed('A120 a Write tool inside a registered worktree', preEdit(d, 'Write', `${base}/wt-a97/notes.txt`, 'proofline-qa', 'q1'));
  denied('A120 a Write tool beside a registered worktree (prefix only)', preEdit(d, 'Write', `${base}/wt-a97-x/notes.txt`, 'proofline-qa', 'q1'), 'outside the project');
  gitR(d, ['worktree', 'remove', '--force', `${base}/wt-a97`]);
  // A111: every git stash subcommand is refused in the project tree, whatever the spelling; evidence worktrees are free.
  // Variables stay UNEXPANDED: the hook sees the text a model sends, not the shell's result.
  const a111 = `${base}/wt-a111`; const a111l = `${base}/lnk-a111`;
  wt(a111, 'A111 fixture worktree');
  symlinkSync(d, a111l);
  /** @param {string} label @param {string[]} cmds @param {string} sub */
  const allDenied = (label, cmds, sub) => { for (const c of cmds) denied(`${label}${c}`, B(c, 'proofline-qa', 'q1'), sub); };
  /** @param {string} label @param {string[]} cmds */
  const allAllowed = (label, cmds) => { for (const c of cmds) allowed(`${label}${c}`, B(c, 'proofline-qa', 'q1')); };
  allDenied('A111 a specialist runs: ', ['git stash list >/dev/null', 'git stash', 'git stash show -p', 'git stash push -u', 'git stash pop', 'git stash apply',
    'git stash drop', 'git stash clear', 'git stash create', 'git stash store abc', 'git stash branch b',
    `git -C ${d} stash list`, 'git --no-pager stash list', 'git -c core.pager=cat stash show', `cd ${d} && git stash list`,
    'GIT_PAGER=cat git stash list', "sh -c 'git stash list'", 'git stash list | head -1', 'cd . && git stash list',
    'git -C $PWD stash list', 'git -C "$PWD" stash list', 'cd $(pwd) && git stash', 'P=$PWD; git -C "$P" stash',
    'git -C "$(git rev-parse --show-toplevel)" stash list', 'cd $(git rev-parse --show-toplevel) && git stash',
    'git -C "$TMPDIR/../$(basename $PWD)" stash list', `sh -c 'cd $0 && git stash' ${d}`,
    `(cd ${a111}); git stash list`, `cd ${a111} | cat; git stash list`, `cd ${a111} & git stash list`,
    `cd ${a111} && cd - && git stash`, `cd ${a111} && cd $OLDPWD && git stash`, `pushd ${a111} >/dev/null; popd >/dev/null; git stash`,
    'git --attr-source HEAD stash list', 'git --bogus-opt HEAD stash list', 'git -C src/.. stash list', 'git -C .. stash list',
    `git -C ${a111l} stash list`, `cd ${a111l} && git stash list`, `env -C ${d} git stash list`, 'command git stash list',
    '/usr/bin/git stash list', 'env git stash list', 'git -c a=b --no-pager -C . stash show'], 'evidence worktree');
  // review R2: unquoted substitutions, wrappers, missing or later-made paths, a variable in subcommand position
  allDenied('A111 R2 a specialist runs: ', ['git -C $(git rev-parse --show-toplevel) stash list', 'git -C $(pwd) stash list', 'git -C `pwd` stash list',
    'git --work-tree=$(pwd) stash', 'git -c user.name=$(whoami) stash', 'git $(echo stash) list', 'git -C $(realpath .) stash show',
    `git -C $(dirname ${a111}/x) stash`, 'find . -exec git stash list \;', 'watch -n1 git stash list', 'parallel git stash ::: list',
    'ssh localhost git stash list', 'setsid git stash', 'chronic git stash', 'unbuffer git stash list',
    'script -c "git stash list" /dev/null', "su -c 'git stash list'", 'function s { git stash list; }; s',
    `cd ${a111}/missing; git stash list`, `ln -s ${d} ${a111}/lk && git -C ${a111}/lk stash list`, `ln -s ${d} ${a111}/lk2; cd ${a111}/lk2; git stash`,
    `GIT_WORK_TREE=${d} git -C ${a111} stash`, `git --work-tree=${d} -C ${a111} stash`, `git -C ${a111} -c core.worktree=${d} stash`,
    `git --work-tree ${d} -C ${a111} stash list`,
    // the shell list had these two as ONE word (a missing space): both are kept, separately and joined
    'S=stash; git $S list', 'git ${S:-stash} list', 'S=stash; git $S listgit ${S:-stash} list', 'git stash${IFS}list', `git worktree add ${a111}/new HEAD && git -C ${a111}/new stash`], 'evidence worktree');
  // A132: a variable that is the VALUE of a git option is not a subcommand, but the net still counts a variable, quote or option where the subcommand goes
  allDenied('A132 bypass stays denied: ', ['git -C $W "$S" list', 'git -C -C $S', 'git -c -c $S', 'git -C $W -C $S', 'git -C $W $S list', 'git -C $W "$(echo stash)" list',
    "git -C $W '$S' list", 'git -C $W `echo stash` list'], 'evidence worktree');
  allAllowed('A111 R2 no false positive: ', ['git log stash', 'git diff main..stash', 'git diff stash@{0}', 'git rev-parse stash-fix', 'git branch stash',
    'git commit -m "stash"', 'git grep stash', 'git config stash.showPatch true', 'grep stash src/impl.txt', 'echo git stash list',
    'printf "git stash\\n"', 'cat notes | grep -n "git stash"']);
  // A132: `git -C $VAR <subcommand>` is not a stash; the three commands a COMPLEX run had denied (git worktree add ... then git -C $W status/apply)
  allAllowed('A132 no false positive: ', ['W=$TMPDIR/t1 && mkdir -p $W && git worktree add --detach $W/wt HEAD 2>&1 | tail -1 && git -C $W/wt status --short && (cd $W/wt && node --test 2>&1 | grep -E "^ok")',
    'R=.agents/runs/T-1; WT=$TMPDIR/rv/wt; git worktree add --detach $WT HEAD >/dev/null 2>&1; git -C $WT status --short; echo $WT',
    'W=$TMPDIR/rv/wt\ngit worktree add --detach $W HEAD >/dev/null 2>&1\ngit diff HEAD --binary | git -C $W diff --stat\ngit worktree remove --force $W',
    'git -C $(pwd) status', 'git -C `pwd` log -1', 'git -c user.name=$X log -1']);
  // A132: the three real command texts of the COMPLEX run (verbatim): none is a stash any more; still refused by a path rule (A97)
  for (const n of [1, 2, 3]) {
    const text = readFileSync(path.join(import.meta.dirname, 'a132-commands', `${n}.txt`), 'utf8').split('\n').map((l) => l.replace(/\/private\/tmp\/[^ ;]*\/project/, d)).join('\n');
    const o = B(text, 'proofline-qa', 'q1');
    assert.ok(!o.includes('git stash'), `A132 replay ${n}: still denied as a stash: ${o}`);
    assert.match(o, /"permissionDecision":"deny".*(cannot be resolved|mktemp would create|changes the project working tree)/s, `A132 replay ${n}: unexpected outcome: ${o}`);
  }
  wt(`${base}/wt a111 sp`, 'A111 spaced fixture worktree');
  allowed('A111 R2 a registered worktree path with spaces', B(`git -C '${base}/wt a111 sp' stash list`, 'proofline-qa', 'q1'));
  gitR(d, ['worktree', 'remove', '--force', `${base}/wt a111 sp`]);
  allAllowed('A111 a specialist may run: ', [`git -C ${a111} stash list`, `git -C ${a111} stash`, `cd ${a111} && git stash list`, `cd ${a111}; git stash`,
    `cd ${a111} && git stash list | head -1`, `git -C ${a111} --no-pager stash show`, `cd ${a111} && git -C . stash list`,
    'grep stash src/impl.txt', 'echo git stash list', 'git log --oneline', 'git commit --dry-run -m stash']);
  if (tmpdirOwn) {
    assert.equal(gitR(d, ['worktree', 'add', '-q', `${T}/wt-a111t`, 'HEAD']).status, 0, 'A111 TMPDIR fixture worktree');
    allowed('A111 a specialist stashes in $TMPDIR/<registered worktree>', B('git -C "$TMPDIR/wt-a111t" stash list', 'proofline-qa', 'q1'));
    allowed('A111 a specialist cd to $TMPDIR/<registered worktree>', B('cd $TMPDIR/wt-a111t && git stash list', 'proofline-qa', 'q1'));
    gitR(d, ['worktree', 'remove', '--force', `${T}/wt-a111t`]);
  }
  rmSync(a111l, { force: true });
  gitR(d, ['worktree', 'remove', '--force', a111]);
  allowed('a verifier submits as itself', B('AGENT_ROLE=verifier sh .agents/scripts/agent.sh submit LC --agent v1 --confidence high', 'proofline-verifier', 'v1'));
  denied('the lead submits', B('AGENT_ROLE=verifier sh .agents/scripts/agent.sh submit LC --confidence high'), "does not match the caller's role");
  // an explorer that never submitted is sent back once, then reported as without a result
  let out = subStop(d, 'proofline-explorer', 'e1'); assert.ok(out.includes('"decision":"block"'), `no-submission stop not sent back: ${out}`);
  subStop(d, 'proofline-explorer', 'e1', true);
  assert.ok(post(d).includes('without a recorded result'), 'missing result not reported to the lead');
  // a rejected submission is returned immediately to the specialist, and the hook sends it back with the reason
  rmSync(path.join(d, '.agents/runs/LC/VERIFY.md'), { recursive: true, force: true });
  expectMsg('a verifier submitted without a report', 'not found in the run', AS(d, 'verifier', ['submit', 'LC', '--agent', 'v0', '--confidence', 'high']));
  out = subStop(d, 'proofline-verifier', 'v0'); matches(out, /last rejection: .*not found in the run/, 'rejection reason not given back to the specialist');
  V(d, 'result_for VERIFY PASS >/dev/null');
  assert.equal(AS(d, 'verifier', ['submit', 'LC', '--agent', 'v1', '--confidence', 'high']).status, 0, 'verifier submit failed');
  subStop(d, 'proofline:proofline-verifier', 'v1'); subStop(d, 'proofline:proofline-verifier', 'v1');
  assert.equal(chomp(A(d, ['pipeline', 'LC']).out).match(/^gate\.VERIFY=(.*)$/m)?.[1], 'pass', 'submit did not record the verifier PASS');
  assert.equal(ls(path.join(d, '.agents/runs/LC/results'), /-verifier\.result\.md$/).length, 1, 'duplicate hook layers recorded twice');
  assert.ok(post(d).includes('submitted: verifier PASS gate=VERIFY'), 'recorded outcome not relayed');
  appendFileSync(path.join(d, 'impl.txt'), '\n');
  subStop(d, 'proofline-reviewer', 'v2');
  gitR(d, ['checkout', '-q', 'impl.txt']);
  void readdirSync; void sleep;
});
