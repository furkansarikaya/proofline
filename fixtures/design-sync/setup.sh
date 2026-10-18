#!/bin/sh
# Builds the design-sync fixture repository in $1: durable design documents
# with four planted drifts and several entries that exist under different
# formatting (decoys). Deterministic and offline.
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

mkdir -p migrations src/api src/store src/jobs src/styles docs/design
cat > package.json <<'X'
{
  "name": "projects-fixture",
  "private": true,
  "type": "module"
}
X
cat > migrations/001_init.sql <<'X'
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL
);
X
cat > migrations/002_tasks.sql <<'X'
create table if not exists "tasks" (
  id integer primary key,
  project_id integer not null references projects(id),
  title text not null,
  done integer not null default 0
);
X
cat > src/store/index.js <<'X'
// Data access over node:sqlite.
import { DatabaseSync } from 'node:sqlite';

export function openStore(path = ':memory:') {
  return new DatabaseSync(path);
}
X
cat > src/api/handlers.js <<'X'
export const listProjects = (req, res) => res.json([]);
export const createProject = (req, res) => res.status(201).json({});
export const getProject = (req, res) => res.json({ id: req.params.id });
export const updateProject = (req, res) => res.json({ id: req.params.id });
X
cat > src/api/routes.js <<'X'
import { listProjects, createProject, getProject, updateProject } from './handlers.js';

export const routes = [
  { method: 'GET', path: '/projects', handler: listProjects },
  { method: 'POST', path: '/projects', handler: createProject },
  { method: 'GET', path: '/projects/:id', handler: getProject },
  { method: 'PATCH', path: '/projects/:id', handler: updateProject },
];
X
cat > src/jobs/mailer.js <<'X'
export function sendDigest(to, body) {
  return { to, body, queued: true };
}
X
cat > src/styles/tokens.css <<'X'
:root {
  --color-primary: #1a73e8;
  --color-danger: #d93025;
  --space-2: 8px;
  --radius-md: 6px;
}
X
cat > docs/design/DESIGN.md <<'X'
# Design system

## Tokens

Defined in `src/styles/tokens.css`.

| Token | Value | Use |
|---|---|---|
| `--color-primary` | `#1A73E8` | primary actions, links |
| `--color-danger` | `#D93025` | destructive actions, errors |
| `--color-surface` | `#FFFFFF` | card and panel backgrounds |
| `--space-2` | `8px` | default gap |
| `--radius-md` | `6px` | buttons, inputs, cards |
X
cat > docs/design/ARCHITECTURE.md <<'X'
# Architecture

## Components

| Component | Path | Responsibility |
|---|---|---|
| HTTP API | `src/api/routes.js` | route table; handlers in `src/api/handlers.js` |
| Store | `./src/store/` | data access over node:sqlite |
| Mailer | `src/jobs/mailer.js` | digest emails |
| Migrations | `migrations/` | schema, applied in file-name order |
X
cat > docs/design/DATA_MODEL.md <<'X'
# Data model

Schema source: `migrations/*.sql`.

## Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| id | integer | primary key |
| email | text | unique |

### `projects`
| Column | Type | Notes |
|---|---|---|
| id | integer | primary key |
| owner_id | integer | -> users.id |
| name | text | |

### `tasks`
| Column | Type | Notes |
|---|---|---|
| id | integer | primary key |
| project_id | integer | -> projects.id |
| title | text | |
| done | integer | 0/1 |

### `audit_log`
| Column | Type | Notes |
|---|---|---|
| id | integer | primary key |
| actor_id | integer | -> users.id |
| action | text | |
| at | text | ISO timestamp |
X
cat > docs/design/API.md <<'X'
# API

Routes are declared in `src/api/routes.js`.

| Method | Path | Description |
|---|---|---|
| GET | `/projects` | list projects |
| POST | `/projects` | create a project |
| GET | `/projects/{id}` | get one project |
| PATCH | `/projects/{id}` | update a project |
| DELETE | `/projects/{id}` | delete a project |
X
commit "feat: projects service with design documents"

mkdir -p src/notify
git mv src/jobs/mailer.js src/notify/mailer.js
commit "refactor: move mailer to src/notify"
