// @ts-check
// T2 port of risk-test.sh (sc_eco_fallback): where the ecosystem definition is read from. An installed project whose own copy is missing warns and has no
// dependency signal; a script that is started from another folder shipping the definition (the repository layout) uses that copy and does not warn.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { node, stateOf } from './port-t2-lib.mjs';

describe('risk-test: ecosystem fallback', () => {
  test('sc_eco_fallback: a script run from a folder that ships the definition uses it when the project\'s copy is missing; an installed project warns', () => {
    const r = stateOf('risk-fsproj');
    mkdirSync(path.join(r, 'ship/scripts'), { recursive: true });
    copyFileSync(path.join(r, '.agents/scripts/agent.sh'), path.join(r, 'ship/scripts/agent.sh'));
    renameSync(path.join(r, '.agents/ecosystems.json'), path.join(r, 'ship/ecosystems.json'));
    let po = node(r, ['pipeline', 'LC']).out;
    assert.ok(po.includes('warning=.agents/ecosystems.json is missing or empty'));
    assert.equal(po.includes('signal.dependency_manifest'), false);
    po = node(r, ['pipeline', 'LC'], { scriptPath: path.join(r, 'ship/scripts/agent.sh') }).out;
    assert.ok(po.includes('signal.dependency_manifest=source=scope:src/Api/a.fsproj(*.fsproj)'));
    assert.equal(po.includes('warning='), false);
  });
});
