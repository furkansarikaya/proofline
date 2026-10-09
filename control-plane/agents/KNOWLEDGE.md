# Knowledge precedence and read contract

Resolve conflicts in this order: (1) the frozen task, (2) current behaviour and tests, (3) durable design
documents (`design_docs` in config: `DESIGN.md`, `docs/design/*`, ADRs), (4) skill guidance, (5) model
preference. A task that forbids dependencies beats a skill that recommends one; current tests beat a stale
document.

Read on demand: start with TASK, the repository and its tests; open a design document only when that leaves a
fact unresolved. Freeze references and derived constraints in EVIDENCE, never copied pages. After freeze,
missing information is an amendment, not a new search.

Two transactions:

- **A (code)**: through CODE_DONE; design documents are read-only.
- **B (knowledge)**: optional, after CODE_DONE, only when the task changed a durable contract or the
  documented architecture: update the documents under `knowledge_scope_root` (proposed ADRs move from the
  run's `design/adr/` to `design_docs.adr_dir`), then `agent.sh knowledge-done <ID>`. Otherwise
  `agent.sh knowledge-done <ID> not_applicable`.

Run artifacts (evidence, plans, QA, reviews) are disposable and are never promoted wholesale into
documentation; their summary goes into the completion report.
