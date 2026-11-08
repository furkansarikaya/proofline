// Builds the system-design fixture repository in <target-dir>: a small multi-module
// service (customers, orders, notify, billing, http) deployed as two replicas.
// A weekly digest needs one new component; the only real trade-off is how the
// weekly run is triggered without sending twice. Deterministic and offline.
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

  f.mkdir('src/customers', 'src/orders', 'src/notify', 'src/billing', 'src/http', 'test', 'deploy', 'scripts');
  f.w('package.json', `{
  "name": "shopfront-fixture",
  "private": true,
  "type": "module",
  "scripts": { "start": "node src/http/server.js", "test": "node --test" }
}
`);
  f.w('README.md', `# shopfront

Order service. Modules:

- \`src/customers/\` customer records
- \`src/orders/\` orders and order queries
- \`src/notify/\` outgoing email
- \`src/billing/\` invoices
- \`src/http/\` HTTP API

Deployment: see \`deploy/README.md\`.
`);
  f.w('deploy/README.md', `# Deployment

- The HTTP service (\`npm start\`) runs as **2 replicas** behind a load balancer; replicas share nothing
  except the database.
- The platform runs scheduled jobs as container cron jobs: a job is a command run in the same image on a
  cron schedule, at most one instance at a time. Jobs are declared in \`deploy/jobs.yaml\`.
- Email goes through the SMTP relay configured by \`SMTP_URL\`.
`);
  f.w('deploy/jobs.yaml', `# Scheduled jobs: name, cron schedule (UTC), command run in the service image.
jobs:
  - name: cleanup-sessions
    schedule: "0 3 * * *"
    command: node scripts/cleanup-sessions.js
`);
  f.w('scripts/cleanup-sessions.js', `// Deletes expired sessions. Run by the platform scheduler (deploy/jobs.yaml).
export function cleanupSessions(sessions, now = Date.now()) {
  return sessions.filter((s) => s.expiresAt > now);
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  console.log('cleanup-sessions: done');
}
`);
  f.w('src/customers/repository.js', `// Customer records. rows: [{ id, email, name, marketingOptIn }]
export function createCustomerRepository(rows) {
  return {
    list: () => rows.map((r) => ({ ...r })),
    byId: (id) => rows.find((r) => r.id === id) ?? null,
  };
}
`);
  f.w('src/orders/repository.js', `// Orders. rows: [{ id, customerId, totalCents, placedAt (ISO string) }]
export function createOrderRepository(rows) {
  return {
    byCustomer: (customerId) => rows.filter((r) => r.customerId === customerId),
    byCustomerSince: (customerId, sinceIso) =>
      rows.filter((r) => r.customerId === customerId && r.placedAt >= sinceIso),
  };
}
`);
  f.w('src/notify/email.js', `// Outgoing email. transport: { send(message) } (SMTP in production, an array in tests).
export function createMailer(transport) {
  return {
    sendEmail({ to, subject, text }) {
      if (!to || !subject) throw new Error('to and subject are required');
      return transport.send({ to, subject, text });
    },
  };
}
`);
  f.w('src/notify/legacy-sms.js', `// Old SMS gateway client. Not used since 2024; kept until the gateway contract ends.
export function sendSms(number, text) {
  throw new Error(\`SMS gateway disabled (\${number}: \${text.length} chars)\`);
}
`);
  f.w('src/billing/invoice.js', `export function invoiceNumber(order) {
  return \`INV-\${String(order.id).padStart(6, '0')}\`;
}
`);
  f.w('src/http/server.js', `import { createServer } from 'node:http';

export function createApp({ orders }) {
  return createServer((req, res) => {
    const m = /^\\/customers\\/(\\d+)\\/orders$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(orders.byCustomer(Number(m[1]))));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
}
`);
  f.w('test/orders.test.js', `import { test } from 'node:test';
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
`);
  f.w('test/email.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer } from '../src/notify/email.js';

test('sends through the transport', () => {
  const sent = [];
  createMailer({ send: (m) => sent.push(m) }).sendEmail({ to: 'a@example.invalid', subject: 'Hi', text: 'x' });
  assert.equal(sent.length, 1);
});
`);
  commit('feat: shopfront service');

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

