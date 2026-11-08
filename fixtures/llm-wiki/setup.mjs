// Builds the llm-wiki fixture in <target-dir>: a small repository with a canonical document and a valid wiki under
// docs/wiki (raw/sessions -> sources -> concepts, entity, decision, lesson, index, log, [[wikilinks]]).
// Deterministic and offline. usage: node setup.mjs <target-dir>
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  const w = 'docs/wiki';
  f.mkdir('docs/design', `${w}/raw/sessions`, `${w}/sources/architecture`, `${w}/sources/session`, `${w}/entities`, `${w}/concepts`, `${w}/decisions`, `${w}/lessons`, `${w}/archive`);
  f.w('docs/design/ARCHITECTURE.md', '# Architecture\n\nA queue service retries failed jobs with exponential backoff.\n');
  f.w(`${w}/raw/sessions/2026-01-05-job-1.md`, '# Session summary: 2026-01-05 JOB-1\n\n- Feature: retry with backoff.\n- Verification: build and tests passed.\n');
  const page = (/** @type {string} */ p, /** @type {string} */ title, /** @type {string} */ status, /** @type {string} */ source, /** @type {string} */ body) =>
    f.w(`${w}/${p}`, `---\ntitle: ${title}\nstatus: ${status}\nsource: ${source}\n---\n\n# ${title}\n\n${body}\n`);
  page('sources/architecture/architecture-overview.md', 'architecture-overview', 'current', 'docs/design/ARCHITECTURE.md', 'Indexes the architecture document.\n\nRelated: [[retry-policy]], [[job-queue]].');
  page('sources/session/2026-01-05-job-1.md', '2026-01-05-job-1', 'current', 'docs/wiki/raw/sessions/2026-01-05-job-1.md', 'Indexes the JOB-1 session summary.\n\nRelated: [[retry-policy]], [[use-backoff]], [[log]].');
  page('concepts/retry-policy.md', 'retry-policy', 'current', 'docs/design/ARCHITECTURE.md', 'Failed jobs retry with exponential backoff.\n\nRelated: [[architecture-overview]], [[2026-01-05-job-1]], [[use-backoff]], [[job-queue]].');
  page('entities/job-queue.md', 'job-queue', 'current', 'docs/design/ARCHITECTURE.md', 'The queue that holds pending jobs.\n\nRelated: [[retry-policy]], [[validate-before-enqueue]].');
  page('decisions/use-backoff.md', 'use-backoff', 'accepted', 'docs/design/ARCHITECTURE.md', 'Backoff beats a fixed delay for the provider.\n\nRelated: [[retry-policy]], [[2026-01-05-job-1]].');
  page('lessons/validate-before-enqueue.md', 'validate-before-enqueue', 'current', 'docs/design/ARCHITECTURE.md', 'Validate a job before it is enqueued.\n\nRelated: [[job-queue]].');
  f.w(`${w}/CLAUDE.md`, '# Wiki rules\n\nImportant claims have sources. See [[KNOWLEDGE-PIPELINE]].\n');
  f.w(`${w}/KNOWLEDGE-PIPELINE.md`, '# Knowledge pipeline\n\nTransaction A reads, transaction B writes. See [[index]].\n');
  f.w(`${w}/index.md`, '# Wiki index\n\n## Entities\n\n- [[job-queue]]\n\n## Decisions\n\n- [[use-backoff]]\n\n## Lessons\n\n- [[validate-before-enqueue]]\n\n## Concepts\n\n- [[retry-policy]]\n\n## Sources\n\n- [[architecture-overview]]\n- [[2026-01-05-job-1]]\n\nSee [[KNOWLEDGE-PIPELINE]] and [[log]].\n');
  f.w(`${w}/log.md`, '# Knowledge log\n\n- 2026-01-05 - JOB-1 session summary ingested. Source: [[2026-01-05-job-1]].\n');
}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });
