// @ts-check
// A202 item 29 (docs/concepts/timeouts.md), the Node form of tests/enforcement/timeouts-test.sh (176-C): time limits that fit real use and slow machines.
//  - timeouts.scale multiplies every duration and is bounded; the approval budget is never scaled;
//  - every timeout key has a minimum and a maximum in config-check, so none can switch a limit off or make it endless;
//  - init and upgrade write the hook limits from the config into the settings files: other settings are kept, the second run changes nothing;
//  - an upgrade keeps the user's values and moves only a limit that still holds an earlier shipped default;
//  - doctor proposes a scale from a measurement and writes it only after the user's own "approve scale";
//  - a step that used most of its time is told to the lead in one line, without blocking;
//  - a build command stopped by its limit is a failure and leaves no sealed record.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, capture, cleanEnv, commitAll, git, newRepo, tmp } from '../lib/harness.mjs';
import { repo } from '../hook/harness.mjs';
import { editConfig, kv, setcfg, shim, sleepSync, strip, tv } from './cfg-util.mjs';
import { fixture } from './lib.mjs';

const PL = path.join(repo, 'bin/proofline');
/** The CLI in a project. @param {string} dir @param {string[]} args @param {Record<string, string>} [env] */
const pl = (dir, args, env = {}) => { const r = spawnSync(process.execPath, [PL, ...args], { cwd: dir, env: cleanEnv(env), encoding: 'utf8', timeout: 300000 }); return { status: r.status, text: (r.stdout ?? '') + (r.stderr ?? '') }; };
const cfgPath = (/** @type {string} */ d) => path.join(d, '.agents/config.yaml');
const cfgText = (/** @type {string} */ d) => readFileSync(cfgPath(d), 'utf8');
/** A fresh repository with an initial commit, as the settings and upgrade scenarios start. @param {string} dir */
function gitProject(dir) {
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['config', 'user.email', 't@t.test']); git(dir, ['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'f.txt'), 'hi\n'); commitAll(dir, 'i');
}
const INIT = ['init', '--yes', '--runtimes', 'claude', '--lead', 'claude', '--worker', 'claude', '--reviewers', 'claude'];

test('scale_multiplies: timeouts.scale multiplies dispatch, build, lock, status block, CI wait and hook limits; the approval budget never moves', () => {
  const d = fixture();
  assert.equal(tv(d, 'scale'), '1', `the default scale is not 1: ${tv(d, 'scale')}`);
  const d1 = Number(tv(d, 'dispatch.STANDARD')); const c1 = Number(tv(d, 'verification.command')); const l1 = Number(tv(d, 'lock'));
  const s1 = tv(d, 'status_block'); const w1 = Number(tv(d, 'batch.ci_wait_minutes')); const h1 = Number(tv(d, 'hook.timeout.pretool'));
  setcfg(d, 'timeouts', 'scale', '2.5');
  const x25 = (/** @type {number} */ n) => Math.trunc((n * 5) / 2);
  assert.equal(Number(tv(d, 'dispatch.STANDARD')), x25(d1), `dispatch.STANDARD ${d1} did not become 2.5 times: ${tv(d, 'dispatch.STANDARD')}`);
  assert.equal(Number(tv(d, 'verification.command')), x25(c1), 'the build and test limit did not scale');
  assert.equal(Number(tv(d, 'lock')), x25(l1), 'the lock wait did not scale');
  assert.equal(tv(d, 'status_block'), '50', `the status block limit did not scale: ${tv(d, 'status_block')} from ${s1}`);
  assert.equal(Number(tv(d, 'batch.ci_wait_minutes')), x25(w1), 'the CI wait did not scale');
  assert.equal(Number(tv(d, 'hook.timeout.pretool')), x25(h1), 'the hook limit did not scale');
  assert.equal(kv(d, 'hook-config', 'approve_budget_seconds'), '20', `the approval budget was scaled: ${kv(d, 'hook-config', 'approve_budget_seconds')}`);
  assert.equal(kv(d, 'hook-config', 'lock_wait_seconds'), '8', "the hook's lock wait was scaled");
  setcfg(d, 'timeouts', 'scale', '10');
  assert.equal(kv(d, 'hook-config', 'approve_budget_seconds'), '20', 'the approval budget moved at scale 10');
  assert.equal(tv(d, 'hook.timeout.stop'), '300', `a hook limit at scale 10 is not 300: ${tv(d, 'hook.timeout.stop')}`);
  assert.ok(Number(tv(d, 'dispatch.CRITICAL')) <= 28800, `a scaled dispatch limit passed the ceiling of 28800 s: ${tv(d, 'dispatch.CRITICAL')}`);
  // the prompt limit never falls below the approval budget + 5, whatever the config says
  setcfg(d, 'timeouts', 'scale', '1.0'); setcfg(d, 'hook', 'prompt_timeout_seconds', '10');
  assert.equal(kv(d, 'hook-timeouts', 'prompt'), '25', `the prompt hook limit fell below the approval budget + 5: ${kv(d, 'hook-timeouts', 'prompt')}`);
});

test('bounds: every time limit has a minimum and a maximum; a bad hand-edited scale is read as 1', () => {
  const d = newRepo();
  const c = cfgText(d);
  const bad = path.join(d, 'cfg.bad'); const good = path.join(d, 'cfg.good');
  assert.equal(A(d, ['config-check']).status, 0, 'the shipped config does not pass config-check');
  /** config-check must refuse the file with LINE added under SECTION. @param {string} section @param {string} line */
  const chk = (section, line) => {
    writeFileSync(bad, c.split('\n').flatMap((l) => (l === `${section}:` ? [l, `  ${line}`] : [l])).join('\n'));
    assert.notEqual(A(d, ['config-check', bad]).status, 0, `config-check accepted ${section}.${line}`);
  };
  for (const b of ['scale: 0', 'scale: 0.4', 'scale: 11', 'scale: abc', 'scale: -2', 'warn_percent: 10', 'warn_percent: 99', 'turbo: 1']) chk('timeouts', b);
  for (const b of ['session_timeout_seconds: 0', 'prompt_timeout_seconds: 9', 'stop_timeout_seconds: 601', 'pretool_timeout_seconds: abc', 'subagent_stop_timeout_seconds: 100000']) chk('hook', b);
  chk('verification', 'command_timeout_seconds: 0'); chk('verification', 'command_timeout_seconds: 59'); chk('verification', 'command_timeout_seconds: 999999');
  chk('dispatch', 'timeout_seconds: 0'); chk('dispatch', 'timeout_seconds: 29'); chk('dispatch', 'timeout_seconds: 28801');
  chk('tasks', 'status_block_seconds: 0'); chk('tasks', 'status_block_seconds: 301');
  chk('batch', 'ci_wait_minutes: 0'); chk('batch', 'ci_appear_minutes: 100000');
  for (const cl of ['TRIVIAL', 'STANDARD', 'COMPLEX', 'CRITICAL']) {
    for (const v of [0, 29, 28801]) {
      let inc = false;
      writeFileSync(bad, c.split('\n').map((l) => {
        if (/^ {4}dispatch_timeout_seconds:/.test(l) && inc) { inc = false; return `    dispatch_timeout_seconds: ${v}`; }
        if (l === `  ${cl}:`) inc = true;
        return l;
      }).join('\n'));
      assert.notEqual(A(d, ['config-check', bad]).status, 0, `config-check accepted pipelines.${cl}.dispatch_timeout_seconds: ${v}`);
    }
  }
  for (const okLine of ['scale: 0.5', 'scale: 10', 'scale: 2.25', 'warn_percent: 50']) {
    writeFileSync(good, c.split('\n').flatMap((l) => (l === 'timeouts:' ? [l, `  ${okLine}`] : [l])).join('\n'));
    assert.equal(A(d, ['config-check', good]).status, 0, `config-check refused a valid timeouts.${okLine}`);
  }
  // a bad hand-edited scale never reaches a timer as 0, a negative or a huge number
  for (const v of ['0', '-3', 'abc', '99', '0.1', '']) { setcfg(d, 'timeouts', 'scale', v); assert.equal(tv(d, 'scale'), '1', `scale '${v}' was not read as 1: ${tv(d, 'scale')}`); }
  setcfg(d, 'timeouts', 'scale', '1.0');
  for (const v of ['0', '-1', 'abc', '5']) { setcfg(d, 'dispatch', 'timeout_seconds', v); assert.ok(Number(tv(d, 'dispatch.default')) >= 30, `dispatch.timeout_seconds '${v}' reached a timer below 30 s: ${tv(d, 'dispatch.default')}`); }
});

test('warn_line: a step at 80% of its time gets one TIME line in next and wait-line; none before, none when dead; the wait instruction stays', async () => {
  const d = fixture();
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  const pid = child.pid;
  try {
    const mk = (/** @type {number} */ elapsed, /** @type {number} */ limit) => {
      mkdirSync(path.join(d, '.agents/runs/LC/dispatch'), { recursive: true });
      writeFileSync(path.join(d, '.agents/runs/LC/dispatch/001-reviewer-claude.running'),
        `pid=${pid}\nrole=reviewer\ntimeout=${limit}\nstarted_epoch=${Math.floor(Date.now() / 1000) - elapsed}\ndispatch in flight: LC reviewer on claude, started now.\n`);
    };
    const time = (/** @type {string} */ out) => out.split('\n').filter((l) => l.startsWith('note=TIME'));
    // a 10000 s limit: a slow machine that takes seconds between mk and the check still reads the same whole percent (85% holds for 8500 to 8599 s)
    mk(1000, 10000); let out = strip(A(d, ['next', 'LC']).out);
    assert.equal(time(out).length, 0, `a step at 10% of its time was reported: ${out}`);
    assert.match(out, /^next=wait: dispatch\.sh LC reviewer in flight/m, `next does not say a dispatch is in flight: ${out}`);
    mk(8500, 10000); out = strip(A(d, ['next', 'LC']).out);
    assert.equal(time(out).length, 1, `a step at 85% of its time is not reported with exactly one line: ${out}`);
    assert.ok(time(out)[0].includes('has used 141m of its 166m limit (85%)'), `the line does not name the use: ${time(out)[0]}`);
    assert.match(out, /^next=wait: dispatch\.sh LC reviewer in flight/m, `the warning replaced the wait instruction: ${out}`);
    assert.match(time(out)[0], /never a pass/i, 'the line does not say a timeout is not a pass');
    const wl = strip(A(d, ['wait-line', 'LC']).out);
    assert.ok(wl.includes('TIME: 85% of its 166m limit'), `wait-line does not carry the warning: ${wl}`);
    assert.equal(wl.split('\n').length, 1, 'wait-line is more than one line');
    // the threshold is config: 90 is not reached at 85%
    setcfg(d, 'timeouts', 'warn_percent', '90'); out = strip(A(d, ['next', 'LC']).out);
    assert.equal(time(out).length, 0, 'warn_percent 90 still warned at 85%');
    setcfg(d, 'timeouts', 'warn_percent', '80');
    // a marker without a start time or a dead process says nothing
    child.kill(); await once(child, 'exit');
    out = strip(A(d, ['next', 'LC']).out);
    assert.equal(time(out).length, 0, 'a dead dispatch was reported as slow');
  } finally { child.kill(); }
});

test('build_timeout: a build command stopped by its limit fails, leaves no sealed record, and the next run starts again', (t) => {
  if (spawnSync('sh', ['-c', 'command -v timeout']).status !== 0) { t.skip('no timeout command here'); return; }
  const d = fixture();
  setcfg(d, 'verification', 'command_timeout_seconds', '60');
  // the shipped bound is 60 s; a test cannot wait that long, so the stop is forced with a stub that exits 124 like timeout(1) does
  const PATH = shim(path.join(tmp('shim'), 'bin'), 'timeout', '#!/bin/sh\nshift\nexit 124\n');
  let skip = false;
  const kept = cfgText(d).split('\n').filter((l) => { if (l.startsWith('commands:')) { skip = true; return false; } if (skip && /^[^ ]/.test(l)) skip = false; return !skip; });
  writeFileSync(cfgPath(d), `${kept.join('\n')}${kept.at(-1) === '' ? '' : '\n'}commands:\n  build: true\n  test: true\n`);
  commitAll(d, 'cmds');
  const r = A(d, ['build-record', 'LC', 'run'], { env: { PATH } });
  assert.notEqual(r.status, 0, `a build command stopped by its limit passed: ${r.text}`);
  assert.ok(r.text.includes('stopped after 60s'), `the stop is not named: ${r.text}`);
  assert.match(r.text, /not a pass/i, 'the message does not say it is not a pass');
  const done = () => { const b = path.join(d, '.agents/local/builds'); return existsSync(b) ? readdirSync(b).map((n) => path.join(b, n, 'done')).filter((f) => existsSync(f)) : []; };
  assert.deepEqual(done(), [], 'a timed-out build left a sealed record that the next run would reuse');
  const r2 = A(d, ['build-record', 'LC', 'run']);
  assert.ok(done().length > 0, `the next run did not make a record (rc ${r2.status}): ${r2.text.split('\n').slice(-4).join('\n')}`);
  assert.equal(strip(done().map((f) => readFileSync(f, 'utf8')).join('')), '0', 'the second run did not pass');
});

test('settings_merge: hook limits come from the config into settings.json: other settings kept, idempotent, kept on upgrade', () => {
  const d = tmp('proj'); gitProject(d);
  mkdirSync(path.join(d, '.claude'));
  const s = path.join(d, '.claude/settings.json');
  writeFileSync(s, `{
  "model": "opus",
  "permissions": { "allow": ["Bash(ls:*)"], "deny": ["Read(./secrets/**)"] },
  "env": { "MY_FLAG": "1" },
  "hooks": {
    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo mine", "timeout": 7 } ] } ],
    "Notification": [ { "hooks": [ { "type": "command", "command": "echo note" } ] } ]
  }
}
`);
  assert.equal(pl(d, INIT).status, 0, 'init failed');
  const text = () => readFileSync(s, 'utf8');
  /** The timeout of the first proofline hook of an event. @param {string} ev */
  const hk = (ev) => {
    const j = JSON.parse(text());
    for (const g of j.hooks[ev] ?? []) for (const h of g.hooks) if (String(h.command ?? '').includes('proofline-hook.mjs')) return String(h.timeout);
    return 'undefined';
  };
  const userKept = (/** @type {string[]} */ extra) => ['"model": "opus"', 'MY_FLAG', 'Read(./secrets', 'echo note', ...extra].every((x) => text().includes(x));
  assert.ok(hk('PreToolUse') === '30' && hk('SubagentStop') === '120' && hk('SubagentStart') === '60', `default hook limits not written: ${hk('PreToolUse')} ${hk('SubagentStart')} ${hk('SubagentStop')}`);
  assert.ok(userKept(['"timeout": 7']), `init lost a user setting: ${text()}`);
  // config -> settings: scale 2 and a single limit
  setcfg(d, 'timeouts', 'scale', '2'); setcfg(d, 'hook', 'subagent_start_timeout_seconds', '45');
  assert.equal(pl(d, ['upgrade']).status, 0, 'upgrade failed');
  assert.ok(hk('PreToolUse') === '60' && hk('SubagentStop') === '240' && hk('SubagentStart') === '90' && hk('UserPromptSubmit') === '60',
    `scaled hook limits not written: ${hk('PreToolUse')} ${hk('SubagentStart')} ${hk('SubagentStop')} ${hk('UserPromptSubmit')}`);
  assert.ok(text().includes('"timeout": 7'), "the timeout of a hook that is not proofline's was changed");
  assert.ok(userKept(['echo mine']), 'upgrade lost a user setting');
  const hooks = () => text().split('\n').filter((l) => l.includes('proofline-hook.mjs')).length;
  assert.equal(hooks(), 7, `hook groups were duplicated or lost: ${hooks()}`);
  // the second run changes nothing, byte for byte
  const once1 = readFileSync(s);
  assert.equal(pl(d, ['upgrade']).status, 0, 'second upgrade failed'); assert.equal(pl(d, ['upgrade']).status, 0, 'third upgrade failed');
  assert.ok(once1.equals(readFileSync(s)), 'a repeated upgrade changed the settings file');
  // the user's config values survive an upgrade
  assert.ok(cfgText(d).split('\n').filter((l) => l === '  scale: 2').length === 1 && cfgText(d).includes('subagent_start_timeout_seconds: 45'), "an upgrade overwrote the user's timeout values");
});

test('upgrade_defaults: an upgrade moves a limit that still holds the earlier default, keeps a changed one and a value set later', () => {
  const src = newRepo();
  const old1 = cfgText(src).split('\n').map((l) => (l.startsWith('proofline_version:') ? 'proofline_version: 0.0.38' : l.replace(/^ {2}timeout_seconds: .*/, '  timeout_seconds: 1800'))).join('\n');
  // the older shipped class values, COMPLEX changed by the user; the new keys do not exist in an old config
  let cls = '';
  const classed = old1.split('\n').map((l) => {
    if (['TRIVIAL', 'STANDARD', 'COMPLEX', 'CRITICAL'].some((c) => l === `  ${c}:`)) cls = l.trim().slice(0, -1);
    if (/^ {4}dispatch_timeout_seconds:/.test(l)) return `    dispatch_timeout_seconds: ${cls === 'TRIVIAL' ? 900 : cls === 'STANDARD' ? 1800 : cls === 'COMPLEX' ? 2400 : 3600}`;
    return l;
  });
  let skip = false;
  const old2 = classed.filter((l) => { if (l.startsWith('timeouts:')) { skip = true; return false; } if (skip && /^[^ ]/.test(l)) skip = false; return !skip; }).join('\n');
  assert.ok(!/^timeouts:/m.test(old2), 'the fixture config still has the new section');
  const d = tmp('up'); gitProject(d);
  assert.equal(pl(d, INIT).status, 0, 'init failed');
  writeFileSync(cfgPath(d), old2);
  assert.equal(pl(d, ['upgrade']).status, 0, 'upgrade failed');
  /** The dispatch_timeout_seconds of a class (the awk g()). @param {string} want */
  const g = (want) => {
    let sec = ''; let c = ''; const out = [];
    for (const l of cfgText(d).split('\n')) {
      if (/^[^ #]/.test(l)) sec = l.split(/\s+/)[0];
      if (/^ {2}[A-Z]+:$/.test(l)) c = l.trim();
      if (l.includes('dispatch_timeout_seconds:') && sec === 'pipelines:' && c === want) out.push(l.trim().split(/\s+/)[1]);
    }
    return out.join('\n');
  };
  const top = () => cfgText(d).split('\n').filter((l) => l.startsWith('  timeout_seconds: ')).map((l) => l.slice('  timeout_seconds: '.length)).join('\n');
  assert.equal(top(), '5400', `dispatch.timeout_seconds at the old default was not moved: ${top()}`);
  assert.ok(g('TRIVIAL:') === '1800' && g('STANDARD:') === '5400' && g('CRITICAL:') === '7200', `class limits at the old defaults were not moved: ${g('TRIVIAL:')} ${g('STANDARD:')} ${g('CRITICAL:')}`);
  assert.equal(g('COMPLEX:'), '2400', `a class limit the user changed (2400) was overwritten: ${g('COMPLEX:')}`);
  assert.ok(cfgText(d).split('\n').includes('  scale: 1.0'), 'the upgrade did not add timeouts.scale');
  // a user who sets 1800 after the upgrade keeps it
  editConfig(d, (t) => t.split('\n').map((l) => l.replace(/^ {2}timeout_seconds: 5400/, '  timeout_seconds: 1800').replace(/^proofline_version:.*/, 'proofline_version: 0.0.39')).join('\n'));
  pl(d, ['upgrade']);
  assert.equal(top(), '1800', 'an upgrade from a current install overwrote a value the user set');
});

test('doctor_scale: doctor proposes a scale from a measurement and writes it only after the user\'s own approve scale', () => {
  const d = fixture();
  const PATH = shim(path.join(tmp('shim'), 'bin'), 'git', `#!/bin/sh\ncase "$*" in *" add "*) sleep 2 ;; esac\nexec ${spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()} "$@"\n`);
  const before = cfgText(d);
  const now = () => Math.floor(Date.now() / 1000);
  let r = pl(d, ['doctor', '--scale'], { PATH });
  assert.equal(r.status, 0, `doctor --scale failed: ${r.text}`);
  assert.ok(r.text.includes('scale proposal'), `a slow machine got no proposal: ${r.text}`);
  assert.ok(r.text.includes('approve scale'), `the question does not show the exact phrase: ${r.text}`);
  assert.equal(cfgText(d), before, "doctor --scale changed the config before the user's reply");
  const prop = path.join(d, '.agents/local/scale/PROPOSAL.tsv');
  assert.ok(existsSync(prop) && readFileSync(prop).length > 0, 'no proposal file');
  const proposed = () => readFileSync(prop, 'utf8').split('\n').map((l) => l.split('\t')).find((f) => f[0] === 'scale')?.[1] ?? '';
  const v0 = proposed();
  assert.match(v0, /^([1-9]\d*\.[05]|[1-9]\d*|10)$/, `the proposed scale is not a bounded half step: ${v0}`);
  // no reply, a reply that is not an approval, a negation, another kind: nothing is written
  assert.notEqual(pl(d, ['doctor', '--apply-scale']).status, 0, '--apply-scale wrote without any reply');
  sleepSync(1000);   // a capture is newer than its request and not ahead of the clock (the Node core ignores a capture dated more than 5 s ahead)
  for (const t of ['looks good', 'do not approve scale', 'approve commands', 'approve scale if it is safe']) {
    capture(d, t, now()); A(d, ['approve-pending']);
    assert.notEqual(pl(d, ['doctor', '--apply-scale']).status, 0, `--apply-scale wrote after '${t}'`);
    assert.equal(cfgText(d), before, `the config changed after '${t}'`);
  }
  // an agent cannot make the approval: the lead-side command refuses, and a forged proposal is another hash
  writeFileSync(prop, 'scale\t9\n');
  assert.notEqual(A(d, ['scale-check']).status, 0, 'a changed proposal was covered by the earlier request');
  pl(d, ['doctor', '--scale'], { PATH });
  const v = proposed();   // measured again: the value may differ, the approval binds the new file
  sleepSync(1000); capture(d, 'approve scale', now()); A(d, ['approve-pending']);
  r = pl(d, ['doctor', '--apply-scale']);
  assert.equal(r.status, 0, `--apply-scale refused after the user's 'approve scale': ${r.text}`);
  const scales = () => cfgText(d).split('\n').filter((l) => l.startsWith('  scale: ')).map((l) => l.slice(9)).join('\n');
  assert.equal(scales(), v, `the approved scale was not written: ${scales()} (wanted ${v})`);
  assert.equal(A(d, ['config-check']).status, 0, 'the written scale does not pass config-check');
  // used up: the same reply does not apply a second proposal
  writeFileSync(prop, 'scale\t3\n');
  assert.notEqual(pl(d, ['doctor', '--apply-scale']).status, 0, 'one reply applied two proposals');
  // a machine within the reference gets no proposal
  rmSync(path.join(d, '.agents/local/scale'), { recursive: true, force: true });
  editConfig(d, (t) => t.split('\n').map((l) => l.replace(/^ {2}scale: .*/, '  scale: 1.0')).join('\n'));
  r = pl(d, ['doctor', '--scale']);
  assert.ok(r.text.includes('timing:'), `doctor --scale printed no timing: ${r.text}`);
});
