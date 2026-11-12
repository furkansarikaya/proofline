// @ts-check
// A258 (#181 item 3, second half): the lead's own session log. When a run ends the control plane finds the lead's session log in the runtime's own folder and appends ONE
// snapshot record (`kind: lead`, role `lead`) to tools.jsonl; `proofline insights` shows it under the role `lead`. Nothing of the log is copied; a log that cannot be used is
// `unreadable` with a reason, never zero. The finder is tested for traversal, symbolic links, a folder in place of a file, a missing file and a huge file; the record through a
// real `terminate` (a run end that needs no gates); the report for one session counted once.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { claudeProjectDir, findClaudeLead } from '../../control-plane/agents/scripts/core/leadlog.mjs';
import { insightsReport, insightsStream } from '../../control-plane/agents/scripts/core/insights.mjs';
import { toolsSummary } from '../../control-plane/agents/scripts/core/toolsinsights.mjs';
import { A, project } from './legacy-lib.mjs';
import { tempDir } from '../lib/tempdir.mjs';
import { posix } from '../lib/winpath.mjs';

const SID = '0a1b2c3d-1111-4222-8333-444455556666';
const SID2 = '0a1b2c3d-1111-4222-8333-444455557777';
const SECRET = 'sk-live-0123456789-do-not-copy';

/** A Claude session log of two tool calls, the first answered with 7 bytes, the second refused by a hook. */
const LOG = [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${SECRET}` } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `out ${SECRET}`.slice(0, 7) }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'PreToolUse:Read hook error: refused' }] } },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

/** A home with the project's session folder; returns { home, dir, file }. @param {string} cwd the working directory the session started in */
function claudeHome(cwd) {
  const home = tempDir('leadlog-home-');
  const dir = path.join(home, '.claude', 'projects', claudeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  return { home, dir, file: path.join(dir, `${SID}.jsonl`) };
}

describe('findClaudeLead: the lead\'s Claude session log', () => {
  const cwd = '/work/my.project_1';
  test('the folder name is the working directory with every character outside [A-Za-z0-9] replaced by a dash', () => {
    assert.equal(claudeProjectDir(cwd), '-work-my-project-1');
    assert.equal(claudeProjectDir('/a b/ü'), '-a-b--');
  });

  test('found: a regular file in the runtime\'s own folder, by the session id; CLAUDE_CONFIG_DIR wins when absolute', () => {
    const { home, file } = claudeHome(cwd);
    writeFileSync(file, LOG);
    const px = (/** @type {{ file: string, reason: string | null }} */ r) => ({ ...r, file: posix(r.file) });   // the product joins with '/', path.join with the host's separator
    assert.deepEqual(px(findClaudeLead({ HOME: home, CLAUDE_CODE_SESSION_ID: SID }, [cwd])), { file: posix(file), reason: null });
    assert.deepEqual(px(findClaudeLead({ HOME: '/nonexistent', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_CODE_SESSION_ID: SID }, ['/other', cwd])), { file: posix(file), reason: null });
    assert.equal(findClaudeLead({ HOME: '', CLAUDE_CONFIG_DIR: 'relative/.claude', CLAUDE_CODE_SESSION_ID: SID }, [cwd]).reason, 'no-claude-home');   // a relative config folder is not used
  });

  test('a session id that is not a UUID is refused before any path is built (traversal, absolute path, empty, upper-case junk)', () => {
    const { home, dir } = claudeHome(cwd);
    writeFileSync(path.join(path.dirname(dir), 'secret.jsonl'), 'x\n');
    for (const bad of ['../secret', `../${claudeProjectDir(cwd)}/${SID}`, '/etc/passwd', '', 'ZZZZZZZZ-1111-4222-8333-444455556666', `${SID}/../..`, `${SID}\n`]) {
      assert.deepEqual(findClaudeLead({ HOME: home, CLAUDE_CODE_SESSION_ID: bad }, [cwd]), { file: '', reason: 'no-session-id' }, JSON.stringify(bad));
    }
  });

  test('missing file, a folder in place of the file, a symbolic link to a file and a symbolic link as the project folder: none is read', () => {
    const { home, dir, file } = claudeHome(cwd);
    const env = { HOME: home, CLAUDE_CODE_SESSION_ID: SID };
    assert.deepEqual(findClaudeLead(env, [cwd]), { file: '', reason: 'no-transcript' });
    mkdirSync(file);
    assert.deepEqual(findClaudeLead(env, [cwd]), { file: '', reason: 'not-a-file' });
    const real = path.join(tempDir('leadlog-real-'), 'real.jsonl'); writeFileSync(real, LOG);
    const home2 = claudeHome('/work/two'); symlinkSync(real, home2.file);
    assert.deepEqual(findClaudeLead({ HOME: home2.home, CLAUDE_CODE_SESSION_ID: SID }, ['/work/two']), { file: '', reason: 'not-a-file' });
    const home3 = tempDir('leadlog-home3-'); mkdirSync(path.join(home3, '.claude/projects'), { recursive: true });
    const target = tempDir('leadlog-target-'); writeFileSync(path.join(target, `${SID}.jsonl`), LOG);
    symlinkSync(target, path.join(home3, '.claude/projects', claudeProjectDir('/work/three')));
    assert.deepEqual(findClaudeLead({ HOME: home3, CLAUDE_CODE_SESSION_ID: SID }, ['/work/three']), { file: '', reason: 'not-a-file' });
    assert.ok(dir.length > 0);
  });
});

/** The records of tools.jsonl. @param {string} dir */
const records = (dir) => readFileSync(path.join(dir, '.agents/local/metrics/tools.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const END = 'reason: the build tool the task needs is not installed here\nevidence: the build command exits 127: command not found in this sandbox\n';

describe('the record at the end of a run', () => {
  /** Run `terminate BLOCKED` as the lead with the given environment. @param {string} dir @param {Record<string, string>} env */
  const terminate = (dir, env) => A(dir, ['terminate', 'LC', 'BLOCKED'], { input: END, env });

  test('a readable session log: one lead record with the counts, the session id and none of the log\'s text', () => {
    const dir = project('scaffold orchestrated no COMPLEX ""');
    const { home, file } = claudeHome(realpathSync(dir));
    writeFileSync(file, LOG);
    const r = terminate(dir, { HOME: home, CLAUDE_CODE_SESSION_ID: SID });
    assert.equal(r.status, 0, r.text);
    assert.equal(r.out, 'run terminated: LC BLOCKED\n');
    const lead = records(dir).filter((x) => x.kind === 'lead');
    assert.equal(lead.length, 1);
    assert.deepEqual({ ...lead[0], time: 'T' }, { schema: 'proofline.tools/1', kind: 'lead', time: 'T', task: 'LC', role: 'lead', focus: null, gate: null, runtime: 'claude', log: 'ok', calls: 2, result_bytes: 42, denied: 1, by_tool: { Bash: { calls: 1, bytes: 7 }, Read: { calls: 1, bytes: 35 } }, reason: null, session: SID });
    assert.ok(!readFileSync(path.join(dir, '.agents/local/metrics/tools.jsonl'), 'utf8').includes(SECRET));
    // insights shows the lead under its own role
    const t = insightsReport(insightsStream(dir, ''), { json: false, only: '', off: false });
    assert.match(t, /^ {2}lead +1 +2\.0 +42 +2 +42 +1 +/m);
  });

  test('no session variable, a log that is not there, a huge log: unreadable with the reason, counts unknown (null), the command unchanged', () => {
    for (const [name, mk, reason] of /** @type {Array<[string, (d: string) => Record<string, string>, string]>} */ ([
      ['no session id', () => ({ HOME: '/nonexistent' }), 'no-session-id'],
      ['no file', (d) => ({ HOME: claudeHome(realpathSync(d)).home, CLAUDE_CODE_SESSION_ID: SID }), 'no-transcript'],
      ['huge file', (d) => { const h = claudeHome(realpathSync(d)); writeFileSync(h.file, ''); truncateSync(h.file, 129 * 1024 * 1024); return { HOME: h.home, CLAUDE_CODE_SESSION_ID: SID }; }, 'too-large'],
      ['not JSON', (d) => { const h = claudeHome(realpathSync(d)); writeFileSync(h.file, 'not json\nstill not\n'); return { HOME: h.home, CLAUDE_CODE_SESSION_ID: SID }; }, 'bad-line'],
    ])) {
      const dir = project('scaffold orchestrated no COMPLEX ""');
      const r = terminate(dir, mk(dir));
      assert.equal(r.status, 0, `${name}: ${r.text}`);
      assert.equal(r.out, 'run terminated: LC BLOCKED\n', name);
      const lead = records(dir).filter((x) => x.kind === 'lead');
      assert.equal(lead.length, 1, name);
      assert.equal(lead[0].log, reason === 'bad-line' ? 'malformed' : 'unreadable', name);
      assert.equal(lead[0].reason, reason, name);
      assert.equal(lead[0].calls, null, name);
      assert.equal(lead[0].result_bytes, null, name);
    }
  });

  test('a Codex lead (CODEX_THREAD_ID, no Claude variable) is looked up as a Codex session, never as a Claude one', () => {
    const dir = project('scaffold orchestrated no COMPLEX ""');
    const r = terminate(dir, { HOME: tempDir('leadlog-nohome-'), CODEX_THREAD_ID: SID });
    assert.equal(r.status, 0, r.text);
    const lead = records(dir).filter((x) => x.kind === 'lead');
    assert.deepEqual([lead[0].runtime, lead[0].log, lead[0].reason, lead[0].session], ['codex', 'unreadable', 'no-rollout', SID]);
  });

  test('metrics: off writes nothing; a tools.jsonl that cannot be written never fails the command', () => {
    const off = project('scaffold orchestrated no COMPLEX ""');
    writeFileSync(path.join(off, '.agents/config.yaml'), `metrics: off\n${readFileSync(path.join(off, '.agents/config.yaml'), 'utf8')}`);
    assert.equal(terminate(off, { HOME: '/nonexistent' }).status, 0);
    assert.throws(() => records(off));
    const blocked = project('scaffold orchestrated no COMPLEX ""');
    mkdirSync(path.join(blocked, '.agents/local/metrics/tools.jsonl'), { recursive: true });   // a folder where the file should be
    const r = terminate(blocked, { HOME: '/nonexistent' });
    assert.equal(r.status, 0, r.text);
    assert.equal(r.out, 'run terminated: LC BLOCKED\n');
  });
});

describe('insights: the lead role', () => {
  /** @param {Record<string, unknown>} o */
  const lead = (o) => JSON.stringify({ schema: 'proofline.tools/1', kind: 'lead', time: 'T', task: 'RUN-A', role: 'lead', focus: null, gate: null, runtime: 'claude', log: 'ok', calls: 5, result_bytes: 500, denied: 0, by_tool: { Bash: { calls: 5, bytes: 500 } }, reason: null, session: SID, ...o });
  /** @param {string[]} lines */
  function summary(lines, only = '') {
    const f = path.join(tempDir('leadlog-sum-'), 'tools.jsonl');
    writeFileSync(f, `${lines.join('\n')}\n`);
    return toolsSummary(f, only);
  }

  test('snapshots of one session are one lead job (the most calls), sessions are summed, an unreadable lead is unknown and never zero', () => {
    const lines = [lead({ calls: 5, result_bytes: 500 }), lead({ calls: 9, result_bytes: 900, time: 'T2', task: 'RUN-B' }), lead({ session: SID2, task: 'RUN-A', calls: 3, result_bytes: 30 }),
      lead({ session: '', task: 'RUN-C', log: 'unreadable', calls: null, result_bytes: null, denied: null, by_tool: null, reason: 'no-transcript' })];
    const s = summary(lines);
    const g = /** @type {import('../../control-plane/agents/scripts/core/toolsinsights.mjs').Group} */ (s.roles.get('lead'));
    assert.deepEqual([g.jobs, g.read, g.unreadable, g.calls, g.bytes], [3, 2, 1, 12, 930]);
    // the session counted once is shown under the task of its best snapshot
    assert.deepEqual([...s.runs.keys()].sort(), ['RUN-B', 'RUN-C', 'RUN-A'].sort());
    assert.equal(/** @type {any} */ (s.runs.get('RUN-B')).calls, 9);
    // the order of the file does not change the result
    const r = summary([...lines].reverse());
    assert.deepEqual(r.runs.get('RUN-B')?.calls, 9);
    assert.deepEqual([r.roles.get('lead')?.calls, r.roles.get('lead')?.jobs], [12, 3]);
  });

  test('the task filter applies to the task of the chosen snapshot; a lead record of another schema is skipped', () => {
    const lines = [lead({ calls: 9, task: 'RUN-B' }), lead({ calls: 1, task: 'RUN-A' }), lead({ schema: 'proofline.tools/9' })];
    assert.equal(summary(lines, 'RUN-B').roles.get('lead')?.calls, 9);
    assert.equal(summary(lines, 'RUN-A').roles.get('lead'), undefined);
    assert.equal(summary(lines).skipped, 1);
  });
});
