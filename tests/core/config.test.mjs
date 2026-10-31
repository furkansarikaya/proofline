// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { extractFunctions } from './helpers.mjs';
import { Config, bytes, configGetFrom, configItems, configLines, dec0, smallInt } from '../../control-plane/agents/scripts/core/config.mjs';
import { BridgeToShell } from '../../control-plane/agents/scripts/core/errors.mjs';

describe('configLines (the awk program of config_lines)', () => {
  test('nested keys, comments, blanks, quotes', () => {
    const t = ['# c', '', 'a: 1', 'b:', '  c: "two"   # note', "  d: 'single'", '  e: "a # b"', 'f: x # y', 'g: x#y', 'h:', ''].join('\n');
    assert.deepEqual(configLines(t), ['a=1', 'b=', 'b.c=two', "b.d='single'", 'b.e="a', 'f=x', 'g=x#y', 'h=']);
  });
  test('block lists under commands.* become key.N lines; the key itself stays empty', () => {
    const t = ['commands:', '  build:', '    - make all', '    - "make test"   # c', "    - 'x y'", '    -', '  test: npm test', '  lint:', '  - l1', 'next: 1'].join('\n');
    assert.deepEqual(configLines(t), ['commands=', 'commands.build=', 'commands.build.0=make all', 'commands.build.1=make test', 'commands.build.2=x y', 'commands.build.3=', 'commands.test=npm test', 'commands.lint=', 'commands.lint.0=l1', 'next=1']);
  });
  test('a list item outside any key, or less indented than its key, is dropped', () => {
    assert.deepEqual(configLines('- a\nk:\n    deep: 1\n  - x\n'), ['k=', 'k..deep=1']);
  });
  test('indentation counts spaces in pairs; a skipped level leaves an empty path part; tabs are not indentation', () => {
    assert.deepEqual(configLines('a:\n      z: 1\n\ttab: 2\n   odd: 3\n'), ['a=', 'a...z=1', '\ttab=2', '\ttab.odd=3']);
  });
  test('CRLF: the carriage return is white space', () => {
    assert.deepEqual(configLines('a: 1\r\nb:\r\n  - x\r\n  - "y"\r\n'), ['a=1', 'b=', 'b.0=x', 'b.1=y']);
  });
  test('a colon in the value, a lone quote, a key with no value, no final newline', () => {
    assert.deepEqual(configLines('u: http://h:80/p\nq: "\nr\nlast: v'), ['u=http://h:80/p', 'q="', 'last=v']);
  });
  test('byte semantics: UTF-8 stays as bytes', () => {
    const lines = configLines(bytes('k: \u00e9'));
    assert.deepEqual(lines, [`k=${bytes('\u00e9')}`]);
    assert.equal(Buffer.from(lines[0], 'latin1').toString('utf8'), 'k=\u00e9');
  });
});

describe('config_get and cfg', () => {
  const lines = configLines('a: 1\nb:\n  c: 2\nl:\n  - x\n  - y\nboth: v\n');
  test('value, absent, empty value, block list', () => {
    assert.equal(configGetFrom(lines, 'a'), '1');
    assert.equal(configGetFrom(lines, 'b.c'), '2');
    assert.equal(configGetFrom(lines, 'b'), '');
    assert.equal(configGetFrom(lines, 'zz'), null);
    assert.equal(configGetFrom(lines, 'l'), 'x\ny');
    assert.deepEqual(configItems(lines, 'l'), ['x', 'y']);
  });
  test('a non-empty value wins over items; items need digits', () => {
    assert.equal(configGetFrom(['k=v', 'k.0=i'], 'k'), 'v');
    assert.equal(configGetFrom(['k.x=i'], 'k'), null);
    assert.equal(configGetFrom(['k.0='], 'k'), '');
  });
  test('cfg: first match, the default for an absent or empty value, keys that contain "="', () => {
    const c = new Config('f', ['a=', 'a=second', 'b=1', 'x=y=z']);
    assert.equal(c.get('a', 'd'), 'd');
    assert.equal(c.get('b', 'd'), '1');
    assert.equal(c.get('nope', 'd'), 'd');
    assert.equal(c.get('x'), 'y=z');
    assert.equal(c.get('x=y'), 'z');
  });
  test('cmds: scalar, else the block list', () => {
    const c = new Config('f', ['commands.build=', 'commands.build.0=a', 'commands.build.1=b', 'commands.test=t']);
    assert.deepEqual(c.cmds('commands.build'), ['a', 'b']);
    assert.deepEqual(c.cmds('commands.test'), ['t']);
    assert.deepEqual(c.cmds('commands.lint'), []);
  });
});

describe('numbers', () => {
  test('dec0 strips leading zeros (08 is the number 8)', () => {
    assert.equal(dec0('08'), '8'); assert.equal(dec0('000'), '0'); assert.equal(dec0('0'), '0'); assert.equal(dec0('0x'), 'x'); assert.equal(dec0('100'), '100'); assert.equal(dec0(''), '');
  });
  test('smallInt leaves numbers beyond the shell integers to the shell code', () => {
    assert.equal(smallInt('000000000000009'), 9);
    assert.throws(() => smallInt('1234567890123456'), BridgeToShell);
  });
});

describe('differential test against the awk program of agent.sh', () => {
  const corpus = [
    'a: 1\nb:\n  c: 2\n', '# only a comment\n', '', '\n\n', 'k: "v"\nq: \'w\'\nz: "a # b"\ny: a # b\nx: "\n', 'commands:\n  build:\n    - a\n    - "b"\n    - \'c\' # d\n    -\n  test: t\n',
    'a:\n      z: 1\n\ttab: 2\n   odd: 3\n', 'a: 1\r\nb:\r\n  - x\r\n', 'u: http://h:80/p\nnocolon\nq: "\nlast: v', '- a\nk:\n    deep: 1\n  - x\n', 'k : v\n k2: v2\n  k3 :   v3   \n',
    'a: "x" # c\nb: "x"y"\nc: ""\nd: "\nf: \'\'\n', 'l:\n- a\n- b\nm: 1\n', 'l:\n  - a\n  - b # c\n  - "q # r"\n', 'a:\n  b:\n    c: 1\n  d: 2\ne: 3\n', 'x:   \n   \ny: 1\n',
    'n: 08\nn2: 0x1\nn3: 1.5.2\n', 'a: b: c: d\n', ': v\n', '  : v\n', 'k:v\nk2:\tv2\n', 'a: \xc3\xa9\n\xc3\xa9: v\n', 'a: #c\nb: x\t#c\n', 'tab:\tv\n',
  ];
  test('configLines equals config_lines on a corpus', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-awk-'));
    try {
      const fns = extractFunctions(['config_lines']);
      corpus.forEach((text, i) => {
        const f = path.join(dir, `c${i}.yaml`);
        writeFileSync(f, text, 'latin1');
        const r = spawnSync('sh', ['-c', `LC_ALL=C; config=/nonexistent; ${fns}\nconfig_lines "$1"`, 'sh', f], { encoding: 'latin1' });
        assert.equal(r.status, 0, `awk failed for corpus ${i}`);
        const expected = r.stdout === '' ? [] : r.stdout.replace(/\n$/, '').split('\n');
        assert.deepEqual(configLines(text), expected, `corpus ${i}: ${JSON.stringify(text)}`);
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('configGetFrom equals config_get (value, items, absent, exit status)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-awk-'));
    try {
      const fns = extractFunctions(['config_lines', 'config_get']);
      const text = 'a: 1\nb:\n  c: 2\n  d:\n    - x\n    - y\ne: v\n  - ignored\nf:\n  - 1\ng: ""\ng2: x\nh.i: dotted\n';
      const f = path.join(dir, 'c.yaml');
      writeFileSync(f, text);
      const lines = configLines(text);
      for (const key of ['a', 'b', 'b.c', 'b.d', 'e', 'f', 'g', 'g2', 'h', 'h.i', 'zz', 'b.d.0', 'b.d.1', 'a.', '', 'b.']) {
        const r = spawnSync('sh', ['-c', `LC_ALL=C; config=/nonexistent; ${fns}\nconfig_get "$1" "$2"`, 'sh', key, f], { encoding: 'latin1' });
        const got = configGetFrom(lines, key);
        assert.equal(got === null ? 1 : 0, r.status, `exit status for ${key}`);
        if (got !== null) assert.equal(`${got}\n`, r.stdout, `value for ${key}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
