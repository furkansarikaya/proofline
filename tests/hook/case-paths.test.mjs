// @ts-check
// A278 (issue #264, AC-5, AC-6 and the case part of AC-7): a path that differs from a protected path only by letter case (or Unicode normalization form) gets the SAME verdict as the exact spelling on a
// file system that folds case, for every role and every guard that compares a path; on a file system that keeps case apart it is a DIFFERENT path (judged like any unprotected sibling, no over-refusal).
// The hook asks the volume with a runtime probe (lib/fscase.mjs). Here the probe is INJECTED so both behaviours are exercised on one host: every variant below names a folder that does not exist on any host (a
// name the host's own real path resolution could fix), so the injected volume alone decides. One test at the end uses the REAL probe on its temp folder and asserts whichever behaviour that folder has;
// none depends on the host being macOS. The verdicts are asked in process (the same buildContext and PreToolUse handler the hook runs); one test spawns the real hook to prove they agree.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, realpathSync, rmSync as rm, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTemplate, copyProject, runHook, rmSync, nodeHook, cleanEnv } from './harness.mjs';
import { createFsCase, useFsCase } from '../../adapters/claude/hooks/lib/fscase.mjs';

const hookDir = dirname(nodeHook);
const { buildContext, finish } = await import(pathToFileURL(join(hookDir, 'lib/context.mjs')).href);
const { handle } = await import(pathToFileURL(join(hookDir, 'events/pretool.mjs')).href);
const { canonCase } = await import(pathToFileURL(join(hookDir, 'guards/paths.mjs')).href);
const { stateOf } = await import(pathToFileURL(join(hookDir, 'guards/kit.mjs')).href);

let template = '';
let base = '';
let dir = ''; // an installed project with the run LC open
let noRun = ''; // the same without an active run (the lead's main session, A169)
before(() => {
  template = buildTemplate(); base = tempDir('hook-case-');
  dir = copyProject(template, base);
  noRun = copyProject(template, base); rm(join(noRun, '.agents/local/ACTIVE_RUN'), { force: true });
});
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const FOLDS = () => createFsCase({ probe: () => true });
const KEEPS = () => createFsCase({ probe: () => false });
/** @template T @param {ReturnType<typeof createFsCase>} inst @param {() => Promise<T>} fn @returns {Promise<T>} */
async function onVolume(inst, fn) { const prev = useFsCase(inst); try { return await fn(); } finally { useFsCase(prev); } }

/** [name, who (agent fields), env (AGENT_ROLE), project] */
const WHO = /** @type {Array<[string, Record<string, string>, Record<string, string>, 'run' | 'norun']>} */ ([
  ['lead', {}, {}, 'run'],
  ['lead without a run', {}, {}, 'norun'],
  ['implementer', { agent_type: 'proofline-implementer', agent_id: 'f1' }, { AGENT_ROLE: 'implementer' }, 'run'],
  ['designer', { agent_type: 'proofline-designer', agent_id: 'f1' }, { AGENT_ROLE: 'designer' }, 'run'],
  ['reviewer', { agent_type: 'proofline-reviewer', agent_id: 'f1' }, { AGENT_ROLE: 'reviewer' }, 'run'],
  ['qa', { agent_type: 'proofline-qa', agent_id: 'f1' }, { AGENT_ROLE: 'qa' }, 'run'],
]);

/** The refusal text, or null when allowed. @param {string} tool @param {Record<string, unknown>} input @param {Record<string, string>} who @param {Record<string, string>} env @param {string} proj */
async function pre(tool, input, who, env, proj, cwd = proj) {
  const raw = Buffer.from(JSON.stringify({ cwd, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...who }));
  const c = await buildContext('pretool', 'claude', raw, cleanEnv({ CLAUDE_PROJECT_DIR: proj, TMPDIR: '/var/proofline-case-tmp', ...env }));
  assert.ok(c, 'no hook context');
  try {
    const out = await handle(c);
    if (typeof out !== 'string' || out === '') return null;
    return /** @type {string} */ (JSON.parse(out).hookSpecificOutput.permissionDecisionReason);
  } finally { finish(c); }
}

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
]);

/** @param {string} who */
const ownerOfScope = (who) => who === 'implementer' || who === 'designer';

for (const [what, exact, variant, sibling] of PATHS) {
  test(`A278 AC-5 (volume folds case): ${what}: ${variant} gets the verdict of ${exact}, for every role and tool`, async () => {
    await onVolume(FOLDS(), async () => {
      for (const [role, who, env, projKey] of WHO) {
        const proj = projKey === 'run' ? dir : noRun;
        for (const [opName, op] of OPS) {
          const a = await pre(...op(exact, proj), who, env, proj);
          const b = await pre(...op(variant, proj), who, env, proj);
          assert.equal(b === null, a === null, `${role}, ${opName}: exact ${a === null ? 'allowed' : 'refused'} but ${variant} ${b === null ? 'allowed' : 'refused'}`);
          // the same verdict means the same reason too: a role that the path rule keeps out anyway would hide a protected name that is not recognised
          assert.equal(reason(b, proj, exact, variant), reason(a, proj, exact, variant), `${role}, ${opName}: another reason for ${variant}`);
        }
      }
    });
  });

  test(`A278 AC-6 (volume keeps case): ${what}: ${variant} is a different path, judged like its unprotected sibling (no over-refusal)`, async () => {
    await onVolume(KEEPS(), async () => {
      for (const [role, who, env, projKey] of WHO) {
        const proj = projKey === 'run' ? dir : noRun;
        for (const [opName, op] of OPS.filter(([n]) => ['Write', 'shell redirect'].includes(n))) { // the allowed verdicts of the lead start the control plane; two tools show the rule
          const v = await pre(...op(variant, proj), who, env, proj);
          const s = await pre(...op(sibling, proj), who, env, proj);
          assert.equal(v === null, s === null, `${role}, ${opName}: ${variant} ${v === null ? 'allowed' : 'refused'} but its unprotected sibling ${sibling} ${s === null ? 'allowed' : 'refused'}`);
        }
        // the implementer and the designer own the run folder: a differently cased name under it is theirs to write on a volume that keeps case
        if (ownerOfScope(role) && variant.startsWith('.agents/runs/LC/')) {
          assert.equal(await pre('Write', { file_path: `${proj}/${variant}`, content: 'x' }, who, env, proj), null, `${role}: Write ${variant} refused although the volume keeps case`);
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
    const [, w, e] = /** @type {[string, Record<string, string>, Record<string, string>]} */ (WHO[2]);
    assert.equal(await pre('Write', { file_path: `${dir}/impl.txt`, content: 'x' }, w, e, dir), null, 'the implementer writes its scope file');
    assert.equal(await pre('Write', { file_path: `${dir}/IMPL.TXT`, content: 'x' }, w, e, dir), null, 'IMPL.TXT is impl.txt here only through the host path rule (it exists), still allowed');
  });
});

// Command words and script names: the volume's PATH folders and working folder decide whether `Agent.SH`, `Kill` and `GIT` are agent.sh, the process killer and git.
// (The marker `@` is removed at run time: a script file that names a process killer fed by a search, or a push to the protected branch, is refused by the author's own hook when node starts it.)
const U = (/** @type {string} */ t) => t.replaceAll('@', '');
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
  ['a link into .agents', 'ln -s a .agents/x', 'ln -s a .AGENTS/x', /links into or out of \.agents/],
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
        assert.equal(await pre('Bash', { command: cased }, who, env, dir), null, `${role}: ${cased} refused on a volume that keeps case`);
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
    assert.equal(await pre('Read', { file_path: `${dir}/DATA.DB` }, w, e, dir), null, 'on a case-keeping volume DATA.DB is not a database named *.db');
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
    assert.equal(await pre('Write', { file_path: `${dir}/.agents/runs/LC/CI-FIX/x.md`, content: 'x' }, w, e, dir), null, 'under the case-keeping run folder CI-FIX is not ci-fix');
    assert.ok(await pre('Write', { file_path: `${dir}/.agents/runs/LC/ci-fix/x.md`, content: 'x' }, w, e, dir), 'the exact spelling is protected there');
    assert.ok(await pre('Write', { file_path: `${dir}/.CODEX/hooks.json`, content: 'x' }, w, e, dir), 'under the folding project root the cased name is protected');
  });
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
  assert.equal(canonCase(c, 'DOCS/TÂCHES/x', true), 'docs/tâches/x');
  assert.equal(canonCase(c, 'Docs/Tâches/x', true), 'docs/tâches/x', 'the decomposed spelling is the same folder');
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
    const sh = await pre('Bash', { command: `echo x > ${rootUp}/impl.txt` }, w, e, dir);
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
