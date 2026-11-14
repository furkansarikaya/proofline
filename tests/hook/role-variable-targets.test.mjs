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
