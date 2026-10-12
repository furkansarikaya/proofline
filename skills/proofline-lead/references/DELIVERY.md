# Delivery: commit, push, PR (D3, D19, D34)

`A` = `.agents/scripts/agent.sh`. Delivery happens before `cleanup` (the git hooks read the run's gates).
The git hooks in `.agents/githooks/` (`core.hooksPath`) enforce identity, protected branches, the task
branch, the gated content and single-use approvals; the lead never bypasses them (`--no-verify`, changing
`core.hooksPath`, editing hooks or config are forbidden).

## 1. Preconditions

- `A next <ID>` prints `agent.sh request-approval <ID> commit`, and `A delivery-check <ID>` prints
  `delivery_ready=true` on the task branch `<git.branch_prefix><ID>-<slug>`.
- The current branch is not in `git.protected_branches` and is not the canonical branch.
- The commit identity is the repository's own (`git var GIT_AUTHOR_IDENT`); never set or change the global
  git configuration; a forbidden identity is the user's to fix.

## 2. Commit

1. Ask: `A request-approval <ID> commit`; relay verbatim with the proposed message
   (`git.commit_format`, default Conventional Commits with the task id, e.g.
   `fix(lookup): return null for an empty key (LK-7)`) and the changed paths from `git status --short`. If
   `A baseline` recorded pre-existing user changes, say they will be part of the commit. STOP.
2. Only when the user's **current** message approves the commit (the runtime records the approval from that
   message; the lead never runs `approve`): `git add -A` (the run directory and `.agents/local/` are ignored) and `git commit -m "<message>"`. The
   pre-commit hook consumes the approval bound to that content fingerprint.
3. A hook rejection is reported verbatim; never retried with other flags.

## 3. Push

With `git.push_requires_approval: true` (default): `A request-approval <ID> push`, relay, STOP; after the
user's approval in their current message (recorded by the runtime), `git push -u origin <task branch>`.
Never `--force`, never another branch, never a tag.

## 4. Pull request

A PR is a separate stop point: `A ask <ID>` with the D13 block, relay `A questions <ID>`, STOP; open it
only when the user's current message approves it (`A answer <ID> <N>` with their words). Body = the completion report's summary, gates and fix rounds, waivers, and open follow-ups
(from `COMPLETION_REPORT.md`, nothing invented). GitHub: `gh pr create --base <canonical_branch> --head
<task branch> --title <commit subject> --body-file .agents/local/assignments/<ID>/PR_BODY.md` (the only `.agents/local/` directory the lead
writes; never `$TMPDIR`). The lead never merges,
approves, tags or closes.

## 5. `deliver <TASK>`

The command runs sections 1 to 4 for a run that is already DONE (`A next` must print the commit request);
a run that is not DONE is reported with its `next=` step instead. After delivery (or when the user declines
it): `A cleanup <ID>`, final report, STOP.
