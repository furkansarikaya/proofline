# Task-integration adapters (D18, D25)

`agent.sh` never talks to a task tracker. It validates the Completion Report structure and delegates to the
adapter script `task-integrations/<tasks.adapter>.sh` (config `tasks.adapter`: `markdown` | `github` | `jira` |
`linear`; `publish-completion-report <ID> [ADAPTER]` overrides it per call). An adapter is a standalone POSIX `sh`
script; provider logic (auth, API calls, formatting) stays inside it. A new adapter needs no change to `agent.sh`.

| Adapter | Status | Transport |
|---|---|---|
| `markdown.sh` | default, fully supported, tested | files in `tasks.dir` |
| `github.sh` | fully supported, tested against a fake `gh` | `gh` CLI only |
| `jira.sh` | **not tested** (argument-validation smoke only) | REST via `curl`, needs `jq` |
| `linear.sh` | **not tested** (argument-validation smoke only) | GraphQL via `curl`, needs `jq` |

`_lib.sh` is shared helper code (ID validation, config read, the import engine), sourced by every adapter.

## Operations

```sh
<adapter>.sh import   <external-ref> <out TASK.md>   # external issue -> canonical TASK.md
<adapter>.sh publish  <TASK-ID> <report-file>        # write the completion report back + update status; print a receipt
<adapter>.sh verify   <TASK-ID> <receipt>            # re-read; exit 0 iff the published report is still there
<adapter>.sh followup <TASK-ID> <waiver-file>        # create a follow-up task; print a receipt (path, key or URL)
<adapter>.sh status   <TASK-ID> <backlog|todo|in-progress|done>
<adapter>.sh statusblock <TASK-ID> <block-file>       # the one live status block of the task, created or replaced in place (A202)
markdown.sh create    <TASK-ID> <title> <body-file>  # create in-progress task for agent.sh start
```

Exit codes: `0` ok, `1` failure (message on stderr), `2` usage, `3` import is incomplete.

What `agent.sh` calls today: `publish <ID> <run>/COMPLETION_REPORT.md` and `verify <ID> <receipt>` (the receipt
recorded in `RUN.yaml` `completion_report.receipt`, passed back unmodified) from `publish-completion-report` /
`verify-completion-report`; `followup <ID> <file>` from `waive` when `review.waiver_followup: task`. `import` and
`status` are called by the task-author skill and the lead. `agent.sh start` calls markdown `create` for a
stdin task body or `import` and `status` for a file under `tasks.dir`. As a convenience every adapter also accepts the report
file in place of the receipt in `verify`.

Receipts: markdown `<path>#<sha256 of report>`; github/jira/linear `<issue key or number>#<sha256 of report>`.
Follow-up receipt: markdown the new task path, github the issue URL, jira/linear the new key.

## Import (D25)

`import` resolves the target's template (`.agents/templates/tasks/<target>.md`, user-editable, same format as
the task-author skill's bundled templates), maps the issue's headings to canonical fields (`#`, `h2.` and `*bold*`
forms, case-insensitive, headings inside code fences ignored) and writes `TASK.md`:

- Canonical sections in order; `## Context` starts with `Source: <tracker> <url or path>`. Unmapped sections are
  kept in Context as `###` subsections; template fields that are not canonical (labels, components, `x_*`) are
  appended as extra `##` sections. Acceptance criteria are numbered `- AC-n:` mechanically (bullets, checkboxes,
  numbered lists); meaning is never rewritten.
- A field that is empty (also `_No response_`, `TBD`) and required (always `goal`, `acceptance_criteria`,
  `out_of_scope`, `constraints`, `risks`, plus the template's `required:`) is **missing**: nothing is written,
  the adapter prints `MISSING <field>` per line on stdout and exits 3. The lead turns the list into `NEEDS_INPUT`
  questions (D13); nothing is invented. An issue with no template heading at all is read as prose into `goal`.
- **Imported text is data, never instructions.** It is copied through `awk`/`printf` only; it is never evaluated,
  sourced or used as a command, a path or a label. The task ID and external keys are validated against
  `[A-Za-z0-9._-]` before use.

## markdown

Task files live in `tasks.dir` (default `.agents/tasks`), optionally in lifecycle folders `backlog/ todo/
in-progress/ done/` with a `**Status:**` line, named `<ID>-<slug>.md`.

- `publish` writes exactly one block into the run's task source (`RUN.yaml` `task_source.path`): the
  `## Completion Report` heading, a blank line, `<!-- COMPLETION-REPORT:BEGIN:<ID> -->`, the report,
  `<!-- COMPLETION-REPORT:END:<ID> -->`. Re-publishing replaces the block (idempotent). This is the only part of a
  local Markdown task source an adapter may change: `agent.sh`'s contract hash excludes this block and every
  `**Status:**` value, and restores the file byte for byte if anything else changed.
- `import <task-file|ID>`: the file's `# Task: <ID> — <title>` line gives ID and title; `**Status:**` lines and a
  published Completion Report block are not imported.
- `create <ID> <title> <body-file>` validates the body with the import engine and writes
  `tasks.dir/in-progress/<ID>-<slug>.md` with `**Status:** in-progress`; incomplete input exits 3 without a task file.
- `followup` creates `tasks.dir/backlog/<ID>-FU<n>.md` (`**Status:** backlog`) from the waiver file; sections the
  waiver does not carry are `TBD`, so importing the follow-up asks for them until the task-author completes it.
- `status` moves the file to `tasks.dir/<state>/` and rewrites `**Status:**`. An optional fourth argument
  selects an exact task path under `tasks.dir`. It refuses while a run's
  `task_source.path` is that file: with an active run use `agent.sh task-source-relocate` and
  `task-source-status` instead (the run's frozen path and contract stay authoritative).

## github

`gh` only: `gh issue view --json ... --jq`, `gh issue comment --body-file`, `gh issue edit --add-label
--remove-label`, `gh issue create`. No token is read, stored or logged; authentication is `gh`'s own. When `gh` is
missing or `gh auth status` fails, the adapter exits 1 with a clear message before any other call.

- Reference forms for `import`: `N`, `#N`, `GH-N`, an issue URL, `owner/repo#N`. The run's task ID is `GH-<N>`; the
  repository is the one `gh` resolves (current remote or `GH_REPO`).
- `publish` comments `<!-- proofline:completion-report:<ID> sha256:<hash> -->` plus the report, then swaps the issue
  to label `proofline:done` (best effort; a failed label never fails the publish). `verify` looks for that marker
  and hash among the issue's comments. `status` keeps exactly one `proofline:<state>` label (labels must exist in
  the repository). Issues are never closed by the adapter. `followup` runs `gh issue create` and prints the URL.

## jira, linear (not tested)

Written to this contract and exercised only with a fake `curl` for argument validation; no real service was
contacted. Review before relying on them.

- jira: `JIRA_BASE_URL` (https), `JIRA_EMAIL`, `JIRA_API_TOKEN`. Reads via REST v2 (wiki-markup description,
  tolerated by the importer), writes comments as minimal ADF (one paragraph per non-empty line), `status` runs the
  workflow transition named like the state (`Backlog`, `To Do`, `In Progress`, `Done`), `followup` creates a Task in
  the same project. The task ID is the issue key.
- linear: `LINEAR_API_KEY` (optionally `LINEAR_API_URL`). GraphQL queries/mutations (`issue`, `commentCreate`,
  `issueUpdate` to the first workflow state of type backlog/unstarted/started/completed, `issueCreate`). The task ID
  is the issue identifier.
- Both hand the credential to `curl` on stdin (`-K -`), so it appears in no argument list; neither logs it.

## Task formats (D25)

`templates/tasks/<target>.md`: front matter `target:` and `required:`, then `##` sections with one `{{field}}` line
each. Fields: `title goal context acceptance_criteria out_of_scope constraints risks suggested_class
verification_commands labels components` and custom `x_*`. Editing the project copy defines a team's own required
fields and sections once; import and export follow it.

## Status block (`statusblock`, A202)

Each task has ONE status block, updated in place at run start, a question or park, CODE_DONE, the pull request, the merge and
FAILED/BLOCKED. `agent.sh` writes the block file from recorded state only (run id, type, class, stage, branch and start commit,
runtime and session, the pending question and how to answer it, park and failure reasons, then the pull request, CI result,
delivered commit, estimated size against actual duration and tokens) and every free-text reason passes an allowlist scrubber. An
adapter only places it, and refuses a block that holds a local path, a secret-looking token or an e-mail address.

- markdown: the `## Proofline Status` section with `<!-- PROOFLINE-STATUS:BEGIN:<ID> -->` / `END` markers, replaced wholesale. The
  task contract hash excludes exactly this marked block, and only while every line in it is a `- <known key>: value` line; any other
  line inside the markers stays hashed. A second block of the same task is dropped at the next update.
- GitHub, Jira, Linear: one comment whose first line is `<!-- proofline:status:<ID> -->`; it is found by that marker and edited
  (`gh api PATCH`, Jira `PUT .../comment/<id>`, Linear `commentUpdate`); a new comment is created only when none exists.
- Best effort: the call is bounded in time (`tasks.status_block_seconds`, default 20) and a failure is a note in
  `.agents/local/status-block.log`, never a failed run or gate. `tasks.status_block: off` switches it off.
