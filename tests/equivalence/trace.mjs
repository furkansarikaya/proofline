// @ts-check
// Install the trace recorder and replay its traces as rig cases (ADR 0001 section 6, input 2).
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Write the `sh` PATH shim into a new directory; returns the directory (put it first on PATH) and the env to set. */
export function installTraceShim(/** @type {string} */ traceDir) {
  const bin = mkdtempSync(join(tmpdir(), 'eq-shim.'));
  writeFileSync(join(bin, 'sh'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, 'trace-shim.mjs')}" "$@"\n`);
  chmodSync(join(bin, 'sh'), 0o755);
  return { bin, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, PROOFLINE_TRACE: traceDir } };
}

/** @typedef {{ n: string, argv: string[], cwdRel: string, seams: Record<string,string>, stdinBase64: string, time: number, manifest: { p: string, sha?: string, mode: number, link?: string }[] }} TraceCall */
export function loadTrace(/** @type {string} */ traceDir) {
  return readdirSync(join(traceDir, 'calls')).sort().map((f) => /** @type {TraceCall} */ ({ ...JSON.parse(readFileSync(join(traceDir, 'calls', f), 'utf8')), n: f }));
}

/** Rebuild the project tree of a call into dest (an empty directory). */
export function restoreSnapshot(/** @type {string} */ traceDir, /** @type {TraceCall} */ call, /** @type {string} */ dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of call.manifest) {
    const p = join(dest, e.p);
    if (e.p.endsWith('/')) { mkdirSync(p, { recursive: true }); continue; }
    mkdirSync(dirname(p), { recursive: true });
    if (e.link !== undefined) symlinkSync(e.link, p);
    else { writeFileSync(p, readFileSync(join(traceDir, 'objects', /** @type {string} */ (e.sha)))); chmodSync(p, e.mode); }
  }
}

/** A recorded call as a rig case: the snapshot is the fixture, the call is the one step. Its window is open at the bottom (the snapshot holds older times). */
export function traceCase(/** @type {string} */ traceDir, /** @type {TraceCall} */ call) {
  const dir = mkdtempSync(join(tmpdir(), 'eq-trace.')); restoreSnapshot(traceDir, call, dir);
  const { AGENT_ROLE, ...seams } = call.seams;
  const env = Object.fromEntries(Object.entries(seams).filter(([k]) => !/^(PROOFLINE_ENGINE|GIT_|LC_ALL$|TMPDIR$)/.test(k)));
  /** @type {import('./rig.mjs').Case} */
  const c = { name: `trace ${call.n}: ${call.argv.slice(1).join(' ')}`, fixture: { dir, builtAt: 0 },
    steps: [{ args: call.argv.slice(1), role: AGENT_ROLE, env, stdin: Buffer.from(call.stdinBase64, 'base64').toString('latin1'), cwd: call.cwdRel }] };
  return c;
}
