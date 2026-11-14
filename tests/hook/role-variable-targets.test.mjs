// @ts-check
// A273 (issue #264, AC-1 to AC-4 and AC-7): a shell write whose target starts with a variable, a substitution or a glob the hook cannot resolve is refused for the implementer and the
// designer exactly as for the lead (A257, "which cannot be resolved"). Before A273 the two roles skipped that branch and `echo x > $OLDPWD/x` reached outside the project.
// Table-driven: every form below is first required to be refused by the LEAD with the "cannot be resolved" verdict (so the table cannot drift from the lead's guard), then run against both roles.
// The hook only judges the command text (nothing is executed); the command is never run by this test.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, copyProject, runHook, rmSync } from './harness.mjs';

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
  const r = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }, { env: { TMPDIR: '/var/proofline-roletgt-tmp', ...env } });
  if (r.stdout === '') return null;
  return /** @type {string} */ (JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason);
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
  test(`A273 review: ${name}: refused for both roles; the lead stays ${leadExpected}`, async () => {
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
