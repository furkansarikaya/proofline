# Night mode

Night mode (`/proofline batch <ID...|all>`, A157) works through several tasks with one approval, in the SAME session : the
lead runs a task, delivers it, and only when it is merged goes on to the next. There is no background process and no headless
session. This page holds the detail; the README keeps the short form. The mechanics are in [workflow](workflow.md#night-mode), the
hook rules around it in [enforcement layers](enforcement-layers.md), and every decision in [decisions](../decisions.md).

## The summary and the approval

`/proofline batch <ID...|all>` orders the listed tasks by `depends_on` and shows one summary: the order, what the approval
covers, what it does not, the tasks left out (CRITICAL or unclassified tasks, and tasks that depend on them) and the reminder
that the computer must stay awake and the session open. Your one reply "approve batch" is bound to that summary (its sha256) and
stands in for the plan approval, the delivery approval (commit, push, pull request, merge only when CI is green and every gate
passed, cleanup) and a mutation budget raise up to `batch.mutation_budget_cap`, for the tasks in the table and nothing else.

A project with no CI check on pull requests can still run a batch (A180). The summary carries a WARNING with the ready
`/proofline task Add a GitHub Actions workflow ...` line, and each pull request is merged only after the project's build and test
commands pass in a clean copy of its commit; the pull request then says "verified locally, no CI". The batch needs a platform
proofline can merge on (GitHub with gh, GitLab with glab, Azure DevOps with az); on another host the lead stops at the pull request
for you to merge.

## Running the batch, in this session

After "approve batch" the lead works in dependency order, one task at a time:

1. `agent.sh batch-next` prints the batch's state from files (a digest) and the next action. The lead calls it before every
   task, so after a context compaction or a restart it continues at the right place.
2. `run`: a worktree for the task (below), then the task through the normal workflow. At an approval request of kind plan or
   mutation budget the lead calls `agent.sh batch-cover <ID> <kind>`.
3. `deliver`: the whole delivery; its approval is covered by `batch-cover <ID> delivery`. The next task starts only when the
   pull request is merged (a record in `merged.tsv`).
4. `ci`: after a merge `agent.sh batch-ci <ID>` checks the CI run of the merge commit itself, not the latest run. Red, still running
   after `batch.ci_wait_minutes`, or no run within `batch.ci_appear_minutes` stops the batch.

A waiver, a scope expansion, a new dependency, a reopen, a destructive data change, a rule promotion, sending the friction
report and a new fix-round budget are never covered: the lead records the question (`agent.sh ask`), the task is parked, the tasks
that depend on it are skipped and the next independent task goes on. A red CI after the pull request is open is a CI-fix round
(at most 2 attempts, same pull request branch); when that stops with its question the task is parked.

`batch-next` is read-only and derives everything from records: `merged.tsv`, the task runs, their questions and approval requests,
`ci.tsv` and `state.tsv` (parks the lead made itself with `agent.sh batch-park`). An answered question or a reopened run un-parks a
task by itself.

## Keep the computer awake and the session open

The batch lives in the session. It stops when the session closes, a usage limit is hit or the computer sleeps. Plug the computer in
and keep the lid open (closing the lid sleeps most machines whatever an inhibitor says). On macOS the session offers to start
`caffeinate -i -w <the session's pid>` (`agent.sh batch-awake`), which keeps the Mac awake for exactly the life of the session and
ends with it; on Linux `systemd-inhibit` is held the same way. Where neither exists the lead says so plainly.

## Resuming after an interruption

Run `/proofline batch` again, with no task IDs (or with the same IDs): when the approved batch is not finished, it continues
where it stopped, with no new plan and no new approval. A merged task (a record in `merged.tsv`) is never run again; a task that was
half done goes on from its run. `/proofline batch --replace <ID...|all>` plans a new batch instead.

## One worktree per task (A169)

Every task runs in a git worktree of its own, `.agents/local/worktrees/<ID>` (git-ignored), made from the
canonical branch just before the task starts (`agent.sh worktree-add <ID>`). The run, its `ACTIVE_RUN`, the task-file move
to `in-progress/` and the open-run check of the commit and push hooks all belong to that worktree, so:

- a task that is parked, waiting for its merge or in a CI-fix round blocks no task that does not depend on it (before,
  the next task failed with `another open run exists in this worktree` and its dependents were skipped);
- the main working tree stays clean: no run, no moved task file, nothing to commit or stash, and `git status` there shows
  what it showed before the batch;
- a task starts only when every task it depends on is merged (a record in `merged.tsv`). A dependency that is parked, skipped
  or awaiting its merge keeps the dependent skipped; the next `/proofline batch` judges it again, so it follows the merge
  and starts from the new canonical tip;
- a merged task's worktree is removed; a parked one keeps its worktree (its run evidence lives there) and the next session
  for that task resumes in it. A pull request that is open but not merged parks the task as `awaiting merge`.

**Where state lives (A185).** The state of one run (`.agents/runs`, `ACTIVE_RUN`, the delivery folder, assignments, locks, the
hook's windows, records and timings) lives in the worktree that owns the run. The runtime hook decides which worktree an event
belongs to from the path the tool touches (when it is inside the project) or else from the working directory, using
`agent.sh worktree-root`, and asks that worktree's `agent.sh`, so the hook, the session and `agent.sh` always read and write
the same run folder. The state that belongs to no single run (`batch`, `approvals`, `metrics`, `friction`, `prompts`) lives
only in the main working tree, and every reader reaches it by path (`shared_dir` in `agent.sh`; the hook uses the main tree
too), never through a link, so a reply you give in the main session reaches `answer --captured` and the session finds the
batch approval and the merge record. Untracked runtime settings (`.claude/settings.json`, `.codex/hooks.json`) are copied in.
**Dependencies.** A worktree never shares a dependency folder with the main tree: `worktree-add` gives it its own copy (a
copy-on-write clone where the file system has one) of every git-ignored folder that `worktree_deps.folders` names in
`ecosystems.json` (for example `node_modules`; `proofline` knows no ecosystem itself, it reads that data), so a task that
changes dependencies changes only its own worktree. A folder that is not relocatable (a Python virtual environment, `.dart_tool`,
`obj`) is not listed and is not copied: the task installs its own. **Local files.** Untracked files that match
`worktree.copy_files` in `.agents/config.yaml` (default `.env*`, `none` switches it off; a pattern without `/` matches at any
depth) are copied in so the project runs, but only a file git IGNORES (one that is not ignored is reported and left behind). A
copied file is listed in the worktree's `.agents/local/worktree-copied`; the pre-commit hook refuses to commit it, even with
`git add -f`, and the secret scan is unchanged. **Windows.** Nothing needs symlinks: where Git Bash cannot create them (no
developer mode), a link would be a stale copy, so none is made; the shared state is read from the main tree's folder by path.
`proofline clean` leaves
the worktrees alone; remove one with `agent.sh worktree-remove <ID>` (refused while a run is inside, `--force` overrides).
Outside night mode `agent.sh worktree-add <ID>` gives a second run the same kind of worktree; start the session in that folder.

From the main working tree, an `agent.sh` command that names a run living in a task worktree (`questions`, `answer`,
`next`, `reopen`, ...) is forwarded to that worktree's own `agent.sh` (the working directory becomes the worktree), and
`proofline queue` lists such runs with their folder. So you answer a parked task's question in the main session, then
`/proofline batch` resumes the task in its worktree. The next-step line for such a task says exactly that, never
`/proofline resume`, which would work in the wrong tree.

## The morning table

`proofline batch status` (`agent.sh batch-status`) is the morning table, generated from records only: task, result, pull request,
merge time, park reason and the pending question of each parked task, then the friction report.

## Limits that are decisions

- Night mode runs markdown task files only: the order and the classes are read from the task files, not from network calls. Import
  other tasks with `/proofline task`; `batch-plan` says so.
- One session works a batch. `batch-next` records the session in `batch/owner`; a second live session is told `NEXT: wait (owned by pid N)`, and a dead owner is taken over. Without a findable session process there is no guard.
- A pull request that was opened but has no merge record (the session died after the merge, or you merged by hand) is read from the platform: merged leads to `deliver-step <ID> cleanup <PR>`, which records the merge; open stays parked; an unreadable state is said in the park reason.

Removed in 0.0.32 : the headless batch driver (`batch run`, the detached `batch start` and `batch stop`, process groups, the
Codex sandbox profile, `driver.pid` and `driver.log`, the per-task timeout and runtime fallback). `proofline batch run` and
`proofline batch stop` say what to do instead.
