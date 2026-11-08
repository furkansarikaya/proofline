// Builds a git repository for test-trust's diff mode (D20) from the full-mode fixtures.
//
// usage: node diff-setup.mjs <go|ts> <target-dir> <fail|pass>
//
// The base commit holds the shop library and its solid tests plus the order-dependent pair
// (price tests). The uncommitted working tree is "the task":
//   fail  refactors two units (ApplyDiscount, NormalizeEmail; behaviour unchanged) and adds
//         the checkout tests: a hollow test (no assertion), a hollow one (mocks everything),
//         a nondeterministic flaky one and a slow one.
//   pass  refactors ApplyDiscount only (behaviour unchanged); the covering test is solid.
// Expected results are in EXPECTED.md ("Diff mode"). Nothing is installed; for ts the
// caller provides node_modules (copy or symlink) before running the tests.
import path from 'node:path';
import { Fx, cli, real } from '../../tests/lib/fixture.mjs';

/** Replace the first occurrence of a fixed string in a file (the shell's awk `edit`); a missing pattern is an error. @param {Fx} f @param {string} rel @param {string} from @param {string} to */
function edit(f, rel, from, to) {
  const s = f.read(rel);
  const i = s.indexOf(from);
  if (i < 0) throw new Error(`pattern not found in ${f.p(rel)}: ${from}`);
  f.w(rel, s.slice(0, i) + to + s.slice(i + from.length));
}

/** @param {string} target @param {string} lang @param {string} scenario */
export function build(target, lang, scenario) {
  const f = new Fx(target);
  f.cp(path.join(import.meta.dirname, lang), '.');
  f.rm('node_modules');
  const [tests, prod] = lang === 'go' ? ['checkout_test.go', 'shop.go'] : ['src/checkout.test.ts', 'src/shop.ts'];
  // the checkout tests belong to the task, not to the base
  f.mkdir('.held');
  f.mv(tests, '.held/checkout-tests');
  f.init({ config: [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false']] });
  f.append('.git/info/exclude', '.held/\n');
  f.commit('Base: shop library with solid price tests');
  // the task (uncommitted): behaviour-preserving refactors of changed units
  if (lang === 'go') {
    edit(f, prod, 'return cents * 90 / 100', 'return cents * 9 / 10');
    if (scenario === 'fail') edit(f, prod, 'strings.ToLower(strings.TrimSpace(email))', 'strings.TrimSpace(strings.ToLower(email))');
  } else {
    edit(f, prod, 'Math.round((cents * 90) / 100)', 'Math.round((cents * 9) / 10)');
    if (scenario === 'fail') edit(f, prod, 'email.trim().toLowerCase()', 'email.toLowerCase().trim()');
  }
  if (scenario === 'fail') f.mv('.held/checkout-tests', tests); else f.rm('.held/checkout-tests');
  try { f.rm('.held'); } catch { /* rmdir 2>/dev/null || true */ }
  console.log(`fixture ready: ${real(target)} (${lang}, scenario ${scenario}; run /test-trust diff from there)`);
  process.stdout.write(f.git(['status', '--short']));
}

await cli(import.meta.url, (target, ...rest) => build(target, rest[0], rest[1]), { usage: 'node diff-setup.mjs <go|ts> <target-dir> <fail|pass>', argc: 3, targetIndex: 1, ok: (a) => (a[0] === 'go' || a[0] === 'ts') && (a[2] === 'fail' || a[2] === 'pass') });
