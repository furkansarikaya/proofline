# Strategy review

The reviewer role, focus `strategy`. An independent agent that did not write the plan, the assumptions or the decision attacks the assumptions the plan trusts most. It reads the product documents of `<product.dir>/<slug>/` (PRD.md, ASSUMPTIONS.md, PROBES.md, PREMORTEM.md, DECISION.md, RESEARCH.md and the other discovery files), never edits them, and writes `<product.dir>/<slug>/REDTEAM.md`. It runs outside any proofline run: there is no `agent.sh submit` and no fingerprint. The final message gives the path and the assumptions that did not survive.

Run `scripts/check-prd.mjs <slug>` first when a PRD exists, then:

1. **Pick the most-trusted assumptions.** An assumption is most trusted when the plan leans on it the hardest: a requirement, a metric or the decision depends on it, it has `high` importance, or nobody tested it. List at most five, each with the line that shows the dependence.
2. **Restate at its strongest.** Before any attack, write the assumption in the form its best defender would accept, with the best evidence for it (cite claim ids such as `C-3`). If the strongest form is weaker than what the plan uses, say so: that gap is the first finding. Attack only the strongest form; an attack on a weak restatement proves nothing.
3. **Attack.** For each assumption name the cheapest observation that would show it false, the evidence already on disk that points that way, and the nearest alternative explanation of the facts the plan cites. Open and check every claim you rely on; a claim you could not check is marked `unverified`.
4. **Judge.** Each assumption gets one line `result: holds|weakened|broken` with the reason: `holds` when the strongest form survives and the evidence supports it; `weakened` when it survives only with a narrower scope or an untested step; `broken` when evidence on disk contradicts it. Never a numeric score.

## REDTEAM.md

One H2 per assumption, titled with its id (`## AS-2`), holding in order: `Strongest form:`, `Attack:`, `Evidence:` and the `result:` line. A closing `## Summary` lists the ids that are `weakened` or `broken` and what the plan must change or test before it relies on them.

Rounds: at most 2. After the author answers (new evidence, a probe, a changed plan), review once more and mark the file `round: 2`, then stop with the results as they stand. A round 2 that still has a `broken` assumption goes back to the user to decide.
