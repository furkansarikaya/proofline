// @ts-check
// Shared helpers of the core tests: the repository paths, a text extractor for agent.sh (the shell is the specification), a fixture project.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const scriptsDir = path.join(repo, 'control-plane', 'agents', 'scripts');
export const agentShPath = path.join(scriptsDir, 'agent.sh');
export const agentSh = readFileSync(agentShPath, 'latin1');

/**
 * The text of shell functions of agent.sh, by name: a one-line function is one line, any other runs to the first line that is exactly `}`.
 * @param {string[]} names
 */
export function extractFunctions(names) {
  const lines = agentSh.split('\n');
  /** @type {string[]} */ const out = [];
  for (const name of names) {
    const i = lines.findIndex((l) => l.startsWith(`${name}() {`));
    if (i < 0) throw new Error(`function not found in agent.sh: ${name}`);
    if (lines[i].trimEnd().endsWith('}') && !lines[i].trimEnd().endsWith('{')) { out.push(lines[i]); continue; }
    let j = i;
    while (lines[j] !== '}') j++;
    out.push(lines.slice(i, j + 1).join('\n'));
  }
  return out.join('\n');
}

/** The lines of agent.sh from the first starting with FROM to the first (after it) starting with TO, both included. @param {string} from @param {string} to */
export function extractRange(from, to) {
  const lines = agentSh.split('\n');
  const i = lines.findIndex((l) => l.startsWith(from));
  const j = lines.findIndex((l, k) => k >= i && l.startsWith(to));
  if (i < 0 || j < 0) throw new Error(`range not found in agent.sh: ${from} .. ${to}`);
  return lines.slice(i, j + 1).join('\n');
}

/** A fixture project root with the layout of an installed project (no scripts: tests that need them copy them). @param {string} [config] */
export function makeProject(config = 'canonical_branch: main\ngit:\n  branch_prefix: t/\n') {
  const root = mkdtempSync(path.join(tmpdir(), 'pl-core-'));
  mkdirSync(path.join(root, '.agents', 'scripts'), { recursive: true });
  mkdirSync(path.join(root, '.agents', 'local'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'config.yaml'), config);
  return root;
}

/** An Io whose output is collected. @param {string} root @param {Record<string, string>} [env] */
export function memoryIo(root, env = {}) {
  /** @type {Buffer[]} */ const out = [];
  /** @type {Buffer[]} */ const err = [];
  const io = {
    env: { PATH: process.env.PATH ?? '', ...env }, cwd: root,
    stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) },
    scriptPath: path.join(root, '.agents', 'scripts', 'agent.sh'),
  };
  return { io, stdout: () => Buffer.concat(out).toString('latin1'), stderr: () => Buffer.concat(err).toString('latin1') };
}
