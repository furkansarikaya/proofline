// @ts-check
// A278 round 4 (issue #264, AC-5, AC-6 and the case part of AC-7): on a volume that folds case a command is judged a second time in the LOWER-CASE WORLD: the whole text folded as it stands (no parsing of
// words, quotes, here-documents or command positions) against a context folded the same way. A case variant therefore gets, by construction, the verdict of its lower-case twin at every position, in every
// embedding, whatever the parser does with the text. These tests hold that: the divergence matrix (0 divergences), the legitimate writes of every role (0 flips against the exact pass alone), ordinary
// commands (0 flips except the accepted prose class, which is judged like its lower-case form), projects with capitals in their path, the context fold, and the cost of large inputs (sizes, never wall time).
// Every generator is seeded; every project is a unique temp folder removed at the end; no test waits.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTemplate, copyProject, rmSync, cleanEnv, runHook } from './harness.mjs';
import { fold, realProbe } from '../../adapters/claude/hooks/lib/fscase.mjs';
import { hookDir, FOLDS, KEEPS, onVolume, WHO, FIVE, pre, U, rng, aliasFolded, dropAliases } from './case-kit.mjs';

const { foldCtx, foldWorld, stateOf } = await import(pathToFileURL(join(hookDir, 'guards/kit.mjs')).href);

let template = ''; let base = '';
let dir = ''; // run LC
let t3 = ''; // run T-3, owns.conf, a registered worktree under Wt/
let wtBase = ''; let wt = '';
let rtkProj = ''; let rtkEnv = /** @type {Record<string, string>} */ ({});
before(() => {
  template = buildTemplate(); base = tempDir('hook-world-'); aliasFolded(base);
  dir = copyProject(template, base);
  t3 = copyProject(template, base);
  renameSync(join(t3, '.agents/runs/LC'), join(t3, '.agents/runs/T-3'));
  cpSync(join(t3, 'tasks/LC.md'), join(t3, 'tasks/T-3.md'));
  for (const f of ['.agents/local/ACTIVE_RUN', '.agents/runs/T-3/TASK.md', '.agents/runs/T-3/RUN.yaml']) writeFileSync(join(t3, f), readFileSync(join(t3, f), 'utf8').replace(/id: LC\b/, 'id: T-3').replace(/^LC$/m, 'T-3').replace(/\bLC\b/g, 'T-3'));
  appendFileSync(join(t3, '.agents/owns.conf'), 'qa QA_PLAN.md QA_REPORT.md reports/ reviews/test-trust/qa/\nimplementer /src/ /Make /Install/ /docs/\ndesigner /docs/ /Make\nreviewer reports/ REVIEW.md\n');
  wtBase = join(base, 'Wt'); mkdirSync(wtBase);
  wt = join(wtBase, 'W1');
  const g = spawnSync('git', ['-C', t3, 'worktree', 'add', '-q', '-b', 'wt-t3', wt], { env: cleanEnv({}), encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  wt = realpathSync.native(wt); wtBase = realpathSync.native(wtBase);
  aliasFolded(wtBase); aliasFolded(wt);
  mkdirSync(join(wt, '.agents/runs/T-3'), { recursive: true });
  rtkProj = copyProject(template, base);
  mkdirSync(join(rtkProj, '.claude'), { recursive: true });
  writeFileSync(join(rtkProj, '.claude/settings.json'), '{"hooks":{"PreToolUse":"rtk"}}');
  const bin = join(base, 'bin'); mkdirSync(bin); writeFileSync(join(bin, 'rtk'), '#!/bin/sh\n'); chmodSync(join(bin, 'rtk'), 0o755);
  rtkEnv = { PATH: `${bin}:${process.env.PATH}` };
});
after(() => { dropAliases(); rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

// ---- (a) the divergence matrix ----

/** Option names are case-sensitive in every program (`-F` is not `-f`): a variant spells the words, not the options. @param {string} s @param {(w: string) => string} f */
const words = (s, f) => s.replace(/\S+/g, (w) => (w.startsWith('-') ? w : f(w)));
/** @param {string} s */ const caps = (s) => words(s, (w) => w.replace(/\b[a-z]/g, (c) => c.toUpperCase()));
/** @param {string} s */ const upper = (s) => words(s, (w) => w.toUpperCase());
/** a seeded random case for every letter @param {string} s @param {() => number} r */
const mixed = (s, r) => words(s, (w) => w.replace(/[a-z]/g, (c) => (r() < 0.5 ? c.toUpperCase() : c)));

/** Every place a command can sit; C is the command (no quote characters in it). */
const EMBED = /** @type {Array<[string, (c: string) => string]>} */ ([
  ['top level', (c) => c],
  ['after a wrapper', (c) => `nohup ${c}`],
  ['find -exec', (c) => `find . -maxdepth 0 -exec ${c} \;`],
  ['xargs', (c) => `echo 1 | xargs ${c}`],
  ['sh -c', (c) => `sh -c '${c}'`],
  ['substitution', (c) => `echo $(${c})`],
  ['backticks', (c) => `echo \`${c}\``],
  ['unquoted here-document with a substitution', (c) => `cat <<EOF\n$(${c})\nEOF`],
  ['quoted here-document body', (c) => `cat <<'EOF'\n${c}\nEOF`],
  ['commit message heredoc with a substitution', (c) => `git commit -m "$(cat <<EOF\n$(${c})\nEOF\n)"`],
  ['${x:-<<A} then the command', (c) => `echo \${x:-<<A}\n${c}`],
  ["$'a\\'b <<A' then the command", (c) => `echo $'a\\'b <<A'\n${c}`],
  ['(( 1<<A )) then the command', (c) => `(( 1<<A ))\n${c}`],
  ['$[1<<A] then the command', (c) => `echo $[1<<A]\n${c}`],
  ['CRLF', (c) => `echo hi\r\n${c}\r\n`],
]);

/** [family, the lower-case command (denied for some roles), project/env override] */
const FAMILIES = /** @type {Array<[string, string, boolean?]>} */ ([
  ['process killer', U('pki@ll foo')], ['process killer by name', U('killal@l node')], ['kill fed by a search', U('ki@ll -9 $(pg@rep node)')],
  ['git stash', 'git stash'], ['git on the live tree', 'git reset --hard'],
  ['push to the protected branch', U('g@it push origin ma@in')], ['force the protected branch', U('g@it branch -f ma@in head')],
  ['agent.sh approve', 'sh .agents/scripts/agent.sh approve t-1'],
  ['dispatch nonce path', 'cat .agents/local/dispatch/x'], ['dispatch nonce find', 'find .agents/local -type f'],
  ['node on the control plane', 'node .agents/scripts/core/x.mjs'],
  ['database migrate', 'python3 manage.py migrate'], ['prisma migrate', 'npx prisma migrate reset'],
  ['write to the git hooks', 'echo x > .agents/githooks/y'], ['write to the runtime settings', 'touch .claude/settings.json'], ['write to a run state folder', 'echo x > .agents/runs/lc/ci-fix/x'],
  ['write outside the project', 'touch ../outside.txt'],
  ['evidence command through rtk', 'npm test', true],
]);

test('A278 round 4 divergence matrix (volume folds case): a case variant of a denied command gets the verdict of its lower-case twin in every embedding, for the lead and four roles', async () => {
  const r = rng(264_401);
  /** @type {string[]} */ const divergences = [];
  let cells = 0; let deniedTwins = 0; const familyDenied = new Map();
  await onVolume(FOLDS(), async () => {
    for (const [family, lower, viaRtk] of FAMILIES) {
      for (const [role, who, env] of FIVE) {
        const proj = viaRtk ? rtkProj : dir; const e = viaRtk ? { ...env, ...rtkEnv } : env;
        for (const [embName, wrap] of EMBED) {
          const twin = await pre('Bash', { command: wrap(lower) }, who, e, proj);
          if (twin !== null) { deniedTwins++; familyDenied.set(family, (familyDenied.get(family) ?? 0) + 1); }
          for (const spell of [caps(lower), upper(lower), mixed(lower, r)]) {
            if (spell === lower) continue;
            const c = wrap(spell);
            const v = await pre('Bash', { command: c }, who, e, proj);
            cells++;
            if ((v === null) !== (twin === null)) divergences.push(`${family} | ${role} | ${embName} | ${JSON.stringify(spell)}: variant ${v === null ? 'allowed' : 'refused'}, twin ${twin === null ? 'allowed' : 'refused'}`);
          }
        }
      }
    }
  });
  assert.ok(cells >= 3000, `the matrix has ${cells} cells`);
  assert.ok(deniedTwins >= 300, `the matrix contains denied twins (${deniedTwins})`);
  for (const [family] of FAMILIES) assert.ok((familyDenied.get(family) ?? 0) > 0, `the family ${family} has a denied twin for some role and embedding (fix the table)`);
  assert.deepEqual(divergences.slice(0, 12), [], `${divergences.length} divergences of ${cells} cells`);
});

test('A278 round 4 (volume folds case): the rtk bypass keeps its meaning in a cased command', async () => {
  const [, who, env] = WHO[0];
  const e = { ...env, ...rtkEnv };
  await onVolume(FOLDS(), async () => {
    assert.ok(await pre('Bash', { command: 'npm test' }, who, e, rtkProj), 'the evidence command is refused without the bypass (fix the table)');
    assert.equal(await pre('Bash', { command: 'RTK_DISABLED=1 npm test' }, who, e, rtkProj), null);
    assert.ok(await pre('Bash', { command: 'Npm Test' }, who, e, rtkProj), 'a cased program is the program');
    assert.equal(await pre('Bash', { command: 'RTK_DISABLED=1 Npm Test' }, who, e, rtkProj), null);
  });
});

test('(regression guard: passes without the fix) A278 round 4 (volume keeps case): the same variants are other programs and other files there, no second pass runs, nothing is refused for the case', async () => {
  await onVolume(KEEPS(), async () => {
    for (const [role, who, env] of FIVE) {
      for (const c of ['Make all', 'Python3 -c 1', 'Rscript x.R', 'JAVA -version', 'Git status', 'Manage.py migrate', 'Npx Prisma migrate reset', 'git log Main','Pkill foo', 'Touch s.txt']) {
        for (const [embName, wrap] of [EMBED[0], EMBED[5], EMBED[8], EMBED[10]]) {
          assert.equal(await pre('Bash', { command: wrap(c) }, who, env, dir), null, `${role}, ${embName}: ${JSON.stringify(c)} is refused on a volume that keeps case`);
        }
      }
    }
  });
});

// ---- (b) the legitimate writes of every role ----

const BODY = 'Install the Make target\nSource Time Command Script Go Cat\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01154uSCGRtcwmouJ68QRffm';
/** [roles by index into FIVE, the command, must be allowed (on both volumes)] */
const LEGIT = /** @type {Array<[number[], string, boolean]>} */ ([
  [[0], 'echo x > .agents/runs/T-3/EVIDENCE.md', true],
  [[0], "cat > .agents/runs/T-3/EVIDENCE.md <<'EOF'\n# Evidence: T-3\n- Base SHA: 93b0158\nInstall Make Source\nEOF", true],
  [[0], 'echo x > .agents/runs/T-3/COMPLETION_REPORT.md', true],
  [[0], 'cat > .agents/runs/T-3/COMPLETION_REPORT.md <<EOF\nDone: Install Make Source Time\nEOF', true],
  [[0], 'echo x > .agents/runs/T-3/scratch/Notes.TXT', true],
  [[0], 'echo x > .agents/local/assignments/T-3-implementer.md', true],
  [[0], 'echo x > .agents/runs/T-3/reports/001-debug.md', false],
  [[0], `git commit -m "$(cat <<'EOF'\n${BODY}\nEOF\n)"`, true],
  [[0], `gh pr create --title t --body "$(cat <<'EOF'\n${BODY}\nEOF\n)"`, true],
  [[0], `bash -c 'cat <<EOF\n${BODY}\nEOF'`, true],
  [[0], `git commit -F - <<'EOF'\n${BODY}\nEOF`, true],
  [[0], 'cat <<EOF > notes.txt\nInstall Make\nEOF', false],
  [[1], 'echo x > src/greet.js', true], [[1], "cat > src/greet.js <<'EOF'\nExport Default Go\nEOF", true], [[1, 2], 'echo x > src/Greet.js', false], [[2], 'echo x > docs/Guide.md', true],
  [[1, 2], 'echo x > .agents/runs/T-3/scratch/out.txt', true],
  [[1, 2], `git commit -m "$(cat <<'EOF'\n${BODY}\nEOF\n)"`, false], [[1, 2], 'cat <<EOF > notes.txt\nInstall Make\nEOF', false],
  [[3], 'echo x > .agents/runs/T-3/reports/001-r.md', true], [[3], 'echo x > .agents/runs/T-3/scratch/o.txt', true],
  [[4], 'echo x > .agents/runs/T-3/QA_PLAN.md', true], [[4], 'cat > .agents/runs/T-3/QA_REPORT.md <<\'EOF\'\nQA: Install Make Source\nEOF', true],
  [[4], 'echo x > .agents/runs/T-3/scratch/o.txt', true],
  [[0, 1, 2, 3, 4], `echo "$(cat <<EOF\n${BODY}\nEOF\n)"`, false],
]);
test('A278 round 4: foldWorld is fold of the whole text except the spellings every program reads in the exact case (option names, variable names, HEAD)', () => {
  const cases = /** @type {Array<[string, string]>} */ ([
    ['Git -C /Tmp/Wt-RO Checkout -- X', 'git -C /tmp/wt-ro checkout -- x'], ['RTK_DISABLED=1 Npm Test', 'RTK_DISABLED=1 npm test'], ['Cat $TMPDIR/X ${HOME}/Y', 'cat $TMPDIR/x ${HOME}/y'],
    ['Git Reset --hard HEAD~1', 'git reset --hard HEAD~1'], ['Git --Git-Dir=.AGENTS/Local Status', 'git --Git-Dir=.agents/local status'], ['Sed -iAGENT.SH X', 'sed -iagent.sh x'],
    ['Echo ß ſh', 'echo ss sh'], ['Ls -R Src/X-C', 'ls -R src/x-c'],
    // structure: the same characters in the same places, whatever the parser makes of them
    ['Cat <<EOF\n$(Xx Y)\nEOF\r\nEcho ${x:-<<A}\nGit', 'cat <<eof\n$(xx y)\neof\r\necho ${x:-<<a}\ngit'],
  ]);
  for (const [a, b] of cases) assert.equal(foldWorld(a), b, a);
  assert.equal(foldWorld('echo hi\n'), 'echo hi\n');
});

const WT_LEGIT = /** @type {Array<[string, string]>} */ ([
  ['redirect QA_PLAN', `cat > ${'$W'}/.agents/runs/T-3/QA_PLAN.md <<'EOF'\n# QA plan\nInstall Make\nEOF`],
  ['redirect QA_REPORT', `echo x > ${'$W'}/.agents/runs/T-3/QA_REPORT.md`],
  ['cd then QA_PLAN', `cd ${'$W'}/.agents/runs/T-3 && cat > QA_PLAN.md <<'EOF'\n# QA plan\nEOF`],
  ['cd then QA_REPORT', `cd ${'$W'}/.agents/runs/T-3 && echo x > QA_REPORT.md`],
  ['git -C on the evidence worktree', `git -C ${'$W'} checkout -- README.md`], ['git -C stash list', `git -C ${'$W'} stash list`],
]);

/** the verdict with the second pass on (the folding volume) and, as the reference, the exact pass alone (the case-keeping volume) @param {string} c @param {number} wi */
async function onOff(c, wi) {
  const [, who, env] = /** @type {typeof WHO[number]} */ (FIVE[wi]);
  const e = { ...env, TMPDIR: wtBase };
  const on = await onVolume(FOLDS(), () => pre('Bash', { command: c }, who, e, t3));
  const off = on === null ? null : await onVolume(KEEPS(), () => pre('Bash', { command: c }, who, e, t3));
  return { on, off };
}

test('(regression guard: passes without the fix) A278 round 4 legitimate writes (volume folds case): the scope writes, artifacts and commit forms of all five roles get the verdict of the case-keeping volume (0 flips), run id T-3, owns.conf present', async () => {
  let allowed = 0; let flips = 0; const roles = new Set();
  for (const [wis, c, must] of LEGIT) {
    for (const wi of wis) {
      const { on, off } = await onOff(c, wi);
      if (on === null) { allowed++; roles.add(wi); continue; } // the second pass only adds refusals: an allowed verdict is the verdict of the exact pass
      if (off === null) { flips++; assert.fail(`${FIVE[wi][0]}: ${JSON.stringify(c)}: allowed without the second pass, refused with it (${on})`); }
      assert.ok(!must, `${FIVE[wi][0]}: ${JSON.stringify(c)} must be allowed (fix the table): ${on}`);
    }
  }
  const wtCmds = WT_LEGIT.map(([n, c]) => [n, c.replaceAll('$W', wt)]);
  for (const [n, c] of wtCmds) {
    const { on, off } = await onOff(/** @type {string} */ (c), 4);
    assert.equal(on, off, `qa in the registered worktree, ${n}: with ${on === null ? 'allowed' : 'refused'}, without ${off === null ? 'allowed' : 'refused'} (${on})`);
  }
  assert.equal(flips, 0);
  const wtOk = await onOff(`git -C ${wt} checkout -- README.md`, 4);
  assert.equal(wtOk.on, null, `qa: git -C in a registered evidence worktree is allowed with the second pass on (${wtOk.on})`);
  assert.ok(allowed >= 20 && roles.size === 5, `the table allows something for every role (${allowed} allowed, roles ${[...roles].join(',')})`);
});

test('(regression guard: passes without the fix) A278 round 4 legitimate writes: a run id and artifact names of any case, written in the exact case, with the second pass on and off (T-3 and LC), and the protected variants stay refused', async () => {
  const targets = ['.agents/runs/T-3/EVIDENCE.md', '.agents/runs/T-3/TASK.md', '.agents/runs/T-3/QA_PLAN.md', '.agents/runs/T-3/reports/001-debug.md', '.agents/runs/T-3/scratch/Notes.TXT', '.agents/local/assignments/T-3/Spec.md', 'src/greet.js', 'src/Greet.js', 'docs/Guide.md', 'impl.txt', 'Make', 'Install/x'];
  const forms = [(/** @type {string} */ t) => `echo x > ${t}`, (t) => `cat > ${t} <<'EOF'\nBody Make\nEOF`, (t) => `mkdir -p ${t.replace(/[^/]*$/, '')} && tee ${t} < /dev/null`];
  let n = 0;
  for (let wi = 0; wi < FIVE.length; wi++) {
    for (const t of targets) for (const f of forms) { const { on, off } = await onOff(f(t), wi); n++; assert.ok(on === null || off !== null, `${FIVE[wi][0]}: ${JSON.stringify(f(t))}: ${on}`); }
  }
  assert.ok(n >= 150);
  await onVolume(FOLDS(), async () => {
    for (const [role, who, env] of FIVE) {
      for (const c of ['echo x > .AGENTS/runs/T-3/CI-FIX/x.md', 'echo x > .agents/runs/T-3/Approvals/a', U('Pki@ll foo')]) assert.ok(await pre('Bash', { command: c }, who, { ...env, TMPDIR: wtBase }, t3), `${role}: ${c} is refused`);
    }
  });
});

// ---- ordinary commands: 0 flips except the accepted prose class ----

const BODY_WORDS = ['Install', 'Make', 'Source', 'Time', 'Command', 'Script', 'Go', 'Cat', 'Git', 'Node', 'Find', 'Sh', 'Echo', 'Test', 'Fix', 'Add', 'Update', 'Python', 'Curl', 'Env', 'Exec', 'Kill', 'Watch', 'Nice', 'Tee', 'Touch', 'Rm', 'Sed', 'Awk', 'Claude', 'the', 'files', 'and', 'of', 'in', 'new', 'hook'];
const TRAILERS = ['Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>', 'Claude-Session: https://claude.ai/code/session_01154uSCGRtcwmouJ68QRffm', 'Part of #264', 'Signed-off-by: A B <a@b.c>'];
/** @param {() => number} r @param {number} n */
function bodyText(r, n) {
  const lines = [];
  for (let l = 0; l < n; l++) lines.push(Array.from({ length: 2 + Math.floor(r() * 7) }, () => BODY_WORDS[Math.floor(r() * BODY_WORDS.length)]).join(' ') + (r() < 0.2 ? ' $HOME `x`' : ''));
  if (r() < 0.6) lines.push('', TRAILERS[Math.floor(r() * TRAILERS.length)] ?? '');
  return lines;
}
/** One ordinary command that carries a here-document, in the forms an agent writes (A278 E1). @param {() => number} r */
function ordinary(r) {
  const body = bodyText(r, 1 + Math.floor(r() * 4));
  const eol = r() < 0.12 ? '\r\n' : '\n';
  const D = ['EOF', 'EOF', "'EOF'", '"EOF"', '\\EOF', 'END', 'SQL', "'PY'", 'MSG', 'EOT'][Math.floor(r() * 10)] ?? 'EOF';
  const w = D.replace(/['"\\]/g, '');
  const j = (/** @type {string[]} */ ls) => ls.join(eol);
  const heredoc = (/** @type {string} */ open, /** @type {string} */ tail = '', ls = body, tabs = false) => `${open}${eol}${j(tabs ? ls.map((x) => `\t${x}`) : ls)}${eol}${tabs ? '\t' : ''}${w}${eol}${tail}`;
  const k = Math.floor(r() * 16);
  switch (k) {
    case 0: case 1: return `git commit -m "$(cat <<${D}${eol}${j(body)}${eol}${w}${eol})"`;
    case 2: return `git add -A && git commit -m "$(cat <<${D}${eol}${j(body)}${eol}${w}${eol})" && git status`;
    case 3: return heredoc(`git commit -F - <<${D}`);
    case 4: return heredoc(`cat <<${D} > notes.txt`);
    case 5: return heredoc(`cat > notes.txt <<${D}`);
    case 6: return heredoc(`python - <<${D}`);
    case 7: return heredoc(`sh <<${D}`);
    case 8: return heredoc(`node - <<${D}`);
    case 9: return heredoc(`psql <<${D}`);
    case 10: return `gh pr create --title "T" --body "$(cat <<${D}${eol}${j(body)}${eol}${w}${eol})"`;
    case 11: return `bash -c 'cat <<${D.replace(/'/g, '')}${eol}${j(body.filter((x) => !x.includes("'")))}${eol}${w}${eol}'`;
    case 12: return `echo "$(cat <<${D}${eol}${j(body)}${eol}${w}${eol})"`;
    case 13: return `echo "$(cat <<${D}${eol}${j(body)}${eol}${w}${eol}$(cat <<X${eol}${body[0]}${eol}X${eol}))"`;
    case 14: return `cat <<A <<B${eol}${j(body)}${eol}A${eol}${j(bodyText(r, 1))}${eol}B${eol}ls`;
    default: return heredoc(`cat <<-${D}`, 'ls', body, true);
  }
}

test('(regression guard: passes without the fix) A278 round 4 ordinary commands (volume folds case): 300 ordinary commands with here-documents, 5 roles: a refusal the case-keeping volume does not give is exactly the lower-case form of the command being refused (the accepted prose class)', async () => {
  const r = rng(264_003);
  const cmds = Array.from({ length: 300 }, () => ordinary(r));
  let flips = 0; let heredocs = 0;
  for (const c of cmds) if (c.includes('<<')) heredocs++;
  assert.ok(heredocs >= 270, `most of the table opens a here-document (${heredocs})`);
  /** @type {string[]} */ const prose = [];
  for (const [role, who, env] of FIVE) {
    for (const c of cmds) {
      const folds = await onVolume(FOLDS(), () => pre('Bash', { command: c }, who, env, dir));
      if (folds === null) continue; // the second pass only adds refusals
      const keeps = await onVolume(KEEPS(), () => pre('Bash', { command: c }, who, env, dir));
      if (keeps !== null) continue;
      flips++;
      const twin = await onVolume(KEEPS(), () => pre('Bash', { command: fold(c) }, who, env, dir));
      assert.ok(twin !== null, `${role}: ${JSON.stringify(c)}: refused on the folding volume (${folds}) but the lower-case form is allowed: not the prose class`);
      prose.push(`${role}: ${c.slice(0, 40)}`);
    }
  }
  assert.ok(flips <= 100, `the prose class is small (${flips} of ${300 * 5})`);
  console.log(`prose-class flips: ${flips} of ${300 * 5}`);
});

// ---- (c) a project path with capitals ----

test('(regression guard: passes without the fix) A278 round 4 (volume folds case): a project whose folder has capital letters keeps every verdict for its absolute .agents paths, the heredoc forms and the qa artifacts (0 flips)', async () => {
  const proj = join(base, 'MyProj');
  cpSync(template, proj, { recursive: true });
  const real = realpathSync.native(proj);
  const cmds = [`ls ${real}/.agents`, `cat ${real}/.agents/runs/LC/TASK.md`, `sh ${real}/.agents/scripts/agent.sh status`, `echo x > ${real}/.agents/runs/LC/scratch/o.txt`, `cd ${real}/.agents`, `find ${real}/.agents -name x`,
    `cat > ${real}/.agents/runs/LC/EVIDENCE.md <<'EOF'\nInstall Make\nEOF`, `cd ${real}/.agents/runs/LC && echo x > QA_PLAN.md`, `cat ${real}/impl.txt`, `echo x > ${real}/impl.txt`, `git -C ${real} status`, `cd ${real} && git commit -m "$(cat <<'EOF'\nInstall Make\nEOF\n)"`];
  let flips = 0;
  for (const [role, who, env] of FIVE) {
    for (const c of cmds) {
      const keeps = await onVolume(KEEPS(), () => pre('Bash', { command: c }, who, env, proj));
      const folds = await onVolume(FOLDS(), () => pre('Bash', { command: c }, who, env, proj));
      if (keeps === null && folds !== null) { flips++; assert.fail(`${role}: ${c}: ${folds}`); }
    }
  }
  assert.equal(flips, 0);
});

// ---- the context fold ----

test('A278 round 4: foldCtx folds every path-valued field and the path-valued environment, shares the guard state, and leaves ids and tokens alone', async () => {
  const capDir = copyProject(template, join(base, 'Proofline-Case')); // a fixed capital: the random suffix of base has none in about 4 of 100 runs (36/62)^6
  const raw = Buffer.from(JSON.stringify({ cwd: capDir, session_id: 'S1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, agent_type: 'proofline-implementer', agent_id: 'F1' }));
  const { buildContext, finish } = await import(pathToFileURL(join(hookDir, 'lib/context.mjs')).href);
  const { cleanEnv: ce } = await import('./harness.mjs');
  const c = await buildContext('pretool', 'claude', raw, ce({ CLAUDE_PROJECT_DIR: capDir, TMPDIR: '/Var/Tmp/X', HOME: '/Users/Me', AGENT_ROLE: 'implementer', TOKEN_X: 'AbC' }));
  try {
    stateOf(c).tasksDir = 'Tasks';
    const f = foldCtx(c);
    for (const k of ['cwd', 'root', 'mainRoot', 'sharedLocal', 'sroot', 'localDir', 'agentPath']) assert.equal(f[k], fold(c[k]), k);
    assert.ok(/[A-Z]/.test(c.root) && !/[A-Z]/.test(f.root), 'the fixture root has capitals (the test is not vacuous)');
    assert.equal(f.env.TMPDIR, '/var/tmp/x'); assert.equal(f.env.HOME, '/users/me');
    assert.equal(f.env.AGENT_ROLE, 'implementer'); assert.equal(f.env.TOKEN_X, 'AbC');
    assert.equal(f.role, c.role); assert.equal(f.act, c.act); assert.equal(f.aidf, c.aidf);
    assert.equal(stateOf(f), stateOf(c), 'one guard state: no agent call is repeated');
    assert.equal(c.root !== f.root, true); assert.ok(c.env.TMPDIR === '/Var/Tmp/X', 'the original is untouched');
    assert.equal(f.get('session_id'), 'S1', 'event fields are read as they came');
  } finally { finish(c); }
});

// ---- (f) pathological inputs ----

test('A278 round 4: a large input costs a second pass of the same size (the fold is linear, a text the fold does not change has no second pass) and gets the verdict of its lower-case twin', async () => {
  const kill = U('Pki@ll foo');
  const shapes = ['echo "$('.repeat(5000) + kill + ')"'.repeat(5000), 'Cat <<A '.repeat(6000), 'Cat <<A\nx\nA\n'.repeat(3500), 'echo $((1<<n)) Git\n'.repeat(2500), '<<'.repeat(25000), `${'ß'.repeat(45000)} ſh -c '${kill}'`, `${'Aaaa'.repeat(12500)}\nFind . -exec ${kill} \;`];
  for (const t of shapes) {
    assert.ok(t.length >= 40_000);
    assert.ok(foldWorld(t).length <= 2 * t.length, 'the fold is linear and bounded');
    const [, who, env] = WHO[0];
    const twin = await onVolume(FOLDS(), () => pre('Bash', { command: foldWorld(t) }, who, env, dir));
    const v = await onVolume(FOLDS(), () => pre('Bash', { command: t }, who, env, dir));
    assert.equal(v === null, twin === null, `${JSON.stringify(t.slice(0, 30))}: variant ${v === null ? 'allowed' : 'refused'}, twin ${twin === null ? 'allowed' : 'refused'}`);
  }
  // a text the fold does not change is judged once
  const lower = 'echo hi\n'.repeat(20000);
  assert.equal(foldWorld(lower), lower);
});

test('(regression guard: passes without the fix) A278 round 4: the real hook process refuses a large cased input as it refuses its lower-case twin', async () => {
  const kill = U('Pki@ll foo');
  const t = `${'echo "a $((1<<2))" Git\n'.repeat(2000)}Find . -maxdepth 0 -exec ${kill} \;`;
  const a = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: t } }, { env: { TMPDIR: '/var/proofline-case-tmp' } });
  const b = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: t.toLowerCase() } }, { env: { TMPDIR: '/var/proofline-case-tmp' } });
  // the real hook probes the real volume: where it folds case the cased text is refused as its twin is; where it keeps case `Find` and `Pki..ll` are other programs and nothing is refused for the case
  const folds = realProbe(dir) !== false;
  assert.equal(b.stdout === '', false, 'the lower-case twin is refused (fix the table)');
  assert.equal(a.stdout === '', !folds, folds ? 'the cased text is refused as its twin' : 'the cased text is other programs on a case-keeping volume');
});
