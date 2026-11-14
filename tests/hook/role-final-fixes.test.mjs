// @ts-check
// A274 (issue #264, package 1, final fix round; follows the first rounds of the same entry): the security round 5 findings for the implementer and the designer, and the pathological-input bounds shared by every role.
// A: a bare `case`/`esac` word or a `$'...'` string inside `$(...)` is read, not refused. B: the role pass judges redirects and the writers the scanner knows from its own tokens.
// C: prefix assignments after `function f {`/`time`, `--` before the command of a wrapper, a command word that is not literal. D: aliases. E: linear-time regular expressions (every role).
// F: direct roleActions rows for the old-style tar forms. The hook only judges the command text; nothing is executed. No clock is read: the bounds are step counts and verdicts.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTemplate, copyProject, rmSync, nodeHook, cleanEnv } from './harness.mjs';
// namespace imports: a name the code under test does not export yet fails its own test, not the whole file
import * as RW from '../../adapters/claude/hooks/guards/rolewrites.mjs';
import * as BASH from '../../adapters/claude/hooks/guards/bash.mjs';
import * as KIT from '../../adapters/claude/hooks/guards/kit.mjs';
const { roleActions, MAX_WRAPPERS, STEPS_PER_CHAR, STEPS_BASE, newGuard } = RW;
/** @param {string} c */
const normalForm = (c) => /** @type {(c: string) => string} */ (/** @type {any} */ (BASH).normalForm)(c);
/** @param {string} l @param {{ steps: number }} [probe] */
const dropBraceVars = (l, probe) => /** @type {(l: string, p?: { steps: number }) => string} */ (/** @type {any} */ (BASH).dropBraceVars)(l, probe);
/** @param {string} t @param {boolean} b @param {{ steps: number }} [probe] */
const envChdirOpt = (t, b, probe) => /** @type {(t: string, b: boolean, p?: { steps: number }) => boolean} */ (/** @type {any} */ (KIT).envChdirOpt)(t, b, probe);

const hookDir = dirname(nodeHook);
const { buildContext, finish } = await import(pathToFileURL(join(hookDir, 'lib/context.mjs')).href);
const { handle } = await import(pathToFileURL(join(hookDir, 'events/pretool.mjs')).href);

let template = '';
let base = '';
let dir = '';
before(() => { template = buildTemplate(); base = tempDir('hook-rolefinal-'); dir = copyProject(template, base); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const ROLES = /** @type {Array<[string, Record<string, string>, Record<string, string>]>} */ ([
  ['implementer', { agent_type: 'proofline-implementer', agent_id: 'f1' }, { AGENT_ROLE: 'implementer' }],
  ['designer', { agent_type: 'proofline-designer', agent_id: 'f1' }, { AGENT_ROLE: 'designer' }],
]);

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

const OUT = '../out/F';
/** [name, command, the lead's verdict (pinned to what 0ef7c794 gave), a pattern the refusal must match]. Every row is refused for both roles. */
const REFUSED = /** @type {Array<[string, string, 'allow' | 'refuse', RegExp]>} */ ([
  // A: still refused after the case/esac and $'...' change (the refusal is now for the right reason)
  ['A: a comment inside a substitution is still a doubt', 'echo $(echo hi # )\nmkdir X)', 'allow', /outside the paths|comment inside a substitution/],
  ['A: a case command at a command position is still a doubt', 'echo $(case x in x) mkdir /etc/x;; esac)', 'allow', /case command inside a substitution|case pattern list/],
  ['A: the code after a parsed $-quote string is read', "echo $(echo $'a\\'b'; mkdir /etc/x)", 'allow', /writes '\/etc\/x'/],
  ['A: the code after a case word argument is read', 'echo $(echo case; mkdir /etc/x)', 'allow', /writes '\/etc\/x'/],
  ['A: the code after an esac word argument is read', 'echo $(echo esac; mkdir /etc/x)', 'allow', /writes '\/etc\/x'/],
  // B: the redirect behind a here-document the lead's scanner swallows
  ['B: << inside (( ))', `(( x = 1<<2 ))\necho q > ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: << inside $[ ]', `echo $[1<<2]\ntouch ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: << inside ${x:-<<E}', `echo \${x:-<<E}\ncp a ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: a nested-quote form', `echo "$(echo "(")"\ntouch ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: << inside (( )) after if', `if (( 1<<2 )); then :; fi\necho q > ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: << inside the header of a for ((;;))', `for (( i=1<<1; i<4; i++ )); do :; done\necho q > ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  // B: the writer the lead's scanner loses behind `function NAME {` or `coproc`
  ['B: function { touch }', `function f { touch ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: function { cp }', `function f { cp a ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: function { tee }', `function f { tee ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: function { dd of= }', `function f { dd of=${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: function { ln -s }', `function f { ln -s a ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: function { install }', `function f { install a ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: function { rsync }', `function f { rsync a ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: function { truncate }', `function f { truncate -s 0 ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: function { mv } (the source is not an owned path either)', `function f { mv a ${OUT}; }; f`, 'allow', /writes '(a|\.\.\/out\/F)'/],
  ['B: coproc tee', `coproc tee ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['B: coproc NAME { touch }', `coproc X { touch ${OUT}; }`, 'allow', /writes '\.\.\/out\/F'/],
  // C: assignments after a reserved word or `time`
  ['C: function { A=1 mkdir }', `function f { A=1 mkdir ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  ['C: time A=1 mkdir', `time A=1 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['C: time -p A=1 mkdir', `time -p A=1 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  // C: `--` ends the options of a wrapper and the operands before the command still count
  ['C: timeout -- 5 mkdir', `timeout -- 5 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['C: taskset --cpu-list 0 mkdir', `taskset --cpu-list 0 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['C: an unknown wrapper option still refuses', `nice -z mkdir ${OUT}`, 'allow', /wrapper an option the hook does not know/],
  // C: a command word that is not literal, with an operand, wherever the tokenizer reads
  ['C: a backtick command word', `\`echo mkdir\` ${OUT}`, 'allow', /not a literal/],
  ['C: a $(...) command word', `$(echo mkdir) ${OUT}`, 'refuse', /not a literal|not literal/],
  ['C: a $VAR command word', `$M ${OUT}`, 'refuse', /not a literal|not literal/],
  ['C: a quoted $VAR command word', `"$M" ${OUT}`, 'refuse', /not a literal|not literal/],
  ['C: a glob command word', `/bin/m?dir ${OUT}`, 'allow', /not a literal/],
  ['C: in source <(...)', `source <(echo '$M ${OUT}')`, 'allow', /not a literal/],
  ['C: in trap', `trap '$M ${OUT}' EXIT`, 'allow', /not a literal/],
  ['C: inside arithmetic', `echo $(( $($M ${OUT}) ))`, 'allow', /not a literal/],
  // round 6 item 1: a quoted value is still an assignment
  ['R6-1: X=\'a\' mkdir', `X='a' mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-1: X="a" mkfifo', `X="a" mkfifo ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-1: quoted prefix and a variable operand', `d=${OUT}; X='a' mkdir $d`, 'allow', /cannot be resolved/],
  ['R6-1: quoted prefix and a substitution operand', `X='a' mkdir $(echo ${OUT})`, 'allow', /substitution|cannot be resolved/],
  ['R6-1: quoted prefix before a wrapper', `X='a' nice mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-1: quoted prefix after time', `time X='a' mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-1: quoted prefix after then', `if true; then X='a' mkdir ${OUT}; fi`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-1: quoted prefix after !', `! X='a' mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-1: quoted prefix inside a group', `{ X='a' mkdir ${OUT}; }`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-1: quoted prefix inside a subshell', `( X='a' mkdir ${OUT} )`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-1: quoted prefix inside a function', `function f { X='a' mkdir ${OUT}; }; f`, 'allow', /writes '\.\.\/out\/F'/],
  // round 6 item 2: ((  )) that is two subshells
  ['R6-2: ((true)&&(mkdir --))', `((true)&&(mkdir -- ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-2: ((:)||(mkdir --))', `((:)||(mkdir -- ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-2: in $((', `echo $((:)&&(mkdir -- ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-2: in $( ((', `echo $( ((:)&&(mkdir -- ${OUT})) )`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-2: after if', `if ((:)&&(mkdir -- ${OUT})); then :; fi`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-2: after while', `while ((:)&&(mkdir -- ${OUT})); do break; done`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-2: inside { }', `{ ((:)&&(mkdir -- ${OUT})); }`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-2: a redirect in the second subshell', `((:)&&(: > ${OUT}))`, 'refuse', /writes '\.\.\/out\/F'/],
  // round 6 item 3: the count of the lead's writes does not decide
  ['R6-3: a counted write before the variable redirect', `echo $(echo x > /dev/null); (( x = 1<<2 ))\nf=${OUT}\necho q > $f`, 'allow', /cannot be resolved/],
  ['R6-3: tee', `echo $(echo x > /dev/null); (( x = 1<<2 ))\nf=${OUT}\ntee $f`, 'allow', /cannot be resolved/],
  ['R6-3: touch', `echo $(echo x > /dev/null); (( x = 1<<2 ))\nf=${OUT}\ntouch $f`, 'allow', /cannot be resolved/],
  ['R6-3: cp', `echo $(echo x > /dev/null); (( x = 1<<2 ))\nf=${OUT}\ncp a $f`, 'allow', /cannot be resolved/],
  ['R6-3: a function that writes through a later variable', `function g { tee $f; }; f=${OUT}; g`, 'allow', /cannot be resolved/],
  ['R6-3: f=impl.txt; tee $f (the roles no longer trust the lead\'s resolution)', 'f=impl.txt; tee $f', 'refuse', /cannot be resolved/],
  // round 6 item 4: any word with = before the command of env is an assignment
  ['R6-4: env a.b=1 tee', `env a.b=1 tee ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-4: env 1X=1 mkdir', `env 1X=1 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R6-4: env a-b=1 mkdir', `env a-b=1 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  // round 7 item 2: a disguised command word inside (( )) that is not arithmetic
  ['R7-2: m\\kdir', `((:)&&(m\\kdir -- ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: mk\'\'dir', `((:)&&(mk''dir -- ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: m"k"dir', `((:)&&(m"k"dir -- ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: /bin/m?dir', `((:)&&(/bin/m?dir -- ${OUT}))`, 'allow', /not a literal/],
  ['R7-2: n\\ice -- m\\kdir', `((:)&&(n\\ice -- m\\kdir ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: m\\kfifo', `((:)&&(m\\kfifo ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: a variable command word in $(( ))', `c='mkdir ${OUT}'; echo $((:)&&($c))`, 'allow', /not a literal/],
  ['R7-2: a variable command word in (( ))', `c='mkdir ${OUT}'; ((:)&&($c))`, 'refuse', /not a literal/],
  ['R7-2: in x=$()', `x=$( ((:)&&(m\\kdir -- ${OUT})) )`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: in backticks', `echo \`((:)&&(m\\kdir -- ${OUT}))\``, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: after if', `if ((:)&&(m\\kdir -- ${OUT})); then :; fi`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: in a pipe', `echo a | ((:)&&(m\\kdir -- ${OUT}))`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: in the background', `((:)&&(m\\kdir -- ${OUT})) &`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: in a case', `case x in x) ((:)&&(m\\kdir -- ${OUT}));; esac`, 'allow', /writes '\.\.\/out\/F'|case/],
  ['R7-2: in a for body', `for i in 1; do ((:)&&(m\\kdir -- ${OUT})); done`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-2: in bash -c', `bash -c '((:)&&(m\\kdir -- ${OUT}))'`, 'allow', /writes '\.\.\/out\/F'/],
  // round 7 item 3: env after --
  ['R7-3: env -- a.b=1 tee', `env -- a.b=1 tee ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-3: env -- 1X=1 mkdir', `env -- 1X=1 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-3: env -i -- 1X=1 mkdir', `env -i -- 1X=1 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-3: env -- -x=1 mkdir', `env -- -x=1 mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  // round 7 item 4
  ['R7-4: X+=a mkdir', `X+=a mkdir ${OUT}`, 'allow', /writes '\.\.\/out\/F'/],
  ['R7-4: a chain of 65 wrappers', `${'nice '.repeat(65)}mkdir ${OUT}`, 'allow', /more than 64 wrappers/],
  // D: aliases
  ['D: alias to a write program', 'alias m=mkdir', 'allow', /alias/],
  ['D: alias with options', "alias m='mkdir -p'", 'allow', /alias/],
  ['D: alias with a path and a write program', "alias w='tee ../out/F'", 'allow', /alias/],
  ['D: alias holding a redirect', "alias w='echo >'", 'allow', /alias/],
  ['D: shopt -s expand_aliases', 'shopt -s expand_aliases', 'allow', /expand_aliases/],
  ['D: shopt -s of several options', 'shopt -s extglob expand_aliases', 'allow', /expand_aliases/],
]);

for (const [name, command, leadExpected, pattern] of REFUSED) {
  test(`A274 ${name}: refused for both roles; the lead stays ${leadExpected}`, async () => {
    for (const [role, who, env] of ROLES) {
      const why = await pre(command, who, env);
      assert.ok(why, `${role}: allowed`);
      assert.match(why, pattern, `${role}: ${why}`);
    }
    const lead = await pre(command, {}, {});
    if (leadExpected === 'allow') assert.equal(lead, null, `the lead's verdict changed: ${lead}`);
    else assert.ok(lead, 'the lead no longer refuses this form');
  });
}

// Wrappers whose `--` the 0ef7c794 code already read correctly: kept so the four spellings of the finding stay pinned.
for (const wrapper of ['env', 'nice', 'command']) {
  test(`A274 C: ${wrapper} -- mkdir is refused for both roles (already on 0ef7c794)`, async () => {
    for (const [role, who, env] of ROLES) assert.ok(await pre(`${wrapper} -- mkdir ${OUT}`, who, env), `${role}: allowed`);
  });
}

/** Default usage: the same changes leave these allowed for both roles. */
const ALLOWED = [
  'echo $(grep -rn case src)',
  'echo $(echo esac)',
  "echo $(echo $'a')",
  "cat <(echo $'a')",
  'x=$(ls | grep -w case)',
  'echo "$(git log --grep case --oneline)"',
  "echo ${x:-$(echo $'a')}",
  'alias ll=\'ls -la\'',
  "alias gs='git status'",
  'shopt -s extglob',
  'shopt -u expand_aliases',
  'shopt expand_aliases',
  'unalias ll',
  'echo x > impl.txt',
  'echo x > $TMPDIR/a',
  'cd "$(git rev-parse --show-toplevel)"',
  'echo $VAR',
  'X=\'a\' echo hi',
  'echo $((1+2))',
  'echo $(( (1+2)*3 ))',
  '(( x = (1+2)*3 ))',
  'for ((i=0;i<3;i++)); do :; done',
  'for ((i=(0);i<3;i++)); do :; done',
  'echo "$HOME"',
  'ls 2>&1 | head',
  'echo hi > /dev/null',
  'env a.b=1 node a.js',
  'echo $(( (a+b) > 3 ))',
  'echo $(( (a) > (b) ))',
  'x=$(( (a) > (b) ? 1 : 2 ))',
  '(( (cd+1) * 2 ))',
  'x=$(( (1+2)*3 ))',
  '(( i++ ))',
  'for ((i=0;i<3;i++)); do node a.js; done',
  '(( (mkdir+1) * (tee) ))',
  'echo $(( $(date +%s) > 5 ))',
  'env -- A=1 node a.js',
  'X+=a echo hi',
  'nice nice nice node a.js',
  'function f { echo hi; }; f',
  'timeout 5 npm test',
  'for ((i=0;i<3;i++)); do echo $i; done',
  'if (( 1<<2 )); then echo ok; fi',
  'time npm test',
];
for (const command of ALLOWED) {
  test(`A274 (stays allowed, AC-4): ${JSON.stringify(command)}`, async () => {
    const [, implWho, implEnv] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
    const why = await pre(command, implWho, implEnv);
    if (command === 'echo x > $TMPDIR/a') assert.match(String(why), /outside the project/, 'the pinned TMPDIR is outside the project in this harness, so only the message is checked');
    else assert.equal(why, null, `implementer: ${why}`);
  });
}

// The direct rows: what the tokenizer returns, not only the verdict of the whole hook (a rule further on can mask a missing action).
/** @param {string} c @param {'target' | 'redir' | 'scan' | 'deny'} kind */
const of = (c, kind) => roleActions(c).actions.filter((a) => a.kind === kind);
/** @param {string} c */
const words = (c) => of(c, 'target').map((a) => (a.kind === 'target' ? a.word.v : ''));

test('A274 A: case and esac are keywords only at a command position', () => {
  for (const c of ['echo $(grep -rn case src)', 'echo $(echo esac)', 'echo $(echo case)', "echo $(echo $'a')", 'echo "$(echo $\'a\')"']) assert.deepEqual(roleActions(c).actions, [], c);
  assert.ok(of('echo $(case x in x) echo y;; esac)', 'deny').length > 0);
  assert.ok(of('echo $(then case x in x) echo y;; esac)', 'deny').length > 0);
  assert.ok(of('echo $(echo hi # )\nmkdir X)', 'deny').length > 0, 'an unquoted # inside $(...) is a comment in bash and eats the )');
  assert.equal(of('echo $(echo a#b)', 'deny').length, 0);
  assert.equal(words("echo $(echo $'a\\'b'; mkdir /etc/x)").join(), '/etc/x', 'the code after a $-quote string is read');
});

test('A274 B: the role pass returns the top-level redirects and the scanner-known writers itself', () => {
  const redirs = (/** @type {string} */ c) => of(c, 'redir').map((a) => (a.kind === 'redir' ? a.word.v : ''));
  assert.deepEqual(redirs(`(( x = 1<<2 ))\necho q > ${OUT}`), [OUT]);
  assert.deepEqual(redirs(`echo hi >> a && echo q 2> b &> c`), ['a', 'b', 'c']);
  assert.deepEqual(redirs('echo hi 2>&1 > /dev/null'), ['/dev/null']);
  assert.deepEqual(redirs('cat < in.txt'), []);
  const scans = (/** @type {string} */ c) => of(c, 'scan').map((a) => (a.kind === 'scan' ? a.text : ''));
  assert.deepEqual(scans(`function f { touch ${OUT}; }`), [`touch '${OUT}'`]);
  assert.deepEqual(scans(`coproc tee -a ${OUT}`), [`tee '-a' '${OUT}'`]);
  assert.deepEqual(scans('echo hi'), []);
  assert.deepEqual(scans('env X=1 cp a "b c"'), ["cp 'a' 'b c'"]);
});

test('A274 C: wrappers, assignments and the command word', () => {
  assert.deepEqual(words('timeout -- 5 mkdir x'), ['x']);
  assert.deepEqual(words('taskset --cpu-list 0 mkdir x'), ['x']);
  assert.deepEqual(words('taskset -c 0 mkdir x'), ['x']);
  assert.deepEqual(words('taskset -- 1 mkdir x'), ['x']);
  assert.deepEqual(words('chrt -- 1 mkdir x'), ['x']);
  assert.deepEqual(words('env -- mkdir x'), ['x']);
  assert.deepEqual(words('time A=1 mkdir x'), ['x']);
  assert.deepEqual(words('function f { A=1 B=2 mkdir x; }'), ['x']);
  assert.deepEqual(words('time -p env A=1 mkdir x'), ['x']);
  assert.ok(of('nice -z mkdir x', 'deny').length > 0, 'an unknown option of a wrapper still refuses');
  assert.ok(of('timeout --bogus 5 mkdir x', 'deny').length > 0);
  assert.ok(of('time CDPATH=x cd y; mkdir z', 'target').every((a) => a.kind === 'target' && a.bad), 'CDPATH after time moves the working directory');
  for (const c of ['$(echo mkdir) x', '`echo mkdir` x', '$M x', '"$M" x', '${M} x', '/bin/m?dir x', '{mkdir,true} x', "echo $($M x)", "trap '$M x' EXIT", 'source <(echo "$M x")', 'echo $(( $($M x) ))']) {
    assert.ok(of(c, 'deny').some((a) => a.kind === 'deny' && /not a literal/.test(a.why)), c);
  }
  for (const c of ['$M', '"$@"', 'echo $M x', '[ -f x ]', '[[ -n $x ]]', 'FOO=$(echo 1)', 'x=$(foo) true']) assert.equal(of(c, 'deny').length, 0, c);
  assert.ok(MAX_WRAPPERS === 64 && STEPS_PER_CHAR === 64 && STEPS_BASE === 4096, 'the named bounds keep their values');
  assert.equal(newGuard(10).budget, STEPS_PER_CHAR * 10 + STEPS_BASE);
});

test('A274 D: an alias for a write program, a redirect or an unreadable word, and expand_aliases, are refused', () => {
  const why = (/** @type {string} */ c) => of(c, 'deny').map((a) => (a.kind === 'deny' ? a.why : '')).join('|');
  for (const c of ['alias m=mkdir', "alias m='mkdir -p'", 'alias m=/bin/mkdir', "alias t='tee -a'", "alias w='echo >'", 'alias x=$Y', 'alias a=b m=cp']) assert.match(why(c), /alias/, c);
  for (const c of ['shopt -s expand_aliases', 'shopt -s extglob expand_aliases', 'shopt -qs expand_aliases']) assert.match(why(c), /expand_aliases/, c);
  for (const c of ['alias ll="ls -la"', "alias gs='git status'", 'alias', 'alias -p', 'shopt -s extglob', 'shopt -u expand_aliases', 'shopt expand_aliases', 'unalias m']) assert.equal(why(c), '', c);
});

// F: the old-style and the new-style tar forms, directly. A tar that extracts into a directory or creates an archive names a write target; the hook-level rows were masked by another rule.
test('A274 F: tar forms name their write target in the role actions', () => {
  assert.deepEqual(words('tar xf a -C /etc'), ['/etc']);
  assert.deepEqual(words('tar x -C /etc -f a'), ['/etc']);
  assert.deepEqual(words('tar xzf a --directory /etc'), ['/etc']);
  assert.deepEqual(words('tar c -f /etc/o a'), ['/etc/o']);
  assert.deepEqual(words('tar xf a -C$V'), ['$V']);
  assert.deepEqual(words('tar xf a.tar'), []);
  assert.deepEqual(words('tar -tf a.tar'), []);
});

// E: the regular expressions of normalForm (bash.mjs), merge.mjs and stash.mjs, linear and with the verdicts of the expressions they replace.
const S = ' \\t\\n\\v\\f\\r';
/** The expression of merge.mjs before A274. */
const OLD_MERGE = /(env|sudo|doas)[ \t\n\v\f\r]+([^;&|]*[ \t\n\v\f\r])?(-[A-Za-z]*[CD]|--chdir)/;
/** The expression of stash.mjs before A274 (per line). */
const OLD_STASH = new RegExp(`(^|[^A-Za-z0-9_.-])(env|sudo|doas)[${S}]+([^;&|]*[${S}])?(-[A-Za-z]*[CD]|--chdir|--chdir=)`);
/** normalForm of bash.mjs before A274. @param {string} cmd */
function oldNormalForm(cmd) {
  if (!/["'\\$]/.test(cmd)) return cmd;
  return cmd.split('\n').map((l) => l.replace(/["'\\]/g, '').replace(/\$\{[^}]*\}/g, '').replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '')).join('\n');
}

test('A274 E: normalForm, the merge expression and the stash expression give the old verdicts on 30000 seeded random strings', () => {
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const T = ['env', 'sudo', 'doas', ' ', '  ', '\t', '\n', '-C', '-D', '-x', '-iC', '-aD', '--chdir', '--chdir=/x', '-', '--', ';', '&', '|', 'a', 'xenv', '.', '_', 'x-', 'C', 'D', '-e', '"', "'", '\\', '${', '}', '$', '$A', '${A}', '-uC'];
  let hits = 0;
  for (let k = 0; k < 30000; k++) {
    let str = '';
    for (let j = 1 + Math.floor(rnd() * 14); j > 0; j--) str += T[Math.floor(rnd() * T.length)];
    const flat = str.replace(/\n/g, ' ');
    assert.equal(envChdirOpt(flat, false), OLD_MERGE.test(flat), JSON.stringify(flat));
    assert.equal(str.split('\n').some((l) => envChdirOpt(l, true)), str.split('\n').some((l) => OLD_STASH.test(l)), JSON.stringify(str));
    assert.equal(normalForm(str), oldNormalForm(str), JSON.stringify(str));
    if (OLD_MERGE.test(flat)) hits++;
  }
  assert.ok(hits > 300, `the generator reaches the match case (${hits})`);
});

test('A274 E: the known answers of the three expressions', () => {
  for (const [text, merge, stash] of /** @type {Array<[string, boolean, boolean]>} */ ([
    ['env -C /x git push', true, true], ['sudo -D /x ls', true, true], ['doas --chdir /x ls', true, true], ['env FOO=1 -C /x', true, true], ['env; -C', false, false],
    ['xenv -C /x', true, false], ['env', false, false], ['env -x', false, false], ['env a|-C', false, false], ['env a  -iD b', true, true], ['env -', false, false],
  ])) {
    assert.equal(envChdirOpt(text, false), merge, text);
    assert.equal(envChdirOpt(text, true), stash, text);
  }
  assert.equal(normalForm('echo ${A} "$B" $C'), 'echo   ');
  assert.equal(dropBraceVars('a${b}c${d'), 'ac${d');
});

test('A274 E: pathological inputs take a linear number of steps and give the old verdict', () => {
  const unclosed = '${'.repeat(110000);
  const probe = { steps: 0 };
  assert.equal(dropBraceVars(unclosed, probe), unclosed, 'nothing is removed when no } follows');
  assert.ok(probe.steps <= 2, `one search for the closing brace, not one per ${'${'} (${probe.steps})`);
  assert.equal(normalForm(unclosed), unclosed);
  const closed = '${a}'.repeat(50000);
  assert.equal(dropBraceVars(closed, { steps: 0 }), '');
  const envs = 'env '.repeat(36000);
  const p2 = { steps: 0 };
  assert.equal(envChdirOpt(envs, false, p2), false);
  assert.ok(p2.steps <= 8 * envs.length, `the scan visits the text a constant number of times (${p2.steps} for ${envs.length})`);
  const p3 = { steps: 0 };
  assert.equal(envChdirOpt(envs, true, p3), false);
  assert.ok(p3.steps <= 8 * envs.length, `${p3.steps}`);
  assert.equal(envChdirOpt(`${envs}-C x`, false), true, 'the option at the end of the long run is found');
  assert.equal(envChdirOpt(`${envs}; -C x`, false), false);
  assert.equal(envChdirOpt(`${'sudo '.repeat(20000)}--chdir=/x`, true), true);
  const bars = 'env -x |'.repeat(30000);
  const p4 = { steps: 0 };
  assert.equal(envChdirOpt(bars, false, p4), false);
  assert.ok(p4.steps <= 8 * bars.length, `${p4.steps}`);
});

// The two $-quote rows of review round 4 (A274 now reads the string): both roles allow them, and the lead's verdict is pinned to what 0ef7c794 gave.
for (const command of ["echo $(echo $'x')", "cat <(echo $'a')"]) {
  test(`A274 round 4 rows re-pinned: ${JSON.stringify(command)} is allowed for both roles and for the lead`, async () => {
    for (const [role, who, env] of ROLES) assert.equal(await pre(command, who, env), null, `${role}: refused`);
    assert.equal(await pre(command, {}, {}), null, 'the lead changed');
  });
}

test('A274 round 6: a quoted assignment value, odd env names and arithmetic-looking subshells in the role actions', () => {
  assert.deepEqual(words("X='a' mkdir x"), ['x']);
  assert.deepEqual(words('X="a b" Y=c mkdir x'), ['x']);
  assert.deepEqual(words('env a.b=1 1X=2 mkdir x'), ['x']);
  assert.deepEqual(words("'X'=a mkdir x"), [], "a quoted name is the command word, not an assignment");
  assert.deepEqual(words('((true)&&(mkdir -- x))'), ['x']);
  assert.deepEqual(words('echo $( ((:)&&(mkdir -- x)) )'), ['x']);
  for (const c of ['echo $((1+2))', '(( x = (1+2)*3 ))', 'for ((i=0;i<3;i++)); do :; done', 'echo $(( (1+2)*3 ))']) assert.deepEqual(roleActions(c).actions, [], c);
});

test('A274 round 7: isArithmetic decides by grammar', () => {
  const ok = ['1+2', '(a+b) > 3', '(a) > (b) ? 1 : 2', '(cd+1) * 2', 'i++', 'x = (1+2)*3', ' ', '', '0x1F + 010', 'a[1] + b', '$x + ${y} * $1', 'a, b', 'a <<= 2', '$(date) > 5', 'a ? b : c ? d : e', '~a', 'a[~5]'];
  const bad = [':)&&(mkdir -- ../x', 'mkdir x', 'a b', "m\\kdir x", "'a'", 'a; b', 'a\nb', '~', 'a : b', '(a', 'a)', '1 +', '..', 'a ? b', '`', 'x --'.concat(' ../y')];
  for (const t of ok) assert.equal(/** @type {any} */ (RW).isArithmetic(t), true, JSON.stringify(t));
  for (const t of bad) assert.equal(/** @type {any} */ (RW).isArithmetic(t), false, JSON.stringify(t));
});

// Security round 8: quotes and `#` protect nothing inside arithmetic text (bash expands every `$(...)` and backtick pair there), and valid arithmetic with expansions stays allowed.
const HIDDEN = [
  "echo $(( '$(mkdir ../out/F)' ))", "x=$(('`mkdir ../out/F`'))", "echo $(( 1 + '$(mkdir ../out/F)' ))", "(( '$(mkdir ../out/F)' ))",
  'echo "$(( \'$(mkdir ../out/F)\' ))"', "echo $[ '$(mkdir ../out/F)' ]",
  "echo $(( ${x:-'$(mkdir ../out/F)'} ))", "echo $(( 1 + $((:)&&(mkdir ../out/F)) ))",
];
for (const command of HIDDEN) {
  test(`A274 round 8: a substitution hidden by a quote or # in arithmetic is judged: ${JSON.stringify(command)}`, async () => {
    assert.ok(of(command, 'target').some((a) => a.kind === 'target' && a.word.v === OUT), 'the role actions hold the write');
    for (const [role, who, env] of ROLES) assert.match(String(await pre(command, who, env)), /writes '\.\.\/out\/F'|outside/, `${role}: allowed`);
  });
}

const ARITH_ALLOWED = [
  'echo $((10#$x))', 'echo $((10#${m}))', 'echo $((0x$h))', 'x=$((16#ff$y))', 'echo $(( "$x" + 1 ))', 'echo $(( "1 + $x" ))', 'echo $(( $x + $(( $y * 2 )) ))', 'echo "$(( (a+b)*2 ))"',
  'echo $(( $[a+1] ))', 'echo $(( $10 + 1 ))', 'echo $((1+2)) $(( 0x1F + 010 )) $(( i++ )) $(( a, b )) $(( a ? 1 : 2 ))', 'echo $(( $# + ${x:-1} + RANDOM + ${#arr[@]} ))',
  'for ((i=0;i<3;i++)); do :; done', '(( i++ ))', 'x=$(( (a+b) > 3 ))', 'echo $(( $(date +%s) > 5 ))', "echo \"$(grep '$(foo)' f)\"",
];
for (const command of ARITH_ALLOWED) {
  test(`A274 round 8: valid arithmetic with expansions is allowed: ${JSON.stringify(command)}`, async () => {
    assert.deepEqual(roleActions(command).actions, []);
    const [, implWho, implEnv] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
    assert.equal(await pre(command, implWho, implEnv), null);
  });
}

test('A274 round 8: isArithmetic grammar covers base prefixes, quoted expansions, $[ ] and positional parameters', () => {
  const ok = ['10#$x', '0x$h', '16#ff$y', '"$x" + 1', '$x + $(( $y * 2 ))', '$[a+1]', '$10 + 1', '${10}'];
  const bad = ["'abc'", "1 + 'x'", '"a b"', '$[a+', '10#', '"$x', '$'];
  for (const t of ok) assert.equal(/** @type {any} */ (RW).isArithmetic(t), true, JSON.stringify(t));
  for (const t of bad) assert.equal(/** @type {any} */ (RW).isArithmetic(t), false, JSON.stringify(t));
});

// Security rounds 9 and 10: a `((` whose closing `))` cannot be placed with certainty (a `#` or `<<` marker, `${y:-;)`, a case `)`, quotes, no `))` at the end) is refused for the roles, with the rewrite hint; the lead is not asked.
// Before, the rest of the text was scanned for substitutions only: a plain command after the `))` hidden by a `#` or `<` ran unseen, and an ordinary quoted `$(` after a placed `))` was refused.
const UNPLACED = [
  'while ((# $(mkdir ../out/F) ${y:-;)); do break; done', 'if (( # $(mkdir ../out/F) <<X\n )); then :; fi', "for ((;'$(mkdir ../out/F)' <<X\n;)); do break; done",
  '(( # $(case 1 in 1) :;; esac) + $(mkdir ../out/F) ))',
  'if (( # )); then :; fi; mkdir ../out/F', '((; # ));mkdir ../out/F#', '(( 1 <<X\n)) ; mkdir ../out/F\nX', '(( < ))\nmkdir ../out/F',
  "((cd a; ls) | wc -l); git commit -m 'feat: handle $( in parser'", 'time ((<<X))\nmkdir ../out/F', 'time (( # )) ; mkdir ../out/F', 'for ((i=0;i<1;#$(mkdir ../out/F))); do :; done', "for ((i=0;i<1;'$(mkdir ../out/F)')); do :; done",
];
UNPLACED.forEach((command, k) => {
  test(`A274 round 10 #${k}: an unplaceable (( is refused for both roles with the hint: ${JSON.stringify(command)}`, async () => {
    assert.ok(roleActions(command).actions.some((a) => a.kind === 'deny'), 'the role actions hold a refusal');
    for (const [role, who, env] of ROLES) assert.match(String(await pre(command, who, env)), /whose end cannot be placed: write a space after the first "\(" for a nested subshell, or simplify the arithmetic/, `${role}: allowed`);
  });
});

// Security round 11: an unquoted `((` that is not part of `$((` is arithmetic or nested subshells whatever precedes it (a keyword, also glued to it, `time`, `!`, `{`, `coproc`, a function header).
const M11 = '\nmkdir ../out/F';
const ANYWHERE = [
  '{ time ((<<X))' + M11 + '\n}', '{ time -p ((; # ));mkdir ../out/F#\n}', 'if :; then time ((<<X))' + M11 + '\nfi', 'for i in 1; do time ((<<X))' + M11 + '\ndone', '{ time (( < ))' + M11 + '\n}',
  'time((<<X))' + M11, 'time -p((<<X))' + M11, 'time ! ((<<X))' + M11, '! time (( # )) ; mkdir ../out/F', 'if :; then time ((# ))' + M11 + '\nfi',
  'if((<<X))' + M11 + '\nthen :; fi', 'while((<<X))' + M11 + '\ndo break; done', 'until((<<X))' + M11 + '\ndo break; done', '!((<<X))' + M11, 'for((<<X))' + M11, 'then((<<X))' + M11, 'do((<<X))' + M11, '{((<<X))' + M11 + '\n}',
  '{ for ((<<X))' + M11 + '\n}', 'if :; then for ((<<X))' + M11 + '\nfi', '! time ((<<X))' + M11, 'coproc ((<<X))' + M11, 'function f ((<<X))' + M11, 'time -- ((<<X))' + M11, 'time time ((<<X))' + M11,
];
ANYWHERE.forEach((command, k) => {
  test(`A274 round 11 #${k}: a (( is read by the same rule wherever it stands: ${JSON.stringify(command)}`, async () => {
    assert.ok(roleActions(command).actions.some((a) => a.kind === 'deny'), 'the role actions hold a refusal');
    for (const [role, who, env] of ROLES) assert.match(String(await pre(command, who, env)), /whose end cannot be placed/, `${role}: allowed`);
    assert.equal(await pre(command, {}, {}), null, 'the lead is not asked');
  });
});

// The `;;` of an empty `for ((;;))` part is no case terminator; a real case pattern list is still a doubt.
const EMPTY_PARTS = ['for ((;;)); do break; done', 'for ((i=0;;i++)); do break; done', 'for ((;;i++)); do break; done', 'for ((i=0;;)); do break; done', 'for (( ; ; )); do break; done', 'if((x));then :;fi', 'time((x))', '!((x))'];
EMPTY_PARTS.forEach((command, k) => {
  test(`A274 round 11 #${k}: an empty for-header part or a glued keyword is allowed: ${JSON.stringify(command)}`, async () => {
    assert.deepEqual(roleActions(command).actions.filter((a) => a.kind === 'target' || a.kind === 'deny'), []);
    const [, implWho, implEnv] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
    assert.equal(await pre(command, implWho, implEnv), null);
  });
});

test('A274 round 11: a real case pattern list inside a substitution is still a doubt', () => {
  assert.ok(roleActions('echo $(case 1 in 1) :;; esac)').actions.some((a) => a.kind === 'deny'));
});

// A placed `))` ends the arithmetic: the text after it is read normally, quotes and all.
const PLACED = [
  '(( i++ )) && echo "it\'s done"', "for ((i=0;i<3;i++)); do echo '$(not code)'; done", 'echo $((1+2))', 'x=$(( (a+b) > 3 ))', "A='b c' node a.js", 'echo $((10#$x)) $((16#ff$y))', 'echo $(( a$i ))',
  'time (( i++ ))', "(( i++ )); git commit -m 'feat: handle $( in parser'", "((i++)); grep -n '$(' f.txt", "(( x = 1 )); sed 's/`//g' f",
];
PLACED.forEach((command, k) => {
  test(`A274 round 10 #${k}: a placed (( )) is allowed and the text after it is read normally: ${JSON.stringify(command)}`, async () => {
    assert.deepEqual(roleActions(command).actions.filter((a) => a.kind === 'target' || a.kind === 'deny'), []);
    const [, implWho, implEnv] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
    assert.equal(await pre(command, implWho, implEnv), null);
  });
});

test('A274 round 10: the lead is not asked about an unplaceable ((', async () => {
  for (const command of UNPLACED) assert.equal(await pre(command, {}, {}), null, JSON.stringify(command));
});

for (const command of ['echo $(( a$i ))', 'echo $(( $x$y ))', 'echo $(( ${x}0 ))', 'echo $(( count_$name + 1 ))', 'echo $(( a[~5] ))', 'echo $(( a$i[1] + 1 ))', 'echo $(( x$i++ ))', 'for ((i=0;i<n$k;i++)); do :; done', '(( x = 1<<2 )); echo ok']) {
  test(`A274 round 9: juxtaposed expansions in arithmetic are allowed: ${JSON.stringify(command)}`, async () => {
    assert.deepEqual(roleActions(command).actions, []);
    const [, implWho, implEnv] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (ROLES[0]);
    assert.equal(await pre(command, implWho, implEnv), null);
  });
}

// Security round 12 (A274, last round): three bypasses of the `((` code. Each row writes `../out/F` in real bash 3.2 and 5 (the first line `V=../out` hides the target), is refused for both roles
// and keeps the lead's verdict of a5a489bd (the second field: 'allow' or 'refuse').
const V12 = 'V=../out\n';
const ROUND12 = /** @type {Array<[string, string, 'allow' | 'refuse']>} */ ([
  // 1: the body of a `for ((...))` loop is judged like any body (`do`, `{`), not dropped
  ['for-do', V12 + 'for ((;;)) do mkdir $V/F; break; done', 'allow'],
  ['for-brace', V12 + 'for ((;;)) { mkdir $V/F; break; }', 'allow'],
  ['for-three-parts', V12 + 'for ((i=0;i<1;i++)) do mkdir $V/F; done', 'allow'],
  ['for-newline-do', V12 + 'for ((;;))\ndo mkdir $V/F; break; done', 'allow'],
  ['for-cp', V12 + 'for ((;;)) do cp /etc/hosts $V/F; break; done', 'refuse'],
  ['for-tee', V12 + 'for ((;;)) do tee $V/F </dev/null; break; done', 'refuse'],
  // 2: a backslash-newline between the two parentheses joins them into `((`
  ['cont-comment', V12 + '(\\\n( # )) ; mkdir $V/F', 'allow'],
  ['cont-heredoc', V12 + '(\\\n(<<X))\nmkdir $V/F', 'allow'],
  ['cont-time', V12 + 'time (\\\n(<<X))\nmkdir $V/F', 'allow'],
  ['cont-brace', V12 + '{ (\\\n( # )) ; mkdir $V/F; }', 'allow'],
  ['cont-redirect-heredoc', V12 + '(\\\n(<<X))\necho x > $V/F', 'allow'],
  ['cont-two-in-a-row', V12 + '(\\\n\\\n( # )) ; mkdir $V/F', 'allow'],
  // 3: `((` after `=` is read by the same rule (bash discards the syntax-error line and runs the next one)
  ['eq-heredoc', V12 + 'x=((<<X))\nmkdir $V/F', 'allow'],
  ['eq-echo', V12 + 'echo a=((<<X))\nmkdir $V/F', 'allow'],
  ['eq-comment', V12 + 'x=(( # )) ; mkdir $V/F', 'allow'],
]);
ROUND12.forEach(([name, command, leadExpected]) => {
  test(`A274 round 12 ${name}: refused for both roles, the lead stays ${leadExpected}: ${JSON.stringify(command)}`, async () => {
    for (const [role, who, env] of ROLES) assert.ok(await pre(command, who, env), `${role}: allowed`);
    const lead = await pre(command, {}, {});
    if (leadExpected === 'allow') assert.equal(lead, null, `the lead's verdict changed: ${lead}`);
    else assert.ok(lead, 'the lead no longer refuses this form');
  });
});

// Allowed rows stay allowed: harmless loop bodies, ordinary arithmetic, assignments and line continuations in ordinary commands.
const ROUND12_OK = [
  'for ((;;)); do break; done', 'for ((i=0;i<3;i++)) do echo $i; done', 'for ((i=0;i<3;i++)) { echo $i; }', 'for ((;;))\ndo break; done', 'x=$((1+2))', 'y=$(( (a+b)*2 ))', 'a=b', 'echo a=1',
  'git commit -m "a" \\\n --amend', 'node a.js \\\n --flag', '(( i++ ))', 'echo $((1+2))', '(\\\n a; b)', 'x=1\n(( x++ ))',
];
ROUND12_OK.forEach((command, k) => {
  test(`A274 round 12 allowed #${k}: ${JSON.stringify(command)}`, async () => {
    for (const [role, who, env] of ROLES) assert.equal(await pre(command, who, env), null, `${role}: refused`);
    assert.equal(await pre(command, {}, {}), null);
  });
});

// Security round 13 (A274): a `))` glued to a backslash-newline, a word or a quote is not placed (bash reports the syntax error at the `(` and runs the next physical line), and `=(` followed by a here-document or comment marker is refused.
const ROUND13 = [
  'export x=((1))\\\nmkdir $V/F', 'export x=((1))\\\n mkdir $V/F', 'declare x=((1))\\\nmkdir $V/F', 'local x=((1))\\\nmkdir $V/F', 'readonly x=((1))\\\nmkdir $V/F', 'typeset x=((1))\\\nmkdir $V/F',
  'declare -a x=((1))\\\nmkdir $V/F', 'export x=((1))\\\nsh -c "mkdir $V/F"', 'export x=((1))\\\n sh -c "mkdir $V/F"', 'echo a=((1))\\\nmkdir $V/F', 'let x=((1))\\\nmkdir $V/F', '(( 1 ))\\\nmkdir $V/F',
  'x=(<<X)\nmkdir $V/F', 'x=( # c\nmkdir $V/F\n)',
].map((x) => V12 + x);
ROUND13.forEach((command, k) => {
  test(`A274 round 13 #${k}: refused for both roles, the lead stays allowed: ${JSON.stringify(command)}`, async () => {
    for (const [role, who, env] of ROLES) assert.ok(await pre(command, who, env), `${role}: allowed`);
    assert.equal(await pre(command, {}, {}), null, 'the lead verdict changed');
  });
});
for (const command of ['y=(a b c)', 'export A=1', 'echo "a=((1))"', 'declare -a arr=(a b)', 'x=$((1+2)); export x']) {
  test(`A274 round 13 allowed: ${JSON.stringify(command)}`, async () => {
    for (const [role, who, env] of ROLES) assert.equal(await pre(command, who, env), null, `${role}: refused`);
    assert.equal(await pre(command, {}, {}), null);
  });
}
