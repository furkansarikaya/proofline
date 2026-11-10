// @ts-check
// The capture contract against the golden bytes recorded from the old shell hook (tests/golden/capture, record.mjs): the capture file, the
// intake copy and the history copy are byte-identical, a task-notification leaves nothing but its intake, and
// captureField of the core read every golden capture as the shell capture_field did (recorded in tests/golden/shell-equivalence.json, A244).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureField, isTaskNotification, safeSession, storePrompt, writeIntake } from '../../control-plane/agents/scripts/core/capture.mjs';
import { CORPUS, MS, PID, SECONDS, SESSION } from '../golden/capture/corpus.mjs';

const GOLDEN = path.join(import.meta.dirname, '..', 'golden', 'capture');
const GOLD = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'golden', 'shell-equivalence.json'), 'utf8'));   // recorded from the shell functions of agent.sh 0.0.77 (A244)
const golden = (/** @type {string} */ name, /** @type {string} */ file) => readFileSync(path.join(GOLDEN, name, file));

for (const c of CORPUS) {
  test(`capture bytes: ${c.name}`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-cap-'));
    try {
      mkdirSync(`${dir}/.agents/local`, { recursive: true });
      const event = golden(c.name, 'event.json');
      const files = JSON.parse(golden(c.name, 'files.json').toString());
      const text = String(JSON.parse(event.toString()).prompt);
      assert.equal(writeIntake(dir, MS, PID, event), `${dir}/.agents/local/prompts/intake/${files.intake}`);
      assert.deepEqual(readFileSync(`${dir}/.agents/local/prompts/intake/${files.intake}`), golden(c.name, 'intake.json'));
      if (isTaskNotification(text)) {
        assert.equal(c.ignored, true);
        assert.deepEqual(readdirSync(`${dir}/.agents/local/prompts`), ['intake']);
        return;
      }
      assert.ok(!c.ignored);
      const r = storePrompt(`${dir}/.agents/local`, SESSION, SECONDS, text);
      assert.ok(r);
      assert.equal(path.basename(r.capture), files.capture);
      assert.equal(path.basename(r.history), files.history);
      assert.deepEqual(readFileSync(r.capture), golden(c.name, 'capture.json'));
      assert.deepEqual(readFileSync(r.history), golden(c.name, 'history.txt'));
      assert.deepEqual(readdirSync(`${dir}/.agents/local/prompts`).sort(), [files.capture, 'history', 'intake'].sort());
      assert.equal(r.id, `${SESSION}:${SECONDS}:${r.sha256}`);
      assert.equal(captureField(readFileSync(r.capture, 'latin1'), 'sha256'), r.sha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('captureField reads every golden capture as the shell capture_field did (answers recorded from the shell, A244)', () => {
  let n = 0;
  for (const c of CORPUS) {
    if (c.ignored) continue;
    const buf = readFileSync(path.join(GOLDEN, c.name, 'capture.json'), 'latin1');
    for (const key of ['session', 'time', 'sha256', 'text', 'missing']) {
      const want = GOLD.captureField[`${c.name}|${key}`];
      assert.notEqual(want, undefined, `no recorded answer for ${c.name} ${key}`);
      assert.equal(captureField(buf, key), want, `${c.name} ${key}`);
      n++;
    }
  }
  assert.ok(n >= 20, `${n} answers checked`);
});

test('the session id is made safe by byte, an empty one is unknown', () => {
  assert.equal(safeSession('a/b cé'), 'a_b_c__');
  assert.equal(safeSession(''), 'unknown');
  assert.equal(safeSession('ok-1.2_x'), 'ok-1.2_x');
});
