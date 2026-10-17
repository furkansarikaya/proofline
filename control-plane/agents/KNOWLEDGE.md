# Knowledge precedence and read contract

Resolve conflicts in this order: (1) the frozen task, (2) current behaviour and tests, (3) durable design
documents (`design_docs` in config: `docs/design/*` including `DESIGN.md`, ADRs), (4) skill guidance, (5) model
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

The project wiki (A139, skill `llm-wiki`) lives under `docs/wiki/`, which is in `knowledge_scope_root` by default:
a path under that prefix is knowledge work, any other path is implementation scope. Transaction A reads it
only on demand and read-only: `index`, then the entity, decision, lesson, concept and finally the source page,
frozen as references in EVIDENCE, with no filing back, no index or log change. Transaction B ingests warranted,
sourced knowledge, updates only the relevant pages and `log.md`, runs the wiki lint, resolves its errors, then
runs `knowledge-done`. Wiki decisions rank below design documents and above lessons; current tests beat a stale
lesson. A project that keeps no wiki simply never writes under `docs/wiki/`.

Run artifacts (evidence, plans, QA, reviews) are disposable and are never promoted wholesale into
documentation; their summary goes into the completion report.
