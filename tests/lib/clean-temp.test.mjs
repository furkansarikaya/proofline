// @ts-check
// `node tests/lib/clean-temp.mjs` (A253): which names it may touch, which folders it leaves (links, files, other users', young ones, a base whose process is alive), the dry run, and the
// whole command on a real temp folder at a fixed instant. No wall clock: the instant is an argument, the "old" folders get their age from `utimes`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { PREFIXES, cleanFakeTools, cleanTemp, isTestTemp, main } from './clean-temp.mjs';
import { cleanEnv, tmp } from './harness.mjs';

const NOW = 1_000_000_000_000; const HOUR = 3600e3;
const clean = (/** @type {number} */ ageH) => { const t = (NOW - ageH * HOUR) / 1000; return t; };
/** A folder with a file in it, `ageH` hours old at NOW. @param {string} dir @param {string} name @param {number} ageH */
function folder(dir, name, ageH) {
  const d = path.join(dir, name); mkdirSync(d); writeFileSync(path.join(d, 'f'), 'x'.repeat(1000)); utimesSync(d, clean(ageH), clean(ageH)); return d;
}

describe('the names it may touch', () => {
  test('the harness\' own names and the legacy ones of the leaking tests match; nothing else does', () => {
    for (const n of ['proofline-h-AbC123', 'proofline-fp.x1y2z3', 'proofline-approve.Qw12er', 'proofline-doctor.abcdef', 'proofline-bt-fake-abcdef', 'proofline-recipe-abcdef', 'proofline-guards-abcdef', 'proofline-submit.abcdef',
      'proofline-t-api-AbCd12', 'proofline-t-pl-t2s-AbCd12', 'wiki-abcdef', 'ds-abcdef', 'probe-bin-abcdef', 'pl-lib-abcdef', 'pl-t2s-abcdef', 'pl-t2-name-abcdef', 'adp-abcdef', 'rv-bin-abcdef', 'rv-proj-abcdef', 'pl-core-abcdef', 'hf5-abcdef', 'hf5b-abcdef', 'br-out-abcdef', 'br-timeout-abcdef', 'bt-fake-abcdef', 'bt-origin-abcdef', 'plr-abcdef', 'recipe-abcdef']) assert.ok(isTestTemp(n), n);
    for (const n of ['dispatch-abcdef', 'knowweave-query-abcdef', 'TemporaryDirectory.abcdef', 'proofline-review-9', 'proofline-review-244', 'proofline-worktree', 'proofline-x-abcdef', 'proofline-h-abc', 'pl-lib-abc', 'pl-lib-abcdefg', 'adp', 'rv-bin-', 'proofline-harness-501', 'proofline-e2e', 'proofline-smoke.abcdef', 'proofline', 'prooflines', 'hf5-', 'hf5-abc', 'hf5-abcdefg', 'br-out-abcde!', 'br-abcdef', 'bt-fake-abcdef/..', 'com.apple.x', 'TemporaryItems', '.proofline-h-abcdef', 'x-proofline-h-abcdef', 'ProofLine-h-abcdef', 'recipe', 'plr-abc']) assert.ok(!isTestTemp(n), n);
    assert.ok(PREFIXES.length > 0);
  });
});

describe('what it removes', () => {
  test('a repository that carries a matching name is kept (a .git inside, file or folder); our own proofline-t-/proofline-h- folders are not', () => {
    const dir = tmp('tmp');
    for (const n of ['pl-lib-REPO01', 'proofline-fp.REPO02']) { const d = folder(dir, n, 9); mkdirSync(path.join(d, '.git')); utimesSync(d, clean(9), clean(9)); }
    const wt = folder(dir, 'pl-lib-WTREE3', 9); writeFileSync(path.join(wt, '.git'), 'gitdir: /x\n'); utimesSync(wt, clean(9), clean(9));
    const ours = folder(dir, 'proofline-t-api-OURS01', 9); mkdirSync(path.join(ours, '.git')); utimesSync(ours, clean(9), clean(9));
    assert.deepEqual(cleanTemp(dir, { now: NOW }).map((x) => path.basename(x.path)), ['proofline-t-api-OURS01']);
    assert.deepEqual(readdirSync(dir).sort(), ['pl-lib-REPO01', 'pl-lib-WTREE3', 'proofline-fp.REPO02']);
  });

  test('a person\'s folder named proofline-<anything> is not on the list, whatever is in it', () => {
    const dir = tmp('tmp'); folder(dir, 'proofline-review-9', 99); folder(dir, 'proofline-review-244', 99);
    assert.deepEqual(cleanTemp(dir, { now: NOW }), []);
  });

  const run = (/** @type {string} */ dir, /** @type {object} */ o = {}) => cleanTemp(dir, { now: NOW, ...o });

  test('old folders with a harness name go (with their size), younger ones and other names stay', () => {
    const dir = tmp('tmp');
    folder(dir, 'proofline-h-OLDOLD', 5); folder(dir, 'hf5-OLDOLD', 3); folder(dir, 'proofline-h-YOUNG1', 1); folder(dir, 'someones-notes', 99); folder(dir, 'proofline-harness-501', 99);
    const r = run(dir);
    assert.deepEqual(r.map((x) => path.basename(x.path)).sort(), ['hf5-OLDOLD', 'proofline-h-OLDOLD']);
    assert.ok(r.every((x) => x.bytes >= 1000));
    assert.deepEqual(readdirSync(dir).sort(), ['proofline-h-YOUNG1', 'proofline-harness-501', 'someones-notes']);
  });

  test('the threshold is 2 hours by default and an option; at exactly the threshold a folder stays', () => {
    const dir = tmp('tmp'); folder(dir, 'proofline-h-EXACT1', 2); folder(dir, 'proofline-h-OVER12', 2.01);
    assert.deepEqual(run(dir, { dryRun: true }).map((x) => path.basename(x.path)), ['proofline-h-OVER12']);
    assert.deepEqual(run(dir, { dryRun: true, hours: 0.5 }).map((x) => path.basename(x.path)).sort(), ['proofline-h-EXACT1', 'proofline-h-OVER12']);
  });

  test('--dry-run reports the same and removes nothing', () => {
    const a = tmp('tmp'); const b = tmp('tmp');
    for (const d of [a, b]) { folder(d, 'proofline-h-OLDOLD', 5); folder(d, 'br-out-OLDOLD', 5); }
    const dry = run(a, { dryRun: true }); const real = run(b);
    assert.deepEqual(dry.map((x) => [path.basename(x.path), x.bytes]), real.map((x) => [path.basename(x.path), x.bytes]));
    assert.equal(readdirSync(a).length, 2); assert.equal(readdirSync(b).length, 0);
  });

  test('a link named like a harness folder is neither followed nor removed, and neither is its target; nor a plain file, nor a folder of another user', () => {
    const dir = tmp('tmp'); const target = folder(tmp('elsewhere'), 'precious', 99);
    symlinkSync(target, path.join(dir, 'proofline-h-LINKED')); utimesSync(path.join(dir, 'proofline-h-LINKED'), clean(9), clean(9));
    writeFileSync(path.join(dir, 'proofline-h-AFILE1'), 'x'); utimesSync(path.join(dir, 'proofline-h-AFILE1'), clean(9), clean(9));
    folder(dir, 'proofline-h-THEIRS', 9);
    assert.deepEqual(run(dir, { uid: (process.getuid?.() ?? 0) + 1 }), [], 'the folders are of another user');
    assert.deepEqual(run(dir).map((x) => path.basename(x.path)), ['proofline-h-THEIRS'], 'only the real folder of this user goes');
    assert.ok(existsSync(path.join(target, 'f')) && existsSync(path.join(dir, 'proofline-h-LINKED')) && existsSync(path.join(dir, 'proofline-h-AFILE1')));
  });

  test('a link INSIDE an old folder is removed as a link; what it points at survives', () => {
    const dir = tmp('tmp'); const target = folder(tmp('elsewhere'), 'precious', 99);
    const d = folder(dir, 'proofline-h-WITHLN', 9); symlinkSync(target, path.join(d, 'ln')); utimesSync(d, clean(9), clean(9));   // the new entry changed the folder's time
    run(dir);
    assert.deepEqual(readdirSync(dir), []); assert.ok(existsSync(path.join(target, 'f')));
  });

  test('a base whose recorded process is alive stays however old; one whose process is gone goes; a garbage .pid is ignored', () => {
    const dir = tmp('tmp');
    for (const [name, pid] of [['proofline-h-ALIVE1', '4242'], ['proofline-h-DEAD11', '4343'], ['proofline-h-JUNK11', 'not a pid']]) {
      const d = folder(dir, name, 9); writeFileSync(path.join(d, '.pid'), `${pid}\n`); utimesSync(d, clean(9), clean(9));
    }
    const r = run(dir, { isAlive: (/** @type {number} */ pid) => pid === 4242 });
    assert.deepEqual(r.map((x) => path.basename(x.path)).sort(), ['proofline-h-DEAD11', 'proofline-h-JUNK11']);
    assert.deepEqual(readdirSync(dir), ['proofline-h-ALIVE1']);
  });

  test('a folder that is not there, or a temp folder that cannot be read, is an empty result and not an error', () => {
    assert.deepEqual(run(path.join(tmp('x'), 'nope')), []);
  });
});

describe('the fake-tool folders of the checkout (A180)', () => {
  test('<pid> and batch-<pid> folders of a dead process go; a live pid, a young folder and other names (also ln-/cx-, which live inside a <pid> folder) stay', () => {
    const dir = tmp('ft');
    folder(dir, '4242', 9); folder(dir, 'batch-4343', 9); folder(dir, '4444', 9); folder(dir, 'batch-4545', 1); folder(dir, 'ln-ABCDEF', 9); folder(dir, 'notes', 99);
    const r = cleanFakeTools(dir, { now: NOW, isAlive: (/** @type {number} */ pid) => pid === 4444 });
    assert.deepEqual(r.map((x) => path.basename(x.path)).sort(), ['4242', 'batch-4343']);
    assert.deepEqual(readdirSync(dir).sort(), ['4444', 'batch-4545', 'ln-ABCDEF', 'notes']);
  });

  test('a fake-tool root that is a link (a branch can commit one) is never entered, and nor is a plain file', () => {
    const target = tmp('target'); folder(target, '2024', 99); folder(target, 'batch-7', 99);
    const holder = tmp('holder'); const link = path.join(holder, '.fake-tools'); symlinkSync(target, link);
    assert.deepEqual(cleanFakeTools(link, { now: NOW }), []);
    assert.deepEqual(readdirSync(target).sort(), ['2024', 'batch-7']);
    const file = path.join(holder, 'file'); writeFileSync(file, 'x'); assert.deepEqual(cleanFakeTools(file, { now: NOW }), []);
  });
});

describe('the command', () => {
  test('the folder it works in is refused however it was given: --tmpdir or TMPDIR, any letter case of the home folder (compared by device and inode)', () => {
    const script = path.join(import.meta.dirname, 'clean-temp.mjs');
    const home = path.join(tmp('h'), 'Home'); mkdirSync(home); folder(home, 'pl-lib-AbC123', 9);
    const run = (/** @type {string[]} */ args, /** @type {Record<string, string>} */ env) => spawnSync(process.execPath, [script, '--dry-run', ...args], { env: cleanEnv({ HOME: home, ...env }), encoding: 'utf8' });
    for (const [args, env] of /** @type {Array<[string[], Record<string, string>]>} */ ([[['--tmpdir', home], {}], [[], { TMPDIR: home }], [[], { TMPDIR: path.dirname(home) }]])) {
      const r = run(args, env);
      assert.equal(r.status, 2, `${args} ${JSON.stringify(env)}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, /refusing/); assert.equal(r.stdout, '');
    }
    const other = path.join(path.dirname(home), 'HOME');   // the same folder under another spelling on a case-insensitive file system; elsewhere it is not there and nothing is scanned
    const r = run(['--tmpdir', other], {});
    assert.ok(!r.stdout.includes('pl-lib-AbC123'), `the home folder was scanned through another spelling: ${r.stdout}`);
    if (existsSync(other)) assert.equal(r.status, 2);
  });

  test('without --tmpdir it also prunes the fake-tool folders of the checkout (and only those of a dead pid)', () => {
    const dir = tmp('tmp'); const ft = tmp('ft'); folder(ft, '999999999', 9); folder(ft, `${process.pid}`, 9);
    /** @type {string[]} */ const out = [];
    assert.equal(main(['--dry-run'], { now: NOW, out: (l) => out.push(l), dirs: [dir], fakeTools: ft }), 0);
    assert.equal(out.length, 2); assert.match(out[0], /would remove .*999999999 .*fake tools unused for 9h/);
    assert.equal(main([], { now: NOW, out: () => {}, dirs: [dir], fakeTools: ft }), 0);
    assert.deepEqual(readdirSync(ft), [`${process.pid}`]);
  });

  test('--tmpdir refuses the root, the home folder, the checkout, an empty value and the folders above them; --hours below 1 is a usage error', () => {
    const script = path.join(import.meta.dirname, 'clean-temp.mjs');
    const home = tmp('home');
    for (const d of ['/', home, path.resolve(import.meta.dirname, '..', '..'), '', path.dirname(home)]) {
      const r = spawnSync(process.execPath, [script, '--dry-run', '--tmpdir', d], { env: cleanEnv({ HOME: home }), encoding: 'utf8' });
      assert.equal(r.status, 2, `--tmpdir ${JSON.stringify(d)}: ${r.stdout}`); assert.match(r.stderr, /refusing|usage/);
    }
    for (const h of ['0', '0.5', '-1', 'x']) assert.equal(spawnSync(process.execPath, [script, '--dry-run', '--hours', h, '--tmpdir', tmp('t')], { env: cleanEnv({}), encoding: 'utf8' }).status, 2, `--hours ${h}`);
    assert.equal(spawnSync(process.execPath, [script, '--dry-run', '--hours', '1', '--tmpdir', tmp('t')], { env: cleanEnv({}), encoding: 'utf8' }).status, 0);
  });

  /** @param {string[]} argv @param {string} dir */
  const cmd = (argv, dir) => { /** @type {string[]} */ const out = []; const status = main([...argv, '--tmpdir', dir], { now: NOW, out: (l) => out.push(l) }); return { status, out }; };

  test('removes old test folders and prunes the template cache of that temp folder, prints each with its size and a total, and --dry-run touches nothing', () => {
    const dir = tmp('tmp'); const uid = process.getuid?.() ?? 0;
    folder(dir, 'proofline-h-OLDOLD', 5);
    const cache = path.join(dir, `proofline-harness-${uid}`); mkdirSync(cache, { mode: 0o700 });
    const entry = folder(cache, 'ctl-old', 20); writeFileSync(path.join(entry, '.built'), ''); utimesSync(path.join(entry, '.built'), clean(20), clean(20));
    const young = folder(cache, 'ctl-young', 1); writeFileSync(path.join(young, '.built'), ''); utimesSync(path.join(young, '.built'), clean(0.1), clean(0.1));
    const dry = cmd(['--dry-run'], dir);
    assert.equal(dry.status, 0);
    assert.equal(dry.out.length, 3); assert.match(dry.out[0], /^would remove .*proofline-h-OLDOLD \(0\.0 MB, unused for 5h\)$/);
    assert.match(dry.out[1], /would remove .*ctl-old .*cache: idle\)$/); assert.match(dry.out[2], /^would remove 2 folders, [\d.]+ MB \(dry run: nothing was removed\)$/);
    assert.ok(existsSync(entry) && existsSync(path.join(dir, 'proofline-h-OLDOLD')));
    const real = cmd([], dir);
    assert.match(real.out.at(-1) ?? '', /^removed 2 folders, /);
    assert.ok(!existsSync(entry) && existsSync(young) && !existsSync(path.join(dir, 'proofline-h-OLDOLD')));
  });

  test('a cache folder that is a link is never entered', () => {
    const dir = tmp('tmp'); const uid = process.getuid?.() ?? 0; const target = tmp('elsewhere');
    const e = folder(target, 'ctl-old', 99); writeFileSync(path.join(e, '.built'), ''); utimesSync(path.join(e, '.built'), clean(99), clean(99));
    symlinkSync(target, path.join(dir, `proofline-harness-${uid}`));
    const r = cmd([], dir);
    assert.ok(existsSync(e), 'the entry behind the link is still there'); assert.match(r.out.at(-1) ?? '', /^removed 0 folders/);
  });

  test('the real process: bad arguments exit 2 with the usage, --dry-run on an empty folder exits 0', () => {
    const script = path.join(import.meta.dirname, 'clean-temp.mjs'); const dir = tmp('tmp');
    const bad = spawnSync(process.execPath, [script, '--nope'], { env: cleanEnv({}), encoding: 'utf8' });
    assert.equal(bad.status, 2); assert.match(bad.stderr, /usage: node tests\/lib\/clean-temp\.mjs/);
    const ok = spawnSync(process.execPath, [script, '--dry-run', '--tmpdir', dir], { env: cleanEnv({}), encoding: 'utf8' });
    assert.equal(ok.status, 0); assert.match(ok.stdout, /^would remove 0 folders, 0\.0 MB \(dry run: nothing was removed\)\n$/);
  });
});

describe('the folders of a test process are removed when it is killed (A253)', () => {
  /** @type {Set<import('node:child_process').ChildProcess>} */ const children = new Set();
  after(() => { for (const c of children) c.kill('SIGKILL'); });   // a handler that swallowed the signal must not leave its child running after a test timed out
  for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
    test(`${sig}: the base folder is gone, and the process still ends by the signal (its exit status is not swallowed)`, { timeout: 30000 }, async () => {
      const code = `import { tmp, base } from ${JSON.stringify(new URL('./harness.mjs', import.meta.url).href)};
        tmp('x'); process.stdout.write(base() + '\\n'); process.stdin.resume();`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: cleanEnv({}), stdio: ['pipe', 'pipe', 'inherit'] });
      children.add(c);
      const baseDir = await new Promise((res) => { let s = ''; c.stdout.on('data', (d) => { s += d; if (s.includes('\n')) res(s.trim()); }); });
      assert.ok(existsSync(/** @type {string} */ (baseDir)), 'the base exists while the process runs');
      assert.equal(readdirSync(/** @type {string} */ (baseDir)).includes('.pid'), true, 'the base records its process');
      const ended = new Promise((res) => c.on('exit', (code, signal) => res({ code, signal })));
      try {
        c.kill(sig);
        assert.deepEqual(await ended, { code: null, signal: sig });
        assert.ok(!existsSync(/** @type {string} */ (baseDir)), 'the base is removed');
      } finally { c.kill('SIGKILL'); }
    });
  }

  test('removeAtExit removes the folder at a normal exit too', async () => {
    const dir = tmp('victim'); writeFileSync(path.join(dir, 'f'), 'x');
    const code = `import { removeAtExit } from ${JSON.stringify(new URL('./harness.mjs', import.meta.url).href)}; removeAtExit(process.argv[1]);`;
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { env: cleanEnv({}) });
    await new Promise((res) => c.on('exit', res));
    assert.ok(!existsSync(dir));
  });
});
