// Builds the risk-signals fixture in <target-dir> (A78): an installed project with run RS-1 classified COMPLEX, its
// baseline captured, a PLAN.md declaring some risk flags and a working-tree change carrying path signals,
// including traps that look like signals and are not. `selfcheck.mjs` compares `agent.sh pipeline RS-1`
// with the known answer in EXPECTED.md. Deterministic, offline, installs nothing.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target, { GIT_AUTHOR_NAME: 'fixture', GIT_COMMITTER_NAME: 'fixture' });
  f.init();
  const CP = path.join(import.meta.dirname, '../../control-plane');
  const ID = 'RS-1';
  const D = '.agents/runs/RS-1';
  /** The control plane's launcher, as the shell builder ran it (cwd the target, no AGENT_ROLE, C locale). @param {string[]} args */
  const A = (args) => {
    const { AGENT_ROLE: _role, ...env } = process.env;
    const r = spawnSync('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: f.root, env: { ...env, ...f.env, LC_ALL: 'C' }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`agent.sh ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  };

  // --- installed project ------------------------------------------------------------------------
  f.mkdir('.agents/scripts', '.agents/local', '.agents/tasks', '.agents/task-integrations', 'api', 'db/migrations', 'web', 'src', 'docs');
  f.cp(`${CP}/agents/config.yaml`, '.agents/config.yaml');
  f.cp(`${CP}/agents/modes`, '.agents/modes');
  f.cp(`${CP}/agents/templates`, '.agents/templates');
  f.cp(`${CP}/agents/scripts/agent.sh`, '.agents/scripts/agent.sh');
  f.cp(`${CP}/agents/scripts/proofline-core.mjs`, '.agents/scripts/proofline-core.mjs');
  f.cp(`${CP}/agents/scripts/core`, '.agents/scripts/core');   // the Node core runs the moved commands (classify, branch, baseline, pipeline)
  // as `proofline init` installs them (A174): the manifests of the languages come from the definition
  f.cp(`${CP}/agents/ecosystems.tsv`, '.agents/ecosystems.tsv');
  f.cp(`${CP}/agents/scripts/ecosystems.sh`, '.agents/scripts/ecosystems.sh');
  f.w('.gitignore', '.agents/runs/\n.agents/local/\n');
  f.w('package.json', '{ "name": "settings-fixture", "private": true, "dependencies": {} }\n');
  f.w('api/openapi.yaml', 'openapi: 3.0.0\npaths:\n  /settings:\n    get:\n      responses:\n        "200":\n          description: ok\n');
  f.w('db/migrations/001_settings.sql', 'create table settings (id integer primary key, theme text not null);\n');
  f.w('web/settings.html', '<main><h1>Settings</h1></main>\n');
  f.w('src/settings.js', 'export function get(key) { return key; }\n');
  f.w('docs/README.md', '# Settings service\n');
  f.w('.agents/tasks/RS-1.md', '# RS-1 settings email\n\n**Status:** in-progress\n');
  f.git(['add', '-A']);
  f.git(['commit', '-q', '-m', 'settings: initial'], { env: { GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z' } });

  // --- run RS-1: classified, baseline captured ----------------------------------------------------
  f.mkdir(D);
  f.w(`${D}/RUN.yaml`, f.read('.agents/templates/RUN.yaml').split('\n').map((l) => l.replace('<TASK-ID>', ID).replace('<REPOSITORY-RELATIVE-TASK-FILE.md>', '.agents/tasks/RS-1.md')).join('\n'));
  f.w('.agents/local/ACTIVE_RUN', `${ID}\n`);
  f.w(`${D}/TASK.md`, `# Task: RS-1 — settings email

## Goal

Users store a notification email in their settings.

## Acceptance criteria

- AC-1: GET /settings returns the email
- AC-2: the settings page shows and edits the email

## Suggested class

COMPLEX
`);
  A(['classify', ID, 'COMPLEX']);
  A(['branch', ID]);
  A(['baseline', ID]);

  // The plan: a data change and a UI section are declared, concurrency is flagged without a matching path, and the
  // contract change is explicitly NOT declared (contract_change: no) although the scope changes api/openapi.yaml.
  f.w(`${D}/PLAN.md`, `---
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

Add a nullable \`email\` column to \`settings\` in migration 002.

## UI

One email input under the theme selector, with an inline validation message.
`);

  // --- the change ---------------------------------------------------------------------------------
  f.append('api/openapi.yaml', '      content:\n        application/json:\n          schema:\n            properties:\n              email: { type: string }\n');
  f.w('db/migrations/002_settings_email.sql', 'alter table settings add column email text;\n');
  f.append('web/settings.html', '<label>Email <input name="email" type="email"></label>\n');
  f.w('package.json', '{ "name": "settings-fixture", "private": true, "dependencies": { "email-check": "1.0.0" } }\n');
  f.w('.env.example', 'SETTINGS_EMAIL_FROM=\n');
  // Traps: named like a contract, a schema client and migrations, but code or documentation.
  f.w('src/contract.js', 'export const contract = { email: "string" };\n');
  f.w('src/openapi-client.js', 'export async function getSettings() { return fetch("/settings"); }\n');
  f.w('docs/migration-notes.md', '# Migration notes\n\nRun 002 after deploying the handler. The spec header stays:\n\nopenapi: 3.0.0\n');
  // Not in the plan's scope: a nested proto contract the diff adds (found by its path, undeclared).
  f.w('proto/v1/settings.proto', 'syntax = "proto3";\nmessage Settings { string email = 1; }\n');
  f.w('db/migrations/README.md', '# Migrations\n\nApplied in file-name order.\n');
  console.log(`risk-signals fixture built: run ${ID}`);

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

