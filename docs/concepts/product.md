# Product documents

Before tasks exist, a product idea can become a product requirements document (PRD) that is checked, reviewed by someone else and only then split into tasks. The `product-spec` skill carries this; the commands are `/proofline product prd|review|split <slug>` and `/proofline trace <FR-n|TASK-ID>`. Before the PRD, the `product-discovery` skill (`product discover`) and the `product-assess` skill (`product assess`, `product outcome`) collect and test the evidence the PRD cites.

Files live in `<product.dir>/<slug>/` (config `product.dir`, default `docs/product`): `PRD.md` and `REVIEW.md`. The folder is inside the default `knowledge_scope_root`, so the knowledge step may write it.

## Evidence model

Every claim carries one marker: a fact with its source (web page with access date and quote, interview quote, or data with the query and the hash of its output), an assumption with its risk type (value, usability, viability, feasibility), or a decision with who made it and why. What nobody knows goes to the assumptions or the open questions, never into the body as fact. Details: `skills/product-spec/references/EVIDENCE.md`.

## PRD

`product prd` is an interview in the main session, like `task --grill`. It writes problem, goals, non-goals, user stories with measurable acceptance criteria, `FR-n` and `NFR-n` requirements, metrics with their baseline, assumptions and open questions (blocking or not). `check-prd.mjs` must exit 0 before the PRD is shown for approval. Words that make a criterion unmeasurable are flagged; add your own in `product.vague_words` (comma-separated).

## Review

`product review` runs the reviewer with focus `spec` on an agent that did not write the PRD. It asks whether two engineers who never spoke would build the same thing, sorts the scope into in, explicitly out and dangerously unmentioned, opens every claim about the repository and records it as verified or unverified, and audits the metrics. It writes `REVIEW.md` with one line, `verdict: ship`, `ship-with-conditions` or `do-not-ship`. At most two rounds.

## Readiness gate

`check-prd.mjs --ready <slug>` exits 0 only when the PRD check is clean, the verdict is `ship` or `ship-with-conditions`, and no blocking open question is left. Otherwise it prints one reason per failed condition and nothing is split.

## Split

`product split` lets task-author split the PRD into tasks, each criterion naming the `FR-n`/`NFR-n` it covers. `check-coverage.mjs` then confirms that every requirement is covered or deferred.

## Trace

`trace` follows a requirement or a task through task, criterion, test, run evidence and pull request, and from an `FR-n` through the facts that use `ref` to the claim, assumption, probe, decision and outcome, from records on disk only. It writes nothing and names every missing link, for example `no test linked`.

## Discovery

`product discover frame|research|interviews|competitors|opportunities <slug>` is an interview in the main session. It writes `FRAME.md`, `RESEARCH.md`, `INTERVIEWS.md`, `COMPETITORS.md` and `OPPORTUNITIES.md` into `<product.dir>/<slug>/`, each only after its checker (`check-research.mjs`, `check-quotes.mjs`, `check-competitors.mjs`, `check-opportunities.mjs`) exits 0 and you approve. With web tools every fact has a URL, an access date and a verbatim quote; without them only assumptions are written, and the skill says so. A number, percent, money amount or market size that is not a valid sourced fact is rejected (`unsourced-number`). A persona needs a source. A competitor cell is `value | source URL | observed YYYY-MM-DD | "quote"`, or empty when it cannot be verified; a cell older than `product.stale_days` (default 90) is reported as `stale`.

**Interviews.** Questions are open and not leading. `INTERVIEWS.md` holds the synthesis under anonymous ids (`INT-n`); the raw text lives only in `.agents/local/product-discovery/<slug>/interviews/INT-n.txt`, next to a `.gitignore` containing `*`, and never in git. `check-quotes.mjs` confirms every quote occurs verbatim in the raw text it cites (a missing raw file is unverifiable and fails), and `--privacy` fails when raw text is tracked or not ignored.

## Evidence ids and the ref marker

Lines start `- <ID> <text> <marker>`. Ids are unique per slug: `C-n` claim, `INT-n` interview, `OP-n` opportunity, `S-n` solution, `AS-n` assumption, `PB-n` probe, `RK-n` premortem risk, `DEC-n` decision, `OC-n` outcome. A PRD or any document cites a claim as `[fact: ref <slug>#C-3]`. That is a valid fact only when a line `- C-3 ` of `<product.dir>/<slug>/*.md` carries a valid fact marker itself; a reference to a missing id or to an assumption is an error.

## Assessment

`product assess assumptions|probes|premortem|redteam|decision <slug>` writes `ASSUMPTIONS.md`, `PROBES.md`, `PREMORTEM.md`, `REDTEAM.md` and `DECISION.md`.

- **Assumptions** have one of four risk types (value, usability, viability, feasibility), an importance and an evidence level, both `high|medium|low`. A numeric score is rejected. The riskiest assumption (`riskiest: yes`) has high importance and low evidence.
- **Probes** state success and failure thresholds before they run. `check-probes.mjs --lock PB-n` writes a timestamp and the sha256 of the normalised thresholds. A result without a lock is rejected, and so is a result whose thresholds hash differently, also against the earliest committed version in git. Thresholds are never set after the result.
- **Premortem** risks are each `real`, `overstated` or `unspoken`, and have a response.
- **Red team** is the reviewer role with focus `strategy` on an agent that did not write the plan. It restates each most-trusted assumption at its strongest, then attacks it; at most 2 rounds.
- **Decision** is one effective line `decision: build|clarify|stop` (the last wins) plus Context, Decision, Consequences and Rejected sections.

## Stop gate

`check-prd.mjs --ready <slug>` refuses the split and prints the reason when `<slug>/DECISION.md` exists with the effective decision `stop`. Without a `DECISION.md` the behaviour is unchanged.

## Outcome

`product outcome <slug>` records, per `OC-n`, the PRD metric id, the baseline, the measuring script with its sha256, the output file (`outcome/<OC-n>.out`) with its sha256, the recorded value, a result (`reached|not-reached|inconclusive`) and a follow-up (`continue|change|drop`). `check-outcome.mjs` rejects a value that differs from the one in the output file or a hash that does not match; `--rerun` runs the script with a timeout and compares the hash. `reached` must follow from baseline and target. The outcome becomes a lesson candidate in the wiki only with your approval (A149).

## Stale evidence

`product.stale_days` (default 90, a positive integer) sets the age after which an observed competitor cell is reported as stale.
