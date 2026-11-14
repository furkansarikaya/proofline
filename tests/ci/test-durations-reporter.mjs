// @ts-check
// The machine-readable reporter of tests/ci/test-durations.mjs (issue 266, A277): one JSON line per finished test or suite, with the duration Node measured.
// `node --test --test-reporter=tests/ci/test-durations-reporter.mjs --test-reporter-destination=stdout <files>`. It reads no clock; the milliseconds are Node's own.
import path from 'node:path';

/**
 * The line of one runner event, or null for an event that is not a finished test. @param {{ type: string, data?: any }} event @param {string} cwd
 * @returns {string | null}
 */
export function lineOf(event, cwd) {
  if (event.type !== 'test:pass' && event.type !== 'test:fail') return null;
  const d = event.data ?? {};
  const det = d.details ?? {};
  const outcome = event.type === 'test:fail' ? 'fail' : d.skip !== undefined && d.skip !== false ? 'skip' : d.todo !== undefined && d.todo !== false ? 'todo' : 'pass';
  const file = typeof d.file === 'string' ? (path.isAbsolute(d.file) ? path.relative(cwd, d.file) : d.file).split(path.sep).join('/') : '';
  return `${JSON.stringify({ file, name: String(d.name ?? ''), nesting: Number(d.nesting ?? 0), ms: Number(det.duration_ms ?? 0), outcome, suite: det.type === 'suite' })}\n`;
}

/** @param {AsyncIterable<{ type: string, data?: any }>} source */
export default async function* report(source) {
  const cwd = process.cwd();
  for await (const event of source) {
    const l = lineOf(event, cwd);
    if (l !== null) yield l;
  }
}
