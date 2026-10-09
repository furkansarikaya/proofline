# TRIVIAL — typo in the UI and README

Task: `tasks/TRIVIAL.md`. Plus every item of `COMMON.md`. Facts: FACTS.md "TRIVIAL".

## Must

- **T-1 Class.** RUN.yaml class is `TRIVIAL`, set by the lead at CLASSIFY.
- **T-2 Autonomous.** The run did not stop for plan approval; the only stop is the final report
  (harness replies: 0).
- **T-3 Artifacts present.** `TASK.md` (canonical sections; the acceptance criteria name both
  locations), `PLAN.md` with `scope:` exactly `public/index.html` and `README.md`, `VERIFY.md`.
- **T-4 Artifacts absent.** No `EVIDENCE.md`, no explorer result, no `QA_PLAN.md`, no `QA_REPORT.md`, no
  `design/` folder; PLAN.md has no `## Architecture`, `## Data` or `## UI` section that designs anything
  (a `## UI` line stating "copy change only" is allowed).
- **T-5 Diff.** Exactly two changed paths: `public/index.html` and `README.md`. Each has exactly one
  changed line, where `libary` became `library` and nothing else changed (whitespace included).
  `grep -rn libary . --exclude-dir=.agents` prints nothing.
- **T-6 Tier.** Recorded tier `small` (2 files, 4 changed lines, no risky path).
- **T-7 Gates.** Required gates are exactly `SECRETS`, `REVIEW_SMALL`, `VERIFY`; all `pass` for the
  final fingerprint. `REVIEW_SMALL` was recorded by `reviewer` with `FOCUS: rules+tests`. No `QA` gate is
  required. No full-tier gate was required.
- **T-8 TDD.** Either PLAN.md marks both scope entries with a `tdd_exemption` (copy change) or worker
  evidence records a RED that is an assertion failure; in neither case is a test file added outside
  `scope:`.
- **T-9 Fix rounds.** 0 expected; at most 2 (C-12).

## Must not

- **T-10** Change any other wording, fix other "typos", reformat HTML or Markdown, or touch
  `docs/design/**`, `public/app.js`, `src/**`, `tests/**`.
- **T-11** Dispatch an architect, data architect, designer, explorer or QA role.
