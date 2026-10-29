# Weakening the Core invariants

**Status:** Rejected, permanently.

The Core invariants in `CONTRIBUTING.md` are the reason proofline exists:

- A run reaches CODE_DONE only when every required gate passed for the
  current content, or the user explicitly waived it.
- SECRETS and SECURITY are never waivable and run on every round that
  changes product code, dependencies or configuration.
- Approvals and waivers come only from the user's own message. No agent
  produces an approval, a waiver, or a justification that turns a finding
  non-blocking.
- Evidence is reproduced independently; an agent's statement is not
  evidence.
- The agent that wrote a change never reviews it.
- When in doubt, take the safe side: the gate runs, the question is asked,
  the finding stays blocking.

## Not acceptable, even to save time or tokens

- Skipping a gate because "it passed last time" without proving its inputs
  did not change.
- Letting an agent write a design justification, an approval record or a
  waiver on the user's behalf.
- Normalising or filtering evidence broadly enough to hide a real
  difference.
- Turning a failing check green by changing what the check measures,
  without proving it still catches the problem it exists for.

## Instead

Make the slow part faster without removing it: selective re-runs keyed on
input hashes, cached audits, earlier questions, better messages. Every
speed-up records in `docs/decisions.md` which check it accelerates and why
no invariant is relaxed. The invariant test suite in `tests/invariants/`
must keep passing.
