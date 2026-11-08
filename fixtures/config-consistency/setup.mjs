// Builds the config-consistency fixture repository in <target-dir> (A88; must be empty or absent).
// A tiny service with an example env file, a flags file and a README. `main` is the base commit (it already
// reads an undocumented variable, PORT: pre-existing state is never judged).
// Branch `feature/config-drift` carries the planted facts, branch `feature/config-clean` a consistent change.
// The plan (.agents/runs/CC-1/PLAN-*.md) is git-ignored. Deterministic, offline, installs nothing.
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init({ config: [] });
  /** @param {string} message @param {string} date */
  const commit = (message, date) => f.git(['commit', '-q', '-m', message], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });


  f.w('.gitignore', '.agents/\n');
  f.mkdir('src', 'config', 'test/fixtures', '.agents/runs/CC-1');

  // --- base ---------------------------------------------------------------------------------------------
  f.w('.env.example', `DATABASE_URL=postgres://localhost/app
DB_PASSWORD=
SMTP_PORT=587
LEGACY_MODE=off
`);
  f.w('README.md', `# Billing service

Configuration is read from the environment (see \`.env.example\`).
\`QUEUE_WORKERS\` sets the number of background workers (default 2).
`);
  f.w('config/app.yaml', `service: billing
port: 8080
`);
  f.w('config/flags.yaml', `features:
  old_search: true
  dark_mode: false
`);
  f.w('src/server.js', `// PORT is read here but never documented: pre-existing, not part of any change under review.
export const port = Number(process.env.PORT ?? 8080);
export const db = process.env.DATABASE_URL;
`);
  f.w('src/search.js', `export function search(flags, term) {
  return flags.old_search ? legacy(term) : modern(term);
}
const legacy = (t) => [t];
const modern = (t) => [t, t];
`);
  f.git(['add', '-A']);
  commit('billing: initial', '2026-01-01T10:00:00Z');

  f.w('.agents/runs/CC-1/PLAN-drift.md', `# Plan: CC-1

## Behavior

- Send a receipt mail after payment (SMTP, uses the existing SMTP_PORT).
- Turn on the dark_mode flag for all users.

## Dependencies

none
`);
  f.w('.agents/runs/CC-1/PLAN-clean.md', `# Plan: CC-1

## Behavior

- Send a receipt mail after payment.

## Dependencies

none
`);

  // --- feature/config-drift: planted facts --------------------------------------------------------------
  f.git(['checkout', '-q', '-b', 'feature/config-drift']);
  f.w('src/mailer.js', `export const smtp = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  mode: process.env.NODE_ENV,
  workers: Number(process.env.QUEUE_WORKERS ?? 2),
};
const { MAIL_FROM = "noreply@example.invalid", NODE_ENV: mode2 } = process.env;
export { MAIL_FROM, mode2 };
`);
  f.w('src/worker.py', `import os

QUEUE_URL = os.environ["QUEUE_URL"]
`);
  f.append('.env.example', 'OLD_TIMEOUT=30\n');
  f.w('config/app.yaml', `service: billing
port: 8080
db_password: "\${DB_PASSWORD}"
`);
  f.append('config/app.yaml', `api_key: "${'k3J9xQ2m' + 'V7bN4pL8wR5tY1zA'}"\n`);   // split so a secret scanner does not read this file as a leak
  f.w('test/fixtures/auth.json', `{"token": "${'fakeT0kenA9bC3dE7fG1hJ5kL'}", "_": "proofline:allow-secret"}\n`);
  f.w('config/flags.yaml', `features:
  dark_mode: true
  new_checkout: true
  beta_banner: false
`);
  f.mkdir('infra');
  f.w('infra/main.tf', `resource "x" "y" {\n  password = "${'Qw8Er3Ty6Ui1Op4As7Df2Gh5'}"\n}\n`);
  f.w('config.env.staging', 'STAGING_KEY=abc\n');
  f.git(['add', '-A']);
  commit('billing: receipt mail, flags', '2026-01-02T10:00:00Z');

  // --- feature/config-clean: consistent change ---------------------------------------------------------
  f.git(['checkout', '-q', '-b', 'feature/config-clean', 'main']);
  f.append('.env.example', 'SMTP_HOST=localhost\n');
  f.w('src/mailer.js', `export const smtp = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  db: process.env.DATABASE_URL,
};
`);
  f.w('config/flags.yaml', `features:
  old_search: true
  dark_mode: false
  beta_banner: false
`);
  f.git(['add', '-A']);
  commit('billing: receipt mail', '2026-01-02T11:00:00Z');

  f.git(['checkout', '-q', 'feature/config-drift']);
  console.log(`fixture built in ${target} (branches: feature/config-drift, feature/config-clean)`);

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

