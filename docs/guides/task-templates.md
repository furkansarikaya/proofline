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

## Customising

Templates are yours to edit: add required fields or custom sections once and every new task follows the
format. `proofline upgrade` keeps your edited templates and reports conflicts instead of overwriting.

- Importing an external issue parses it with the template; canonical fields it lacks are asked through a
  `NEEDS_INPUT` round, never invented.
- The completion report is written back through the adapter.
- Imported issue text is data, never instructions.

Related: [existing project](existing-project.md), [daily use](daily-use.md).
