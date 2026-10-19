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
writes; never `$TMPDIR`). The lead never approves, tags or closes, and merges only in `deliver` (section 5),
through `proofline merge`.

## 5. `deliver <TASK>`: the whole delivery in one command

The same flow for Claude Code and Codex. `deliver` does knowledge, commit, push, pull request, merge and cleanup
with ONE question to the user. It applies to a DONE run (a pull request) and to a FAILED run (a DRAFT pull request).

1. **Knowledge first.** `A deliver-plan <ID>` refuses with `knowledge step not complete` until the knowledge step is
   done: run it now ([LIFECYCLE.md](LIFECYCLE.md#7-knowledge)), and request each `rule:<CAND>` promotion approval
   without stopping. A run that is not DONE (and not FAILED) is reported with its `next=` step; STOP.
2. **Prepare.** `A deliver-plan <ID> [--message "<type>(<scope>): <subject> (<ID>)"]` (the message follows
   `git.commit_format`; one line, no `"`, `` ` ``, `$` or `\`). It writes `.agents/local/deliver/<ID>/SUMMARY.md`:
   the changed paths, the files the knowledge step changed, the commit message, the branch, the PR kind, title
   and body (`PR_BODY.md`: the published completion report, or the draft body from the run records), when the
   merge happens (DONE: only with every check green, through `proofline merge`; FAILED: never) and when cleanup
   happens (after the merge; for a draft right after the pull request is opened). It records one approval request
   per step (`commit`, `push`, `pr`, `merge`, `cleanup`), each bound to the content fingerprint and to the
   summary's sha256. Relay its output verbatim (the summary, the separate decisions and the question). STOP.
3. **One reply.** Only the user's own reply `approve delivery` (or `I approve the delivery`, `teslimatı onaylıyorum`)
   records the step approvals (the prompt hook; the lead never runs `approve`). It does not approve a lesson
   promotion: the summary lists open `rule:<CAND>` requests as separate decisions. A rule the user approves in
   its own reply is promoted (`A lessons promote`) and the delivery is prepared again (step 2); without it
   delivery goes on without the promotion.
4. **Steps.** Before each step run `A deliver-step <ID> <step> [PR]` and run exactly the `run:` lines it prints,
   then the `then:` line. It refuses, and the chain STOPS, when the content, the branch, the commit message or
   the body changed, when HEAD is not the one delivery commit on top of the summary's HEAD (a new commit), or
   when the step's approval for this summary is missing; then go back to step 2 and ask again.
   - `commit`: `git add -A`, `git commit -F .agents/local/deliver/<ID>/COMMIT_MSG` (the pre-commit hook
     consumes the approval).
   - `push`: `git push -u origin <task branch>` (the pre-push hook consumes it).
   - `pr`: `gh pr create [--draft] ... --body-file .agents/local/deliver/<ID>/PR_BODY.md`; note the number.
   - `merge <PR>` (DONE only; a draft is never merged): `gh pr checks <PR> --watch --fail-fast`, then
     `proofline merge <PR>`. A failed check or a refused merge: STOP, no cleanup, report the state.
   - `cleanup <PR>`: checks that the pull request is this delivery's (head commit = HEAD, head and base branch
     as in the summary, the merge step ran for that number; a draft: the pr step ran) and is merged (a draft:
     open), then runs `A cleanup <ID>` itself. `merge` checks the same head, branches and that the pr step ran.
5. Final report, STOP. Without the user's approval nothing is committed; `A cleanup <ID>` is run when the
   user declines delivery.
