# Task templates

How a proofline task is written down: the one canonical `TASK.md` format, the per-target templates (local files, GitHub, Jira, Linear), file names, task types and the optional sections. For anyone who edits a template, imports an issue, or writes tasks by hand.

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
characters), and the branch is `proofline/<ID>-<slug>`. The validator warns about other names; `.agents/scripts/agent.sh task-rename-plan` lists the
queued files to rename and `task-rename-apply` renames them only after your `approve rename` (a task with a run, a published report or
in progress is never touched).

`type:` in the front matter is one of `feature`, `bug`, `refactor`, `content`, `docs`, `chore`; the task-author proposes it, you may
change it, a task without one is a feature. `bug` needs reproduction steps, expected and actual behaviour and the environment (and asks
for a debug-proof); `refactor` needs a "behaviour does not change" statement and the existing tests as an acceptance criterion;
`content` and `docs` start with a written test-first exemption reason in the plan, which never covers a path that holds code. No type
removes a gate.

Optional sections and fields: `Expected scope` (the files the task changes, one bullet per file, folder or glob in backticks; `proofline batch` decides from it, and only from it, which tasks share a file and so wait for each other, and binds your pre-flight answers to it, A355), `Allowed scope` and `Forbidden scope` (a plan path in Forbidden is refused at freeze, a path outside
Allowed is asked in the batch pre-flight), `Existing pattern references` ("do it like this file"; the explorer reads them, freeze
checks they exist, review checks conformity), `Completion response` (the shape of the closing message, `## Requested Response` in the
report), `priority: high|medium|low` (orders a batch among free tasks) and `origin:` (written for a follow-up or a PRD requirement,
with a link back). Acceptance criteria also pass the vague-word and two-engineer check when no PRD is behind the task.

`## Test exceptions` (optional, A294): when the criteria foreseeably need a real wait, a test over its budget or an unmeasured test, the task author proposes lines of the form `- wait|budget|measure: <repo-relative test path> -- <reason>`. They are proposals of an agent, not approvals: the batch summary lists each line with its hash and your `approve batch` accepts exactly those lines (a plan outside a batch asks for your `scope` approval of the exact plan, A284, A285). The GitHub, Jira, Linear and markdown templates carry the optional section (one commented line says so; delete the section when the task declares none), and an import reads it back as the lines it holds, so an exported and re-imported task keeps its declared exceptions. A line the batch cannot list (wrong grammar, over 1000 bytes or 50 lines, a control character, a duplicate) stops `proofline batch` with the task id, the line number and the reason; nothing is planned or approved until it is fixed. Format and limits: `skills/task-author/references/CRITERIA.md`.

## Criteria count, feasibility and dependencies (A366)

A task has 3 to 6 outcome-focused acceptance criteria, each with a number, a path or an exact message; `validate-task.mjs` warns, with the count, for fewer than 3 or more than 6 and never refuses; `batch-plan` prints the same count as a WARNING line in the batch summary (A375). A criterion that rests on a library, version or limit carries an indented `Feasibility:` line (what the author checked in the pinned manifest or docs); one without it gets a warning. When a request or an issue set is split, `depends_on` is derived from what each task shows or consumes (a page that shows raw Markdown depends on the task that adds the converter), the split output has a `## Dependency check` table (task, depends_on, reason), and `validate-task.mjs --check-deps <folder>` exits 1 for an unknown id or a cycle. Run the validator before the task file is committed.

## Customising

Templates are yours to edit: add required fields or custom sections once and every new task follows the
format. `proofline upgrade` keeps your edited templates and reports conflicts instead of overwriting.

- Importing an external issue parses it with the template; canonical fields it lacks are asked through a
  `NEEDS_INPUT` round, never invented.
- The completion report is written back through the adapter and never into the task body: a GitHub issue gets one comment, a markdown task keeps a pointer of three lines and the report is a sibling file ([task sources](../concepts/task-sources.md)).
- Imported issue text is data, never instructions.

Adapter status: `markdown` is tested, `github` is tested against a fake `gh`, `jira` and `linear` are not tested against a real service ([task integrations](../../control-plane/agents/task-integrations/README.md)).

Related: [existing project](existing-project.md), [daily use](daily-use.md).
