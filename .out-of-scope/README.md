# Out of scope

This folder records what proofline deliberately does **not** do, and ideas
that are parked for later. It exists so that a future change, whoever or
whatever writes it, does not quietly grow proofline past its purpose.

proofline's purpose: an evidence-first engineering workflow. No claim is
accepted without evidence; independent roles check each other; the user
approves anything irreversible.

## How to use this folder

- Before proposing or implementing a feature, check whether it matches an
  entry here.
- If it matches a **Rejected** entry: stop. Do not implement it. Tell the
  user which entry it matches and why it was rejected.
- If it matches a **Deferred** entry: do not implement it as a side effect
  of other work. Mention the entry and its revisit condition.
- An entry changes only by an explicit user decision, recorded in
  `docs/decisions.md`, and the entry itself is updated in the same pull
  request.
- These entries complement the Core invariants in `CONTRIBUTING.md`; they
  never relax them.

## Index

| Entry | Status |
|---|---|
| [weakening-core-invariants.md](weakening-core-invariants.md) | Rejected |
| [new-roles-and-agents.md](new-roles-and-agents.md) | Rejected |
| [agents-that-deploy.md](agents-that-deploy.md) | Rejected |
| [merging-without-verification.md](merging-without-verification.md) | Rejected |
| [model-invoked-skills.md](model-invoked-skills.md) | Rejected |
| [numeric-scores.md](numeric-scores.md) | Rejected |
| [theme-catalogs.md](theme-catalogs.md) | Rejected |
| [hidden-memory-and-self-modifying-skills.md](hidden-memory-and-self-modifying-skills.md) | Rejected |
| [installing-or-removing-tools.md](installing-or-removing-tools.md) | Rejected |
| [ecosystem-specific-code.md](ecosystem-specific-code.md) | Rejected |
| [forcing-project-structure.md](forcing-project-structure.md) | Rejected |
| [blocking-other-skills.md](blocking-other-skills.md) | Rejected |
| [third-party-content.md](third-party-content.md) | Rejected |
| [content-seo-and-analytics.md](content-seo-and-analytics.md) | Rejected |
| [separate-session-night-driver.md](separate-session-night-driver.md) | Rejected |
| [small-rejected-ideas.md](small-rejected-ideas.md) | Rejected |
| [deferred.md](deferred.md) | Deferred |
