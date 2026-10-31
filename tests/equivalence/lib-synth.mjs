// @ts-check
// Synthetic sides for the rig's own tests: a consistent run folder whose times, chain hashes and bindings follow from one start time.
import { sha256 } from './normalise.mjs';

const iso = (/** @type {number} */ t) => new Date(t * 1000).toISOString().slice(0, 19) + 'Z';
const RUN = '.agents/runs/LC';

/** @param {number} t0 epoch seconds of the first event; every other time is a fixed offset from it */
export function synthSide(t0, /** @type {{ ledger?: (l: Record<string, any>[]) => void, files?: (f: Record<string, string>) => void }} */ tweak = {}) {
  /** @type {Record<string,string>} */ const f = {};
  f[`${RUN}/gates/001-QA.yaml`] = `gate: "QA"\nresult: "PASS"\ntimestamp: "${iso(t0 + 2)}"\n`;
  f[`${RUN}/approvals/001-request-push.yaml`] = `kind: "push"\nbound: "abc"\nrequested_at: ${t0 + 3}\n`;
  f[`${RUN}/approvals/001-push.yaml`] = `kind: "push"\ncapture_time: 4000000000\nrequest: "001-request-push.yaml"\napproved_at: ${t0 + 5}\nconsumed: "true"\nconsumed_at: ${t0 + 6}\n`;
  f[`${RUN}/questions/001.md`] = `from: lead\nasked_at: ${t0 + 7}\n---\nwhy?\n`;
  f[`${RUN}/questions/001.answer.md`] = `answered_by: user\ntime: ${iso(t0 + 8)}\nanswered_epoch: ${t0 + 8}\n---\nbecause\n`;
  f[`${RUN}/waivers/001-F1.yaml`] = `finding: "F1"\ngate_record: "001-QA.yaml"\ngate_record_sha256: "${sha256(f[`${RUN}/gates/001-QA.yaml`])}"\ntimestamp: "${iso(t0 + 9)}"\n`;
  f[`${RUN}/decisions/001-qa.decision`] = `runtime=claude\ndecided_at=${t0 + 10}\n`;
  /** @type {Record<string, any>[]} */
  const l = [
    { event: 'start', epoch: t0, detail: 'task=tasks/LC.md' },
    { event: 'gate:QA', epoch: t0 + 2, detail: `gates/001-QA.yaml@${sha256(f[`${RUN}/gates/001-QA.yaml`])}` },
    { event: 'waive', epoch: t0 + 9, detail: `waivers/001-F1.yaml@${sha256(f[`${RUN}/waivers/001-F1.yaml`])} F1` },
    { event: 'decide', epoch: t0 + 11, detail: '001-qa.decision runtime=claude' },
  ];
  tweak.files?.(f); tweak.ledger?.(l);
  return { f, l };
}

/** Render the ledger the way ledger_append does (the chain hashes follow from the lines) and build a Side. */
export function toSide(/** @type {ReturnType<typeof synthSide>} */ s, /** @type {[number, number]} */ window, /** @type {Partial<import('./normalise.mjs').Side>} */ over = {}) {
  /** @type {string[]} */ const lines = [];
  s.l.forEach((e, i) => {
    const prev = i === 0 ? 'genesis' : sha256(lines[i - 1]);
    lines.push(e.raw ?? `seq=${i + 1} prev=${e.prev ?? prev} event=${e.event} role=lead from=- to=- digest=${e.digest ?? 'd1'} ts=${e.ts ?? iso(e.epoch)} epoch=${e.epochText ?? e.epoch} detail=${e.detail}`);
  });
  /** @type {Map<string, import('./normalise.mjs').FileEntry>} */ const files = new Map();
  for (const [p, c] of Object.entries(s.f)) files.set(p, { mode: 0o644, data: Buffer.from(c) });
  files.set(`${RUN}/LEDGER.log`, { mode: 0o644, data: Buffer.from(lines.join('\n') + '\n') });
  return { outputs: [{ code: 0, stdout: 'ok\n', stderr: '' }], files, window, ...over };
}
