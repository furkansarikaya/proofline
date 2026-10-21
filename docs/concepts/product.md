# Product documents

Before tasks exist, a product idea can become a product requirements document (PRD) that is checked, reviewed by someone else and only then split into tasks. The `product-spec` skill carries this; the commands are `/proofline product prd|review|split <slug>` and `/proofline trace <FR-n|TASK-ID>`.

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

`trace` follows a requirement or a task through task, criterion, test, run evidence and pull request, from records on disk only. It writes nothing and names every missing link, for example `no test linked`.
