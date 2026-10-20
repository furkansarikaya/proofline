# Wiki rules

This Git-backed Markdown wiki is a knowledge graph. Current repository state and canonical documentation outrank it.

1. Important claims have sources.
2. Contradictions are explicit, never silently deleted.
3. Relationships are meaningful and run both ways.
4. Only actual ingest or filed-back query operations are logged in [[log]].
5. Outdated pages move to `archive/`; nothing is deleted.
6. One concept or decision generally maps to one page.
7. Explicit task requirements outrank wiki knowledge.
8. A `source:` is a repository file that exists. A task ID is history, not a link: run directories are disposable and are never cited.
9. A contradicted page has `status: contradicted` and a `contradicts:` line.

## Inside a proofline run

Transaction A (code): retrieval is read-only. Follow [[index]], then entity, decision, lesson, concept, source; freeze the references in EVIDENCE; file nothing back and change neither log nor index.

Transaction B (knowledge): runs after every CODE_DONE; the one rule is in [[KNOWLEDGE-PIPELINE]]. Ingest keeps its approval step, the lint reports and never fixes by itself. See [[KNOWLEDGE-PIPELINE]].
