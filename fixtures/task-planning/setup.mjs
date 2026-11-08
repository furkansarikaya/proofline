// Builds the task-planning fixture in <target-dir>: a repo as it looks after a grill (A: tasks written to tasks.dir as <ID>.md,
// B: project-level ADR linked from a task, D: team.yaml under a self-ignoring .agents/local). Offline.
// usage: node setup.mjs <target-dir>
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init();   // the shell ran a bare `git init -q` (the host's init.defaultBranch decided; no commit is made); the branch is now always main
  f.mkdir('.agents/tasks', 'docs/adr', '.agents/local');
  f.w('docs/adr/0001-use-postgres.md', '# ADR 0001: Use Postgres\nStatus: accepted\n');
  for (const n of [1, 2]) {
    const dep = n === 2 ? 'depends_on: T-1\n' : '';
    f.w(`.agents/tasks/T-${n}.md`, `# Task: T-${n} — Sample

---
size: S
sprint: 1
assignee: dev-${n}
${dep}---

## Goal
Do thing ${n}.

## Context
See [ADR 0001](/docs/adr/0001-use-postgres.md).

## Acceptance criteria
- AC-1: The thing ${n} works and returns HTTP 200.

## Out of scope
Nothing else.

## Constraints
None stated by the user.

## Risks
None known.

## Suggested class
STANDARD - small change

## Verification commands
npm test
`);
  }
  f.w('.agents/local/.gitignore', '*\n');
  f.w('.agents/local/team.yaml', 'people: 2\n');
}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>', empty: false });
