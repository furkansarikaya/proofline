// @ts-check
// A278 (issue #264, AC-5, AC-6 and the case part of AC-7): a path that differs from a protected path only by letter case (or Unicode normalization form) gets the SAME verdict as the exact spelling on a
// file system that folds case, for every role and every guard that compares a path; on a file system that keeps case apart it is a DIFFERENT path (judged like any unprotected sibling, no over-refusal).
// The hook asks the volume with a runtime probe (lib/fscase.mjs). Here the probe is INJECTED so both behaviours are exercised on one host: every variant below names a folder that does not exist on any host (a
// name the host's own real path resolution could fix), so the injected volume alone decides. One test at the end uses the REAL probe on its temp folder and asserts whichever behaviour that folder has;
// none depends on the host being macOS. The verdicts are asked in process (the same buildContext and PreToolUse handler the hook runs); one test spawns the real hook to prove they agree.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync as rm, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTemplate, copyProject, runHook, rmSync, cleanEnv } from './harness.mjs';
import { createFsCase } from '../../adapters/claude/hooks/lib/fscase.mjs';
import { hookDir, FOLDS, KEEPS, onVolume, WHO, pre, U, aliasFolded, dropAliases, WIN, slash, lowerAscii } from './case-kit.mjs';

const { canonCase } = await import(pathToFileURL(join(hookDir, 'guards/paths.mjs')).href);
const { stateOf } = await import(pathToFileURL(join(hookDir, 'guards/kit.mjs')).href);

let template = '';
let base = '';
let dir = ''; // an installed project with the run LC open
let noRun = ''; // the same without an active run (the lead's main session, A169)
before(() => {
  template = buildTemplate(); base = tempDir('hook-case-'); aliasFolded(base);
  dir = copyProject(template, base);
  noRun = copyProject(template, base); rm(join(noRun, '.agents/local/ACTIVE_RUN'), { force: true });
});
after(() => { dropAliases(); rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** A refusal text without the spelling of the path that was typed (the project folder and both spellings become placeholders), so two spellings of one path compare equal. @param {string | null} text @param {string} proj @param {string} exact @param {string} variant */
const reason = (text, proj, exact, variant) => (text === null ? null : text.replaceAll(proj, '<P>').replaceAll(variant, '<p>').replaceAll(exact, '<p>'));

/** One operation on a project-relative path: the tool call that names it. @type {Array<[string, (p: string, proj: string) => [string, Record<string, unknown>]]>} */
const OPS = [
  ['Write', (p, proj) => ['Write', { file_path: `${proj}/${p}`, content: 'x' }]],
  ['Edit', (p, proj) => ['Edit', { file_path: `${proj}/${p}`, old_string: 'a', new_string: 'b' }]],
  ['NotebookEdit', (p, proj) => ['NotebookEdit', { notebook_path: `${proj}/${p}`, new_source: 'x' }]],
  ['shell redirect', (p) => ['Bash', { command: `echo x > ${p}` }]],
  ['shell cp', (p) => ['Bash', { command: `cp a ${p}` }]],
  ['shell rm', (p) => ['Bash', { command: `rm ${p}` }]],
];

// [what it protects, exact spelling, differently cased spelling, an unprotected sibling spelled like the variant]. Every folder named here is absent from the fixture, and from any host's real tree.
const PATHS = /** @type {Array<[string, string, string, string]>} */ ([
  ['a run state folder (A143: written only by agent.sh and the hooks)', '.agents/runs/LC/ci-fix/x.md', '.agents/runs/LC/CI-FIX/x.md', '.agents/runs/LC/CI-FIXX/x.md'],
  ['the same, every segment cased', '.agents/runs/LC/worker-evidence/x', '.AGENTS/Runs/LC/Worker-Evidence/x', '.AGENTS/Runs/LC/Worker-EvidenceX/x'],
  ['the approvals folder of a run that is not the active one (a wildcard run id)', '.agents/runs/OTHER/approvals/a', '.agents/runs/OTHER/Approvals/a', '.agents/runs/OTHER/ApprovalsX/a'],
  ['the specialist result files (suffix .result.md)', '.agents/runs/LC/results/a.result.md', '.agents/runs/LC/Results/a.RESULT.MD', '.agents/runs/LC/Results/a.RESULT.MDX'],
  ['the dispatch results (prefix dispatch-)', '.agents/runs/LC/results/dispatch-1', '.agents/runs/LC/results/DISPATCH-1', '.agents/runs/LC/results/DISPATCHX-1'],
  ['the git hooks wiring (never changed by an agent)', '.agents/githooks/pre-push', '.AGENTS/GitHooks/pre-push', '.AGENTS/GitHooksX/pre-push'],
  ['the git config family (a dot is a boundary)', '.git/config.worktree', '.GIT/Config.Worktree', '.GIT/ConfigX.Worktree'],
  ['the runtime hooks folder', '.agents/hooks/pre', '.Agents/HOOKS/pre', '.Agents/HOOKSX/pre'],
  ['the runtime settings (a prefix of the name)', '.claude/settings.local.json', '.CLAUDE/Settings.Local.JSON', '.CLAUDE/SettingX.Local.JSON'],
  ['the Codex hooks', '.codex/hooks.json', '.CODEX/Hooks.json', '.CODEX/HooksX.json'],
  ['the long s (APFS folds U+017F to s): an approvals folder', '.agents/runs/LC/approvals/x', '.agents/runs/LC/approval\u017f/x', '.agents/runs/LC/approval\u017fX/x'],
  ['the long s in two folders of one path', '.agents/runs/LC/questions/x', '.agents/runs/LC/que\u017ftions/x', '.agents/runs/LC/que\u017ftionsX/x'],
  ['the Kelvin sign (U+212A) for the k of hooks', '.agents/hooks/pre', '.agents/hoo\u212As/pre', '.agents/hoo\u212AsX/pre'],
]);

/** @param {string} who */
const ownerOfScope = (who) => who === 'implementer' || who === 'designer';

for (const [what, exact, variant, sibling] of PATHS) {
  test(`A278 AC-5 (volume folds case): ${what}: ${variant} gets the verdict of ${exact}, for every role and tool`, async () => {
    await onVolume(FOLDS(), async () => {
      for (const [role, who, env, projKey] of WHO) {
        const proj = projKey === 'run' ? dir : noRun;
        for (const [opName, op] of OPS) {
          // NTFS folds ASCII case only (A271, the Windows fold stays ASCII): the long s and the Kelvin sign are other letters there, so on Windows that variant gets the verdict of its unprotected sibling
          const ref = WIN && /[^\x00-\x7f]/.test(variant) ? sibling : exact;
          const a = await pre(...op(ref, proj), who, env, proj);
          const b = await pre(...op(variant, proj), who, env, proj);
          assert.equal(b === null, a === null, `${role}, ${opName}: ${ref} ${a === null ? 'allowed' : 'refused'} but ${variant} ${b === null ? 'allowed' : 'refused'}`);
          // the same verdict means the same reason too: a role that the path rule keeps out anyway would hide a protected name that is not recognised
          assert.equal(reason(b, proj, ref, variant), reason(a, proj, ref, variant), `${role}, ${opName}: another reason for ${variant}`);
        }
      }
    });
  });

  test(`A278 AC-6 (volume keeps case): ${what}: ${variant} is a different path, judged like its unprotected sibling (no over-refusal)`, async () => {
    await onVolume(KEEPS(), async () => {
      for (const [role, who, env, projKey] of WHO) {
        const proj = projKey === 'run' ? dir : noRun;
        // Windows has no case-keeping volume for the hook (A271): there an ASCII case variant IS the exact path and gets its verdict; a variant with another letter (the long s, the Kelvin sign) is another name there as everywhere
        const ntfs = WIN && lowerAscii(variant) === lowerAscii(exact);
        const ref = ntfs ? exact : sibling;
        for (const [opName, op] of OPS.filter(([n]) => ['Write', 'shell redirect'].includes(n))) { // the allowed verdicts of the lead start the control plane; two tools show the rule
          const v = await pre(...op(variant, proj), who, env, proj);
          const s = await pre(...op(ref, proj), who, env, proj);
          assert.equal(v === null, s === null, `${role}, ${opName}: ${variant} ${v === null ? 'allowed' : 'refused'} but ${ntfs ? 'the exact path' : 'its unprotected sibling'} ${ref} ${s === null ? 'allowed' : 'refused'}`);
        }
        // the implementer and the designer own the run folder: a differently cased name under it is theirs to write on a volume that keeps case (never on NTFS, where it is the protected folder)
        if (ownerOfScope(role) && variant.startsWith('.agents/runs/LC/')) {
          const w = await pre('Write', { file_path: `${proj}/${variant}`, content: 'x' }, who, env, proj);
          if (ntfs) assert.equal(w === null, (await pre('Write', { file_path: `${proj}/${exact}`, content: 'x' }, who, env, proj)) === null, `${role}: Write ${variant} judged otherwise than ${exact} on NTFS`);
          else assert.equal(w, null, `${role}: Write ${variant} refused although the volume keeps case`);
        }
      }
    });
  });
}

test('A278 AC-5: an unprotected path and the run scratch folder keep their verdict however they are cased (the fix is no blanket refusal)', async () => {
  await onVolume(FOLDS(), async () => {
    for (const [role, who, env, projKey] of WHO) {
      const proj = projKey === 'run' ? dir : noRun;
      const scratch = projKey === 'run' ? '.agents/runs/LC/scratch/o.txt' : '.agents/local/scratch/o.txt';
      const scratchUp = projKey === 'run' ? '.AGENTS/RUNS/LC/SCRATCH/o.txt' : '.AGENTS/LOCAL/SCRATCH/o.txt';
      assert.equal(await pre('Write', { file_path: `${proj}/${scratch}`, content: 'x' }, who, env, proj), null, `${role}: scratch`);
      assert.equal(await pre('Write', { file_path: `${proj}/${scratchUp}`, content: 'x' }, who, env, proj), null, `${role}: scratch, cased`);
    }
    const [, w, e] = WHO[2];
    assert.equal(await pre('Write', { file_path: `${dir}/impl.txt`, content: 'x' }, w, e, dir), null, 'the implementer writes its scope file');
    // IMPL.TXT is impl.txt only on a host whose real file system folds case (the path rule resolves the existing file): that is the host's behaviour, covered by the real-file-system test below, not by an injected volume
  });
});

// Command words and script names: the volume's PATH folders and working folder decide whether `Agent.SH`, `Kill` and `GIT` are agent.sh, the process killer and git.
// (The marker `@` is removed at run time: a script file that names a process killer fed by a search, or a push to the protected branch, is refused by the author's own hook when node starts it.)
const COMMANDS = /** @type {Array<[string, string, string, RegExp | null]>} */ ([
  ['agent.sh approve (the user alone approves)', 'sh .agents/scripts/agent.sh approve T-1', 'sh .agents/scripts/Agent.SH approve T-1', /no model runs agent\.sh approve/],
  ['agent.sh record (verdicts enter only through submit)', 'sh .agents/scripts/agent.sh record x', 'sh .AGENTS/scripts/AGENT.SH record x', /agent\.sh record is never run/],
  ['a process killer fed by a process search', U('ki@ll -9 $(pg@rep node)'), U('Ki@ll -9 $(pg@rep node)'), /with PIDs taken from a process search/],
  ['git push of the protected branch', U('g@it push origin ma@in'), U('G@IT push origin ma@in'), /git push of the protected branch/],
  ['a script written by the command, then run', U('cat > .agents/runs/LC/scratch/s.sh <<EOF\nki@ll -9 $(pg@rep node)\nEOF\nsh .agents/runs/LC/scratch/s.sh'), U('cat > .agents/runs/LC/scratch/S.SH <<EOF\nki@ll -9 $(pg@rep node)\nEOF\nsh .agents/runs/LC/scratch/s.sh'), /with PIDs taken from a process search/],
  ['git stash in the live tree', 'git stash', 'GIT stash', /git stash/],
  ['database client against the project', 'sqlite3 x.db', 'SQLITE3 X.DB', /database file|database client|would open/],
  ['database file named by a token', 'cat data.db', 'cat DATA.DB', /names the database file/],
  ['node on the control plane (tripwire)', 'node .agents/scripts/core/x.mjs', 'NODE .AGENTS/SCRIPTS/core/x.mjs', /never starts Node on the control plane/],
  ['the dispatch nonce folder', 'cat .agents/local/dispatch/x', 'cat .AGENTS/Local/Dispatch/x', /PROOFLINE_DISPATCH/],
  ['a link into .agents (a stays-same pin: .AGENTS exists on every host, so a host that resolves it passes without the fix too)', 'ln -s a .agents/x', 'ln -s a .AGENTS/x', /links into or out of \.agents/],
]);

const IMPL = /** @type {[string, Record<string, string>, Record<string, string>, 'run' | 'norun']} */ (WHO[2]);
for (const [what, exact, variant, why] of COMMANDS) {
  test(`A278 AC-5 (volume folds case): ${what}: the cased spelling is refused as the exact one is, for the lead and the specialists`, async () => {
    await onVolume(FOLDS(), async () => {
      for (const [role, who, env, projKey] of WHO) {
        const proj = projKey === 'run' ? dir : noRun;
        const a = await pre('Bash', { command: exact }, who, env, proj);
        const b = await pre('Bash', { command: variant }, who, env, proj);
        assert.equal(b === null, a === null, `${role}: exact ${a === null ? 'allowed' : 'refused'}, cased ${b === null ? 'allowed' : 'refused'} (${b ?? a})`);
      }
      const a = await pre('Bash', { command: exact }, WHO[0][1], WHO[0][2], dir);
      assert.ok(a === null ? true : why === null || why.test(a), `the lead's exact refusal is the expected one (fix the table): ${a}`);
    });
  });
}

test('A278 AC-6 (volume keeps case): the cased command words are other programs and other files: not refused for the protected name (no over-refusal)', async () => {
  await onVolume(KEEPS(), async () => {
    for (const [what, exact, variant, why] of COMMANDS) {
      if (/database|link into|dispatch nonce|a script written/.test(what)) continue; // judged by text or a real file here, not by the program name
      const b = await pre('Bash', { command: variant }, WHO[0][1], WHO[0][2], dir);
      if (WIN) { // NTFS and the Windows program lookup read the cased words as the exact ones (A271): the cased spelling gets the verdict of the exact one
        const a = await pre('Bash', { command: exact }, WHO[0][1], WHO[0][2], dir);
        assert.equal(b === null, a === null, `${what}: on Windows the cased spelling is judged as the exact one (${b ?? a})`);
        continue;
      }
      if (b !== null && why !== null) assert.doesNotMatch(b, why, `${what}: the cased spelling must not be refused as the protected one: ${b}`);
    }
  });
});

test('A278 AC-5/AC-6: a specialist writing with a cased write program (TOUCH, Tee) is judged as the lower-case program on a folding volume and as an unknown program on a case-keeping one', async () => {
  const cmds = [['TOUCH ../outside.txt', 'touch ../outside.txt'], ['Tee ../outside.txt <<< x', 'tee ../outside.txt <<< x']];
  for (const [role, who, env] of [WHO[2], WHO[3]]) {
    for (const [cased, lower] of cmds) {
      await onVolume(FOLDS(), async () => {
        assert.ok(await pre('Bash', { command: lower }, who, env, dir), `${role}: ${lower} is refused (fix the table)`);
        assert.ok(await pre('Bash', { command: cased }, who, env, dir), `${role}: ${cased} allowed on a volume that folds case`);
      });
      await onVolume(KEEPS(), async () => {
        const v = await pre('Bash', { command: cased }, who, env, dir);
        if (WIN) assert.ok(v, `${role}: ${cased} allowed on Windows, where TOUCH starts touch (A271)`);
        else assert.equal(v, null, `${role}: ${cased} refused on a volume that keeps case`);
      });
    }
  }
});

test('A278 AC-5/AC-6: the db guard reads DATA.DB as data.db on a folding volume only (the Read and Grep tools too)', async () => {
  const [, w, e] = WHO[2];
  await onVolume(FOLDS(), async () => {
    assert.ok(await pre('Read', { file_path: `${dir}/DATA.DB` }, w, e, dir), 'Read of a cased database name allowed');
    assert.ok(await pre('Grep', { pattern: 'x', path: `${dir}/Data.Sqlite` }, w, e, dir), 'Grep of a cased database name allowed');
  });
  await onVolume(KEEPS(), async () => {
    if (WIN) assert.ok(await pre('Read', { file_path: `${dir}/DATA.DB` }, w, e, dir), 'on Windows (NTFS, A271) DATA.DB is data.db');
    else assert.equal(await pre('Read', { file_path: `${dir}/DATA.DB` }, w, e, dir), null, 'on a case-keeping volume DATA.DB is not a database named *.db');
    assert.ok(await pre('Read', { file_path: `${dir}/data.db` }, w, e, dir), 'the exact name is still a database');
  });
});

test('A278 mixed volume: one protected name is protected under a folding folder and is another name under a case-keeping one, in one process, each folder probed once', async () => {
  const proj = realpathSync.native(dir);
  const runDir = join(proj, '.agents/runs/LC');
  /** @type {string[]} */ const asked = [];
  // the run folder stands for a case-keeping volume mounted inside the project tree (or a per-folder flag); every other folder folds case
  const inst = createFsCase({ probe: (d) => { asked.push(d); return d !== runDir; } });
  const [, w, e] = WHO[2];
  await onVolume(inst, async () => {
    const cased = await pre('Write', { file_path: `${dir}/.agents/runs/LC/CI-FIX/x.md`, content: 'x' }, w, e, dir);
    if (WIN) assert.ok(cased, 'Windows folds ASCII case in every folder (A271): CI-FIX is ci-fix whatever the injected volume says');
    else assert.equal(cased, null, 'under the case-keeping run folder CI-FIX is not ci-fix');
    assert.ok(await pre('Write', { file_path: `${dir}/.agents/runs/LC/ci-fix/x.md`, content: 'x' }, w, e, dir), 'the exact spelling is protected there');
    assert.ok(await pre('Write', { file_path: `${dir}/.CODEX/hooks.json`, content: 'x' }, w, e, dir), 'under the folding project root the cased name is protected');
  });
  if (WIN) { assert.deepEqual(asked, [], 'on Windows no folder is asked: NTFS is case-insensitive by definition (A271)'); return; }
  assert.deepEqual([...new Set(asked)].sort(), [proj, runDir].sort(), 'two different folders, two probes, each asked once');
  assert.equal(asked.length, 2);
});

test('A278 Unicode: the Kelvin sign for the k of a protected name, and a decomposed spelling of a configured folder, do not get around the deny-list', async () => {
  const [, w, e] = WHO[2];
  await onVolume(FOLDS(), async () => {
    assert.ok(await pre('Write', { file_path: `${dir}/.agents/hooKs/x`, content: 'x' }, w, e, dir), 'KELVIN SIGN for the k of hooks');
  });
  const c = /** @type {any} */ ({ act: 'LC' });
  stateOf(c).tasksDir = 'docs/tâches'; // a configured, non-ASCII task folder
  // Windows keeps the ASCII-only fold of A271 for these names: a capital letter outside ASCII is not folded there, so the cased spelling of a configured non-ASCII folder is returned as typed
  assert.equal(canonCase(c, 'DOCS/TÂCHES/x', true), WIN ? 'DOCS/TÂCHES/x' : 'docs/tâches/x');
  assert.equal(canonCase(c, 'Docs/Tâches/x', true), WIN ? 'Docs/Tâches/x' : 'docs/tâches/x', 'the decomposed spelling is the same folder');
  assert.equal(canonCase(c, 'Docs/Tâches/x', false), 'Docs/Tâches/x', 'a volume that keeps case apart is not rewritten');
});

test('A278 fail closed: a probe that cannot decide protects the cased name and the cased command word (more refusals, never fewer)', async () => {
  const [, w, e] = WHO[2];
  const broken = createFsCase({ probe: () => { throw new Error('cannot tell'); } });
  await onVolume(broken, async () => {
    assert.ok(await pre('Write', { file_path: `${dir}/.agents/runs/LC/CI-FIX/x.md`, content: 'x' }, w, e, dir), 'the cased protected name is refused');
    assert.ok(await pre('Bash', { command: 'sh .agents/scripts/Agent.SH approve T-1' }, w, e, dir), 'Agent.SH is agent.sh when the volume cannot be asked');
  });
});

test('A278: the in-process verdict and the verdict of the real hook process agree on a cased protected path', async () => {
  const [, w, e] = WHO[2];
  const p = `${dir}/.agents/runs/LC/CI-FIX/x.md`;
  const spawned = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: p, content: 'x' }, ...w }, { env: { TMPDIR: '/var/proofline-case-tmp', ...e } });
  const inProc = await onVolume(createFsCase(), () => pre('Write', { file_path: p, content: 'x' }, w, e, dir)); // the real probe in both
  assert.equal(spawned.stdout === '', inProc === null);
});

test('A278 real file system: the temp folder has some behaviour, and the guards judge a cased path accordingly (no host is assumed)', async () => {
  writeFileSync(join(dir, 'Zz-Probe.txt'), 'x');
  const folds = existsSync(join(dir, 'zZ-pROBE.TXT')); // found here without the code under test
  const [, w, e] = WHO[2];
  const exactSpelling = '.agents/runs/LC/ci-fix/x.md';
  const cased = '.agents/runs/LC/CI-FIX/x.md';
  const sibling = '.agents/runs/LC/CI-FIXX/x.md';
  await onVolume(createFsCase(), async () => { // the real probe, a fresh cache
    assert.ok(await pre('Write', { file_path: `${dir}/${exactSpelling}`, content: 'x' }, w, e, dir), 'the exact protected spelling is refused');
    const b = await pre('Write', { file_path: `${dir}/${cased}`, content: 'x' }, w, e, dir);
    if (folds) assert.ok(b, 'the temp folder folds case: the cased spelling is refused too');
    else { assert.equal(b, null, 'the temp folder keeps case: the cased spelling is another path'); assert.equal(await pre('Write', { file_path: `${dir}/${sibling}`, content: 'x' }, w, e, dir), null); }
    // a differently cased project root: the project on a folding volume, another place on a case-keeping one
    const rootUp = dir.toUpperCase();
    assert.notEqual(rootUp, dir);
    const viaRoot = await pre('Write', { file_path: `${rootUp}/impl.txt`, content: 'x' }, w, e, dir);
    if (folds) assert.equal(viaRoot, null, 'the cased root is the project: the scope file is writable as with the exact root');
    else assert.ok(viaRoot, 'the cased root is another place, outside the project');
    assert.ok(await pre('Write', { file_path: `${rootUp}/${exactSpelling}`, content: 'x' }, w, e, dir), 'the protected state is refused through the cased root as well (inside, or outside the project)');
    // a cased spelling of the project root in a shell write is judged as the exact root
    const sh = await pre('Bash', { command: `echo x > ${slash(rootUp)}/impl.txt` }, w, e, dir);
    if (folds) assert.equal(sh, null); else assert.ok(sh);
  });
});

test('A278: the probe writes nothing into the project (the folder listing is the same after a verdict)', async () => {
  const listing = () => readdirSync(dir, { recursive: true }).join('|');
  const before = listing();
  const [, w, e] = WHO[2];
  await onVolume(createFsCase(), async () => { await pre('Write', { file_path: `${dir}/.agents/runs/LC/CI-FIX/x.md`, content: 'x' }, w, e, dir); });
  assert.equal(listing(), before);
});

// ---- A278 round 1: a command word is read in any case at EVERY command position (B1) ----

/** @param {string} w */
const capitalized = (w) => w[0].toUpperCase() + w.slice(1);
/** @param {string} w */
const alternating = (w) => [...w].map((c, i) => (i % 2 === 1 ? c.toUpperCase() : c)).join('');
/** The spellings of a word a folding volume reads as the word: upper case, capitalized, alternating, the long s for s and the Kelvin sign for k. @param {string} w */
function spellings(w) {
  const v = new Set([w.toUpperCase(), capitalized(w), alternating(w)]);
  if (w.includes('s')) v.add(w.replace(/s/g, 'ſ'));
  if (w.includes('k')) v.add(w.replace(/k/g, 'K'));
  v.delete(w);
  return [...v];
}

/** Every position a command word can take: top level, find -exec, xargs, a shell string, a substitution, a here-document fed to a shell, after a wrapper. */
const POSITIONS = /** @type {Array<[string, (c: string) => string]>} */ ([
  ['top level', (c) => c],
  ['find -exec', (c) => `find . -maxdepth 0 -exec ${c} \\;`],
  ['xargs target', (c) => `echo 1 | xargs ${c}`],
  ['sh -c string', (c) => `sh -c '${c}'`],
  ['substitution', (c) => `echo $(${c})`],
  ['here-document to a shell', (c) => `sh <<EOF\n${c}\nEOF`],
  ['after a wrapper', (c) => `nohup ${c}`],
]);

// [family, the lower-case command, the word the volume reads in any case, indexes into WHO]
const GUARD_FAMILIES = /** @type {Array<[string, string, string, number[]]>} */ ([
  ['process killer (A156)', U('pki@ll foo'), U('pki@ll'), [0, 2, 4]],
  ['process killer by name', U('killal@l foo'), U('killal@l'), [0, 2]],
  ['git push of the protected branch', U('g@it push origin ma@in'), U('g@it'), [0, 2]],
  ['git on the live tree (specialist)', 'git reset --hard', 'git', [2, 4]],
  ['git stash (A71)', 'git stash', 'git', [2, 4]],
  ['read role writer (A143)', 'touch s.txt', 'touch', [4]],
  ['agent.sh approve', 'sh .agents/scripts/agent.sh approve T-1', 'agent.sh', [0, 2]],
  ['dispatch nonce find (A171)', 'find .agents/local -type f', 'find', [0, 2, 4]],
  ['node on the control plane', 'node .agents/scripts/core/x.mjs', 'node', [0, 2]],
  ['specialist write program', 'touch ../outside.txt', 'touch', [2]],
]);

/** @param {string} cmd @param {string} word @param {string} spelling */
const withWord = (cmd, word, spelling) => cmd.replace(word, spelling);

test('A278 B1 (volume folds case): every guard family reads a command word in any case at every command position as it reads the lower-case word', async () => {
  await onVolume(FOLDS(), async () => {
    for (const [family, lower, word, whoIdx] of GUARD_FAMILIES) {
      for (const wi of whoIdx) {
        const [role, who, env, projKey] = /** @type {typeof WHO[number]} */ (WHO[wi]);
        const proj = projKey === 'run' ? dir : noRun;
        assert.ok(await pre('Bash', { command: lower }, who, env, proj), `${family}, ${role}: the lower-case command is allowed (fix the table)`);
        for (const [posName, wrap] of POSITIONS) {
          const base = await pre('Bash', { command: wrap(lower) }, who, env, proj);
          for (const sp of spellings(word)) {
            const v = await pre('Bash', { command: wrap(withWord(lower, word, sp)) }, who, env, proj);
            assert.equal(v === null, base === null, `${family}, ${role}, ${posName}: ${sp} is ${v === null ? 'allowed' : 'refused'} but the lower-case word is ${base === null ? 'allowed' : 'refused'}`);
          }
        }
      }
    }
  });
});

test('A278 B1 (volume folds case): the evidence-command rule (A194, rtk installed) reads npm, make, pytest, agent.sh and git in any case', async () => {
  const proj = copyProject(template, base);
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, '.claude/settings.json'), '{"hooks":{"PreToolUse":"rtk"}}');
  const bin = tempDir('hook-case-bin-'); writeFileSync(join(bin, 'rtk'), '#!/bin/sh\n'); chmodSync(join(bin, 'rtk'), 0o755);
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}` };
  const cases = /** @type {Array<[string, string, number[]]>} */ ([['npm test', 'npm', [0, 4]], ['make test', 'make', [0, 4]], ['pytest', 'pytest', [0]], ['sh .agents/scripts/agent.sh build-record', 'agent.sh', [0]], ['git diff', 'git', [4]]]);
  await onVolume(FOLDS(), async () => {
    for (const [lower, word, whoIdx] of cases) {
      for (const wi of whoIdx) {
        const [role, who, wenv] = /** @type {typeof WHO[number]} */ (WHO[wi]);
        const base = await pre('Bash', { command: lower }, who, { ...wenv, ...env }, proj);
        // Windows: the hook does not find rtk there (it reads only the `/` entries of PATH and the name rtk, never rtk.exe: docs/concepts/workflow.md, A271), so the evidence-command rule is not enforced and no spelling is refused for it
        if (WIN) assert.equal(base, null, `${role}: ${lower} is refused on Windows although the rule is a documented gap there: ${base}`); else assert.ok(base && /rtk/.test(base), `${role}: ${lower} is not the rtk refusal (fix the table): ${base}`);
        for (const sp of spellings(word)) {
          const v = await pre('Bash', { command: withWord(lower, word, sp) }, who, { ...wenv, ...env }, proj);
          if (WIN) assert.equal(v === null, base === null, `${role}: ${sp} is judged otherwise than ${lower} on Windows: ${v}`); else assert.ok(v && /rtk/.test(v), `${role}: ${sp} escapes the evidence-command rule: ${v}`);
        }
      }
    }
  });
});

test('A278 B1 (volume keeps case; a regression guard for no over-refusal, it passes without the fix): Make, Python3, Rscript, JAVA, Git and a cased write program are other programs there and are not refused', async () => {
  await onVolume(KEEPS(), async () => {
    for (const c of ['Make all', 'Python3 -c 1', 'Rscript x.R', 'JAVA -version', 'Git status', 'Npm test', 'Pytest', U('Pki@ll foo'), 'Touch s.txt']) {
      for (const wi of [0, 2, 4]) {
        const [role, who, env, projKey] = /** @type {typeof WHO[number]} */ (WHO[wi]);
        const v = await pre('Bash', { command: c }, who, env, projKey === 'run' ? dir : noRun);
        if (WIN) assert.equal(v === null, (await pre('Bash', { command: c.toLowerCase() }, who, env, projKey === 'run' ? dir : noRun)) === null, `${role}: ${c} is judged otherwise than its lower-case twin on Windows (A271)`);
        else assert.equal(v, null, `${role}: ${c} refused on a volume that keeps case`);
      }
    }
  });
});

// ---- A278 round 1: branch names on a git dir that folds case (B2) ----

/** @param {string} root @param {string} head */
const setHead = (root, head) => writeFileSync(join(root, '.git/HEAD'), `ref: refs/heads/${head}\n`);
const MAIN_FORMS = /** @type {string[]} */ ([
  U('git branch -f MA@IN HEAD'), U('git branch -M Ma@in'), U('git update-ref refs/heads/MA@IN HEAD'), U('git update-ref REFS/Heads/ma@in HEAD'), U('git checkout -B MA@IN'), U('git switch -C Mas@ter'),
  U('git fetch origin x:MA@IN'), U('git checkout MA@IN && git me@rge feat'), U('git switch Ma@in; git reba@se feat'),
]);
const ON_MAIN = /** @type {string[]} */ ([U('git me@rge feat'), U('git reba@se feat'), 'git cherry-pick abc', 'git push', 'git push origin HEAD', 'git reset --hard abc']);
const LEAD = WHO[0];

test('A278 B2 (git dir folds case): the protected branch is protected in any case and form: the commands that move it, and the commands run while HEAD is MAIN', async () => {
  const proj = copyProject(template, base);
  await onVolume(FOLDS(), async () => {
    setHead(proj, 'feat');
    for (const c of MAIN_FORMS) assert.ok(await pre('Bash', { command: c }, LEAD[1], LEAD[2], proj), `not refused: ${c}`);
    setHead(proj, 'MAIN');
    for (const c of ON_MAIN) assert.ok(await pre('Bash', { command: c }, LEAD[1], LEAD[2], proj), `not refused with HEAD at MAIN: ${c}`);
    setHead(proj, 'main');
    for (const c of ON_MAIN) assert.ok(await pre('Bash', { command: c }, LEAD[1], LEAD[2], proj), `the exact name is not refused with HEAD at main (fix the table): ${c}`);
    // round 4 (accepted side effect): the text is judged in the lower-case world as a whole, so a push to Main on the remote is judged like a push to main (GitHub ref names are case-sensitive; the refusal is the safe side)
    setHead(proj, 'feat');
    assert.ok(await pre('Bash', { command: U('git push origin HEAD:Ma@in') }, LEAD[1], LEAD[2], proj), 'a push to a differently cased remote branch is judged like its lower-case twin');
    assert.ok(await pre('Bash', { command: U('git push origin Ma@in') }, LEAD[1], LEAD[2], proj));
    assert.ok(await pre('Bash', { command: U('git push origin HEAD:ma@in') }, LEAD[1], LEAD[2], proj), 'the exact remote name is refused');
  });
});

test('A278 B2 (git dir keeps case; a regression guard for no over-refusal, it passes without the fix): MAIN is another branch there, judged like any task branch (no over-refusal)', async () => {
  const proj = copyProject(template, base);
  await onVolume(KEEPS(), async () => {
    setHead(proj, 'feat');
    // Windows has no case-keeping git dir for the hook (A271): MAIN is main there, and every form is refused as its lower-case twin is
    for (const c of MAIN_FORMS) { const v = await pre('Bash', { command: c }, LEAD[1], LEAD[2], proj); if (WIN) assert.ok(v, `not refused on Windows: ${c}`); else assert.equal(v, null, `refused on a case-keeping git dir: ${c}`); }
    setHead(proj, 'MAIN');
    for (const c of ON_MAIN) { const v = await pre('Bash', { command: c }, LEAD[1], LEAD[2], proj); if (WIN) assert.ok(v, `not refused with HEAD at MAIN on Windows: ${c}`); else assert.equal(v, null, `refused with HEAD at MAIN on a case-keeping git dir: ${c}`); }
  });
});

test('A278 B2 real file system: in a throwaway repository the refs of the temp folder fold case or not, and the guards judge the cased branch accordingly', async () => {
  const proj = copyProject(template, base);
  const repo = join(proj, '.agents/local/scratch/case-repo'); // inside the project: the hook's tmp rules judge a repository under the runner's /tmp as outside the project
  mkdirSync(repo, { recursive: true });
  const run = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', repo, ...a], { env: cleanEnv(), encoding: 'utf8' });
  assert.equal(run('init', '-q', '-b', 'main').status, 0);
  assert.equal(run('commit', '-q', '--allow-empty', '-m', 'x').status, 0);
  const folds = existsSync(join(repo, '.git/refs/heads/MAIN')); // the ground truth of the ref store, found without the code under test
  await onVolume(createFsCase(), async () => {
    const v = await pre('Bash', { command: U(`git -C ${repo} branch -f MA@IN HEAD`) }, LEAD[1], LEAD[2], proj);
    if (folds) assert.ok(v, 'the refs fold case: MAIN is main'); else assert.equal(v, null, 'the refs keep case: MAIN is another branch');
    assert.ok(await pre('Bash', { command: U(`git -C ${repo} branch -f ma@in HEAD`) }, LEAD[1], LEAD[2], proj), 'the exact name is refused');
  });
});

// ---- A278 round 2: a project path with capitals (C1), here-document shapes (D1), the migrate patterns (D2) ----

test('A278 C1 (volume folds case): in a project whose folder has capital letters the absolute paths of the project keep their verdicts, and the protected variants stay refused (0 allow-to-deny flips against the unfolded judgement)', async () => {
  const { cpSync } = await import('node:fs');
  const proj = join(base, 'MyProj');
  cpSync(template, proj, { recursive: true });
  const real = realpathSync.native(proj);
  const cmds = [`ls ${real}/.agents`, `cat ${real}/.agents/runs/LC/TASK.md`, `sh ${real}/.agents/scripts/agent.sh status`, `echo x > ${real}/.agents/runs/LC/scratch/o.txt`, `cd ${real}/.agents`, `find ${real}/.agents -name x`,
    `sed -n 1p ${real}/.agents/runs/LC/TASK.md`, `cat ${real}/impl.txt`, `echo x > ${real}/impl.txt`];
  let flips = 0;
  for (const [role, who, env] of WHO.filter((w) => w[3] === 'run')) {
    for (const c of cmds) {
      const unfolded = await onVolume(KEEPS(), () => pre('Bash', { command: c }, who, env, proj));
      const folded = await onVolume(FOLDS(), () => pre('Bash', { command: c }, who, env, proj));
      if (unfolded === null && folded !== null) flips++;
      assert.equal(folded === null, unfolded === null, `${role}: ${c}: unfolded ${unfolded === null ? 'allowed' : 'refused'}, folded ${folded === null ? 'allowed' : 'refused'} (${folded})`);
    }
    // the protected variants stay refused through the project path
    await onVolume(FOLDS(), async () => {
      assert.ok(await pre('Bash', { command: `echo x > ${real}/.agents/runs/LC/CI-FIX/x` }, who, env, proj), `${role}: shell write to a cased protected folder`);
      assert.ok(await pre('Write', { file_path: `${real}/.AGENTS/githooks/x`, content: 'x' }, who, env, proj), `${role}: Write to a cased protected folder`);
    });
  }
  assert.equal(flips, 0);
});

test('A278 D2: the configured migration commands are read without case on a folding volume at every position (Manage.py, Prisma, in find -exec and behind a runner), and are other files on a case-keeping one', async () => {
  const cmds = ['python3 Manage.py migrate', 'npx Prisma migrate reset', 'pnpm exec Prisma migrate reset', 'bunx Prisma migrate reset', 'yarn dlx Prisma migrate reset', 'find . -maxdepth 0 -exec Prisma migrate reset \\;', 'Prisma migrate reset'];
  for (const wi of [0, 2]) {
    const [role, who, env] = /** @type {typeof WHO[number]} */ (WHO[wi]);
    await onVolume(FOLDS(), async () => {
      for (const c of cmds) {
        const twin = await pre('Bash', { command: c.toLowerCase() }, who, env, dir);
        assert.ok(twin, `${role}: the lower-case ${c} is allowed (fix the table)`);
        assert.ok(await pre('Bash', { command: c }, who, env, dir), `${role}: ${c} escapes the migration guard`);
      }
    });
    await onVolume(KEEPS(), async () => {
      for (const c of cmds.filter((x) => /Manage|Prisma/.test(x))) {
        const v = await pre('Bash', { command: c }, who, env, dir);
        if (WIN) assert.ok(v, `${role}: ${c} allowed on Windows, where Manage.py is manage.py (A271)`); else assert.equal(v, null, `${role}: ${c} refused on a case-keeping volume`);
      }
    });
  }
});


// ---- A278 round 4 note: HEAD in any case (security round G) ----

test('A278 round 4 HEAD forms (git dir folds case): head, Head, hEAD are HEAD for a push and a reset with main checked out, for the lead and four roles; a case-keeping git dir reads them as other words', async () => {
  const proj = copyProject(template, base);
  const five = [WHO[0], WHO[2], WHO[3], WHO[4], WHO[5]];
  const variants = (/** @type {string} */ c) => ['head', 'Head', 'hEAD'].map((v) => c.replace('HEAD', v));
  setHead(proj, 'main');
  await onVolume(FOLDS(), async () => {
    for (const [role, who, env] of five) {
      const exact = await pre('Bash', { command: 'git push origin HEAD' }, who, env, proj);
      assert.ok(exact, `${role}: the exact push of HEAD is refused on main (fix the table)`);
      for (const v of variants('git push origin HEAD')) assert.ok(await pre('Bash', { command: v }, who, env, proj), `${role}: ${v} is refused like HEAD`);
      for (const v of variants('git push origin HEAD:refs/heads/x')) assert.equal((await pre('Bash', { command: v }, who, env, proj)) === null, (await pre('Bash', { command: 'git push origin HEAD:refs/heads/x' }, who, env, proj)) === null, `${role}: ${v}`);
      for (const c of ['git reset --hard HEAD~1', 'git log HEAD~1', 'git diff HEAD', 'git checkout HEAD -- .', 'git merge HEAD']) {
        const e = await pre('Bash', { command: c }, who, env, proj);
        for (const v of variants(c)) assert.equal((await pre('Bash', { command: v }, who, env, proj)) === null, e === null, `${role}: ${v} vs ${c}`);
      }
    }
  });
  await onVolume(KEEPS(), async () => {
    const [, who, env] = WHO[0];
    const pushHead = await pre('Bash', { command: 'git push origin head' }, who, env, proj);
    if (WIN) assert.ok(pushHead, 'head is HEAD on Windows (A271): a push with main checked out is refused');
    else assert.equal(pushHead, null, 'head is not HEAD on a case-keeping git dir');
    assert.equal((await pre('Bash', { command: 'git log head~1' }, who, env, proj)) === null, WIN ? (await pre('Bash', { command: 'git log HEAD~1' }, who, env, proj)) === null : true, 'a read of head~1 is judged as HEAD~1 on Windows and allowed on a case-keeping dir');
  });
});

test('A278 round 4 HEAD forms, real git: in a throwaway repository head is HEAD exactly when the ref store folds case, and the guard agrees', async () => {
  const repo = tempDir('hook-case-head-');
  const run = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', repo, ...a], { env: cleanEnv(), encoding: 'utf8' });
  assert.equal(run('init', '-q', '-b', 'main').status, 0);
  assert.equal(run('commit', '-q', '--allow-empty', '-m', 'x').status, 0);
  const folds = run('rev-parse', '--verify', '-q', 'head').status === 0;
  const proj = copyProject(template, base);
  setHead(proj, 'main');
  const [, who, env] = WHO[0];
  const v = await onVolume(createFsCase(), () => pre('Bash', { command: 'git push origin head' }, who, env, proj));
  const probeFolds = existsSync(join(repo, '.git/HEAD')) && existsSync(join(repo, '.git/head'));
  if (folds && probeFolds) assert.ok(v, 'head resolves to HEAD here, so the push is refused');
  if (!probeFolds) assert.equal(v, null, 'head is no ref here: not refused');
});
