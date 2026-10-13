#!/bin/sh
# Builds the config-consistency fixture repository in $1 (A88; must be empty or absent).
# A tiny service with an example env file, a flags file and a README. `main` is the base commit (it already
# reads an undocumented variable, PORT: pre-existing state is never judged).
# Branch `feature/config-drift` carries the planted facts, branch `feature/config-clean` a consistent change.
# The plan (.agents/runs/CC-1/PLAN-*.md) is git-ignored. Deterministic, offline, installs nothing.
set -eu

[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
TARGET=$1
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $TARGET" >&2
  exit 1
fi
mkdir -p "$TARGET"
cd "$TARGET"

GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=Fixture
GIT_AUTHOR_EMAIL=fixture@example.invalid
GIT_COMMITTER_NAME=Fixture
GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
commit() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"; }

git init -q
git symbolic-ref HEAD refs/heads/main
printf '.agents/\n' > .gitignore
mkdir -p src config test/fixtures .agents/runs/CC-1

# --- base ---------------------------------------------------------------------------------------------
cat > .env.example <<'EOF'
DATABASE_URL=postgres://localhost/app
DB_PASSWORD=
SMTP_PORT=587
LEGACY_MODE=off
EOF
cat > README.md <<'EOF'
# Billing service

Configuration is read from the environment (see `.env.example`).
`QUEUE_WORKERS` sets the number of background workers (default 2).
EOF
cat > config/app.yaml <<'EOF'
service: billing
port: 8080
EOF
cat > config/flags.yaml <<'EOF'
features:
  old_search: true
  dark_mode: false
EOF
cat > src/server.js <<'EOF'
// PORT is read here but never documented: pre-existing, not part of any change under review.
export const port = Number(process.env.PORT ?? 8080);
export const db = process.env.DATABASE_URL;
EOF
cat > src/search.js <<'EOF'
export function search(flags, term) {
  return flags.old_search ? legacy(term) : modern(term);
}
const legacy = (t) => [t];
const modern = (t) => [t, t];
EOF
git add -A
commit 2026-01-01T10:00:00Z "billing: initial"

cat > .agents/runs/CC-1/PLAN-drift.md <<'EOF'
# Plan: CC-1

## Behavior

- Send a receipt mail after payment (SMTP, uses the existing SMTP_PORT).
- Turn on the dark_mode flag for all users.

## Dependencies

none
EOF
cat > .agents/runs/CC-1/PLAN-clean.md <<'EOF'
# Plan: CC-1

## Behavior

- Send a receipt mail after payment.

## Dependencies

none
EOF

# --- feature/config-drift: planted facts --------------------------------------------------------------
git checkout -q -b feature/config-drift
cat > src/mailer.js <<'EOF'
export const smtp = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  mode: process.env.NODE_ENV,
  workers: Number(process.env.QUEUE_WORKERS ?? 2),
};
const { MAIL_FROM = "noreply@example.invalid", NODE_ENV: mode2 } = process.env;
export { MAIL_FROM, mode2 };
EOF
cat > src/worker.py <<'EOF'
import os

QUEUE_URL = os.environ["QUEUE_URL"]
EOF
printf 'OLD_TIMEOUT=30\n' >> .env.example
cat > config/app.yaml <<'EOF'
service: billing
port: 8080
db_password: "${DB_PASSWORD}"
EOF
printf 'api_key: "%s"\n' "k3J9xQ2m""V7bN4pL8wR5tY1zA" >> config/app.yaml
printf '{"token": "%s", "_": "proofline:allow-secret"}\n' "fakeT0kenA9bC3dE7fG1hJ5kL" > test/fixtures/auth.json
cat > config/flags.yaml <<'EOF'
features:
  dark_mode: true
  new_checkout: true
  beta_banner: false
EOF
mkdir -p infra
printf 'resource "x" "y" {\n  password = "%s"\n}\n' "Qw8Er3Ty6Ui1Op4As7Df2Gh5" > infra/main.tf
printf 'STAGING_KEY=abc\n' > config.env.staging
git add -A
commit 2026-01-02T10:00:00Z "billing: receipt mail, flags"

# --- feature/config-clean: consistent change ---------------------------------------------------------
git checkout -q -b feature/config-clean main
printf 'SMTP_HOST=localhost\n' >> .env.example
cat > src/mailer.js <<'EOF'
export const smtp = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  db: process.env.DATABASE_URL,
};
EOF
cat > config/flags.yaml <<'EOF'
features:
  old_search: true
  dark_mode: false
  beta_banner: false
EOF
git add -A
commit 2026-01-02T11:00:00Z "billing: receipt mail"

git checkout -q feature/config-drift
echo "fixture built in $TARGET (branches: feature/config-drift, feature/config-clean)"
