// @ts-check
// The attribution trailer of the delivery commit (A224, user decision of 2026-11-07): composition, the strict validation of every configured line, the off switch,
// the default, and config-check. The delivery chain itself (summary, approval hash, tamper check, ledger) is in run6-plan.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TRAILER, MAX_TRAILER_BYTES, MAX_TRAILER_LINES, composeCommitMessage, resolveTrailer, trailerFromConfig, trailerLineProblem } from '../../control-plane/agents/scripts/core/committrailer.mjs';
import { configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { checkConfigLines } from '../../control-plane/agents/scripts/core/commands/config-check.mjs';

/** A config object as far as trailerFromConfig reads one: the text of a config file. @param {string} text */
function configOf(text) {
  const lines = configLines(text);
  return { cmds: (/** @type {string} */ key) => {
    const own = lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1)).filter((v) => v !== '');
    if (own.length > 0) return own.slice(0, 1);
    return lines.filter((l) => new RegExp(`^${key.replace(/\./g, '\\.')}\\.[0-9]+=`).test(l)).map((l) => l.slice(l.indexOf('=') + 1));
  } };
}

test('composition: the approved line, a blank line, the trailer lines; without trailers the line alone', () => {
  assert.equal(composeCommitMessage('feat: x (T-1)', []), 'feat: x (T-1)\n');
  assert.equal(composeCommitMessage('feat: x (T-1)', ['Co-Authored-By: A <a@b.c>']), 'feat: x (T-1)\n\nCo-Authored-By: A <a@b.c>\n');
  assert.equal(composeCommitMessage('feat: x (T-1)', ['A: 1', 'B: 2']), 'feat: x (T-1)\n\nA: 1\nB: 2\n');
});

test('the default is the standard attribution line; an empty list gives it, and so does a config without the key', () => {
  assert.equal(DEFAULT_TRAILER, 'Co-Authored-By: Claude <noreply@anthropic.com>');
  assert.deepEqual(resolveTrailer([]), { lines: [DEFAULT_TRAILER], source: 'default', problems: [] });
  assert.deepEqual(resolveTrailer(['', '  ']), { lines: [DEFAULT_TRAILER], source: 'default', problems: [] });
  assert.deepEqual(trailerFromConfig(configOf('git:\n  commit_format: conventional\n')).lines, [DEFAULT_TRAILER]);
  assert.deepEqual(trailerFromConfig(configOf('git:\n  commit_trailer:\n')).source, 'default', 'an empty key is the default, like every other key');
});

test('off switches the trailer off; it stands alone', () => {
  assert.deepEqual(resolveTrailer(['off']), { lines: [], source: 'off', problems: [] });
  assert.deepEqual(trailerFromConfig(configOf('git:\n  commit_trailer: off\n')), { lines: [], source: 'off', problems: [] });
  assert.equal(resolveTrailer(['off', 'A: b']).problems.length, 1);
  assert.equal(resolveTrailer(['A: b', 'OFF']).problems.length, 1);
});

test('config override: a scalar, or a block list of lines, in the given order; a comment tail and surrounding quotes are the config reader\'s', () => {
  assert.deepEqual(trailerFromConfig(configOf('git:\n  commit_trailer: "Co-Authored-By: Dev <dev@example.com>"\n')).lines, ['Co-Authored-By: Dev <dev@example.com>']);
  const two = trailerFromConfig(configOf('git:\n  commit_trailer:\n    - Co-Authored-By: Dev <dev@example.com>\n    - Part-of: tracker 12 # a comment\n'));
  assert.deepEqual(two, { lines: ['Co-Authored-By: Dev <dev@example.com>', 'Part-of: tracker 12'], source: 'config', problems: [] });
  assert.deepEqual(resolveTrailer([Buffer.from('Co-Authored-By: Çağrı <c@y.z>', 'utf8').toString('latin1')]).problems, [], 'UTF-8 text (as the config reader returns it, one char per byte) is fine');
});

test('every refusal: a bad key, a bad separator, an empty value, a long line, too many lines, a duplicate, the characters kept out of every commit line', () => {
  const bad = [
    ['1abc: x', 'a key that starts with a digit'], ['Bad Key: x', 'a space in the key'], ['Key:x', 'no space after the colon'], ['Key : x', 'a space before the colon'], ['Key:  ', 'an empty value'],
    ['Key: ', 'a blank value'], [': x', 'no key'], ['no trailer here', 'no colon'], [`${'K'.repeat(41)}: x`, 'a key of 41 characters'], [`Key: ${'v'.repeat(MAX_TRAILER_BYTES)}`, 'more than the byte limit'],
    ['Key: a"b', 'a double quote'], ['Key: a`b', 'a backtick'], ['Key: a$b', 'a dollar'], ['Key: a\\b', 'a backslash'],
    ['Key: a\tb', 'a tab'], ['Key: a\rb', 'a carriage return'], ['Key: a\nCo-Authored-By: Evil <e@x.y>', 'a newline that carries a second trailer'], ['Key: a\u0000b', 'a NUL'], ['Key: a\u001bb', 'an escape'], ['Key: a\u007fb', 'DEL'],
    ['Key: x ', 'a trailing blank'], ['Key: ÿ', 'a byte that is not UTF-8'], ['Key: Ã', 'a cut UTF-8 sequence'],
    [`Key: ${Buffer.from('a‮b', 'utf8').toString('latin1')}`, 'a right-to-left override'], [`Key: ${Buffer.from('a b', 'utf8').toString('latin1')}`, 'a line separator'],
    [`Key: ${Buffer.from('a​b', 'utf8').toString('latin1')}`, 'a zero-width space'], [`Key: ${Buffer.from('a\u0085b', 'utf8').toString('latin1')}`, 'a next-line character'],
    ['Signed-off-by: Linus <l@kernel.org>', 'a sign-off'], ['signed-off-by: x', 'a sign-off in lower case'], ['Reviewed-by: x', 'a review'], ['Acked-by: x', 'an acknowledgement'], ['Tested-by: x', 'a test claim'], ['APPROVED-BY: x', 'an approval claim'],
  ];
  for (const [line, why] of bad) assert.notEqual(trailerLineProblem(line), null, `${why}: ${JSON.stringify(line)}`);
  const good = ['Co-Authored-By: Claude <noreply@anthropic.com>', 'Co-Authored-By: Name <n@e.co>', 'Ticket: ABC-123', 'Part-of: #12', 'X: y', `Key: ${'v'.repeat(MAX_TRAILER_BYTES - 5)}`, 'Cc: someone <s@e.co>'];
  for (const line of good) assert.equal(trailerLineProblem(line), null, line);
  assert.equal(resolveTrailer(Array.from({ length: MAX_TRAILER_LINES + 1 }, (_, i) => `K${i}: v`)).problems.length, 1, 'six lines');
  assert.deepEqual(resolveTrailer(Array.from({ length: MAX_TRAILER_LINES }, (_, i) => `K${i}: v`)).problems, [], 'five lines');
  assert.equal(resolveTrailer(['A: b', 'a: B']).problems.length, 1, 'a duplicate');
  assert.deepEqual(resolveTrailer(['A: b', 'Signed-off-by: x']).lines, [], 'a refused list gives no line at all, never a part of it');
});

test('config-check: a bad git.commit_trailer is reported by the same rules, a good one and off are not', () => {
  const check = (/** @type {string} */ t) => checkConfigLines(configLines(`canonical_branch: main\ngit:\n  branch_prefix: proofline/\n${t}`)).messages;
  assert.deepEqual(check('  commit_trailer: "Co-Authored-By: Claude <noreply@anthropic.com>"\n'), []);
  assert.deepEqual(check('  commit_trailer:\n    - "A: b"\n    - "C: d"\n'), [], 'quoted list items are the documented form');
  assert.deepEqual(check('  commit_trailer: off\n'), []);
  assert.deepEqual(check('  commit_trailer:\n    - A: b\n    - C: d\n'), []);
  assert.deepEqual(check('  commit_trailer:\n'), []);
  assert.match(check('  commit_trailer: Signed-off-by: x\n').join('\n'), /certifies what a person did/);
  assert.match(check('  commit_trailer:\n    - A: b\n    - not a trailer\n').join('\n'), /line 2 is not "Key: value"/);
  assert.match(check('  commit_trailer:\n    - off\n    - A: b\n').join('\n'), /off stands alone/);
});
