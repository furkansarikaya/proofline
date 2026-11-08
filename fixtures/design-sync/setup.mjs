// Builds the design-sync fixture repository in <target-dir>: durable design documents
// with four planted drifts and several entries that exist under different
// formatting (decoys). Deterministic and offline.
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

  f.mkdir('migrations', 'src/api', 'src/store', 'src/jobs', 'src/styles', 'docs/design');
  f.w('package.json', `{
  "name": "projects-fixture",
  "private": true,
  "type": "module"
}
`);
  f.w('migrations/001_init.sql', `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL
);
`);
  f.w('migrations/002_tasks.sql', `create table if not exists "tasks" (
  id integer primary key,
  project_id integer not null references projects(id),
  title text not null,
  done integer not null default 0
);
`);
  f.w('src/store/index.js', `// Data access over node:sqlite.
import { DatabaseSync } from 'node:sqlite';

export function openStore(path = ':memory:') {
  return new DatabaseSync(path);
}
`);
  f.w('src/api/handlers.js', `export const listProjects = (req, res) => res.json([]);
export const createProject = (req, res) => res.status(201).json({});
export const getProject = (req, res) => res.json({ id: req.params.id });
export const updateProject = (req, res) => res.json({ id: req.params.id });
`);
  f.w('src/api/routes.js', `import { listProjects, createProject, getProject, updateProject } from './handlers.js';

export const routes = [
  { method: 'GET', path: '/projects', handler: listProjects },
  { method: 'POST', path: '/projects', handler: createProject },
  { method: 'GET', path: '/projects/:id', handler: getProject },
  { method: 'PATCH', path: '/projects/:id', handler: updateProject },
];
`);
  f.w('src/jobs/mailer.js', `export function sendDigest(to, body) {
  return { to, body, queued: true };
}
`);
  f.w('src/styles/tokens.css', `:root {
  --color-primary: #1a73e8;
  --color-danger: #d93025;
  --space-2: 8px;
  --radius-md: 6px;
}
`);
  f.w('docs/design/DESIGN.md', `# Design system

## Tokens

Defined in \`src/styles/tokens.css\`.

| Token | Value | Use |
|---|---|---|
| \`--color-primary\` | \`#1A73E8\` | primary actions, links |
| \`--color-danger\` | \`#D93025\` | destructive actions, errors |
| \`--color-surface\` | \`#FFFFFF\` | card and panel backgrounds |
| \`--space-2\` | \`8px\` | default gap |
| \`--radius-md\` | \`6px\` | buttons, inputs, cards |
`);
  f.w('docs/design/ARCHITECTURE.md', `# Architecture

## Components

| Component | Path | Responsibility |
|---|---|---|
| HTTP API | \`src/api/routes.js\` | route table; handlers in \`src/api/handlers.js\` |
| Store | \`./src/store/\` | data access over node:sqlite |
| Mailer | \`src/jobs/mailer.js\` | digest emails |
| Migrations | \`migrations/\` | schema, applied in file-name order |
`);
  f.w('docs/design/DATA_MODEL.md', `# Data model

Schema source: \`migrations/*.sql\`.

## Tables

### \`users\`
| Column | Type | Notes |
|---|---|---|
| id | integer | primary key |
| email | text | unique |

### \`projects\`
| Column | Type | Notes |
|---|---|---|
| id | integer | primary key |
| owner_id | integer | -> users.id |
| name | text | |

### \`tasks\`
| Column | Type | Notes |
|---|---|---|
| id | integer | primary key |
| project_id | integer | -> projects.id |
| title | text | |
| done | integer | 0/1 |

### \`audit_log\`
| Column | Type | Notes |
|---|---|---|
| id | integer | primary key |
| actor_id | integer | -> users.id |
| action | text | |
| at | text | ISO timestamp |
`);
  f.w('docs/design/API.md', `# API

Routes are declared in \`src/api/routes.js\`.

| Method | Path | Description |
|---|---|---|
| GET | \`/projects\` | list projects |
| POST | \`/projects\` | create a project |
| GET | \`/projects/{id}\` | get one project |
| PATCH | \`/projects/{id}\` | update a project |
| DELETE | \`/projects/{id}\` | delete a project |
`);
  commit('feat: projects service with design documents');

  f.mkdir('src/notify');
  f.git(['mv', 'src/jobs/mailer.js', 'src/notify/mailer.js']);
  commit('refactor: move mailer to src/notify');

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

