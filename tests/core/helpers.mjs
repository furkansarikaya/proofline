// @ts-check
// Shared helpers of the core tests: the repository paths, the text of agent.sh, a fixture project. (Until A244 also a text extractor for the shell functions of agent.sh: the tests that ran them compare
// with answers recorded from them now, tests/golden/shell-equivalence.json.)
import { tempDir } from '../lib/tempdir.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const scriptsDir = path.join(repo, 'control-plane', 'agents', 'scripts');
export const agentShPath = path.join(scriptsDir, 'agent.sh');
export const agentSh = readFileSync(agentShPath, 'latin1');

/** A fixture project root with the layout of an installed project (no scripts: tests that need them copy them). @param {string} [config] */
export function makeProject(config = 'canonical_branch: main\ngit:\n  branch_prefix: t/\n') {
  const root = tempDir('pl-core-');
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

/** The commands the old agent.sh preamble left to the shell code (none since A245: agent.sh is a launcher and every command runs in the Node core). @param {string} text the text of agent.sh @returns {string[]} */
export function shellListed(text) {
  const m = /\ncase "\$\{1:-\}" in\n((?:  [^\n]*\\\n)*  [^\n]*\) ;;)\n  \*\)\n/.exec(text);
  if (!m) return [];   // issue #173 package A moved the last nine: the preamble has no list of shell commands any more
  return m[1].replace(/\\\n/g, '').trim().replace(/\) ;;$/, '').split('|').map((x) => x.trim());
}
