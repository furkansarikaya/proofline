// @ts-check
// Differential test of the hook's command tokenizer (adapters/claude/hooks/command-scan.mjs) against the awk scanner it replaces
// (`scan_cmd` in adapters/claude/hooks/proofline-hook.sh, the specification until stage 10). The awk program is extracted from the shell
// hook into a temp script; both are run over a corpus (every quoted string and line of tests/enforcement/*, hand-written spellings) and a
// seeded fuzz, and their outputs are compared byte for byte. A fresh awk process per case (the awk keeps state across records).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { kindOf, parseAgentRecord, parseHeredocRecord, scanBytes, scanCommand, scanText } from '../../adapters/claude/hooks/command-scan.mjs';

const repo = resolve(import.meta.dirname, '../..');
const hookText = readFileSync(join(repo, 'adapters/claude/hooks/proofline-hook.sh'), 'utf8');
const haveAwk = spawnSync('awk', ['--version']).error === undefined || spawnSync('awk', ['BEGIN{}']).status === 0;

/** The awk program of scan_cmd(): from `awk 'BEGIN { RS` to the line `{ qn = 1; ...}'`. */
function extractAwk() {
  const lines = hookText.split('\n');
  const s = lines.findIndex((l) => l === 'scan_cmd() {');
  assert.ok(s >= 0, 'scan_cmd not found');
  const first = lines[s + 1];
  assert.ok(first.startsWith("  awk 'BEGIN"), first);
  const e = lines.findIndex((l, i) => i > s && l.startsWith('  { qn = 1;'));
  const prog = [first.replace(/^ {2}awk '/, ''), ...lines.slice(s + 2, e), lines[e].replace(/'$/, '')].join('\n');
  assert.ok(!prog.includes("'"), 'the awk program holds a single quote');
  return prog;
}

let dir = '';
let progFile = '';
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pl-scan-'));
  progFile = join(dir, 'scan.awk');
  writeFileSync(progFile, extractAwk());
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

/** @param {Buffer} input @returns {Promise<Buffer>} */
function awkScan(input) {
  return new Promise((res, rej) => {
    const p = spawn('awk', ['-f', progFile], { env: { PATH: process.env.PATH, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'ignore'] });
    /** @type {Buffer[]} */ const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', rej);
    p.on('close', () => res(Buffer.concat(chunks)));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Compare awk and Node over all inputs, bounded concurrency; returns the first differences. @param {Buffer[]} inputs */
async function compare(inputs, workers = 16) {
  /** @type {string[]} */ const bad = [];
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < inputs.length) {
      const inp = inputs[next++];
      const want = await awkScan(inp);
      const got = scanBytes(inp);
      if (!want.equals(got) && bad.length < 8) bad.push(`input ${JSON.stringify(inp.toString('latin1'))}\n--- awk\n${want.toString('latin1')}\n--- node\n${got.toString('latin1')}`);
    }
  }));
  return bad;
}

/** The text the hook feeds the awk: `printf '%s\n' "$cmd"`. @param {string} s */
const hookInput = (s) => Buffer.from(`${s}\n`, 'utf8');

// ---- corpus -------------------------------------------------------------------------------------------------------
function enforcementFiles() {
  const d = join(repo, 'tests/enforcement');
  /** @type {string[]} */ const out = [];
  for (const f of readdirSync(d, { withFileTypes: true })) {
    if (f.isFile() && /\.(sh|mjs)$/.test(f.name)) out.push(join(d, f.name));
    if (f.isDirectory()) for (const g of readdirSync(join(d, f.name))) out.push(join(d, f.name, g));
  }
  return out;
}
/** Every line and every quoted string (and its unescaped form) of the enforcement tests. */
function corpusFromTests() {
  /** @type {Set<string>} */ const set = new Set();
  for (const f of enforcementFiles()) {
    const text = readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t) set.add(t);
      for (const m of t.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
        const body = m[1] ?? m[2] ?? m[3] ?? '';
        if (body) { set.add(body); set.add(body.replace(/\\(.)/g, '$1')); set.add(body.replace(/\\n/g, '\n')); }
      }
    }
    set.add(text.slice(0, 4000));
  }
  return [...set];
}

const HAND = [
  '', ' ', '\n', '\n\n', 'true', 'git status', "g''it commit -n", 'g""it commit --no-verify -m x', 'gi\\t push origin main', "git\\\ncommit -n",
  "$'git' push origin main", "$'\\x67it' status", 'sh agent.sh approve T-1', 'sh .agents/scripts/agent.sh next', 'agent.s""h approve', "'agent.sh' approve",
  'AGENT_ROLE=lead sh x.sh', 'export AGENT_ROLE=lead; true', 'env AGENT_ROLE=a b', 'echo ${AGENT_ROLE}', 'echo $AGENT_ROLE', 'AGENT_ROLE+=x true',
  'cat > f <<EOF\nbody $(rm -rf /x)\nEOF\nls', "cat > f <<'EOF'\nbody $(rm -rf /x)\nEOF\nls", 'cat <<-EOF\n\tx\n\tEOF\nls', 'cat <<EOF', 'cat <<A <<B\n1\nA\n2\nB\nls',
  'cat << EOF > out.txt\nline\nEOF', 'tee a b <<EOF\nx\nEOF', 'echo "unbalanced', "echo 'unbalanced", 'echo `unbalanced', 'echo $(unbalanced', 'echo "$(unbalanced',
  'echo hi\rthere', 'echo a\u0000b'.replace('\u0000', ''), 'echo café üğşıİ Ş', 'Türkçe > çıktı.txt', 'echo "İstanbul" > "ı.txt"',
  'a && b || c | d & e; f\ng', 'a;;b', '(a; b) | (c)', '{ a; b; }', 'case x in stop|halt) echo y;; esac', 'case $x in (a|b) true;; esac', 'echo >&2 hi', 'echo 2>&1', 'cmd &> f', 'cmd &>> f',
  'cmd >| f', 'cmd >> f', 'cmd 2> f', 'cmd < f', 'cmd <<< "x"', 'cat < <(ls)', 'diff <(a) <(b)', 'echo >(tee f)', 'echo $((1+2)) $(( (1) ))', 'echo # comment\nls', 'echo a#b', 'x=1 y=2 z',
  'ID=T-6; sh agent.sh next $ID', 'ID=T-6 && sh agent.sh next ${ID}', 'IFS=: ; X=1; sh a.sh $X', 'read X; echo $X', 'for i in 1 2; do X=$i; done',
  'sudo -u root env -i FOO=1 nice -n 5 timeout 10 xargs -I{} rm {}', 'env -S "a b"', 'env -u X sh -c "echo hi"', 'command -v sh', 'nohup sh -c "sh -c \\"sh -c x\\""',
  'bash -c "bash -c \'bash -c \\"bash -c y\\"\'"', 'sh -c "$(cat x)"', 'sh -s', 'sh', 'sh -o pipefail -c x', 'sh -- x.sh', 'bash ./agent.sh approve', '. ./agent.sh next', 'source $X',
  'eval "$x"', 'claude -p hi', 'claude --print x', 'codex exec x', 'codex -m x e y', 'git -c core.hooksPath=/x commit', 'git -ccore.hooksPath=x log', 'git --config-env=alias.x=Y log',
  'git commit -n', 'git commit -an', 'git commit -m "n" -n', 'git commit -nm x', 'git commit --no-verify', 'git push --no-verify', 'git config core.hooksPath x', 'git config -e',
  'GIT_DIR=x git status', 'GIT_CONFIG_COUNT=1 git log', 'git --git-dir=x log', 'git -C d --work-tree w commit -n',
  'tee f', 'tee -a f g', 'touch -t 2001 f g', 'rm -rf a b', 'truncate -s 0 f', 'unlink x', 'chmod 755 a b', 'chmod --reference=r a', 'chown -R u:g d', 'dd if=a of=b', 'dd of=/dev/null',
  'cp a b c', 'cp -t d a b', 'cp --target-directory=d a', 'mv a b', 'mv a b c d', 'install -m 644 a b', 'rsync -e ssh a b', 'ln -s a b', 'ln a', 'ln -s agent.sh x', 'cp agent.sh y',
  "sed -i 's/a/b/' f", 'sed -i.bak s/a/b/ f', "sed -ni 's/a/b/p' f", 'sed -n -i -e x f', 'sed --in-place s/a/b/ f', 'perl -pi -e s/a/b/ f', 'ruby -i x f', 'awk -i inplace x f', 'awk --include=inplace x f',
  'awk -i inplace', 'patch -p1 < x', 'ed f', 'vim -c q f', 'cd /a && cat > b', 'cd a && cd b && tee c', 'cd - && tee c', 'cd "$X" && tee c', 'cd /a; echo > rel; cd; echo > rel2',
  'x=$(echo a) tee f', 'echo "`echo hi`"', 'echo "a$(echo "b$(echo c)")"', 'echo "\\$(not)"', 'echo \\$(not)', 'echo \\', 'echo \\\n x', "echo 'a'\"b\"c", 'a|b|c|d|e|f',
  'cmd1 |& cmd2', 'cmd &', '& cmd', '| cmd', ') cmd', 'cmd )', '(((((a)))))', '$(((((((a)))))))', 'echo $(echo $(echo $(echo $(echo $(echo deep)))))',
  'sh -c "sh -c \\"sh -c \\\\\\"sh -c \\\\\\\\\\\\\\"sh -c x\\\\\\\\\\\\\\"\\\\\\"\\""', 'cat <<EOF\n$(sh -c "git commit -n")\n`rm x`\nEOF',
  'ps -o pid= -p 1', 'dd of=x', 'echo a=b', 'a=b c=d', 'A=1', 'A=1 B=2; sh x $A', 'A=$(date); sh x $A', 'A="x y"; sh x $A', 'A=x\\ y; sh x $A', 'echo $', 'echo ${', 'echo ${X',
  'export AGENT_ROLE', 'unset AGENT_ROLE', 'printf -v x y; echo $x', 'local X=1', 'X=1\nsh a.sh $X', '(X=1; sh a.sh $X)', 'X=1 | sh a.sh $X',
  `${'a '.repeat(2000)}`, `${'echo x; '.repeat(1500)}`, `echo ${'y'.repeat(10240)}`, `cat > f <<EOF\n${'line\n'.repeat(3000)}EOF\nls`, `${'(' .repeat(300)}a${')'.repeat(300)}`,
  '\x01', 'a\x01b', 'a;\x01 cd /x\x01 tee y', 'cd /a\x01tee b', '\x01\x01', 'x\x01',
];

describe('command-scan against the awk scanner', { skip: haveAwk ? false : 'no awk' }, () => {
  test('hand-written spellings, byte for byte', async () => {
    const inputs = [];
    for (const h of HAND) { inputs.push(hookInput(h)); inputs.push(Buffer.from(h, 'utf8')); }
    const bad = await compare(inputs);
    assert.deepEqual(bad, []);
  });

  test('every command string of tests/enforcement', async () => {
    const corpus = corpusFromTests();
    assert.ok(corpus.length > 1000, `corpus too small: ${corpus.length}`);
    const bad = await compare(corpus.map(hookInput));
    assert.deepEqual(bad, []);
  });

  test('invalid UTF-8, high bytes, control bytes', async () => {
    /** @type {Buffer[]} */ const inputs = [
      Buffer.from([0x65, 0x63, 0x68, 0x6f, 0x20, 0xff, 0xfe, 0x20, 0xc3, 0x28, 0x0a]),
      Buffer.from('echo "ç\x07\x1b[31m" > \x7fı\n', 'latin1'),
      Buffer.from('g\xe9it commit -n\r\n', 'latin1'),
      Buffer.from('cat <<E\r\nx\r\nE\r\nls\r\n', 'latin1'),
      Buffer.from('\x1b]0;x\x07 tee f\n', 'latin1'),
    ];
    assert.deepEqual(await compare(inputs), []);
  });

  test('a seeded fuzz of generated commands', async () => {
    let seed = 0x5eed1234;
    const rnd = (/** @type {number} */ n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
    const pick = (/** @type {string[]} */ a) => a[rnd(a.length)];
    const words = ['git', 'g\'\'it', 'sh', 'bash', 'agent.sh', './agent.sh', 'cat', 'tee', 'rm', 'cp', 'mv', 'ln', 'sed', 'perl', 'awk', 'ruby', 'env', 'sudo', 'xargs', 'timeout', 'nice', 'cd', 'echo',
      'commit', 'push', 'config', 'checkout', 'approve', 'next', '-c', '-i', '-n', '-p', '-m', '-t', '-C', '-S', '--no-verify', '--in-place', 'inplace', 'core.hooksPath=x', 'of=f', 'f', 'g.txt',
      '/tmp/x', '../up', '~/h', '$X', '${X}', '$(cd /a)', '`id`', '"$(id)"', "'q q'", '"d d"', 'AGENT_ROLE=lead', 'X=1', 'A=b', 'IFS=:', '.', 'source', 'eval', 'claude', 'codex', 'exec', 'e',
      '2', '1', 'ç', 'ı', 'Türk', '#c', 'a#b', '\\', '\\\n', '$', '${', '$(('];
    const seps = [' ', ' ', ' ', ' ', ';', ' && ', ' || ', ' | ', ' & ', '\n', ' ; ', '\t'];
    const redirs = ['>', '>>', '<', '2>', '&>', '>&', '<<EOF', '<<-EOF', "<<'EOF'", '<<<', '<(', '>(', '>|', '2>&1'];
    const opens = ['(', ')', '{', '}', '"', "'", '`', '$(', '"$(', '"`', ')', '"'];
    const cmds = [];
    for (let n = 0; n < 3500; n++) {
      let s = '';
      const len = 2 + rnd(14);
      for (let k = 0; k < len; k++) {
        const r = rnd(20);
        if (r < 12) s += pick(words);
        else if (r < 14) s += pick(redirs);
        else if (r < 16) s += pick(opens);
        else s += pick(seps);
        s += pick(seps);
      }
      if (rnd(8) === 0) s += `\n${pick(['EOF', 'x', ''])}\n${pick(words)}`;
      if (rnd(25) === 0) s = `${pick(['\x01', ''])}${s}\x01${pick(words)}`;
      cmds.push(hookInput(s));
    }
    const t0 = Date.now();
    const bad = await compare(cmds);
    assert.deepEqual(bad, []);
    assert.ok(Date.now() - t0 < 60000, 'fuzz took longer than 60 s');
  });
});

describe('command-scan API', () => {
  test('records, commands and literal flags', () => {
    const r = scanCommand('FOO=1 sh agent.s""h approve T-1 > out.txt; echo $X');
    assert.deepEqual(r.commands.map((c) => c.word), ['env', 'sh', 'echo']);
    assert.deepEqual(r.commands[1].args, ['agent.sh', 'approve', 'T-1']);
    assert.deepEqual(kindOf(r, 'W').map((x) => x.value), ['out.txt']);
    assert.deepEqual(kindOf(r, 'A').map(parseAgentRecord), [{ literal: true, sub: 'approve' }]);
    assert.deepEqual(kindOf(scanCommand('sh agent.sh $SUB'), 'A').map(parseAgentRecord), [{ literal: false, sub: '$SUB' }]);
  });
  test('here-document records and the trailing newline the hook adds', () => {
    const r = scanCommand('cat > f <<EOF\none\ntwo\nEOF');
    assert.deepEqual(kindOf(r, 'H').map(parseHeredocRecord), [{ cmd: 'cat', path: 'f', body: 'one\ntwo\n' }]);
    assert.equal(scanCommand('true').raw, scanText('true\n').raw);
  });
  test('non-ASCII text round-trips', () => {
    const r = scanCommand('echo x > Türkçe/ç.txt');
    assert.deepEqual(kindOf(r, 'W').map((x) => x.value), ['Türkçe/ç.txt']);
  });
  test('a 250 KB command is scanned in well under a second', () => {
    const t0 = Date.now();
    scanCommand(`echo ${'x'.repeat(250000)}`);
    scanCommand('a; '.repeat(40000));
    assert.ok(Date.now() - t0 < 5000);
  });
});
