// @ts-check
// A339: the direct-child test of the A327 run-owned removal and other-open-run skip, on the Windows spellings. Runs on every host through the platform and realpath parameters of pathin.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnlinkedFolder, scratchChildName } from '../../control-plane/agents/scripts/core/pathin.mjs';

const LONG = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
const SHORT = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
/** a fake realpath.native: 8.3 short names expand, slashes become backslashes, a link maps elsewhere */
const links = new Map([['c:\\users\\runneradmin\\appdata\\local\\temp\\swap', 'C:\\Users\\runneradmin\\other\\target']]);
const real = (/** @type {string} */ p) => {
  const bs = p.replace(/\//g, '\\');
  return links.get(bs.toLowerCase()) ?? bs.replace(/RUNNER~1/i, 'runneradmin');
};
const w = { platform: 'win32', real };

test('win32: the same temp folder in every spelling gives the name of a direct child', () => {
  for (const p of [
    'C:/Users/runneradmin/AppData/Local/Temp/verify-LC.x', 'c:/users/RUNNERADMIN/appdata/local/temp/verify-LC.x', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\verify-LC.x',
    'C:/Users/RUNNER~1/AppData/Local/Temp/verify-LC.x', 'C:/Users/runneradmin/AppData/Local/Temp/verify-LC.x/',
  ]) assert.equal(scratchChildName(p, [SHORT, undefined], w), 'verify-LC.x', p);
  assert.equal(scratchChildName('C:/Users/runneradmin/AppData/Local/Temp/verify-LC.x', [`${LONG}\\`], w), 'verify-LC.x', 'trailing separator on the temp folder');
  assert.equal(scratchChildName('C:/Users/runneradmin/AppData/Local/Temp/verify-LC.x', ['c:/users/runneradmin/appdata/local/temp'], w), 'verify-LC.x', 'forward slashes and case');
});

test('win32: lookalikes are no direct child: sibling, nested, other drive, other parent, dotdot, the folder itself', () => {
  for (const p of [
    'C:/Users/runneradmin/AppData/Local/Temp2/verify-LC.x', 'C:/Users/runneradmin/AppData/Local/Temp/nest/verify-LC.x', 'D:/Users/runneradmin/AppData/Local/Temp/verify-LC.x',
    'C:/Users/runneradmin/AppData/Local/verify-LC.x', 'C:/Users/runneradmin/AppData/Local/Temp/../verify-LC.x', 'C:/Users/runneradmin/AppData/Local/Temp/..', 'C:/Users/runneradmin/AppData/Local/Temp',
    '//srv/share/Temp/verify-LC.x', 'verify-LC.x',
  ]) assert.equal(scratchChildName(p, [SHORT, LONG], w), null, p);
});

test('POSIX: the old rule, byte for byte (private prefix dropped, exact parent, case and backslash significant)', () => {
  for (const platform of ['linux', 'darwin']) {
    const io = { platform };
    assert.equal(scratchChildName('/tmp/verify-LC.x', ['/tmp'], io), 'verify-LC.x');
    assert.equal(scratchChildName('/private/var/folders/a/T/verify-LC', ['/var/folders/a/T'], io), 'verify-LC');
    assert.equal(scratchChildName('/tmp/a/verify-LC.x', ['/tmp'], io), null);
    assert.equal(scratchChildName('/TMP/verify-LC.x', ['/tmp'], io), null);
    assert.equal(scratchChildName('/tmp2/verify-LC.x', ['/tmp'], io), null);
    assert.equal(scratchChildName('/tmp/../verify-LC.x', ['/tmp'], io), null);
    assert.equal(scratchChildName('C:\\tmp\\verify-LC.x', ['C:\\tmp'], io), null, 'a backslash is a name character');
    assert.equal(scratchChildName('/x/tmp/verify-LC.x', ['/tmp'], io), null);
  }
});

test('win32: isUnlinkedFolder accepts one folder in two spellings and refuses a link or junction', () => {
  assert.equal(isUnlinkedFolder('C:/Users/RUNNER~1/AppData/Local/Temp/verify-LC.x', w), true);
  assert.equal(isUnlinkedFolder('c:/users/runneradmin/appdata/local/temp/verify-LC.x', w), true);
  assert.equal(isUnlinkedFolder('C:/Users/runneradmin/AppData/Local/Temp/swap', w), false);
});
