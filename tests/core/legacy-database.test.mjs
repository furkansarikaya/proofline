// @ts-check
// Absolute Node port of enforcement-test.sh database_guard DB-36: the database block of the shipped config.yaml equals the built-in defaults of the core
// (`db-config all` prints the same with the block removed as with the shipped file). The hook half of database_guard (DB-1 .. DB-35, DB-42 .. DB-45) is
// replayed in tests/hook/enforcement-recorded-paths.test.mjs. DB-37 .. DB-41 (start records the baseline, db-check, freeze refusal) use start, db-check and
// freeze, which are still shell commands: they stay in enforcement-test.sh for the batch stage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, project } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';

test('DB-36: config.yaml database block equals the built-in defaults', () => {
  const dir = project('new_repo');
  const cfg = path.join(dir, '.agents/config.yaml');
  const shippedText = readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'utf8');
  // the shipped file without its database: block
  let skip = false;
  const without = shippedText.split('\n').filter((l) => {
    if (l.startsWith('database:')) { skip = true; return false; }
    if (skip && /^[^ #]/.test(l)) skip = false;
    return !skip;
  }).join('\n');
  writeFileSync(cfg, without);
  const builtin = A(dir, ['db-config', 'all']);
  assert.equal(builtin.status, 0, builtin.text);
  writeFileSync(cfg, shippedText);
  const shipped = A(dir, ['db-config', 'all']);
  assert.equal(shipped.status, 0, shipped.text);
  assert.ok(builtin.out.length > 0, 'db-config printed nothing');
  assert.equal(builtin.out, shipped.out, 'config.yaml database defaults differ from the built-in defaults');
});
