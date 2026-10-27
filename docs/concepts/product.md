# Product documents

Before tasks exist, a product idea can become a product requirements document (PRD) that is checked, reviewed by someone else and only then split into tasks. The `product-spec` skill carries this; the commands are `/proofline product prd|review|split <slug>` and `/proofline trace <FR-n|TASK-ID>`. Before the PRD, the `product-discovery` skill (`product discover`) and the `product-assess` skill (`product assess`, `product outcome`) collect and test the evidence the PRD cites.

Files live in `<product.dir>/<slug>/` (config `product.dir`, default `docs/product`): `PRD.md` and `REVIEW.md`. The folder is inside the default `knowledge_scope_root`, so the knowledge step may write it.

## Evidence model

Every claim carries one marker: a fact with its source (web page with access date and quote, interview quote, or data with the query and the hash of its output), an assumption with its risk type (value, usability, viability, feasibility), or a decision with who made it and why. What nobody knows goes to the assumptions or the open questions, never into the body as fact. Details: `skills/product-spec/references/EVIDENCE.md`.

**Never invent a fact; always propose.** The ban covers facts (a number, a quote, a competitor feature, a regulation). The skills must also bring candidate assumptions, risks, opportunities, competitors to examine, edge cases, alternative solutions and questions nobody asked. Each is a proposal, `[proposal: assumption|risk|opportunity|competitor|edge-case|alternative|question]`, shown in the conversation. You accept it (it is written as `[assumption: <risk> source agent accepted by user]`, or `changed by user`), or reject it (a line `- RP-<n> <proposal> rejected by user: <reason>` under `## Rejected proposals`). A pending `[proposal: ...]` in a finished file is an error. A number in an assumption is allowed as an estimate with a basis: `[assumption: value estimate "<basis>"]`; a number with no source is never a fact.

**Minimum contribution, counted by the checkers.** `ASSUMPTIONS.md` holds at least 5 assumptions you did not state, `PREMORTEM.md` at least 5 risks you did not state (`; source: agent accepted by user`), and the spec review lists at least 3 topics the PRD never mentions. Accepted and rejected proposals both count: the agent does its part, the decision stays yours.

**Quality bar.** Before any document is shown, the skill checks itself against five questions (`references/QUALITY-BAR.md`, the same in the three product skills): concrete (swap the product name for a competitor's; if the sentence is still true it is generic), every fact sourced, tells you something new, states the unknowns, has a "so what?". The spec reviewer and the red team use the same rubric. `references/EXAMPLES.md` of each skill shows a shallow and a good example per document.

When questions are independent, the skills ask up to three in one message, with lettered options and a recommended answer ("1A, 2C").

## PRD

`product prd` is an interview in the main session, like `task --grill`. It writes problem, goals, non-goals, user stories with measurable acceptance criteria, `FR-n` and `NFR-n` requirements, a completeness list, metrics with their baseline, assumptions and open questions (blocking or not). The PRD stays plain, and still answers ten topics in one line each: error and empty states, permissions and roles, personal data and retention, security, performance, accessibility, multilingual, analytics events, rollout and migration, dependencies. A topic names the id that covers it, or is closed with `not applicable to this project` (rule `completeness`). `check-prd.mjs` must exit 0 before the PRD is shown for approval. Words that make a criterion unmeasurable are flagged; add your own in `product.vague_words` (comma-separated).

## Review

`product review` runs the reviewer with focus `spec` on an agent that did not write the PRD. It asks whether two engineers who never spoke would build the same thing, sorts the scope into in and explicitly out, checks the PRD against the completeness list and lists at least three topics the PRD never mentions, opens every claim about the repository and records it as verified or unverified, audits the metrics and applies the quality bar. It writes `REVIEW.md` with one line, `verdict: ship`, `ship-with-conditions` or `do-not-ship`. `check-review.mjs` checks the file. At most two rounds.

## Readiness gate

`check-prd.mjs --ready <slug>` exits 0 only when the PRD check is clean, the verdict is `ship` or `ship-with-conditions`, the review check is clean, and no blocking open question is left. Otherwise it prints one reason per failed condition and nothing is split.

## Split

`product split` lets task-author split the PRD into tasks, each criterion naming the `FR-n`/`NFR-n` it covers. `check-coverage.mjs` then confirms that every requirement is covered or deferred.

## Trace

`trace` follows a requirement or a task through task, criterion, test, run evidence and pull request, and from an `FR-n` through the facts that use `ref` to the claim, assumption, probe, decision and outcome, from records on disk only. It writes nothing and names every missing link, for example `no test linked`.

## Discovery

`product discover frame|research|interviews|competitors|opportunities <slug>` is an interview in the main session. It writes `FRAME.md`, `RESEARCH.md`, `INTERVIEWS.md`, `COMPETITORS.md` and `OPPORTUNITIES.md` into `<product.dir>/<slug>/`, each only after its checker (`check-research.mjs`, `check-quotes.mjs`, `check-competitors.mjs`, `check-opportunities.mjs`, `check-insights.mjs`) exits 0 and you approve. With web tools every fact has a URL, an access date and a verbatim quote; without them only assumptions are written, and the skill says so. A number, percent, money amount or market size that is neither a valid sourced fact nor an estimate with a basis is rejected (`unsourced-number`). A persona needs a source.

- **Research method.** `RESEARCH.md` starts with a search plan written before the search (`SQ-n`: question, queries, source types: official docs, pricing pages, changelogs, regulation, user reviews, forums, job postings, interviews, data). A claim the decision rests on is tagged `(critical; second source: C-m)` and needs a second fact from an independent source. Web facts older than `product.stale_days` are reported `stale`. The file ends with what was searched and not found. Method: `skills/product-discovery/references/RESEARCH-METHOD.md`.
- **Competitors.** A competitor cell is `value | source URL | observed YYYY-MM-DD | "quote"`, or empty when it cannot be verified; a cell older than `product.stale_days` (default 90) is reported as `stale`. Beyond the table, each competitor has a profile (who it sells to, its positioning in its own words, pricing model, what users praise and complain about from sourced reviews, switching cost) and the file ends with the implications for us.
- **Opportunities.** Each opportunity cites evidence. The ranking has no scores: evidence strength, affected users (sourced or an estimate with a basis), fit with the goal and rough effort, with reasons for the top three. The decision stays yours.
- **So what?** `RESEARCH.md`, `INTERVIEWS.md`, `COMPETITORS.md` and `OPPORTUNITIES.md` each end with 3 to 7 insights: the observation, the ids it rests on and what it changes in the decision of `FRAME.md`. `check-insights.mjs` rejects a set with no insights, an insight without evidence ids or without an implication.

**Interviews.** Questions are open and not leading. `INTERVIEWS.md` holds the synthesis under anonymous ids (`INT-n`); the raw text lives only in `.agents/local/product-discovery/<slug>/interviews/INT-n.txt`, next to a `.gitignore` containing `*`, and never in git. `check-quotes.mjs` confirms every quote occurs verbatim in the raw text it cites (a missing raw file is unverifiable and fails), and `--privacy` fails when raw text is tracked or not ignored.

## Evidence ids and the ref marker

Lines start `- <ID> <text> <marker>`. Ids are unique per slug: `C-n` claim, `INT-n` interview, `OP-n` opportunity, `S-n` solution, `AS-n` assumption, `PB-n` probe, `RK-n` premortem risk, `DEC-n` decision, `OC-n` outcome. A PRD or any document cites a claim as `[fact: ref <slug>#C-3]`. That is a valid fact only when a line `- C-3 ` of `<product.dir>/<slug>/*.md` carries a valid fact marker itself; a reference to a missing id or to an assumption is an error.

## Assessment

`product assess assumptions|probes|premortem|redteam|decision <slug>` writes `ASSUMPTIONS.md`, `PROBES.md`, `PREMORTEM.md`, `REDTEAM.md` and `DECISION.md`.

- **Assumptions** have one of four risk types (value, usability, viability, feasibility), an importance and an evidence level, both `high|medium|low`. A numeric score is rejected. The riskiest assumption (`riskiest: yes`) has high importance and low evidence. A number in the statement is an estimate with a basis. At least 5 assumptions come from the agent (accepted, or listed as rejected).
- **Probes** state success and failure thresholds before they run; the agent proposes a threshold with its basis and you accept or change it before it is locked. `check-probes.mjs --lock PB-n` writes a timestamp and the sha256 of the normalised thresholds. A result without a lock is rejected, and so is a result whose thresholds hash differently, also against the earliest committed version in git. Thresholds are never set after the result.
- **Premortem** risks are each `real`, `overstated` or `unspoken`, and have a response. At least 5 risks come from the agent (`source: agent accepted by user`, or listed as rejected).
- **Red team** is the reviewer role with focus `strategy` on an agent that did not write the plan. It restates each most-trusted assumption at its strongest, then attacks it; at most 2 rounds.
- **Decision** is one effective line `decision: build|clarify|stop` (the last wins) plus Context, Decision, Consequences and Rejected sections.

## Stop gate

`check-prd.mjs --ready <slug>` refuses the split and prints the reason when `<slug>/DECISION.md` exists with the effective decision `stop`. Without a `DECISION.md` the behaviour is unchanged.

## Outcome

`product outcome <slug>` records, per `OC-n`, the PRD metric id, the baseline, the measuring script with its sha256, the output file (`outcome/<OC-n>.out`) with its sha256, the recorded value, a result (`reached|not-reached|inconclusive`) and a follow-up (`continue|change|drop`). `check-outcome.mjs` rejects a value that differs from the one in the output file or a hash that does not match; `--rerun` runs the script with a timeout and compares the hash. `reached` must follow from baseline and target. The outcome becomes a lesson candidate in the wiki only with your approval (A149).

## Stale evidence

`product.stale_days` (default 90, a positive integer) sets the age after which an observed competitor cell is reported as stale.
