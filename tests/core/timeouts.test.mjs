// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Config, configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { ProoflineError } from '../../control-plane/agents/scripts/core/errors.mjs';
import { hookKnob, hookTimeouts, timeoutsInfo, tmScale, tmScaleMilli, tmScaled, tmWarnPercent, verifyCommandTimeout } from '../../control-plane/agents/scripts/core/timeouts.mjs';

const GOLD = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'golden', 'shell-equivalence.json'), 'utf8'));   // recorded from the shell functions of agent.sh 0.0.77 (A244)

/** @param {string} text */
const cfgOf = (text) => new Config('x', configLines(text));

describe('timeouts.scale', () => {
  test('milli: bounds, fractions, octal-looking numbers, junk', () => {
    const m = (/** @type {string} */ v) => tmScaleMilli(cfgOf(`timeouts:\n  scale: ${v}\n`));
    assert.equal(m('1'), 1000); assert.equal(m('0.5'), 500); assert.equal(m('0.49'), 1000); assert.equal(m('10'), 10000); assert.equal(m('10.001'), 1000);
    assert.equal(m('08'), 8000); assert.equal(m('08.5'), 8500); assert.equal(m('2.3456'), 2345); assert.equal(m('.5'), 500); assert.equal(m('5.'), 5000);
    assert.equal(m('abc'), 1000); assert.equal(m('1.5.2'), 1000); assert.equal(m('-1'), 1000);
    assert.equal(tmScaleMilli(cfgOf('')), 1000);
    assert.throws(() => m('99999999999999999999'), ProoflineError);
  });
  test('tmScale prints like awk (%.6g)', () => {
    assert.equal(tmScale(cfgOf('timeouts:\n  scale: 1\n')), '1');
    assert.equal(tmScale(cfgOf('timeouts:\n  scale: 2.345\n')), '2.345');
    assert.equal(tmScale(cfgOf('timeouts:\n  scale: 10\n')), '10');
  });
  test('tmScaled rounds up and clamps; the order lo then hi', () => {
    const c = cfgOf('timeouts:\n  scale: 1.5\n');
    assert.equal(tmScaled(c, 7), 11); assert.equal(tmScaled(c, 0), 1); assert.equal(tmScaled(c, '0008', 1, 100), 12); assert.equal(tmScaled(c, 100, 1, 50), 50); assert.equal(tmScaled(c, 5, 10, 3), 3);
    assert.throws(() => tmScaled(c, 'x'), ProoflineError);
    assert.throws(() => tmScaled(c, '1234567890123'), ProoflineError);
    assert.equal(tmScaled(c, '999999999999', 1, 28800), 28800);
  });
});

describe('knobs', () => {
  test('warn percent, hook knob, verify timeout', () => {
    assert.equal(tmWarnPercent(cfgOf('timeouts:\n  warn_percent: 010\n')), 50);
    assert.equal(tmWarnPercent(cfgOf('timeouts:\n  warn_percent: 100\n')), 95);
    assert.equal(tmWarnPercent(cfgOf('timeouts:\n  warn_percent: x\n')), 80);
    assert.equal(hookKnob(cfgOf('hook:\n  next_budget_seconds: 099\n'), 'next_budget_seconds', 10, 2, 20), 20);
    assert.equal(hookKnob(cfgOf(''), 'lock_wait_seconds', 8, 1, 20), 8);
    assert.equal(verifyCommandTimeout(cfgOf('verification:\n  command_timeout_seconds: 5\n')), 60);
  });
  test('the prompt hook limit is at least the approval budget plus five', () => {
    const lines = hookTimeouts(cfgOf('hook:\n  approve_budget_seconds: 25\n  prompt_timeout_seconds: 10\n'));
    assert.ok(lines.includes('prompt=30'));
    assert.equal(lines.length, 7);
    assert.deepEqual(lines.map((l) => l.split('=')[0]), ['session', 'prompt', 'pretool', 'posttool', 'subagent-start', 'subagent-stop', 'stop']);
  });
  test('timeoutsInfo hands a non-number status block limit to the shell', () => {
    assert.throws(() => timeoutsInfo(cfgOf('tasks:\n  status_block_seconds: abc\n')), ProoflineError);
    assert.ok(timeoutsInfo(cfgOf('')).includes('hook.approve_budget=20 (never scaled)'));
  });
});

describe('the shell functions, as recorded (A244)', () => {
  test('timeouts_info, hook_timeouts, verify_command_timeout over config variants give what the shell functions of agent.sh gave', () => {
    assert.equal(GOLD.timeouts.length, 8);
    for (const { variant: v, out } of GOLD.timeouts) {
      const c = cfgOf(v);
      const expected = `${timeoutsInfo(c).join('\n')}\n---\n${hookTimeouts(c).join('\n')}\n---\n${verifyCommandTimeout(c)}\n`;
      assert.equal(expected, out, JSON.stringify(v));
    }
  });
});
