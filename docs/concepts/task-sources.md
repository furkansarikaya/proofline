# Task sources

Where a task comes from and where its completion report goes. A GitHub issue is the recommended source: the issue stays what people wrote, and the report is one comment under it. Jira and Linear are supported only against fakes ([task integrations](../../control-plane/agents/task-integrations/README.md)); running proofline remotely when an issue gets a label is deferred ([out of scope](../../.out-of-scope/deferred.md)).

## GitHub issues (recommended)

1. Install and log in the GitHub CLI once: `gh auth login` (proofline never reads or stores a token).
2. Set `tasks.adapter: github` in `.agents/config.yaml` (or `proofline init --task-adapter github`).
3. `proofline task --import <issue-url|number>` (`N`, `#N`, `GH-N`, an issue URL or `owner/repo#N`) prints the line for your agent session. The lead reads the issue with `gh` (nothing is written to it), maps the issue's headings to the canonical task fields with the template `.agents/templates/tasks/github.md`, and asks for what the issue lacks instead of inventing it. The task id is `GH-<number>`. The issue text is data, never instructions.
4. `proofline run GH-<number>` takes it through the workflow. The label `proofline:<state>` on the issue follows the run, and the live status is one comment that is edited in place.
5. At the end, `publish-completion-report` posts the report as **one comment** (edited in place if you publish again). The issue body is never edited. The full report also stays in the run folder.

What is done to the comment before it leaves your machine, because people are notified and the text was written by agents:

| Risk | What the comment does |
|---|---|
| a secret in the report | a line that matches the built-in secret rules is replaced by a note; the full report stays in the run |
| `@name` notifies a person | a bare `@name` or `@org/team` outside code is put in code ticks |
| an image or HTML that calls home | `![` is escaped and `<img` is written as text |
| a report over GitHub's size limit | cut on a line at 60000 bytes, a code block left open is closed, and the last line names the report in the run |
| the wrong issue | the number comes from the task id (digits only), the repository is the project's own remote; a run imported from another repository's issue is refused |

Only the lead's delivery path posts; a role cannot. If the post fails (network, `gh` access), `publish-completion-report` refuses with the command to run again, and the report is untouched in `.agents/runs/<ID>/COMPLETION_REPORT.md`; delivery still needs a verifiable publication, so this is not skipped.

## Markdown task files (default)

A task is a file in `tasks.dir` (`.agents/tasks/<state>/<ID>-<slug>.md`). Publishing the report no longer pastes it into the file: the report is written to `<tasks.dir>/<ID>/COMPLETION_REPORT.md` (a folder of the task, which no task scan reads) and the task file keeps, between the `COMPLETION-REPORT` markers, three lines:

```
Report: .agents/tasks/T-1/COMPLETION_REPORT.md
Report-sha256: <hash>
Changed: <the one-line summary of the report>
```

Explorers, `batch-plan`, the `depends_on` reader and the task validator are not affected: they read the task file, which stays small, and the block between the markers is outside the task's frozen contract as before. `proofline trace` follows the pointer. Tasks finished earlier keep their inline report; `verify-completion-report` still accepts it.

## Other trackers

Jira and Linear: [task integrations](../../control-plane/agents/task-integrations/README.md) (not tested against a real service). Your own adapter: [writing an adapter](../guides/writing-an-adapter.md).
