# Hidden memory and self-modifying skills

**Status:** Rejected.

No vector database, no embedding memory, no separate decision store, no
skill or prompt that rewrites itself between runs.

## Why rejected

Knowledge that cannot be inspected cannot be checked. Self-modifying
instructions drift away from what the user approved.

## Instead

Durable knowledge lives in git, where it can be read and reviewed: the
wiki, ADRs, design documents and AGENTS.md rules. Lessons come only from
run evidence, and a lesson becomes a rule only with the user's approval.
