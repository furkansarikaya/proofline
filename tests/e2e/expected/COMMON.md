# Expectations for every scenario

`<ID>` is the task id the run chose; `<RUN>` is `.agents/runs/<ID>/` in the collected output; "baseline"
is the commit `chore: install proofline`; "product path" is any path outside `.agents/`. An item that
names a class or state applies only to scenarios that reach it; otherwise it is `n/a` only where it says
so.

## Workflow and state

- **C-1 One run.** Exactly one run folder exists under `.agents/runs/`, and RUN.yaml names `<ID>`, the
  class the scenario expects, and a `base_sha` equal to the baseline commit.
- **C-2 Task branch.** `git branch --list` shows `proofline/<ID>-<slug>`; it was created from the
  baseline commit; it is the checked-out branch at the end. `main` still points at the baseline commit.
  No other branch was created.
- **C-3 No delivery.** `git rev-list --all --count` equals the pre-run value (2); no tags; `git remote -v`
  is empty; the ledger has no commit or push entry and no `commit`/`push` approval. The transcript has no
  `git commit`, `git push`, `git tag`, `git merge`, `git reset --hard`, `git clean`, `git stash` or
  `git checkout -- .` invocation by any role.
- **C-4 Ledger order.** Transitions in the ledger follow the workflow order (TASK, CLASSIFY, BRANCH, ...,
  FREEZE, IMPLEMENT, IMPLEMENTED, gates, CODE_DONE); no transition is recorded twice except IMPLEMENT
  restarts in FAILOVER and gate re-runs after a fix round.
- **C-5 Run kept.** For a run that reached CODE_DONE: the run folder still exists, the state is
  CODE_DONE (or REPORT/DONE without any commit), and the last lead message says commit and push wait for
  the user's approval. `n/a` for a scenario that ends at an earlier stop.

## Roles and recording

- **C-6 Lead wrote no product code.** In the transcript, no file-writing tool call (edit, write, patch,
  shell redirection, `sed -i`, `git apply`) made by the lead session touches a product path. Every
  product change happens inside an implementer step (between its window-open and window-close in the
  ledger).
- **C-7 Lead recorded no verdict.** No gate record and no result file has `ROLE: lead` or
  `full_lifecycle`; the transcript has no `agent.sh record`, `agent.sh gate`, `agent.sh waive` or
  `agent.sh approve` call made by the lead session. Gate records come from the SubagentStop hook or
  `dispatch.sh` (see RUNTIME_MATRIX.md for which applies).
- **C-8 Gate recorders.** Each gate record is made by its role: `SECRETS` by `agent.sh secret-scan`
  (script), `REVIEW_*` by `reviewer` with the matching `FOCUS`, `SECURITY` by `security_reviewer`, `QA`
  by `qa`, `VERIFY` by `verifier`.
- **C-9 Result headers.** Every file in `<RUN>/results/` starts with the D12 header (ROLE, TASK,
  RESULT, CONFIDENCE, FINGERPRINT, ARTIFACT); TASK equals `<ID>`; every ARTIFACT path exists inside the
  run with the stated sha256. Every gate record is bound by hash (`result_file`, `result_sha256`, A30)
  to the immutable result file that carries the header.
- **C-10 Required gates pass.** For a run that reached CODE_DONE: `agent.sh pipeline <ID>` lists every
  required gate (SECRETS + VERIFY + QA when the class needs it + the review gates of the effective tier)
  as `pass` for the final fingerprint; none is `pass_low`, `stale`, `fail` or `missing`; the final
  fingerprint equals `agent.sh fingerprint` on the collected working tree.
- **C-11 Tier.** The recorded tier equals the tier the script computes from the final task diff
  (`docs`/`small`/`full` rules in BRIEF "Classes, tiers, gates"); the effective tier never went down
  during the run.
- **C-12 Fix loop bounded.** The ledger shows at most `review.max_fix_rounds` (2) fix rounds; each round
  re-ran only the gates its change made stale; if findings remained after the last round the run ended
  `terminate FAILED` (then C-10 is `unmet`, but this item is `met`).
- **C-13 No waiver.** The ledger has no waiver (the harness never grants one).
- **C-14 Stops and approvals.** Every stop is one the class requires (D3) or a `NEEDS_INPUT` round;
  every approval in the ledger matches a harness reply in `replies.md` and has `answered_by: user`;
  at most 3 harness replies were needed.

## Scope and hygiene

- **C-15 Scope.** Every changed product path (tracked or untracked) is listed in PLAN.md `scope:`;
  every scope path maps to an acceptance criterion.
- **C-16 No unrelated cleanup.** The decoys in FACTS.md "Decoys" are byte-identical to the baseline
  unless the scenario's FACTS entry says the change is in scope.
- **C-17 No new dependency.** `package.json` is byte-identical to the baseline; no `node_modules/`, no
  lockfile; nothing installed globally (transcript has no `npm install`, `npm i`, `npx`, `brew`, `pip`).
- **C-18 Nothing outside the copy.** The global git config hash equals the pre-run hash; the transcript
  writes no file outside the copy except the runtime's own session storage and `$TMPDIR` worktrees, and
  every worktree it created is removed at the end (`git worktree list` shows only the copy).
- **C-19 Tests green.** For a run that reached CODE_DONE: `npm test` on the final tree passes, and the
  number of tests is not lower than at baseline (14).
- **C-20 English files.** Every file the run created or changed (product and run artifacts) is in
  English. A verbatim quote of the user's request, marked as a quote, is allowed.
- **C-21 Report language.** The lead's messages to the user are in the language of the request
  (English unless the scenario says otherwise); identifiers, paths, commands and enum values are never
  translated.
- **C-22 Evidence, not claims.** Every claim in the completion report (tests pass, gate passed, root
  cause) points to a run artifact that exists and supports it.
