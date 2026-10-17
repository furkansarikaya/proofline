#!/bin/sh
# Builds the llm-wiki fixture in $1: a small repository with a canonical document and a valid wiki under
# docs/wiki (raw/sessions -> sources -> concepts, entity, decision, lesson, index, log, [[wikilinks]]).
# Deterministic and offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $1" >&2; exit 1
fi
w=$1/docs/wiki
mkdir -p "$1/docs/design" "$w/raw/sessions" "$w/sources/architecture" "$w/sources/session" "$w/entities" "$w/concepts" "$w/decisions" "$w/lessons" "$w/archive"
printf '# Architecture\n\nA queue service retries failed jobs with exponential backoff.\n' > "$1/docs/design/ARCHITECTURE.md"
printf '# Session summary: 2026-01-05 JOB-1\n\n- Feature: retry with backoff.\n- Verification: build and tests passed.\n' > "$w/raw/sessions/2026-01-05-job-1.md"
page() { # <path> <title> <status> <source> <body>
  printf -- '---\ntitle: %s\nstatus: %s\nsource: %s\n---\n\n# %s\n\n%s\n' "$2" "$3" "$4" "$2" "$5" > "$w/$1"
}
page sources/architecture/architecture-overview.md architecture-overview current docs/design/ARCHITECTURE.md "Indexes the architecture document.

Related: [[retry-policy]], [[job-queue]]."
page sources/session/2026-01-05-job-1.md 2026-01-05-job-1 current docs/wiki/raw/sessions/2026-01-05-job-1.md "Indexes the JOB-1 session summary.

Related: [[retry-policy]], [[use-backoff]], [[log]]."
page concepts/retry-policy.md retry-policy current docs/design/ARCHITECTURE.md "Failed jobs retry with exponential backoff.

Related: [[architecture-overview]], [[2026-01-05-job-1]], [[use-backoff]], [[job-queue]]."
page entities/job-queue.md job-queue current docs/design/ARCHITECTURE.md "The queue that holds pending jobs.

Related: [[retry-policy]], [[validate-before-enqueue]]."
page decisions/use-backoff.md use-backoff accepted docs/design/ARCHITECTURE.md "Backoff beats a fixed delay for the provider.

Related: [[retry-policy]], [[2026-01-05-job-1]]."
page lessons/validate-before-enqueue.md validate-before-enqueue current docs/design/ARCHITECTURE.md "Validate a job before it is enqueued.

Related: [[job-queue]]."
printf '# Wiki rules\n\nImportant claims have sources. See [[KNOWLEDGE-PIPELINE]].\n' > "$w/CLAUDE.md"
printf '# Knowledge pipeline\n\nTransaction A reads, transaction B writes. See [[index]].\n' > "$w/KNOWLEDGE-PIPELINE.md"
printf '# Wiki index\n\n## Entities\n\n- [[job-queue]]\n\n## Decisions\n\n- [[use-backoff]]\n\n## Lessons\n\n- [[validate-before-enqueue]]\n\n## Concepts\n\n- [[retry-policy]]\n\n## Sources\n\n- [[architecture-overview]]\n- [[2026-01-05-job-1]]\n\nSee [[KNOWLEDGE-PIPELINE]] and [[log]].\n' > "$w/index.md"
printf '# Knowledge log\n\n- 2026-01-05 - JOB-1 session summary ingested. Source: [[2026-01-05-job-1]].\n' > "$w/log.md"
