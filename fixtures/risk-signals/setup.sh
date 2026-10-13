#!/bin/sh
# Builds the risk-signals fixture in $1 (A78): an installed project with run RS-1 classified COMPLEX, its
# baseline captured, a PLAN.md declaring some risk flags and a working-tree change carrying path signals,
# including traps that look like signals and are not. `selfcheck.sh` compares `agent.sh pipeline RS-1`
# with the known answer in EXPECTED.md. Deterministic, offline, installs nothing.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
HERE=$(CDPATH='' cd "$(dirname "$0")" && pwd)
CP=$HERE/../../control-plane
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then echo "error: target directory is not empty: $1" >&2; exit 1; fi
mkdir -p "$1"; cd "$1"
LC_ALL=C; export LC_ALL
GIT_CONFIG_GLOBAL=/dev/null; GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
unset AGENT_ROLE 2>/dev/null || true
ID=RS-1 D=.agents/runs/RS-1
A() { sh ./.agents/scripts/agent.sh "$@"; }

# --- installed project ------------------------------------------------------------------------
mkdir -p .agents/scripts .agents/local .agents/tasks api db/migrations web src docs
cp "$CP/agents/config.yaml" .agents/
cp -R "$CP/agents/modes" "$CP/agents/templates" .agents/
cp "$CP/agents/scripts/agent.sh" .agents/scripts/
printf '.agents/runs/\n.agents/local/\n' > .gitignore
printf '{ "name": "settings-fixture", "private": true, "dependencies": {} }\n' > package.json
printf 'openapi: 3.0.0\npaths:\n  /settings:\n    get:\n      responses:\n        "200":\n          description: ok\n' > api/openapi.yaml
printf 'create table settings (id integer primary key, theme text not null);\n' > db/migrations/001_settings.sql
printf '<main><h1>Settings</h1></main>\n' > web/settings.html
printf 'export function get(key) { return key; }\n' > src/settings.js
printf '# Settings service\n' > docs/README.md
printf '# RS-1 settings email\n\n**Status:** in-progress\n' > .agents/tasks/RS-1.md
git init -q; git symbolic-ref HEAD refs/heads/main
git add -A; GIT_AUTHOR_DATE=2026-01-01T10:00:00Z GIT_COMMITTER_DATE=2026-01-01T10:00:00Z git commit -q -m "settings: initial"

# --- run RS-1: classified, baseline captured ----------------------------------------------------
mkdir -p "$D"
sed -e "s#<TASK-ID>#$ID#" -e "s#<REPOSITORY-RELATIVE-TASK-FILE.md>#.agents/tasks/RS-1.md#" .agents/templates/RUN.yaml > "$D/RUN.yaml"
printf '%s\n' "$ID" > .agents/local/ACTIVE_RUN
cat > "$D/TASK.md" <<'EOF'
# Task: RS-1 — settings email

## Goal

Users store a notification email in their settings.

## Acceptance criteria

- AC-1: GET /settings returns the email
- AC-2: the settings page shows and edits the email

## Suggested class

COMPLEX
EOF
A classify "$ID" COMPLEX >/dev/null
A branch "$ID" >/dev/null
A baseline "$ID" >/dev/null

# The plan: a data change and a UI section are declared, concurrency is flagged without a matching path, and the
# contract change is explicitly NOT declared (contract_change: no) although the scope changes api/openapi.yaml.
cat > "$D/PLAN.md" <<'EOF'
---
scope:
  - path: api/openapi.yaml
    criteria: [AC-1]
  - path: db/migrations/002_settings_email.sql
    new: true
    criteria: [AC-1]
  - path: web/settings.html
    criteria: [AC-2]
  - path: package.json
    criteria: [AC-1]
  - path: .env.example
    new: true
    criteria: [AC-1]
  - path: src/contract.js
    new: true
    criteria: [AC-1]
  - path: src/openapi-client.js
    new: true
    criteria: [AC-1]
  - path: docs/migration-notes.md
    new: true
    criteria: [AC-1]
  - path: db/migrations/README.md
    new: true
    criteria: [AC-1]
---
# Plan

## Assumptions

none

## Architecture

The settings handler reads the email from the settings table; the page gets one input.

## Risk

contract_change: no
concurrency: yes  # two tabs may save settings at once

## Data

destructive: no

Add a nullable `email` column to `settings` in migration 002.

## UI

One email input under the theme selector, with an inline validation message.
EOF

# --- the change ---------------------------------------------------------------------------------
printf '      content:\n        application/json:\n          schema:\n            properties:\n              email: { type: string }\n' >> api/openapi.yaml
printf 'alter table settings add column email text;\n' > db/migrations/002_settings_email.sql
printf '<label>Email <input name="email" type="email"></label>\n' >> web/settings.html
printf '{ "name": "settings-fixture", "private": true, "dependencies": { "email-check": "1.0.0" } }\n' > package.json
printf 'SETTINGS_EMAIL_FROM=\n' > .env.example
# Traps: named like a contract, a schema client and migrations, but code or documentation.
printf 'export const contract = { email: "string" };\n' > src/contract.js
printf 'export async function getSettings() { return fetch("/settings"); }\n' > src/openapi-client.js
printf '# Migration notes\n\nRun 002 after deploying the handler. The spec header stays:\n\nopenapi: 3.0.0\n' > docs/migration-notes.md
# Not in the plan's scope: a nested proto contract the diff adds (found by its path, undeclared).
mkdir -p proto/v1; printf 'syntax = "proto3";\nmessage Settings { string email = 1; }\n' > proto/v1/settings.proto
printf '# Migrations\n\nApplied in file-name order.\n' > db/migrations/README.md
echo "risk-signals fixture built: run $ID"
