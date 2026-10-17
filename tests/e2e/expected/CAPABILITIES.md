# Expected: capabilities (A95)

Additional numbered items, scored in a separate table. They never replace or loosen an item of `COMMON.md`
or a scenario file. Evidence paths are relative to the run's `out/`. An item marked not-applicable must meet
the stated condition; otherwise it is scored.

- **N-1 Pipeline signals.** [invariant] Applicable when the diff touches a UI, contract or migration path.
  `agent-pipeline.txt` is a real `agent.sh pipeline <ID>` output (not a placeholder) and lists each signal
  with its source (path/content pattern or plan flag) and the check it triggered.
  Evidence: `agent-pipeline.txt`, `git-diff-main-head.patch`.
- **N-2 Assumptions and risk.** [invariant] `runs/<ID>/PLAN.md` carries `## Assumptions`, and `## Risk` when the plan declares a risk flag or
  `agent-pipeline.txt` lists a flag-requiring signal (otherwise the `## Risk` part is not-applicable). Any
  assumption with risk high and status unverified at freeze was asked through `NEEDS_INPUT` before the freeze
  (`runs/<ID>/LEDGER.log` order, `replies-log.txt` kind `question`). Not-applicable only for a run with no
  high-risk unverified assumption, and only the second sentence.
  Evidence: `runs/<ID>/PLAN.md`, `runs/<ID>/LEDGER.log`, `replies-log.txt`.
- **N-3 Metrics.** [invariant] `metrics/records.jsonl` exists with `step` kinds (always when metrics are on), `run` kinds only once
  the run reached DONE or was terminated (a run stopped awaiting the user has step records only), and `dispatch`
  kinds only when `dispatch.sh` was used (see the lead transcript or `out/`), and a null token
  value is not shown as a number anywhere in it or in `insights.txt`. Not-applicable when `metrics: off`
  (stated in the installed config).
  Evidence: `metrics/records.jsonl`, `insights.txt`, `install.txt`.
- **N-4 Visual focus.** [invariant] COMPLEX only (a UI path is present). The QA gate record carries a `visual` focus
  result: either measured evidence (a visual-proof report whose screenshots are listed with hashes in
  `visual-artifacts.txt`) or an explicit UNSUPPORTED with a reason when no browser or tool exists; never PASS
  without evidence. The completion report lists Unsupported Checks and unverified assumptions.
  Evidence: `runs/<ID>/gates/*.yaml`, `runs/<ID>/results/`, `visual-artifacts.txt`, `lead-*.final.txt`.
- **N-5 No new damage.** [invariant] No new capability changed a file outside PLAN.md `scope:` or wrote to a database
  other than one the test infrastructure created (K-9 stays as written).
  Evidence: `git-status.txt`, `git-untracked.txt`, `db-probe.txt`, `runs/<ID>/PLAN.md`.
- **N-6 Insights read-only.** [invariant] `proofline insights` run against the run directory exited 0 (`summary.txt`
  `insights_exit=0`, output in `insights.txt`) and `agents_hash_before_insights` equals
  `agents_hash_after_insights` in `summary.txt`.
  Evidence: `summary.txt`, `insights.txt`.
