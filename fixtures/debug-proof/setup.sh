#!/bin/sh
# Builds the debug-proof fixture repository in $1: eight commits, a regression
# introduced by commit 5, a harmless but suspicious-looking rewrite in commit 3,
# and a known-good tag on commit 2. Deterministic and offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $1" >&2; exit 1
fi
mkdir -p "$1"
cd "$1"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
git init -q
git symbolic-ref HEAD refs/heads/main
git config commit.gpgsign false
git config core.autocrlf false
printf '.agents/\n' >> .git/info/exclude

N=0
commit() {
  N=$((N + 1))
  d="@$((1767261600 + N * 86400)) +0000"
  git add -A
  GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d git commit -q -m "$1"
}

# 1
mkdir -p src test
cat > package.json <<'X'
{
  "name": "ledger-fixture",
  "private": true,
  "type": "module"
}
X
cat > src/money.js <<'X'
// Amounts are integer cents.
export function formatCents(cents) {
  return (cents / 100).toFixed(2);
}
X
cat > test/money.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents } from '../src/money.js';

test('formats whole and fractional amounts', () => {
  assert.equal(formatCents(1234), '12.34');
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(100), '1.00');
});

test('formats negative amounts', () => {
  assert.equal(formatCents(-1234), '-12.34');
});
X
commit "feat: format amounts in cents"

# 2 (known good, tagged v1.0)
cat > src/money.js <<'X'
// Amounts are integer cents.
export function formatCents(cents) {
  return (cents / 100).toFixed(2);
}

export function parseCents(text) {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`not an amount: ${text}`);
  const value = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -value : value;
}
X
cat > test/money.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, parseCents } from '../src/money.js';

test('formats whole and fractional amounts', () => {
  assert.equal(formatCents(1234), '12.34');
  assert.equal(formatCents(0), '0.00');
  assert.equal(formatCents(100), '1.00');
});

test('formats negative amounts', () => {
  assert.equal(formatCents(-1234), '-12.34');
});

test('parses amounts', () => {
  assert.equal(parseCents('12.34'), 1234);
  assert.equal(parseCents(' -0.50 '), -50);
  assert.throws(() => parseCents('12.3'));
});
X
commit "feat: parse amounts"
git tag v1.0

# 3 (decoy: looks risky, output identical to commit 2 for every integer)
cat > src/money.js <<'X'
// Amounts are integer cents.
// HACK: avoid toFixed (float formatting) - integer math only, revisit later
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

export function parseCents(text) {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`not an amount: ${text}`);
  const value = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -value : value;
}
X
commit "perf: drop toFixed from formatCents (quick hack)"

# 4
cat > README.md <<'X'
# ledger

Tiny invoicing helpers. Amounts are integer cents.

    node --test
X
commit "docs: add README"

# 5 (regression: a single-digit cent remainder is padded on the wrong side)
cat > src/money.js <<'X'
// Amounts are integer cents.
// HACK: avoid toFixed (float formatting) - integer math only, revisit later
export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + Math.floor(abs / 100) + '.' + (abs % 100 + '').padEnd(2, '0');
}

export function parseCents(text) {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`not an amount: ${text}`);
  const value = Number(m[2]) * 100 + Number(m[3]);
  return m[1] ? -value : value;
}
X
commit "style: tidy formatCents"

# 6
cat > src/invoice.js <<'X'
import { formatCents } from './money.js';

export function invoiceTotal(lines) {
  const cents = lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  return formatCents(cents);
}
X
cat > test/invoice.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceTotal } from '../src/invoice.js';

test('sums invoice lines', () => {
  assert.equal(invoiceTotal([{ qty: 2, unitCents: 999 }, { qty: 1, unitCents: 1001 }]), '29.99');
  assert.equal(invoiceTotal([]), '0.00');
});
X
commit "feat: invoice totals"

# 7
cat > .editorconfig <<'X'
root = true

[*]
indent_style = space
indent_size = 2
X
commit "chore: add editorconfig"

# 8
cat > src/invoice.js <<'X'
import { formatCents } from './money.js';

export function invoiceTotal(lines, currency = '') {
  const cents = lines.reduce((sum, line) => sum + line.qty * line.unitCents, 0);
  return currency ? `${formatCents(cents)} ${currency}` : formatCents(cents);
}
X
cat >> test/invoice.test.js <<'X'

test('appends the currency code', () => {
  assert.equal(invoiceTotal([{ qty: 1, unitCents: 1250 }], 'EUR'), '12.50 EUR');
});
X
commit "feat: currency code on invoice totals"
