# Task templates

proofline has one canonical internal task format, `TASK.md`: goal, context, numbered observable acceptance
criteria, out of scope, constraints, risks, suggested class. Each task target (where the task is stored) has a
template that renders and parses it.

Templates live in `.agents/templates/tasks/` after `proofline init`:

| File | Target |
|---|---|
| `markdown.md` | local task files in `tasks.dir` (default `.agents/tasks`) |
| `github.md` | GitHub issue body and labels |
| `jira.md` | Jira summary, description, acceptance criteria, labels, components |
| `linear.md` | Linear |

The adapter is chosen by `tasks.adapter` in `.agents/config.yaml` (`markdown`, `github`, `jira`, `linear`).

## Anatomy

A template starts with front matter naming the target and its required fields, then the body with
`{{placeholder}}` markers:

```text
---
target: jira
required: title goal acceptance_criteria out_of_scope constraints risks labels components
---
## Summary
{{title}}
...
```

## Names, type and optional fields (A202)

A task file is named `<ID>-<slug>.md`; the slug comes from the title (Turkish and other Latin letters become ASCII, at most 48
characters), and the branch is `proofline/<ID>-<slug>`. The validator warns about other names; `agent.sh task-rename-plan` lists the
queued files to rename and `task-rename-apply` renames them only after your `approve rename` (a task with a run, a published report or
in progress is never touched).

`type:` in the front matter is one of `feature`, `bug`, `refactor`, `content`, `docs`, `chore`; the task-author proposes it, you may
change it, a task without one is a feature. `bug` needs reproduction steps, expected and actual behaviour and the environment (and asks
for a debug-proof); `refactor` needs a "behaviour does not change" statement and the existing tests as an acceptance criterion;
`content` and `docs` start with a written test-first exemption reason in the plan, which never covers a path that holds code. No type
removes a gate.

Optional sections and fields: `Allowed scope` and `Forbidden scope` (a plan path in Forbidden is refused at freeze, a path outside
Allowed is asked in the batch pre-flight), `Existing pattern references` ("do it like this file"; the explorer reads them, freeze
checks they exist, review checks conformity), `Completion response` (the shape of the closing message, `## Requested Response` in the
report), `priority: high|medium|low` (orders a batch among free tasks) and `origin:` (written for a follow-up or a PRD requirement,
with a link back). Acceptance criteria also pass the vague-word and two-engineer check when no PRD is behind the task.

## Customising

Templates are yours to edit: add required fields or custom sections once and every new task follows the
format. `proofline upgrade` keeps your edited templates and reports conflicts instead of overwriting.

- Importing an external issue parses it with the template; canonical fields it lacks are asked through a
  `NEEDS_INPUT` round, never invented.
- The completion report is written back through the adapter.
- Imported issue text is data, never instructions.

Related: [existing project](existing-project.md), [daily use](daily-use.md).
