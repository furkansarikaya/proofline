// @ts-check
// T2 port of risk-test.sh: the content rules of the log_sensitive signal (sc_log_words_match, sc_log_pattern_wide) and the not-a-contract list
// (sc_not_contract_drift). The cases are the literal lists of the shell scenarios; the answers are the ones the shell gave.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { RISK_NOT_CONTRACT, riskWordsMatch } from '../../control-plane/agents/scripts/core/signals.mjs';
import { agentsSrc, repo } from './port-t2-lib.mjs';

/** only the process environment is read, and only when a pattern needs the platform awk */
const ctxFor = () => /** @type {any} */ ({ childEnv: () => ({ PATH: process.env.PATH ?? '', LC_ALL: 'C' }) });

describe('risk-test: log_sensitive and the not-a-contract list', () => {
  test('sc_log_words_match: whole identifier parts, case-insensitive, plural; discard and classname are false friends; the content pattern must match too', () => {
    const ctx = ctxFor();
    for (const lw of ['log(userPassword)', 'log(user_password)', 'log(passwords)', 'log(PASSWORD)', 'log(card)', 'log(ssn)', 'log(user.Email)']) {
      assert.equal(riskWordsMatch(ctx, 'log', 'password card ssn email', [lw]), true, lw);
    }
    for (const lw of ['log(discard)', 'log(classname)', 'log(scardy)', 'log(started)', 'print(password)']) {
      assert.equal(riskWordsMatch(ctx, '^log', 'password card ssn email', [lw]), false, lw);
    }
    assert.equal(riskWordsMatch(ctx, '^log', 'token', ['x', 'log(token)']), true);
  });
  test('sc_log_pattern_wide: the widened log pattern of config.yaml opens for Console/Debug/Trace/Fprint*/print/puts/dump with a sensitive word; false friends stay closed', () => {
    const ctx = ctxFor();
    const cfg = readFileSync(path.join(agentsSrc, 'config.yaml'), 'latin1').split('\n');
    const i = cfg.findIndex((l) => l === '  log_sensitive:');
    const re = (cfg.slice(i).find((l) => l.startsWith('    content: ')) ?? '').slice('    content: '.length);
    assert.ok(re.length > 0);
    for (const lw of ['Console.WriteLine(password)', 'Debug.WriteLine(token)', 'Trace.WriteLine(secret)', 'fmt.Fprintf(w, "%s", password)', 'fmt.Fprint(os.Stderr, token)',
      'fmt.Fprintln(w, secret)', 'FMT.FPRINTF(w, password)', 'print "password"', 'puts "token"', 'var_dump($password)', 'dump($password)']) {
      assert.equal(riskWordsMatch(ctx, re, 'password token secret', [lw]), true, `opened for ${lw}`);
    }
    for (const lw of ['logger.info("started")', 'x = discard', 'classname = 1', 'cardinality = 2', 'phoneme = 3', 'scorecard = 4', 'cardholder = 5', 'wildcard = 6', 'tokenizer = 7', 'secretary = 8']) {
      assert.equal(riskWordsMatch(ctx, re, 'password token secret card phone', [lw]), false, `opened for ${lw}`);
    }
  });
  test('sc_not_contract_drift: the not-a-contract list equals the one of contract-proof', async () => {
    const m = await import(path.join(repo, 'skills/contract-proof/scripts/diff-contract.mjs'));
    assert.equal(RISK_NOT_CONTRACT, m.NOT_A_CONTRACT.source);
  });
  test('A251: a content pattern the translator does not cover (a word boundary) is matched by the platform grep, then the word test: no awk is started', () => {
    const ctx = ctxFor();
    // `\\<log` is not covered by ereToRegExp, so the platform grep selects the lines and the word test decides
    assert.equal(riskWordsMatch(ctx, '\\<log', 'password card', ['log(userPassword)']), true);
    assert.equal(riskWordsMatch(ctx, '\\<log', 'password card', ['blog(userPassword)']), false);
    assert.equal(riskWordsMatch(ctx, '\\<log', 'password card', ['log(discard)']), false);
    assert.equal(riskWordsMatch(ctx, '\\<log', 'password card', ['x', 'y(log(passwords))']), true);
    assert.equal(riskWordsMatch(ctx, '\\<log', 'password card', []), false);
    // a pattern the platform grep cannot use matches nothing (the awk exit status 2 was no match either)
    assert.equal(riskWordsMatch(ctx, '(unclosed\\<', 'password', ['log(password)']), false);
  });
});
