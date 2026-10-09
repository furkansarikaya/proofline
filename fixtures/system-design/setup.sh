#!/bin/sh
# Builds the system-design fixture repository in $1: a small multi-module
# service (customers, orders, notify, billing, http) deployed as two replicas.
# A weekly digest needs one new component; the only real trade-off is how the
# weekly run is triggered without sending twice. Deterministic and offline.
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

mkdir -p src/customers src/orders src/notify src/billing src/http test deploy scripts
cat > package.json <<'X'
{
  "name": "shopfront-fixture",
  "private": true,
  "type": "module",
  "scripts": { "start": "node src/http/server.js", "test": "node --test" }
}
X
cat > README.md <<'X'
# shopfront

Order service. Modules:

- `src/customers/` customer records
- `src/orders/` orders and order queries
- `src/notify/` outgoing email
- `src/billing/` invoices
- `src/http/` HTTP API

Deployment: see `deploy/README.md`.
X
cat > deploy/README.md <<'X'
# Deployment

- The HTTP service (`npm start`) runs as **2 replicas** behind a load balancer; replicas share nothing
  except the database.
- The platform runs scheduled jobs as container cron jobs: a job is a command run in the same image on a
  cron schedule, at most one instance at a time. Jobs are declared in `deploy/jobs.yaml`.
- Email goes through the SMTP relay configured by `SMTP_URL`.
X
cat > deploy/jobs.yaml <<'X'
# Scheduled jobs: name, cron schedule (UTC), command run in the service image.
jobs:
  - name: cleanup-sessions
    schedule: "0 3 * * *"
    command: node scripts/cleanup-sessions.js
X
cat > scripts/cleanup-sessions.js <<'X'
// Deletes expired sessions. Run by the platform scheduler (deploy/jobs.yaml).
export function cleanupSessions(sessions, now = Date.now()) {
  return sessions.filter((s) => s.expiresAt > now);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('cleanup-sessions: done');
}
X
cat > src/customers/repository.js <<'X'
// Customer records. rows: [{ id, email, name, marketingOptIn }]
export function createCustomerRepository(rows) {
  return {
    list: () => rows.map((r) => ({ ...r })),
    byId: (id) => rows.find((r) => r.id === id) ?? null,
  };
}
X
cat > src/orders/repository.js <<'X'
// Orders. rows: [{ id, customerId, totalCents, placedAt (ISO string) }]
export function createOrderRepository(rows) {
  return {
    byCustomer: (customerId) => rows.filter((r) => r.customerId === customerId),
    byCustomerSince: (customerId, sinceIso) =>
      rows.filter((r) => r.customerId === customerId && r.placedAt >= sinceIso),
  };
}
X
cat > src/notify/email.js <<'X'
// Outgoing email. transport: { send(message) } (SMTP in production, an array in tests).
export function createMailer(transport) {
  return {
    sendEmail({ to, subject, text }) {
      if (!to || !subject) throw new Error('to and subject are required');
      return transport.send({ to, subject, text });
    },
  };
}
X
cat > src/notify/legacy-sms.js <<'X'
// Old SMS gateway client. Not used since 2024; kept until the gateway contract ends.
export function sendSms(number, text) {
  throw new Error(`SMS gateway disabled (${number}: ${text.length} chars)`);
}
X
cat > src/billing/invoice.js <<'X'
export function invoiceNumber(order) {
  return `INV-${String(order.id).padStart(6, '0')}`;
}
X
cat > src/http/server.js <<'X'
import { createServer } from 'node:http';

export function createApp({ orders }) {
  return createServer((req, res) => {
    const m = /^\/customers\/(\d+)\/orders$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(orders.byCustomer(Number(m[1]))));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}
X
cat > test/orders.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrderRepository } from '../src/orders/repository.js';

test('orders since a date', () => {
  const repo = createOrderRepository([
    { id: 1, customerId: 7, totalCents: 1000, placedAt: '2026-01-01T10:00:00Z' },
    { id: 2, customerId: 7, totalCents: 2000, placedAt: '2026-01-09T10:00:00Z' },
    { id: 3, customerId: 8, totalCents: 3000, placedAt: '2026-01-09T10:00:00Z' },
  ]);
  assert.deepEqual(repo.byCustomerSince(7, '2026-01-05T00:00:00Z').map((o) => o.id), [2]);
});
X
cat > test/email.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer } from '../src/notify/email.js';

test('sends through the transport', () => {
  const sent = [];
  createMailer({ send: (m) => sent.push(m) }).sendEmail({ to: 'a@example.invalid', subject: 'Hi', text: 'x' });
  assert.equal(sent.length, 1);
});
X
commit "feat: shopfront service"
