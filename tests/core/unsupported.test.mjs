// @ts-check
// An input the Node core does not handle fails in Node (A210: no fallback to the shell): exit 1 and a message that names the reason. One table.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { memoryIo, scriptsDir } from './helpers.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'pl-unsup-'));
mkdirSync(path.join(root, '.agents'), { recursive: true });
cpSync(path.join(scriptsDir, '..', 'config.yaml'), path.join(root, '.agents', 'config.yaml'));
after(() => rmSync(root, { recursive: true, force: true }));

const MANDATORY = /^proofline: a mandatory argument is missing or empty \(see: proofline help\)\n$/;
/** @type {Array<[string, string[], RegExp]>} */
const TABLE = [
  ['a backslash in a config key', ['config-get', 'a\\b'], /^proofline: input not supported \(config-get shape\)\n$/],
  ['an over-long number', ['tm-scaled', '1234567890123'], /^proofline: input not supported \(tm-scaled shape\)\n$/],
  ['an empty mandatory argument (digest)', ['digest', ''], MANDATORY],
  ['a missing mandatory argument (verify-scope)', ['verify-scope'], MANDATORY],
  ['a missing mandatory argument (questions)', ['questions'], MANDATORY],
  ['a newline in a path (path-kind)', ['path-kind', 'a\nb'], /^proofline: input not supported \(newline in a path\)\n$/],
];

for (const [name, argv, message] of TABLE) {
  test(`${name}: exit 1 and the Node message`, () => {
    const m = memoryIo(root, {});
    assert.equal(run(argv, m.io), 1, argv.join(' '));
    assert.equal(m.stdout(), '');
    assert.match(m.stderr(), message);
  });
}
