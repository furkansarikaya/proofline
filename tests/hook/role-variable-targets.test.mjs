// @ts-check
// A273 (issue #264, AC-1 to AC-4 and AC-7): a shell write whose target starts with a variable, a substitution or a glob the hook cannot resolve is refused for the implementer and the
// designer exactly as for the lead (A257, "which cannot be resolved"). Before A273 the two roles skipped that branch and `echo x > $OLDPWD/x` reached outside the project.
// Table-driven: every form below is first required to be refused by the LEAD with the "cannot be resolved" verdict (so the table cannot drift from the lead's guard), then run against both roles.
// The hook only judges the command text (nothing is executed); the command is never run by this test.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTemplate, copyProject, runHook, rmSync, nodeHook, cleanEnv } from './harness.mjs';
import { tokenize, roleActions, rewriteAnsiC, MAX_DEPTH } from '../../adapters/claude/hooks/guards/rolewrites.mjs';
import { WRITE_PROGRAMS } from '../../adapters/claude/hooks/command-scan.mjs';

// The verdicts are asked in process (the same buildContext and PreToolUse handler the hook process runs; one test spawns the real hook to prove they agree): a hook process per question made the file take minutes.
const hookDir = dirname(nodeHook);
const { buildContext, finish } = await import(pathToFileURL(join(hookDir, 'lib/context.mjs')).href);
const { handle } = await import(pathToFileURL(join(hookDir, 'events/pretool.mjs')).href);

let template = '';
let base = '';
let dir = '';
before(() => { template = buildTemplate(); base = tempDir('hook-roletgt-'); dir = copyProject(template, base); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

// The role comes from the agent type plus the dispatched role variable (no window needed), TMPDIR pinned outside /tmp so the verdict does not depend on the host.
const ROLES = /** @type {Array<[string, Record<string, string>, Record<string, string>]>} */ ([
  ['implementer', { agent_type: 'proofline-implementer', agent_id: 'f1' }, { AGENT_ROLE: 'implementer' }],
  ['designer', { agent_type: 'proofline-designer', agent_id: 'f1' }, { AGENT_ROLE: 'designer' }],
]);
const LEAD = /** @type {[string, Record<string, string>, Record<string, string>]} */ (['lead', {}, {}]);

/** @param {string} command @param {Record<string, string>} who @param {Record<string, string>} env @returns {Promise<string | null>} the refusal text, or null when allowed */
async function pre(command, who, env) {
  const raw = Buffer.from(JSON.stringify({ cwd: dir, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }));
  const c = await buildContext('pretool', 'claude', raw, cleanEnv({ CLAUDE_PROJECT_DIR: dir, TMPDIR: '/var/proofline-roletgt-tmp', ...env }));
  assert.ok(c, 'no hook context');
  try {
    const out = await handle(c);
    if (typeof out !== 'string' || out === '') return null;
    return /** @type {string} */ (JSON.parse(out).hookSpecificOutput.permissionDecisionReason);
  } finally { finish(c); }
}

/** The real hook process, for the parity test. @param {string} command @param {Record<string, string>} who @param {Record<string, string>} env @returns {Promise<string | null>} */
async function preSpawn(command, who, env) {
  const r = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }, { env: { TMPDIR: '/var/proofline-roletgt-tmp', ...env } });
  return r.stdout === '' ? null : /** @type {string} */ (JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason);
}

// [name, command]. The first five are AC-1; the rest are the other spellings the lead refuses (redirect operators, file descriptors, quoting, brace and arithmetic forms, default-value forms,
// the programs that write through an operand, nested shells, globs).
const REFUSED = /** @type {Array<[string, string]>} */ ([
  ['AC-1 redirect to $OLDPWD', 'echo x > $OLDPWD/x'],
  ['AC-1 redirect to $(pwd)/..', 'echo x > $(pwd)/../x'],
  ['AC-1 tee ${HOME}', 'tee ${HOME}/x'],
  ['AC-1 cp to $VAR', 'cp a $VAR/x'],
  ['AC-1 quoted redirect target', 'echo x > "$OLDPWD/x"'],
  ['append >>', 'echo x >> $OLDPWD/x'],
  ['clobber >|', 'echo x >| $OLDPWD/x'],
  ['both streams &>', 'echo x &> $OLDPWD/x'],
  ['fd redirect 2>', 'echo x 2> $OLDPWD/x'],
  ['fd redirect 2> glued', 'echo x 2>$OLDPWD/x'],
  ['redirect glued', 'echo x >$OLDPWD/x'],
  ['fd duplicate then redirect', 'echo x 2>&1 > $VAR/x'],
  ['exec redirect', 'exec > $VAR/x'],
  ['braced ${OLDPWD}', 'echo x > ${OLDPWD}/x'],
  ['default-value ${OLDPWD:-/}', 'echo x > ${OLDPWD:-/}/x'],
  ['default-value ${X:-..}', 'echo x > ${X:-..}/x'],
  ['arithmetic $((1))', 'echo x > $((1))/x'],
  ['bare variable target', 'echo x > $VAR'],
  ['quoted bare variable', 'echo x > "$VAR"'],
  ['single-quoted variable text', "echo x > '$VAR/x'"],
  ['escaped dollar', 'echo x > \\$VAR/x'],
  ['variable inside an in-scope name', 'echo x > impl.txt/$VAR'],
  ['variable glued to an in-scope name', 'echo x > impl.txt$VAR'],
  ['variable assigned in the same command', 'X=/etc; echo x > $X/y'],
  ['tee -a', 'tee -a $VAR/x'],
  ['tee after --', 'tee -- $VAR/x'],
  ['pipe into tee', 'echo x | tee $OLDPWD/x'],
  ['cp -t', 'cp -t $VAR a'],
  ['cp into a variable directory', 'cp -r impl.txt $VAR'],
  ['install', 'install a $VAR/x'],
  ['ln -s', 'ln -s a $VAR/x'],
  ['dd of=', 'dd if=a of=$VAR/x'],
  ['dd of= quoted', 'dd of="$VAR/x"'],
  ['dd from a pipe', 'printf x | dd of=$VAR/x'],
  ['sed -i', 'sed -i s/a/b/ $VAR/x'],
  ['sed -i with a suffix', 'sed -i.bak s/a/b/ $VAR/x'],
  ['sed -i with an empty suffix', "sed -i '' s/a/b/ $VAR/x"],
  ['perl -pi', 'perl -pi -e s/a/b/ $VAR/x'],
  ['rm', 'rm $VAR/x'],
  ['touch', 'touch $VAR/x'],
  ['truncate', 'truncate -s0 $VAR/x'],
  ['here-string', 'cat <<< hi > $VAR/x'],
  ['here-document', 'cat <<EOF > $VAR/x\nhi\nEOF'],
  ['xargs cp', 'xargs -I{} cp {} $VAR/x'],
  ['tar -C', 'tar -C $VAR -xf a.tar'],
  ['unzip -d', 'unzip a -d $VAR'],
  ['curl -o', 'curl -o $VAR/x u'],
  ['wget -O', 'wget -O $VAR/x u'],
  ['sh -c', "sh -c 'echo x > $VAR/x'"],
  ['bash -c double quoted', 'bash -c "echo x > \\$VAR/x"'],
  ['a command with a redirect', 'node -e 1 > $VAR/x'],
  ['glob *', 'echo x > *.txt'],
  ['glob prefix', 'echo x > impl.*'],
  ['glob ?', 'echo x > i?pl.txt'],
  ['glob [..]', 'echo x > [i]mpl.txt'],
]);

for (const [name, command] of REFUSED) {
  test(`A273: ${name}: the lead, the implementer and the designer all get the "cannot be resolved" refusal`, async () => {
    const lead = await pre(command, LEAD[1], LEAD[2]);
    assert.ok(lead && /which cannot be resolved/.test(lead), `the lead no longer refuses this form as unresolvable (fix the table): ${lead}`);
    for (const [role, who, env] of ROLES) {
      const why = await pre(command, who, env);
      assert.ok(why, `${role}: allowed`);
      assert.match(why, /which cannot be resolved/, `${role}: ${why}`);
    }
  });
}

test('A273 AC-4: a literal in-scope target stays allowed (implementer impl.txt; both roles the run scratch folder)', async () => {
  const [, implWho, implEnv] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
  assert.equal(await pre('echo x > impl.txt', implWho, implEnv), null);
  assert.equal(await pre('echo x >> impl.txt', implWho, implEnv), null);
  for (const [role, who, env] of ROLES) {
    assert.equal(await pre('echo x > .agents/runs/LC/scratch/o.txt', who, env), null, `${role}: scratch write`);
  }
});

test('A273: a literal target outside the role paths is still refused by the path rule, not by the unresolved rule', async () => {
  for (const [role, who, env] of ROLES) {
    const why = await pre('echo x > src/app.js', who, env);
    assert.ok(why, `${role}: allowed`);
    assert.doesNotMatch(why, /cannot be resolved/, `${role}: ${why}`);
  }
});

// A273 addendum: (a) a cd the scanner cannot place makes every later relative target unresolvable; (b) mkdir and its kin create a path. Implementer and designer only: the lead's verdicts stay as they were.
const CD_REFUSED = /** @type {Array<[string, string]>} */ ([
  ['cd $VAR then a redirect', 'cd $VAR; echo x > impl.txt'],
  ['cd $(mktemp -d) then tee', 'cd "$(mktemp -d)" && tee f'],
  ['pushd $X then tee', 'pushd $X && tee f'],
  ['cd - then tee', 'cd - && tee f'],
  ['cd $OLDPWD then a redirect', 'cd $OLDPWD && echo x > impl.txt'],
  ['cd with no operand (home) then a redirect', 'cd && echo x > impl.txt'],
  ['cd backtick then tee', 'cd `pwd`; tee f'],
  ['cd -P -- $X then tee', 'cd -P -- $X; tee f'],
  ['cd in a subshell then tee', '(cd $X; tee f)'],
  ['cd then rm', 'cd $X; rm f'],
  ['cd then sed -i', 'cd $X; sed -i s/a/b/ f'],
  ['cd then cp', 'cd $X; cp impl.txt f'],
  ['cd on an earlier line', 'cd $X\necho x > impl.txt'],
  ['popd then tee', 'popd; tee f'],
  ['a literal cd after the unresolved one does not repair it', 'cd $X; cd src; echo x > a.txt'],
  ['cd $VAR then mkdir', 'cd $VAR; mkdir d'],
]);
const MKDIR_REFUSED = /** @type {Array<[string, string]>} */ ([
  ['mkdir $VAR/x', 'mkdir $VAR/x'],
  ['mkdir -p $VAR/x', 'mkdir -p $VAR/x'],
  ['mkdir quoted variable', 'mkdir "$V"'],
  ['mkdir -m mode then variable', 'mkdir -p -m 755 $V/x'],
  ['mkdir ${HOME}', 'mkdir -p ${HOME}/x'],
  ['mkdir glob', 'mkdir -p d*'],
  ['mkfifo', 'mkfifo $V/x'],
]);

for (const [name, command] of [...CD_REFUSED, ...MKDIR_REFUSED]) {
  test(`A273: ${name}: refused for both roles as unresolvable, the lead's text is not the new one`, async () => {
    for (const [role, who, env] of ROLES) {
      const why = await pre(command, who, env);
      assert.ok(why, `${role}: allowed`);
      assert.match(why, /cannot be resolved/, `${role}: ${why}`);
    }
    const lead = await pre(command, LEAD[1], LEAD[2]);
    assert.ok(lead === null || !/after a cd to a directory that cannot be resolved|the command creates/.test(lead), `the lead got the role-only text: ${lead}`);
  });
}

test("A273: the lead's verdict for a bare mkdir through a variable is unchanged (allowed: the scanner records no write)", async () => {
  assert.equal(await pre('mkdir $VAR/x', LEAD[1], LEAD[2]), null);
  assert.equal(await pre('mkdir -p $VAR/x', LEAD[1], LEAD[2]), null);
});

test('A273: a literal cd stays allowed for both roles (cd into the run scratch folder, then a relative write; a literal mkdir)', async () => {
  for (const [role, who, env] of ROLES) {
    assert.equal(await pre('cd .agents/runs/LC/scratch && echo x > o.txt', who, env), null, `${role}: literal cd`);
    assert.equal(await pre('mkdir -p .agents/runs/LC/scratch/d', who, env), null, `${role}: literal mkdir`);
  }
  const [, who, env] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
  assert.equal(await pre('cd . && echo x > impl.txt', who, env), null);
});

test('A273: `cd src && echo x > a.txt` is judged by the path rule (literal cd), not refused as unresolvable', async () => {
  for (const [role, who, env] of ROLES) {
    const why = await pre('cd src && echo x > a.txt', who, env);
    assert.ok(why === null || !/cannot be resolved/.test(why), `${role}: ${why}`);
  }
});

// Rows the guard before A273 already refused (by the path rule, the glob rule or the scope rule): kept as regression rows, not as bypass proofs.
const ALREADY_REFUSED = new Set(["cp a \"`pwd`/../x\"", "echo x > /dev/null/../../etc/x", "cp -rt $X a", "cp -t src a", "cp -t ../x a", "sed -i -e s/a/b/ impl.txt /etc/hosts", "sed -n -i.bak -e p /etc/x", "install -m755 a b", "cp \"$(git rev-parse HEAD)\" a", "ruby -pi -e 1 /etc/x", "gsed -i s/a/b/ /etc/x", "gawk --include=inplace 1 /etc/x", "mawk -i inplace 1 /etc/x", "echo x > ${TMPDIR}/x/*/y", "echo x > $TMPDIR/*/y", "echo x > /tmp/*/../x"]);
const tag = (/** @type {string} */ c) => (ALREADY_REFUSED.has(c) ? ' (already refused on the old code by another rule)' : '');
// Security review round 1 (issue #264): the operands the scanner does not record as writes. Role verdict: refused for both roles; lead verdict: pinned explicitly (allow = the lead's guard allows it today and keeps doing so).
const BEYOND_SCANNER = /** @type {Array<[string, string, 'allow' | 'refuse']>} */ ([
  ["echo x >& $VAR/x", "echo x >& $VAR/x", 'allow'],
  ["echo x >&$OLDPWD/x", "echo x >&$OLDPWD/x", 'allow'],
  ["echo x 2>&$VAR", "echo x 2>&$VAR", 'allow'],
  ["echo x >& $(pwd)/../x", "echo x >& $(pwd)/../x", 'allow'],
  ["echo x >& ../x", "echo x >& ../x", 'allow'],
  ["cp a `pwd`/../x", "cp a `pwd`/../x", 'allow'],
  ["tee `pwd`/../x", "tee `pwd`/../x", 'allow'],
  ["touch `pwd`/../x", "touch `pwd`/../x", 'allow'],
  ["rm `pwd`/../x", "rm `pwd`/../x", 'allow'],
  ["mkdir -p `pwd`/../x", "mkdir -p `pwd`/../x", 'allow'],
  ["install -d `pwd`/../x", "install -d `pwd`/../x", 'allow'],
  ["cp -t `pwd`/.. a", "cp -t `pwd`/.. a", 'allow'],
  ["cp a \"`pwd`/../x\"", "cp a \"`pwd`/../x\"", 'refuse'],
  ["echo x > /dev/$X", "echo x > /dev/$X", 'allow'],
  ["echo x > /dev/*", "echo x > /dev/*", 'allow'],
  ["echo x > /dev/$(echo ../etc)/x", "echo x > /dev/$(echo ../etc)/x", 'allow'],
  ["tee /dev/$X", "tee /dev/$X", 'allow'],
  ["cp a /dev/$X", "cp a /dev/$X", 'allow'],
  ["dd of=/dev/$X", "dd of=/dev/$X", 'allow'],
  ["echo x > /dev/null/../../etc/x", "echo x > /dev/null/../../etc/x", 'refuse'],
  ["echo x > ${TMPDIR%%/*}/etc/x", "echo x > ${TMPDIR%%/*}/etc/x", 'allow'],
  ["echo x > ${TMPDIR:0:0}/x", "echo x > ${TMPDIR:0:0}/x", 'allow'],
  ["echo x > ${TMPDIR/*/}/x", "echo x > ${TMPDIR/*/}/x", 'allow'],
  ["install -d $VAR/x", "install -d $VAR/x", 'allow'],
  ["install -d -m755 $VAR", "install -d -m755 $VAR", 'allow'],
  ["install -t$X a", "install -t$X a", 'allow'],
  ["mv -t$X a", "mv -t$X a", 'allow'],
  ["cp -t$X a", "cp -t$X a", 'allow'],
  ["cp --target=$VAR a", "cp --target=$VAR a", 'allow'],
  ["cp --target-directory=$VAR a", "cp --target-directory=$VAR a", 'refuse'],
  ["cp --target-directory $VAR a", "cp --target-directory $VAR a", 'refuse'],
  ["cp -rt $X a", "cp -rt $X a", 'refuse'],
  ["cp -t src a", "cp -t src a", 'refuse'],
  ["cp -t ../x a", "cp -t ../x a", 'refuse'],
  ["sed -i s/a/b/ $VAR impl.txt", "sed -i s/a/b/ $VAR impl.txt", 'refuse'],
  ["perl -pi -e 1 $VAR impl.txt", "perl -pi -e 1 $VAR impl.txt", 'refuse'],
  ["awk -i inplace 1 $VAR impl.txt", "awk -i inplace 1 $VAR impl.txt", 'refuse'],
  ["sed -i s/a/b/ /etc/hosts impl.txt", "sed -i s/a/b/ /etc/hosts impl.txt", 'refuse'],
  ["sed -i -e s/a/b/ impl.txt /etc/hosts", "sed -i -e s/a/b/ impl.txt /etc/hosts", 'refuse'],
  ["sed -n -i.bak -e p /etc/x", "sed -n -i.bak -e p /etc/x", 'refuse'],
  ["mkdir ../x", "mkdir ../x", 'allow'],
  ["mkdir /etc/x", "mkdir /etc/x", 'allow'],
  ["mkdir -p ~/x", "mkdir -p ~/x", 'allow'],
  ["mkdir ../{x,y}", "mkdir ../{x,y}", 'allow'],
  ["mkdir -p `pwd`/x", "mkdir -p `pwd`/x", 'allow'],
]);

for (const [name, command, leadExpected] of BEYOND_SCANNER) {
  test(`A273 review: ${name}${tag(command)}: refused for both roles; the lead stays ${leadExpected}`, async () => {
    for (const [role, who, env] of ROLES) {
      const why = await pre(command, who, env);
      assert.ok(why, `${role}: allowed`);
    }
    const lead = await pre(command, LEAD[1], LEAD[2]);
    if (leadExpected === 'allow') assert.equal(lead, null, `the lead's verdict changed: ${lead}`);
    else assert.ok(lead, 'the lead no longer refuses this form');
  });
}

const STAY_ALLOWED = ["echo hi >& 1", "sed s/a/b/ /etc/hosts", "mkdir -m 755 .agents/runs/LC/scratch/e"];
test('A273 review: file descriptors, /dev/null and the standard streams, a heredoc body with backticks and a literal in-scope in-place edit stay allowed', async () => {
  const [, implWho, implEnv] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
  for (const command of STAY_ALLOWED) {
    assert.equal(await pre(command, implWho, implEnv), null, command);
  }
  for (const [role, who, env] of ROLES) {
    for (const command of ['echo hi >&2', 'echo hi 2>&1', 'echo hi >&-', 'echo x > /dev/null', 'echo x > /dev/stderr', 'echo x > /dev/fd/2', 'echo x > /dev/tty', 'mkdir -p .agents/runs/LC/scratch/d', 'cd .agents/runs/LC/scratch && cp -t d a']) {
      assert.equal(await pre(command, who, env), null, `${role}: ${command}`);
    }
  }
});

// Review round 2: a command text tokenizer of its own (rolewrites.mjs) reads what the scanner loses. Role verdict: refused for both roles; lead verdict pinned explicitly.
const ROUND2 = /** @type {Array<[string, string, 'allow' | 'refuse']>} */ ([
  ["install -dm755 /etc/x", "install -dm755 /etc/x", 'allow'],
  ["install -vdm755 /etc/x", "install -vdm755 /etc/x", 'allow'],
  ["install -ddm755 /etc/x", "install -ddm755 /etc/x", 'allow'],
  ["install -d /etc/x", "install -d /etc/x", 'allow'],
  ["install -m755 a b", "install -m755 a b", 'refuse'],
  ["cp $(true) a /etc/x", "cp $(true) a /etc/x", 'allow'],
  ["mv $(true) a /etc/x", "mv $(true) a /etc/x", 'allow'],
  ["install $(true) a /etc/x", "install $(true) a /etc/x", 'allow'],
  ["dd if=$(true) of=/etc/x", "dd if=$(true) of=/etc/x", 'allow'],
  ["tar -C $(true) -xf a", "tar -C $(true) -xf a", 'refuse'],
  ["unzip $(true) -d /etc", "unzip $(true) -d /etc", 'allow'],
  ["curl $(true) -o /etc/x", "curl $(true) -o /etc/x", 'allow'],
  ["cp \"$(git rev-parse HEAD)\" a", "cp \"$(git rev-parse HEAD)\" a", 'refuse'],
  ["echo x >& \"\"/etc/x", "echo x >& \"\"/etc/x", 'allow'],
  ["echo x >& ''/etc/x", "echo x >& ''/etc/x", 'allow'],
  ["echo x >& \"impl.txt\"/../../etc/x", "echo x >& \"impl.txt\"/../../etc/x", 'allow'],
  ["echo x >& \\/etc/x", "echo x >& \\/etc/x", 'allow'],
  ["echo x > \"`echo /etc/x`\"", "echo x > \"`echo /etc/x`\"", 'allow'],
  ["echo x > .agents/runs/LC/scratch/\"`echo ..`\"/f", "echo x > .agents/runs/LC/scratch/\"`echo ..`\"/f", 'allow'],
  ["echo x > .agents/runs/LC/scratch`true`/../../f", "echo x > .agents/runs/LC/scratch`true`/../../f", 'refuse'],
  ["chmod 600 `pwd`/../x", "chmod 600 `pwd`/../x", 'allow'],
  ["chown u `pwd`/x", "chown u `pwd`/x", 'allow'],
  ["shred `pwd`/x", "shred `pwd`/x", 'allow'],
  ["curl -o `pwd`/x u", "curl -o `pwd`/x u", 'allow'],
  ["wget -O `pwd`/x u", "wget -O `pwd`/x u", 'allow'],
  ["wget -P `pwd` u", "wget -P `pwd` u", 'allow'],
  ["unzip a -d `pwd`/..", "unzip a -d `pwd`/..", 'allow'],
  ["rsync a `pwd`/../x", "rsync a `pwd`/../x", 'allow'],
  ["perl -0pi -e 1 /etc/x", "perl -0pi -e 1 /etc/x", 'allow'],
  ["ruby -pi -e 1 /etc/x", "ruby -pi -e 1 /etc/x", 'refuse'],
  ["gsed -i s/a/b/ /etc/x", "gsed -i s/a/b/ /etc/x", 'refuse'],
  ["gawk --include=inplace 1 /etc/x", "gawk --include=inplace 1 /etc/x", 'refuse'],
  ["mawk -i inplace 1 /etc/x", "mawk -i inplace 1 /etc/x", 'refuse'],
  ["perl -0pi -e 1 impl.txt /etc/x", "perl -0pi -e 1 impl.txt /etc/x", 'allow'],
  ["env -C /etc tee .agents/runs/LC/scratch/o.txt", "env -C /etc tee .agents/runs/LC/scratch/o.txt", 'allow'],
  ["sudo -D /etc tee .agents/runs/LC/scratch/o.txt", "sudo -D /etc tee .agents/runs/LC/scratch/o.txt", 'allow'],
  ["env --chdir=/etc tee .agents/runs/LC/scratch/o.txt", "env --chdir=/etc tee .agents/runs/LC/scratch/o.txt", 'allow'],
  ["CDPATH=/etc cd .agents/runs/LC/scratch; tee o.txt", "CDPATH=/etc cd .agents/runs/LC/scratch; tee o.txt", 'allow'],
  ["export CDPATH=/etc; cd .agents/runs/LC/scratch; tee o.txt", "export CDPATH=/etc; cd .agents/runs/LC/scratch; tee o.txt", 'allow'],
  ["curl -fsSLo /etc/x u", "curl -fsSLo /etc/x u", 'allow'],
  ["wget -qO /etc/x u", "wget -qO /etc/x u", 'allow'],
  ["wget -qP /etc u", "wget -qP /etc u", 'allow'],
  ["wget -o /etc/log u", "wget -o /etc/log u", 'allow'],
  ["echo x > ${TMPDIR}/x/*/y", "echo x > ${TMPDIR}/x/*/y", 'refuse'],
  ["echo x > $TMPDIR/*/y", "echo x > $TMPDIR/*/y", 'refuse'],
  ["echo x > /tmp/*/../x", "echo x > /tmp/*/../x", 'refuse'],
  ["echo x > /dev/disk0", "echo x > /dev/disk0", 'allow'],
  ["dd of=/dev/disk0", "dd of=/dev/disk0", 'allow'],
  ["tee /dev/disk0", "tee /dev/disk0", 'allow'],
  ["patch /etc/x < impl.txt", "patch /etc/x < impl.txt", 'allow'],
  ["patch -o /etc/x impl.txt", "patch -o /etc/x impl.txt", 'allow'],
  ["ed /etc/x", "ed /etc/x", 'allow'],
  ["vim /etc/x", "vim /etc/x", 'allow'],
  ["unlink $VAR/x", "unlink $VAR/x", 'refuse'],
  ["rmdir $VAR/x", "rmdir $VAR/x", 'refuse'],
  ["chgrp g $VAR/x", "chgrp g $VAR/x", 'refuse'],
  ["ex $VAR/x", "ex $VAR/x", 'allow'],
  ["vi $VAR/x", "vi $VAR/x", 'allow'],
  ["view $VAR/x", "view $VAR/x", 'allow'],
  ["nvim $VAR/x", "nvim $VAR/x", 'allow'],
  ["gpatch $VAR/x", "gpatch $VAR/x", 'allow'],
  ["bsdtar -C $VAR -xf a", "bsdtar -C $VAR -xf a", 'refuse'],
  ["gtar -C $VAR -xf a", "gtar -C $VAR -xf a", 'refuse'],
  ["chmod 600 $VAR/x", "chmod 600 $VAR/x", 'refuse'],
  ["ruby -pi -e 1 $VAR impl.txt", "ruby -pi -e 1 $VAR impl.txt", 'refuse'],
]);

for (const [name, command, leadExpected] of ROUND2) {
  test(`A273 round 2: ${name}${tag(command)}: refused for both roles; the lead stays ${leadExpected}`, async () => {
    for (const [role, who, env] of ROLES) assert.ok(await pre(command, who, env), `${role}: allowed`);
    const lead = await pre(command, LEAD[1], LEAD[2]);
    if (leadExpected === 'allow') assert.equal(lead, null, `the lead's verdict changed: ${lead}`);
    else assert.ok(lead, 'the lead no longer refuses this form');
  });
}

test('A273 round 2: every program the scanner knows as a writer has a row in a refused table (completeness against WRITE_PROGRAMS; the tables are hand-derived from it)', () => {
  const words = new Set();
  for (const [, command] of [...REFUSED, ...CD_REFUSED, ...MKDIR_REFUSED, ...BEYOND_SCANNER, ...ROUND2]) {
    for (const sc of tokenize(command)) { const w = sc.words[0]; if (w) words.add(w.v.replace(/^.*\//, '')); }
  }
  // a program whose operand is only reachable through a flag the table spells with another command word (dd of=, tar -C) counts through that row
  const missing = [...WRITE_PROGRAMS].filter((p) => !words.has(p));
  assert.deepEqual(missing, [], 'a writer the scanner knows has no refused-table row');
});

test('A273 round 2: quoted text, commit messages, heredoc bodies and fd duplicates do not trigger (AC-4 over-refusal guards)', async () => {
  for (const [role, who, env] of ROLES) {
    for (const command of ["git commit -m \"docs: document `install`\"", "sed -n 1p f && echo \"`date`\"", "echo \"x >& $LOG\"", "cat <<EOF\nrun >& $LOG\nEOF", "mkdir -pm 755 .agents/runs/LC/scratch/d", "mknod .agents/runs/LC/scratch/f p"]) assert.equal(await pre(command, who, env), null, `${role}: ${command}`);
  }
  const [, who, env] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
  for (const command of ["install -Dm755 a impl.txt", "sed -i s/a/b/ impl.txt && git commit -m \"fix `x`\"", "vim impl.txt"]) assert.equal(await pre(command, who, env), null, command);
});

test('A273 round 2: the in-process verdicts agree with the real hook process for the lead and both roles (a sample of refused and allowed commands)', async () => {
  for (const [, who, env] of [...ROLES, LEAD]) {
    for (const command of ['echo x > $OLDPWD/x', 'echo $(mkdir /etc/x)', "echo $'a\\'b'; touch /etc/x", 'echo x > .agents/runs/LC/scratch/o.txt', 'git commit -m "docs: document `install`"']) {
      assert.equal(await preSpawn(command, who, env), await pre(command, who, env), command);
    }
  }
});

test('A273 round 2: the tokenizer is linear on pathological input (a quadratic reader would not finish)', () => {
  const big = '`'.repeat(300000) + "'".repeat(1001) + '$('.repeat(100000) + '"'.repeat(5001);
  assert.ok(Array.isArray(tokenize(big)));
  const heres = 'cat <<A\n'.repeat(60000) + 'x\n'.repeat(120000);
  assert.ok(roleActions(heres).actions.length === 0);
  const many = 'tee a$(x) '.repeat(100000);
  assert.ok(roleActions(many).actions.length >= 1);
});

// ---- Review round 3 (A273): the role scan reads code wherever the shell runs code (substitutions, backticks, process substitutions, here-document expansions, `sh -c` strings, compound commands, wrappers),
// the `$'...'` string, tar, gawk and GNU mkdir -Z. Each row is its own test: refused for both roles; the lead's verdict is pinned to what the base gave (it never changes). A row the base already refused for both
// roles by another rule is tagged: it is a regression row, not a bypass proof.
const R3_H1_SUBSTITUTION = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["echo $(mkdir /etc/x)", 'allow'],
  ["echo \"$(mkdir /etc/x)\"", 'allow'],
  ["echo `mkdir /etc/x`", 'allow'],
  ["echo \"`mkdir /etc/x`\"", 'allow'],
  ["x=$(mkdir /etc/x)", 'allow'],
  ["cat <(mkdir /etc/x)", 'allow'],
  ["echo ${X:-$(mkdir /etc/x)}", 'allow'],
  ["echo $(echo $(echo $(mkdir /etc/x)))", 'allow'],
  ["echo $(echo `mkdir /etc/x`)", 'allow'],
  ["echo $( mkdir /etc/x )", 'allow'],
  ["echo $((1)) $(mkdir /etc/x)", 'allow'],
]);
const R3_H1_HEREDOC_BODY = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["cat <<EOF\n$(mkdir /etc/x)\nEOF", 'allow'],
  ["cat <<EOF\n`mkdir /etc/x`\nEOF", 'allow'],
  ["cat <<-EOF\n\t$(mkdir /etc/x)\n\tEOF", 'allow'],
]);
const R3_H1_ARITHMETIC = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["echo $[1<<2]\nmkdir /etc/x", 'allow'],
  ["(( 1<<2 ))\nmkdir /etc/x", 'allow'],
  ["echo $((1<<2))\nmkdir /etc/x", 'allow'],
  ["echo $[ $(mkdir /etc/y) ]", 'allow'],
  ["echo $(( $(mkdir /etc/y) ))", 'allow'],
]);
const R3_H1_COMPOUND = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["{ mkdir /etc/x; }", 'allow'],
  ["if true; then mkdir /etc/x; fi", 'allow'],
  ["if false; then true; elif true; then mkdir /etc/x; fi", 'allow'],
  ["if false; then true; else mkdir /etc/x; fi", 'allow'],
  ["if mkdir /etc/x; then true; fi", 'allow'],
  ["while true; do mkdir /etc/x; done", 'allow'],
  ["until false; do mkdir /etc/x; done", 'allow'],
  ["for i in 1; do mkdir /etc/x; done", 'allow'],
  ["! mkdir /etc/x", 'allow'],
  ["f() { mkdir /etc/x; }; f", 'allow'],
  ["function f { mkdir /etc/x; }; f", 'allow'],
  ["case x in x) mkdir /etc/x;; esac", 'allow'],
  ["true && { mkdir /etc/x; }", 'allow'],
  ["if true; then A=1 mkdir /etc/x; fi", 'allow'],
  ["(mkdir /etc/x)", 'allow'],
]);
const R3_H1_SHELL_STRING = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["sh -c 'mkdir /etc/x'", 'allow'],
  ["bash -c \"mkdir /etc/x\"", 'allow'],
  ["bash -lc 'mkdir /etc/x'", 'allow'],
  ["sh -ec 'mkdir /etc/x'", 'allow'],
  ["zsh -c 'mkdir /etc/x'", 'allow'],
  ["sh -c \"sh -c 'mkdir /etc/x'\"", 'refuse'],
  ["bash -o pipefail -c 'mkdir /etc/x'", 'allow'],
  ["eval 'mkdir /etc/x'", 'refuse'],
  ["echo 'mkdir /etc/x' | sh", 'refuse'],
  ["sh <<'EOF'\nmkdir /etc/x\nEOF", 'refuse'],
  ["cat <<'EOF' | bash\nmkdir /etc/x\nEOF", 'refuse'],
  ["bash <<< 'mkdir /etc/x'", 'refuse'],
  ["echo mkdir /etc/x | sh -s", 'refuse'],
]);
const R3_H1_WRAPPER = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["timeout 5 mkdir /etc/x", 'allow'],
  ["timeout -k 5 10 mkdir /etc/x", 'allow'],
  ["stdbuf -o0 mkdir /etc/x", 'allow'],
  ["ionice -c3 mkdir /etc/x", 'allow'],
  ["ionice -c 3 mkdir /etc/x", 'allow'],
  ["nice mkdir /etc/x", 'allow'],
  ["nice -n 5 mkdir /etc/x", 'allow'],
  ["nohup mkdir /etc/x", 'allow'],
  ["env VAR=1 mkdir /etc/x", 'allow'],
  ["command mkdir /etc/x", 'allow'],
  ["exec mkdir /etc/x", 'allow'],
  ["time mkdir /etc/x", 'allow'],
  ["time -p mkdir /etc/x", 'allow'],
  ["sudo mkdir /etc/x", 'allow'],
  ["chrt 10 mkdir /etc/x", 'allow'],
  ["taskset 1 mkdir /etc/x", 'allow'],
  ["nohup timeout 5 nice mkdir /etc/x", 'allow'],
]);
const R3_H1_OTHER_WRITERS = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["echo $(install -d /etc/x)", 'allow'],
  ["echo $(mkfifo /etc/x)", 'allow'],
  ["echo $(mknod /etc/x p)", 'allow'],
  ["echo $(patch /etc/x < a)", 'allow'],
  ["echo $(ed /etc/x)", 'allow'],
  ["sh -c 'install -d /etc/x'", 'allow'],
  ["sh -c 'mkfifo /etc/x'", 'allow'],
  ["sh -c 'mknod /etc/x p'", 'allow'],
  ["sh -c 'patch /etc/x'", 'allow'],
  ["sh -c 'ed /etc/x'", 'allow'],
  ["sh -c 'sed -i s/a/b/ /etc/x'", 'refuse'],
  ["sh -c 'cp -t /etc a'", 'refuse'],
  ["if true; then install -d /etc/x; fi", 'allow'],
  ["timeout 5 patch /etc/x", 'allow'],
  ["env X=1 ed /etc/x", 'allow'],
  ["echo $(tar -cf /etc/x.tar a)", 'allow'],
  ["echo $(gawk -i inplace 1 /etc/x)", 'refuse'],
  ["echo $(curl -o /etc/x http://a)", 'refuse'],
]);
const R3_H2_REDIRECT_IN_SUBSTITUTION = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["echo $(echo hi >& /etc/zz)", 'allow'],
  ["sh -c \"echo hi >& /etc/zz\"", 'allow'],
  ["echo $(echo hi > /etc/zz)", 'refuse'],
  ["sh -c \"echo hi >> /etc/zz\"", 'refuse'],
  ["echo $(echo hi &> /etc/zz)", 'refuse'],
  ["sh -c \"echo hi &> /etc/zz\"", 'refuse'],
  ["echo $(echo hi | tee /etc/zz)", 'refuse'],
  ["sh -c 'cp a /etc/zz'", 'refuse'],
  ["echo $(cp a /etc/zz)", 'refuse'],
  ["sh -c \"echo hi >& \\$OLDPWD/zz\"", 'allow'],
  ["cat <(echo hi > /etc/zz)", 'refuse'],
  ["echo \"`echo hi >& /etc/zz`\"", 'allow'],
  ["echo $(echo hi >| /etc/zz)", 'refuse'],
  ["echo $(echo hi 2>/etc/zz)", 'refuse'],
  ["cat <<EOF\n$(echo hi >& /etc/zz)\nEOF", 'allow'],
]);
const R3_M_ANSI_C = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["echo $'a\\'b'; touch /etc/x", 'allow'],
  ["echo $'\\'' ; echo hi > /etc/x", 'allow'],
  ["echo $'it\\'s'; rm /etc/x", 'allow'],
  ["echo $'a\\'b'; tee /etc/x", 'allow'],
  ["echo $'a\\'b'; cp a /etc/x", 'allow'],
  ["echo $'a\\'b'; mkdir /etc/x", 'allow'],
  ["echo $'\\x41'; touch /etc/x", 'refuse'],
  ["echo x > $'\\x2fetc\\x2fx'", 'refuse'],
  ["echo $'a\\'b' > /etc/x", 'allow'],
  ["echo $'a\\'b' && sh -c 'echo hi >& /etc/x'", 'allow'],
]);
const R3_M_TAR = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["tar -cf /etc/x.tar a", 'allow'],
  ["tar cf /etc/x.tar a", 'allow'],
  ["tar -c -f /etc/x.tar a", 'allow'],
  ["tar --create --file=/etc/x.tar a", 'allow'],
  ["tar --create --file /etc/x.tar a", 'allow'],
  ["tar cf $OUT/a.tar a", 'allow'],
  ["tar -cf ../x.tar a", 'allow'],
  ["gtar -czf /etc/x.tgz a", 'allow'],
  ["bsdtar -cf /etc/x.tar a", 'allow'],
  ["tar -xf a.tar -C /etc", 'refuse'],
  ["tar -x -C /etc -f a.tar", 'refuse'],
  ["tar xf a.tar --directory=/etc", 'refuse'],
  ["tar xfC a.tar /etc", 'allow'],
  ["tar -rf /etc/x.tar a", 'allow'],
  ["tar -cvf /etc/x.tar a", 'allow'],
]);
const R3_M_GAWK = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["gawk -i ./inplace.awk 1 /etc/x", 'allow'],
  ["gawk -i /usr/share/awk/inplace.awk 1 /etc/x", 'allow'],
  ["gawk --include=/x/inplace.awk 1 /etc/x", 'allow'],
  ["gawk --include /x/inplace 1 /etc/x", 'allow'],
  ["gawk -i ./inplace 1 /etc/x", 'allow'],
]);
const R3_M_MKDIR_Z = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["mkdir -Z /etc/x", 'allow'],
  ["mkfifo -Z /etc/x", 'allow'],
  ["mknod -Z /etc/x p", 'allow'],
  ["mkdir -pZ /etc/x", 'allow'],
  ["mkdir --context /etc/x", 'allow'],
]);
const R3_DEEP = /** @type {Array<[string, 'allow' | 'refuse']>} */ ([
  ["echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo hi))))))))))", 'allow'],
  ["echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(mkdir /etc/x)))))))))", 'allow'],
]);
const ALREADY_R3 = new Set([ "echo $((1<<2))\nmkdir /etc/x", "case x in x) mkdir /etc/x;; esac", "(mkdir /etc/x)", "sh -c \"sh -c 'mkdir /etc/x'\"", "eval 'mkdir /etc/x'", "echo 'mkdir /etc/x' | sh", "sh <<'EOF'\nmkdir /etc/x\nEOF", "cat <<'EOF' | bash\nmkdir /etc/x\nEOF", "bash <<< 'mkdir /etc/x'", "echo mkdir /etc/x | sh -s", "nice mkdir /etc/x", "nice -n 5 mkdir /etc/x", "nohup mkdir /etc/x", "env VAR=1 mkdir /etc/x", "command mkdir /etc/x", "exec mkdir /etc/x", "time mkdir /etc/x", "time -p mkdir /etc/x", "sudo mkdir /etc/x", "sh -c 'sed -i s/a/b/ /etc/x'", "sh -c 'cp -t /etc a'", "env X=1 ed /etc/x", "echo $(gawk -i inplace 1 /etc/x)", "echo $(curl -o /etc/x http://a)", "echo $(echo hi > /etc/zz)", "sh -c \"echo hi >> /etc/zz\"", "echo $(echo hi &> /etc/zz)", "sh -c \"echo hi &> /etc/zz\"", "echo $(echo hi | tee /etc/zz)", "sh -c 'cp a /etc/zz'", "echo $(cp a /etc/zz)", "cat <(echo hi > /etc/zz)", "echo $(echo hi >| /etc/zz)", "echo $(echo hi 2>/etc/zz)", "echo $'\\x41'; touch /etc/x", "echo x > $'\\x2fetc\\x2fx'", "echo $'a\\'b' && sh -c 'echo hi >& /etc/x'", "tar -xf a.tar -C /etc", "tar -x -C /etc -f a.tar", "tar xf a.tar --directory=/etc", "mknod -Z /etc/x p" ]);
const R3_ALLOWED = [
 "git commit -m \"docs: use `install` and $(date)\"",
 "git commit -m 'docs: mkdir /etc/x'",
 "cat <<'EOF'\nmkdir /etc/x $(foo) `bar`\nEOF",
 "cat <<EOF\nvalue $HOME and `date`\nEOF",
 "echo \"$HOME\"",
 "grep -rn \"$(pwd)\" src",
 "sed -n 1,5p impl.txt",
 "npm test",
 "node --test tests/x.test.mjs",
 "ls 2>&1",
 "echo \"mkdir /etc/x\"",
 "echo 'mkdir /etc/x'",
 "grep 'mkdir /etc/x' impl.txt",
 "sh -c 'echo hi'",
 "bash -c \"ls $(pwd)\"",
 "echo $(git rev-parse HEAD)",
 "x=$(cat impl.txt)",
 "if [ -f impl.txt ]; then echo ok; fi",
 "for f in a b; do echo $f; done",
 "timeout 5 npm test",
 "mkdir -p .agents/runs/LC/scratch/d && echo x > .agents/runs/LC/scratch/d/o",
 "echo $'a\\'b'",
 "echo $'a\\'b'; echo hi > .agents/runs/LC/scratch/o.txt",
 "tar -tf a.tar",
 "tar -xf a.tar",
 "tar -cf - impl.txt | wc -c",
 "tar -cf .agents/runs/LC/scratch/a.tar impl.txt",
 "gawk '{print}' impl.txt",
 "mkdir -Z .agents/runs/LC/scratch/dz",
 "mkdir -p .agents/runs/LC/scratch/dz2",
 "git commit -m \"$(cat <<'EOF'\nfix: don't break\n\nEOF\n)\"",
 "echo $(date)",
 "echo $(( 1 > 0 ))",
 "echo $((2<<3))",
 "(( 1<<2 ))\ncat impl.txt",
 "ls | grep x",
 "echo hi | xargs echo",
 "echo \"it's $(date)\"",
 "echo `date` > .agents/runs/LC/scratch/o.txt",
 "git log --oneline | head -5",
 "node -e 'console.log(1)'",
 "python3 -c 'print(1)'",
 "echo hi >&2",
 "echo 'a b' | wc -c",
 "echo $(echo $(echo $(echo hi)))"
];
const R3_GROUPS = /** @type {Array<[string, Array<[string, 'allow' | 'refuse']>]>} */ ([["H1 substitution", R3_H1_SUBSTITUTION], ["H1 heredoc body", R3_H1_HEREDOC_BODY], ["H1 arithmetic", R3_H1_ARITHMETIC], ["H1 compound", R3_H1_COMPOUND], ["H1 shell string", R3_H1_SHELL_STRING], ["H1 wrapper", R3_H1_WRAPPER], ["H1 other writers", R3_H1_OTHER_WRITERS], ["H2 redirect in substitution", R3_H2_REDIRECT_IN_SUBSTITUTION], ["M ansi-c", R3_M_ANSI_C], ["M tar", R3_M_TAR], ["M gawk", R3_M_GAWK], ["M mkdir -Z", R3_M_MKDIR_Z], ["deep", R3_DEEP]]);

for (const [group, rows] of R3_GROUPS) {
  for (const [command, leadExpected] of rows) {
    test(`A273 round 3 (${group}): ${JSON.stringify(command)}${ALREADY_R3.has(command) ? ' (already refused on the base by another rule)' : ''}: refused for both roles; the lead stays ${leadExpected}`, async () => {
      for (const [role, who, env] of ROLES) assert.ok(await pre(command, who, env), `${role}: allowed`);
      const lead = await pre(command, LEAD[1], LEAD[2]);
      if (leadExpected === 'allow') assert.equal(lead, null, `the lead's verdict changed: ${lead}`);
      else assert.ok(lead, 'the lead no longer refuses this form');
    });
  }
}

for (const command of R3_ALLOWED) {
  test(`A273 round 3 (stays allowed, AC-4): ${JSON.stringify(command)}`, async () => {
    for (const [role, who, env] of ROLES) assert.equal(await pre(command, who, env), null, `${role}: refused`);
  });
}

test('A273 round 3: a write before the cd the scanner cannot place stays allowed; the same write after it is refused (one source for the position: rolewrites.mjs badAt)', async () => {
  const [, who, env] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
  assert.equal(await pre('echo x > impl.txt; cd $OLDPWD', who, env), null);
  assert.equal(await pre('rm impl.txt; cd -', who, env), null);
  assert.ok(await pre('cd -; rm impl.txt', who, env));
  assert.ok(await pre('cd $X; echo x > impl.txt', who, env));
  assert.ok(await pre('echo $(cd $X; touch impl.txt)', who, env));
  assert.ok(await pre("sh -c 'cd $X; touch impl.txt'", who, env));
  assert.equal(roleActions('echo x > impl.txt; cd $OLDPWD').badAt, 'echo x > impl.txt;'.length);
  assert.equal(roleActions('echo hi').badAt, -1);
  assert.equal(roleActions('env -C /etc true').badAt, 0);
});

test('A273 round 3: the tokenizer reads a $-quote string with its escapes (the text after a backslash-quote is not hidden) and decodes only the escapes it knows', () => {
  const Q = "'";
  const BS = '\\';
  const src = `echo $${Q}a${BS}${Q}b${Q}; touch X`;
  assert.deepEqual(tokenize(src).map((s) => s.words.map((x) => x.v)), [['echo', `a${Q}b`], ['touch', 'X']]);
  assert.equal(tokenize(`echo $${Q}${BS}x41${Q}`)[0]?.words[1]?.vr, true);
  assert.equal(rewriteAnsiC(src), `echo ${Q}a${Q}${BS}${Q}${Q}b${Q}; touch X`);
  // inside double quotes and single quotes a $-quote is text, not a string: nothing is rewritten
  assert.equal(rewriteAnsiC(`echo "$${Q}x${Q}" ${Q}it $${Q}x${Q} ok`), `echo "$${Q}x${Q}" ${Q}it $${Q}x${Q} ok`);
  // inside a command substitution it is a string again
  assert.equal(rewriteAnsiC(`echo "$(echo $${Q}a${BS}${Q}b${Q})"`), `echo "$(echo ${Q}a${Q}${BS}${Q}${Q}b${Q})"`);
});

test('A273 round 3: the depth bound fails closed with its own reason, and a command inside the bound is read', () => {
  // n levels of `echo $(...)` around a core command that sits at a command position
  const nest = (/** @type {number} */ n, /** @type {string} */ core) => { let c = core; for (let k = 0; k < n; k++) c = `echo $(${c})`; return c; };
  assert.ok(roleActions(nest(MAX_DEPTH + 1, 'echo hi')).actions.some((a) => a.kind === 'deny' && /deeper than/.test(a.why)));
  assert.equal(roleActions(nest(MAX_DEPTH, 'echo hi')).actions.length, 0);
  assert.equal(roleActions(nest(MAX_DEPTH, 'mkdir /etc/x')).actions.length, 1);
  assert.equal(roleActions("sh -c 'echo hi'").actions.length, 0);
  assert.equal(roleActions("sh -c 'mkdir /etc/x'").actions.length, 1);
});

test('A273 round 3: the tokenizer stays linear on pathological input with recursion (a quadratic or exponential reader would not finish)', () => {
  const denies = (/** @type {string} */ c) => roleActions(c).actions.some((a) => a.kind === 'deny');
  assert.ok(denies('$('.repeat(100000)));
  assert.equal(roleActions('`'.repeat(100001)).actions.length, 0);
  assert.ok(Array.isArray(roleActions("sh -c '".repeat(50000)).actions));
  assert.ok(denies('"$('.repeat(60000)));
  assert.equal(roleActions(`${'{ '.repeat(100000)}mkdir /etc/x`).actions.length, 1);
  assert.ok(denies('echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(mkdir /etc/x)))))))))'.repeat(2000)));
  assert.equal(roleActions('cat <<EOF\n$(mkdir /etc/x)\nEOF\n'.repeat(20000)).actions.length, 20000);
  assert.ok(Array.isArray(roleActions('echo "$(echo " '.repeat(30000)).actions));
});
