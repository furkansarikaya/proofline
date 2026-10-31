// @ts-check
// Records the golden files from the OLD engine, the shell code of agent.sh (the specification). Run by hand and review the diff; the golden
// test (tests/core/golden.test.mjs) then holds both engines to the recorded text:
//   node tests/core/golden/record.mjs [risk-words-match|next-order]
//   risk-words-match.json  risk_words_match (agent.sh): the cases of risk-test.sh sc_log_words_match and sc_log_pattern_wide plus boundary cases
//   next-order.txt         the stdout of `agent.sh next` along the lifecycle (intake: classify, branch, baseline; plan; implement; gates), the order
//                          that tests/skills/proofline-lead.test.mjs states in prose (intake follows the order agent.sh next prints)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { baseEnv } from '../../equivalence/fixture.mjs';
import { stateFixture } from '../../equivalence/cases/stage2-fixtures.mjs';
import { extractFunctions, repo } from '../helpers.mjs';

export const GOLDEN = path.join(import.meta.dirname);
/** The shipped risk.log_sensitive.content pattern, as test sc_log_pattern_wide reads it from config.yaml (the golden stores its text). */
export const LOG_RE = (() => {
  const cfg = readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'utf8').split('\n');
  const i = cfg.indexOf('  log_sensitive:'); const l = cfg.slice(i).find((x) => x.startsWith('    content: '));
  if (i < 0 || !l) throw new Error('log_sensitive content not found in config.yaml');
  return l.slice('    content: '.length);
})();
/** The states `next` is recorded on, in lifecycle order. */
export const NEXT_STATES = ['intake-unclassified', 'intake-classified', 'intake-branched', 'intake-planned', 'gates-standalone', 'gates-frozen', 'gates-implemented', 'gates-failed'];

/** @typedef {{ re: string, words: string, lines: string[], match: boolean }} WordsCase */

/** risk_words_match run in sh exactly as agent.sh defines it. @returns {boolean} */
export function shellRiskWordsMatch(/** @type {string} */ re, /** @type {string} */ words, /** @type {string[]} */ lines) {
  const r = spawnSync('sh', ['-c', `${extractFunctions(['risk_words_match'])}\nrisk_words_match "$1" "$2"`, 'x', re, words], { input: lines.join('\n') + '\n', encoding: 'latin1', env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' } });
  if (r.status !== 0 && r.status !== 1) throw new Error(`risk_words_match exited ${r.status}: ${r.stderr}`);
  return r.status === 0;
}

/** Inputs only (the expected result is what the shell says). The first two groups are the lists of risk-test.sh. @returns {Omit<WordsCase,'match'>[]} */
export function wordsInputs() {
  /** @type {Omit<WordsCase,'match'>[]} */ const c = [];
  const W = 'password card ssn email';
  for (const l of ['log(userPassword)', 'log(user_password)', 'log(passwords)', 'log(PASSWORD)', 'log(card)', 'log(ssn)', 'log(user.Email)']) c.push({ re: 'log', words: W, lines: [l] });
  for (const l of ['log(discard)', 'log(classname)', 'log(scardy)', 'log(started)', 'print(password)']) c.push({ re: '^log', words: W, lines: [l] });
  c.push({ re: '^log', words: 'token', lines: ['x', 'log(token)'] });
  for (const l of ['Console.WriteLine(password)', 'Debug.WriteLine(token)', 'Trace.WriteLine(secret)', 'fmt.Fprintf(w, "%s", password)', 'fmt.Fprint(os.Stderr, token)', 'fmt.Fprintln(w, secret)', 'FMT.FPRINTF(w, password)',
    'print "password"', 'puts "token"', 'var_dump($password)', 'dump($password)']) c.push({ re: LOG_RE, words: 'password token secret', lines: [l] });
  for (const l of ['logger.info("started")', 'x = discard', 'classname = 1', 'cardinality = 2', 'phoneme = 3', 'scorecard = 4', 'cardholder = 5', 'wildcard = 6', 'tokenizer = 7', 'secretary = 8'])
    c.push({ re: LOG_RE, words: 'password token secret card phone', lines: [l] });
  // boundaries of the word test: the character before (letter, camel-case hump, digit, underscore) and after (plural s, other letters)
  for (const l of ['log(myPassword)', 'log(my_password)', 'log(my-password)', 'log(1password)', 'log(Passwords)', 'log(PASSWORDS)', 'log(passwordx)', 'log(passwordS)', 'log(passwordsx)', 'log(passwordss)', 'log(xpassword)', 'log(XPassword)',
    'log(passwordAbc)', 'log(password1)', 'log(password_x)', 'log(password)', 'log( password )', 'log("the password is")', 'log(passwordpassword)', 'log(pass)', 'log(credit card)', 'log(creditcard)', 'log(Card)', 'log(CARDS)'])
    c.push({ re: 'log', words: W, lines: [l] });
  c.push({ re: 'log', words: '', lines: ['log(password)'] }, { re: 'log', words: '   ', lines: ['log(password)'] }, { re: 'log', words: 'Password  CARD', lines: ['log(password)', 'log(card)'] });
  c.push({ re: 'log', words: 'password', lines: [''] }, { re: 'log', words: 'password', lines: ['no match here', 'log(nothing)', 'log(password) at the end'] }, { re: '^$', words: 'password', lines: ['password'] });
  c.push({ re: 'log', words: 'password', lines: ['log(pass', 'word)'] }, { re: 'log', words: 'password password', lines: ['log(password)'] }, { re: 'log|print', words: 'token', lines: ['print(Token)'] });
  c.push({ re: 'log', words: 'pass.word', lines: ['log(pass.word)', 'log(passXword)'] }, { re: '[', words: 'password', lines: ['log(password)'] });
  c.push({ re: 'log', words: 'password', lines: ['log(\tpassword\t)', 'log(password)\r'] });
  return c;
}

/** The recorded cases. @returns {WordsCase[]} */
export function recordWords() {
  return wordsInputs().filter((c) => c.re !== '[').map((c) => ({ ...c, match: shellRiskWordsMatch(c.re, c.words, c.lines) }));
}

/** `next` for each state, the old engine. @returns {string} */
export function recordNext() {
  const run = (/** @type {string} */ dir, /** @type {string[]} */ args) => spawnSync('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: dir, encoding: 'latin1', env: baseEnv(dir, { PROOFLINE_ENGINE: 'sh' }) });
  let out = '';
  const empty = stateFixture('empty'); const r0 = run(empty.dir, ['next']);
  out += `== no run (agent.sh next)\n# exit ${r0.status}\n${r0.stdout}`;
  for (const s of NEXT_STATES) { const r = run(stateFixture(s).dir, ['next', 'LC']); out += `== ${s} (agent.sh next LC)\n# exit ${r.status}\n${r.stdout}`; }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv[2];
  if (!which || which === 'risk-words-match') { writeFileSync(path.join(GOLDEN, 'risk-words-match.json'), JSON.stringify(recordWords(), null, 1) + '\n'); console.log('recorded risk-words-match.json'); }
  if (!which || which === 'next-order') { writeFileSync(path.join(GOLDEN, 'next-order.txt'), recordNext(), 'latin1'); console.log('recorded next-order.txt'); }
}
