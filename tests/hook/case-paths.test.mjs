// @ts-check
// A278 (issue #264, AC-5, AC-6 and the case part of AC-7): a path that differs from a protected path only by letter case (or Unicode normalization form) gets the SAME verdict as the exact spelling on a
// file system that folds case, for every role and every guard that compares a path; on a file system that keeps case apart it is a DIFFERENT path (judged like any unprotected sibling, no over-refusal).
// The hook asks the volume with a runtime probe (lib/fscase.mjs). Here the probe is INJECTED so both behaviours are exercised on one host: every variant below names a folder that does not exist on any host (a
// name the host's own real path resolution could fix), so the injected volume alone decides. One test at the end uses the REAL probe on its temp folder and asserts whichever behaviour that folder has;
// none depends on the host being macOS. The verdicts are asked in process (the same buildContext and PreToolUse handler the hook runs); one test spawns the real hook to prove they agree.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync as rm, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const cases = /** @type {Array<[string, string, number[]]>} */ ([['npm test', 'npm', [0, 4]], ['make test', 'make', [0, 4]], ['pytest', 'pytest', [0]], ['sh .agents/scripts/agent.sh build-record', 'agent.sh', [0]], ['git diff', 'git', [4]]]);
  await onVolume(FOLDS(), async () => {
    for (const [lower, word, whoIdx] of cases) {
      for (const wi of whoIdx) {
        const [role, who, wenv] = /** @type {typeof WHO[number]} */ (WHO[wi]);
        const base = await pre('Bash', { command: lower }, who, { ...wenv, ...env }, proj);
        assert.ok(base && /rtk/.test(base), `${role}: ${lower} is not the rtk refusal (fix the table): ${base}`);
        for (const sp of spellings(word)) {
          const v = await pre('Bash', { command: withWord(lower, word, sp) }, who, { ...wenv, ...env }, proj);
          assert.ok(v && /rtk/.test(v), `${role}: ${sp} escapes the evidence-command rule: ${v}`);
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
        assert.equal(await pre('Bash', { command: c }, who, env, projKey === 'run' ? dir : noRun), null, `${role}: ${c} refused on a volume that keeps case`);
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
    // a remote side keeps its case: GitHub ref names are case-sensitive, so Main there is not the protected branch
    setHead(proj, 'feat');
    assert.equal(await pre('Bash', { command: U('git push origin HEAD:Ma@in') }, LEAD[1], LEAD[2], proj), null, 'a push to a differently cased REMOTE branch');
    assert.equal(await pre('Bash', { command: U('git push origin Ma@in') }, LEAD[1], LEAD[2], proj), null);
    assert.ok(await pre('Bash', { command: U('git push origin HEAD:ma@in') }, LEAD[1], LEAD[2], proj), 'the exact remote name is refused');
  });
});

test('A278 B2 (git dir keeps case; a regression guard for no over-refusal, it passes without the fix): MAIN is another branch there, judged like any task branch (no over-refusal)', async () => {
  const proj = copyProject(template, base);
  await onVolume(KEEPS(), async () => {
    setHead(proj, 'feat');
    for (const c of MAIN_FORMS) assert.equal(await pre('Bash', { command: c }, LEAD[1], LEAD[2], proj), null, `refused on a case-keeping git dir: ${c}`);
    setHead(proj, 'MAIN');
    for (const c of ON_MAIN) assert.equal(await pre('Bash', { command: c }, LEAD[1], LEAD[2], proj), null, `refused with HEAD at MAIN on a case-keeping git dir: ${c}`);
  });
});

test('A278 B2 real file system: in a throwaway repository the refs of the temp folder fold case or not, and the guards judge the cased branch accordingly', async () => {
  const repo = tempDir('hook-case-repo-');
  const run = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', repo, ...a], { env: cleanEnv(), encoding: 'utf8' });
  assert.equal(run('init', '-q', '-b', 'main').status, 0);
  assert.equal(run('commit', '-q', '--allow-empty', '-m', 'x').status, 0);
  const folds = existsSync(join(repo, '.git/refs/heads/MAIN')); // the ground truth of the ref store, found without the code under test
  const proj = copyProject(template, base);
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

test('A278 D1 (volume folds case): a here-document delimiter or terminator that is a program name does not hide the next line (the folded text keeps the structure of the original)', async () => {
  const shapes = [(/** @type {string} */ w) => `cat <<${w}\nx\n${w}\n`, (w) => `cat <<\\${w}\nx\n${w}\n`, (w) => `cat <<'${w}'\nx\n${w}\n`, (w) => `cat <<-${w}\n\tx\n\t${w}\n`, (w) => `echo $(cat <<${w}\nx\n${w}\n)\n`];
  const words = ['Time', 'Git', 'Echo', 'Sh', 'Find', 'EOF'];
  const inner = [U('find . -maxdepth 0 -exec Pki@ll foo \\;'), U('Set@sid Pki@ll foo'), U('Watch Pki@ll foo'), U("find . -execdir Sh -c 'Pki@ll foo' \\;")];
  await onVolume(FOLDS(), async () => {
    for (const [wi, w] of words.entries()) {
      for (const [si, shape] of shapes.entries()) {
        for (const wh of [WHO[0], WHO[2], WHO[4]]) {
          const [role, who, env, projKey] = /** @type {typeof WHO[number]} */ (wh);
          const proj = projKey === 'run' ? dir : noRun;
          const c = shape(w) + inner[(wi + si) % inner.length];
          const twin = await pre('Bash', { command: c.toLowerCase() }, who, env, proj);
          const v = await pre('Bash', { command: c }, who, env, proj);
          assert.equal(v === null, twin === null, `${role}, ${JSON.stringify(c)}: ${v === null ? 'allowed' : 'refused'} but its lower-case twin is ${twin === null ? 'allowed' : 'refused'}`);
          if (si === 0 && wh === WHO[0]) assert.ok(v, `the lead is not refused: ${JSON.stringify(c)}`);
        }
      }
    }
  });
});

test('A278 D1: the folded text keeps the line and here-document structure (the regions are the scanner\'s: delimiters, bodies and terminators as typed; an arithmetic shift and a here-string open nothing)', async () => {
  const { foldWords } = await import(pathToFileURL(join(hookDir, 'guards/kit.mjs')).href);
  const { scanRegions } = await import(pathToFileURL(join(hookDir, 'command-scan.mjs')).href);
  const text = "cat <<Time\nGit push\nTime\nGit status\ncat <<<Git\necho $((1<<2))\nGit x";
  assert.deepEqual(scanRegions(text).regions.map(([x, y]) => text.slice(x, y)), ['Time', 'Git push\nTime\n']);
  const out = foldWords(text);
  assert.equal(out, "cat <<Time\nGit push\nTime\ngit status\ncat <<<Git\necho $((1<<2))\ngit x");
  assert.equal(out.split('\n').length, text.split('\n').length);
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
      for (const c of cmds.filter((x) => /Manage|Prisma/.test(x))) assert.equal(await pre('Bash', { command: c }, who, env, dir), null, `${role}: ${c} refused on a case-keeping volume`);
    });
  }
});

test('A278 C1: foldWords folds the protected word and the path below it, never the absolute path above it, and a program name inside a project or relative path is a file name', async () => {
  const { foldWords } = await import(pathToFileURL(join(hookDir, 'guards/kit.mjs')).href);
  assert.equal(foldWords('ls /Users/Me/Proj/.AGENTS/Local/x', '/Users/Me/Proj'), 'ls /Users/Me/Proj/.agents/local/x');
  assert.equal(foldWords('sh /Users/Me/Proj/.agents/scripts/Agent.SH status', '/Users/Me/Proj'), 'sh /Users/Me/Proj/.agents/scripts/agent.sh status', 'a name below .agents is folded');
  assert.equal(foldWords('cd /Users/Me/Git/Proj; Git status', '/Users/Me/Git/Proj'), 'cd /Users/Me/Git/Proj; git status');
  assert.equal(foldWords('cat Src/Git/Make /usr/bin/GIT', '/p'), 'cat Src/Git/Make /usr/bin/git');
});

// ---- A278 round 3: the here-document regions are the scanner's (E1 the commit forms, E2 the lines the old private parser misread, the ordinary table, the pathological input) ----

/** a small seeded generator (mulberry32) @param {number} seed */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
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

test('A278 E1 (volume folds case): the commit and PR forms that carry a here-document are judged as on a case-keeping volume (no "changes its here-document structure" for a body with capitals)', async () => {
  const { foldWords } = await import(pathToFileURL(join(hookDir, 'guards/kit.mjs')).href);
  const body = 'Install the Make target\nSource Time Command Script Go Cat\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01154uSCGRtcwmouJ68QRffm';
  const cmds = [
    `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`,
    `git commit -m "$(cat <<EOF\n${body}\nEOF\n)"`,
    `echo "$(cat <<EOF\n${body}\nEOF\n)"`,
    `gh pr create --title t --body "$(cat <<'EOF'\n${body}\nEOF\n)"`,
    `bash -c 'cat <<EOF\n${body}\nEOF'`,
    `git commit -F - <<'EOF'\n${body}\nEOF`,
  ];
  for (const c of cmds) assert.equal(foldWords(c).split('\n').length, c.split('\n').length);
  for (const [role, who, env, projKey] of WHO) {
    const proj = projKey === 'run' ? dir : noRun;
    for (const c of cmds) {
      const keeps = await onVolume(KEEPS(), () => pre('Bash', { command: c }, who, env, proj));
      const folds = await onVolume(FOLDS(), () => pre('Bash', { command: c }, who, env, proj));
      assert.ok(!/here-document structure/.test(folds ?? ''), `${role}: ${JSON.stringify(c)}: ${folds}`);
      assert.equal(folds === null, keeps === null, `${role}: ${JSON.stringify(c)}: keeps ${keeps === null ? 'allowed' : 'refused'} but folds ${folds === null ? 'allowed' : 'refused'} (${folds})`);
    }
  }
});

test('A278 E2 (volume folds case): a line the old private parser took for a here-document opener (a quote spanning lines, an arithmetic shift, a delimiter with a suffix) gives a case variant the verdict of its lower-case twin', async () => {
  const kill = U('Pki@ll foo');
  const cases = [
    `echo "a\nb <<X"\nFind . -maxdepth 0 -exec ${kill} \\;`,
    `echo "a\nb <<X"\nFind . -execdir Sh -c '${kill}' \\;`,
    `echo $((1<<n))\nFind . -maxdepth 0 -exec ${kill} \\;`,
    `echo $((1<<n))\nWatch ${kill}`,
    `cat <<'X'Y\nx\nX\nFind . -maxdepth 0 -exec ${kill} \\;\nXY\nok`,
    `cat <<'X'Y\nx\nXY\nFind . -maxdepth 0 -exec ${kill} \\;`,
    `echo 'a\nb <<X'\nSetsid ${kill}`,
  ];
  let denied = 0;
  await onVolume(FOLDS(), async () => {
    for (const wh of [WHO[0], WHO[2], WHO[4]]) {
      const [role, who, env, projKey] = /** @type {typeof WHO[number]} */ (wh);
      const proj = projKey === 'run' ? dir : noRun;
      for (const c of cases) {
        const twin = await pre('Bash', { command: c.toLowerCase() }, who, env, proj);
        const v = await pre('Bash', { command: c }, who, env, proj);
        if (twin !== null) denied++;
        assert.equal(v === null, twin === null, `${role}, ${JSON.stringify(c)}: ${v === null ? 'allowed' : 'refused'} but its lower-case twin is ${twin === null ? 'allowed' : 'refused'}`);
      }
    }
  });
  assert.ok(denied >= 6, `the table must contain denied twins (it had ${denied})`);
});

test('A278 E1 ordinary heredoc table (volume folds case): 300 ordinary commands with here-documents, 5 roles: the folded judgement equals the case-keeping one (0 flips), and the folded text keeps the scanner\'s bodies', async () => {
  const { foldWords } = await import(pathToFileURL(join(hookDir, 'guards/kit.mjs')).href);
  const { scanCommand } = await import(pathToFileURL(join(hookDir, 'command-scan.mjs')).href);
  const r = rng(264_003);
  const cmds = Array.from({ length: 300 }, () => ordinary(r));
  const shape = (/** @type {string} */ t) => scanCommand(t, { fold: true }).records.filter((x) => x.kind === 'H').map((x) => x.raw.split('\x03').slice(2).join('\x03')).join('\0');
  let heredocs = 0;
  for (const c of cmds) {
    const v = foldWords(c);
    assert.equal(v.split('\n').length, c.split('\n').length, JSON.stringify(c));
    assert.equal(shape(v), shape(c), `the bodies changed: ${JSON.stringify(c)}`);
    if (shape(c) !== '') heredocs++;
  }
  assert.ok(heredocs >= 270, `most of the table opens a here-document (${heredocs})`);
  let flips = 0;
  for (const [role, who, env, projKey] of WHO.filter((w) => w[0] !== 'lead without a run')) {
    const proj = projKey === 'run' ? dir : noRun;
    for (const c of cmds) {
      const folds = await onVolume(FOLDS(), () => pre('Bash', { command: c }, who, env, proj));
      if (folds === null) continue; // the second pass only adds refusals, so an allowed verdict here is allowed on the case-keeping volume too; only a refusal needs the comparison
      const keeps = await onVolume(KEEPS(), () => pre('Bash', { command: c }, who, env, proj));
      if (keeps === null) { flips++; assert.fail(`${role}: ${JSON.stringify(c)}: keeps allowed, folds refused (${folds})`); }
    }
  }
  assert.equal(flips, 0);
});

test('A278 E1: a pathological input costs steps in proportion to its size (many openers, many nested substitutions, many shifts), not a quadratic scan', async () => {
  const { foldWords } = await import(pathToFileURL(join(hookDir, 'guards/kit.mjs')).href);
  const { scanRegions } = await import(pathToFileURL(join(hookDir, 'command-scan.mjs')).href);
  const forms = ['Cat <<A '.repeat(25000), 'Cat <<A\nx\nA\n'.repeat(16000), 'echo "$(Cat <<A\nx\nA\n)"\n'.repeat(8000), 'echo $((1<<n)) Git\n'.repeat(10000), '<<'.repeat(100000)];
  for (const t of forms) {
    assert.ok(t.length >= 180_000);
    const { steps, regions } = scanRegions(t, { fold: true });
    assert.ok(steps <= 2 * t.length, `${steps} scanner steps for ${t.length} characters`);
    assert.ok(regions.length <= t.length / 2);
    assert.equal(foldWords(t).length, t.length);
  }
});
