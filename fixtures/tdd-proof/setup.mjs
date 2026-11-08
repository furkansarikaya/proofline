// Builds the tdd-proof fixture repository in <target-dir>: a duration module without
// parseDuration (so a first test that imports it fails to load, not to assert)
// and a colleague's test for the formatDuration change that passes before the
// change (hollow). Deterministic and offline.
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init({ config: [['commit.gpgsign', 'false'], ['core.autocrlf', 'false']] });
  let n = 0;
  /** @param {string} message @param {string} [date] */
  const commit = (message, date) => {
    n++;
    const d = date ?? `@${1767261600 + n * 86400} +0000`;
    f.git(['add', '-A']);
    f.git(['commit', '-q', '-m', message], { env: { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
  };
  f.append('.git/info/exclude', '.agents/\n');

  f.mkdir('src', 'test');
  f.w('package.json', `{
  "name": "timer-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
`);
  f.w('README.md', `# timer

Duration helpers (seconds). Plain Node ESM, no dependencies.

    node --test
`);
  f.w('src/duration.js', `// Durations are whole seconds.
export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  let out = '';
  if (h) out += \`\${h}h\`;
  if (m) out += \`\${m}m\`;
  if (s) out += \`\${s}s\`;
  return out;
}
`);
  f.w('test/format.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/duration.js';

test('formats hours, minutes and seconds', () => {
  assert.equal(formatDuration(5400), '1h30m');
  assert.equal(formatDuration(3725), '1h2m5s');
  assert.equal(formatDuration(42), '42s');
});
`);
  commit('feat: format durations');

  f.w('TASK.md', `# Task: FX-TDD — Parse durations and format zero

## Goal
Users can type durations such as \`1h30m\`, and a zero duration is displayed instead of an empty string.

## Acceptance criteria
- AC-1: \`parseDuration(text)\` exported from \`src/duration.js\` returns the number of seconds for
  strings made of \`<n>h\`, \`<n>m\`, \`<n>s\` parts in that order, each optional but at least one present
  (\`'1h30m'\` -> 5400, \`'45s'\` -> 45, \`'2h5s'\` -> 7205).
- AC-2: \`parseDuration\` throws an \`Error\` for any other input (\`''\`, \`'abc'\`, \`'30m1h'\`).
- AC-3: \`formatDuration(0)\` returns \`'0s'\`; all other outputs of \`formatDuration\` are unchanged.

## Out of scope
Days, fractional values, negative durations.

## Constraints
No dependencies. Tests use \`node:test\`.

## Suggested class
STANDARD (two small behaviour changes in one module, new public function)

## Verification commands
- \`node --test\`
`);
  f.w('test/format-zero.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration } from '../src/duration.js';

// AC-3: written ahead of the change by a colleague.
test('formatDuration(0) is displayable', () => {
  const out = formatDuration(0);
  assert.equal(typeof out, 'string');
  assert.ok(!out.includes('undefined'));
});
`);
  commit('chore: add task FX-TDD and a test for AC-3');

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

