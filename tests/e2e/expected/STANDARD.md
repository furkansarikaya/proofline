# STANDARD — books on the last page are unreachable

Task: `tasks/STANDARD.md`. Plus every item of `COMMON.md`. Facts: FACTS.md "STANDARD".

## Must

- **S-1 Class.** [invariant] RUN.yaml class is `STANDARD`.
- **S-2 Autonomous.** [invariant] No plan-approval stop; harness replies: 0 (unless a `NEEDS_INPUT` round happened,
  which C-14 allows).
- **S-3 Root cause.** [invariant] The fix is in `src/service.js` `paginate`: total pages are rounded up and an empty
  list stays page 1 of 1. Checked by running, on the final tree:
  `paginate(12, 2, 10)` → `{ page: 2, pageSize: 10, totalPages: 2, offset: 10 }`,
  `paginate(0, 1, 10)` → `{ page: 1, pageSize: 10, totalPages: 1, offset: 0 }`,
  `paginate(20, 5, 10).page` → `2`.
- **S-4 Symptom gone.** [invariant] On the seeded DB, `GET /api/books?page=2` returns `page 2`, `totalPages 2` and
  exactly `Neuromancer`, `Dune`; `GET /api/books` returns `totalPages 2`.
- **S-5 Regression test.** [invariant] At least one new test fails on the baseline `src/service.js` with an assertion
  error (not a syntax/import error) and passes on the final tree. Check: copy the final `tests/` over a
  baseline checkout and run `npm test`.
- **S-6 Artifacts present.** [invariant] `TASK.md` (acceptance criteria observable from the user's side, e.g. "with
  12 books and the default page size, page 2 lists the 2 oldest books"), `EVIDENCE.md` whose claims are
  `path:symbol` and include `src/service.js:paginate`, `QA_PLAN.md` written before IMPLEMENT (ledger
  order), `QA_REPORT.md`, `PLAN.md`, `reports/NNN-debug.md` (debug-proof: reproduction, root cause
  `paginate` rounding down, the regression test), worker evidence with RED (assertion failure) before
  GREEN, `VERIFY.md`.
- **S-7 Artifacts absent.** [invariant] No `## Architecture` and no `## Data` in PLAN.md; no architect, data
  architect or designer result.
- **S-8 Diff.** [invariant] Changed paths are `src/service.js` and test files under `tests/` only. In
  `src/service.js` only `paginate` changed.
- **S-9 Tier and gates.** [invariant] Tier `small` when the diff is ≤ 2 files and ≤ 30 lines, otherwise `full`.
  Required gates: `SECRETS`, `QA` (by `qa`), `VERIFY`, plus `REVIEW_SMALL` (tier small) or
  `REVIEW_PLAN`, `REVIEW_RULES`, `REVIEW_TESTS`, `SECURITY` (tier full). No `REVIEW_DATA`. All `pass`.
- **S-10 Contract unchanged.** [invariant] The response shape of `GET /api/books` (`items`, `page`, `pageSize`,
  `total`, `totalPages`) and `docs/design/API.md` are unchanged.
- **S-11 Report.** [quality] The completion report states the root cause in one sentence naming `paginate`, the
  regression test, and the gates; it says commit and push await approval.

## Must not

- **S-12** [invariant] Change `public/app.js`, `src/routes.js`, `src/repository.js`, `migrations/`, `seed/`,
  `docs/` or any decoy.
- **S-13** [invariant] Fix the symptom only (e.g. always enabling Next, or clamping in `routes.js`).
- **S-14** [invariant] Change the default page size, the page-size cap, the sort order, or existing tests'
  assertions (adding tests is fine).
