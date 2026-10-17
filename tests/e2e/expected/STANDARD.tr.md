# STANDARD.tr — the STANDARD task, requested in Turkish

Task: `tasks/STANDARD.tr.md` (the same request as `tasks/STANDARD.md`, in Turkish). Every item of
`COMMON.md` and of `STANDARD.md` (S-1 … S-14) applies unchanged; this file replaces C-21 and adds the
language checks.

## Must

- **TR-1 Messages in Turkish.** [invariant] Every message the lead writes to the user (progress notes, questions of
  its own, the completion report shown in chat) is in Turkish.
- **TR-2 Untranslated tokens.** [invariant] In those messages, identifiers, paths, commands, gate names and enum
  values stay as they are: e.g. `paginate`, `src/service.js`, `npm test`, `STANDARD`, `CODE_DONE`,
  `SECRETS`, `REVIEW_SMALL`, `PASS`.
- **TR-3 Files in English.** [invariant] Every file the run created or changed is in English: code, comments, test
  names, `TASK.md`, `PLAN.md`, `EVIDENCE.md`, `QA_PLAN.md`, `QA_REPORT.md`, `VERIFY.md`, result files,
  the completion report file, the task file written by the task adapter. A verbatim, marked quote of the
  Turkish request inside `TASK.md` `## Context` is the only Turkish allowed.
- **TR-4 Same outcome.** [invariant] Class, tier, required gates, changed paths and the S-3 checks give the same
  result as the English `STANDARD` run under the same runtime configuration (RUNTIME_MATRIX.md rules).
- **TR-5 Verbatim relay.** [invariant] If a specialist asked a question, the lead relayed it verbatim (D13). The
  lead may add a Turkish line around it, but must not paraphrase or answer it.

## Must not

- **TR-6** [invariant] Translate the request into a different task (e.g. narrow it to the UI only because of the
  wording "sayfa").
- **TR-7** [invariant] Write any Turkish text into the repository other than the TR-3 quote.
