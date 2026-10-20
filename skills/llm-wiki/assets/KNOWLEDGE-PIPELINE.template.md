# Knowledge pipeline

## Transaction A: code

Take the smallest traversal the task needs: [[index]], entity, decision, lesson, concept, source. Freeze the references and the constraints you derived from them in EVIDENCE. Retrieval is read-only here: no filed-back synthesis, no log entry, no index change, no page update. Missing essential knowledge is an amendment and a re-freeze.

## Transaction B: knowledge

The one rule (the proofline control plane's KNOWLEDGE.md): the step always runs after CODE_DONE and evaluates the wiki every time. The outcome is KNOWLEDGE_DONE with pages written, or `not_applicable` with a one-sentence reason the script accepts (it refuses one when the task changed user-visible behaviour, a durable contract or something a design document describes). Run artifacts are disposable and never promoted wholesale. After CODE_DONE:

1. Ingest warranted, sourced knowledge, with the normal review and approval step.
2. Update only the relevant pages and the wiki operation log.
3. Run the lint, resolve its errors, then record KNOWLEDGE_DONE.

A task cannot rewrite its own past; once finished it becomes history for later tasks.
