# Spec review

The reviewer role, focus `spec`. An agent that did not write the PRD reviews it; it reads the PRD, never edits it, and writes `<product.dir>/<slug>/REVIEW.md` from [the template](../assets/REVIEW.template.md). It runs outside any proofline run: there is no `agent.sh submit` and no fingerprint. The final message gives the `verdict:` line and the path.

Run `scripts/check-prd.mjs <slug>` first, then:

1. **Two-engineer test.** Would two engineers who never spoke build the same thing from this PRD? Each place where they would not is a blocking finding.
2. **Scope triple.** List what is in scope, what is explicitly out, and what is dangerously unmentioned (a thing a reader would assume and the PRD never says).
3. **Claim ledger.** Open and check every concrete claim about the repository (file, function, behaviour, number). Record each as `verified` or `unverified`, with the path or the reason.
4. **Metric audit.** Each metric names its event, where it is recorded, and a baseline (or a linked open question).

Verdict: any blocking finding means `do-not-ship`; findings that can be met while the tasks run are `ship-with-conditions` (listed under `## Conditions`); otherwise `ship`.

Rounds: at most 2. After the author revises, review once more (`round: 2`), then stop with the verdict as it stands. A round 2 that is still not `ship` goes back to the user to decide.
