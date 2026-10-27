# Spec review

The reviewer role, focus `spec`. An agent that did not write the PRD reviews it; it reads the PRD, never edits it, and writes `<product.dir>/<slug>/REVIEW.md` from [the template](../assets/REVIEW.template.md). It runs outside any proofline run: there is no `agent.sh submit` and no fingerprint. The final message gives the `verdict:` line and the path.

Run `scripts/check-prd.mjs <slug>` first, then:

1. **Two-engineer test.** Would two engineers who never spoke build the same thing from this PRD? Each place where they would not is a blocking finding.
2. **Scope and completeness.** List what is in scope and what is explicitly out. Then check the PRD against the completeness list (error and empty states, permissions and roles, personal data and retention, security, performance, accessibility, multilingual, analytics events, rollout and migration, dependencies): write one line per topic in `## Completeness` as `covered`, `missing` or `not applicable`. A topic closed with "not applicable to this project" needs a plausible reason; say when it has none.
3. **Dangerously unmentioned.** In `## Never mentioned` list at least three topics a reader would assume and the PRD never says: the missing topics of the list first, then edge cases of the stories, a user or role nobody named, a failure that nobody planned for. The reviewer contributes here; do not stop at what the author already wrote.
4. **Claim ledger.** Open and check every concrete claim about the repository (file, function, behaviour, number). Record each as `verified` or `unverified`, with the path or the reason.
5. **Metric audit.** Each metric names its event, where it is recorded, and a baseline (or a linked open question).
6. **Quality bar.** Hold the PRD to [QUALITY-BAR.md](QUALITY-BAR.md): concrete (swap the product name for a competitor's: still true means generic), sourced, new, unknowns stated, so what. Write one line per question in `## Quality bar`; a failed one names the line.

Run `scripts/check-review.mjs <slug>` before you finish: it checks the verdict line, the ten completeness answers and the three topics.

Verdict: any blocking finding means `do-not-ship`; findings that can be met while the tasks run are `ship-with-conditions` (listed under `## Conditions`); otherwise `ship`.

Rounds: at most 2. After the author revises, review once more (`round: 2`), then stop with the verdict as it stands. A round 2 that is still not `ship` goes back to the user to decide.
