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
import { tokenize, roleActions } from '../../adapters/claude/hooks/guards/rolewrites.mjs';
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

test('A273 round 2: the in-process verdicts agree with the real hook process (a sample of refused and allowed commands)', async () => {
  for (const [, who, env] of ROLES) {
    for (const command of ['echo x > $OLDPWD/x', 'install -dm755 /etc/x', 'cp $(true) a /etc/x', 'echo x >& ""/etc/x', 'echo x > .agents/runs/LC/scratch/o.txt', 'git commit -m "docs: document `install`"']) {
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
