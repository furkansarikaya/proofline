# Knowledge precedence and read contract

Resolve conflicts in this order: (1) the frozen task, (2) current behaviour and tests, (3) durable design
documents (`design_docs` in config: `docs/design/*` including `DESIGN.md`, or the surface documents and the shared base when `design_docs.design` is a mapping; ADRs), (4) skill guidance, (5) model
preference. A task that forbids dependencies beats a skill that recommends one; current tests beat a stale
document.

Read on demand: start with TASK, the repository and its tests; open a design document only when that leaves a
fact unresolved. Freeze references and derived constraints in EVIDENCE, never copied pages. After freeze,
missing information is an amendment, not a new search.

Two transactions:

- **A (code)**: through CODE_DONE; design documents are read-only.
- **B (knowledge)**: one rule (A159). The knowledge step always runs after CODE_DONE (and for a FAILED or
  BLOCKED run). The wiki and the design documents are evaluated every time, and the outcome is exactly one of:
  - `agent.sh knowledge-done <ID>` (KNOWLEDGE_DONE) with the pages written: the lead writes only under
    `knowledge_scope_root` and the `design_docs` paths (the runtime hook allows exactly these in this step and
    nowhere else; with design surfaces that is the shared document and every surface document, `agent.sh design-surface <PATH>`
    names the ones that apply to a changed file); proposed ADRs move from the run's `design/adr/` to `design_docs.adr_dir`.
    For a persuade or experience UI the designer wrote `DESIGN.md` first as the direction contract; here its final
    form is updated from the world as built (patterns used with their reasons, fonts and images in the ledger), so a
    rule is never defended against what was really built.
  - `agent.sh knowledge-done <ID> not_applicable "<reason>"`: one specific sentence on why the wiki and the design
    documents need nothing. The reason is recorded in RUN.yaml and the ledger and shown in the completion report.
    `agent.sh` REFUSES it, naming the signal, when the task changed user-visible behaviour (a command, flag,
    config key, output or error text), a durable contract, or something a design document describes: a
    documentation path in the diff, a contract or data change or a design document named in the frozen PLAN.md,
    or user-visible words in the acceptance criteria. The lead then does the real knowledge step.

The project wiki (A139, skill `llm-wiki`) lives under `docs/wiki/`, which is in `knowledge_scope_root` by default:
a path under that prefix is knowledge work, any other path is implementation scope. Transaction A reads it
only on demand and read-only: `index`, then the entity, decision, lesson, concept and finally the source page,
frozen as references in EVIDENCE, with no filing back, no index or log change. The knowledge step ingests warranted,
sourced knowledge, first checks whether an existing page can be updated before opening a new one (`validate-wiki.mjs <wiki> --similar "<title>"`), updates only the relevant pages and `log.md` (older entries move to `log-archive.md` with `--archive-log`, never deleted), runs the wiki lint (it proposes merging near-duplicate pages; a proposal is not an error), resolves its errors, then
runs `knowledge-done`. Wiki decisions rank below design documents and above lessons; current tests beat a stale
lesson. A project that keeps no wiki simply never writes under `docs/wiki/`.

Run artifacts (evidence, plans, QA, reviews) are disposable and are never promoted wholesale into
documentation; their summary goes into the completion report.

Lesson candidates (`agent.sh lessons`) are derived from the run's gate and finding records and live as rows of one wiki page, `docs/wiki/lessons/observations.md`; a row needs a source that resolves to a gate record or finding, or `knowledge-done` fails. A row becomes a project rule in `AGENTS.md` only through `lessons promote`, which needs the user's recorded `rule:<ID>` approval. Promotion is proposed once the same kind of finding appears in a second run (`repeats=1`). Nothing else writes a rule.

Shortcut debt (A153): `shortcut: <limit>, <when to improve>` comments in code are collected by `agent.sh debt` (grep, read-only). In transaction B, `agent.sh debt page` rewrites the one wiki page `docs/wiki/concepts/shortcut-debt.md` from them; a removed shortcut drops off the page. Observations in an implementer report (`## Observations`) are proposed to the user as new tasks and written to `tasks.dir` by the task author only after the user approves.
