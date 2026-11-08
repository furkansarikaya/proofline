// The role generator (adapters/generate.mjs) against the fixture roles in tests/generator/fixtures/roles, and the role-source conformance check.
// Ported from generator-test.sh (A234): every `check` of the shell suite is a `ck` here, named by the same words (tests/legacy-port-map.tsv).
// GEN_UNDER_TEST=<path of generate.sh> runs the same expectations against the shell generator (how the port was proven equal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { conform, problems } from './role-conformance.mjs';
import { parseRole } from '../../adapters/generate.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const FIX = join(repo, 'tests/generator/fixtures/roles');
const GEN = process.env.GEN_UNDER_TEST || join(repo, 'adapters/generate.mjs');
const T = mkdtempSync(join(tmpdir(), 'gen-test-'));
process.on('exit', () => rmSync(T, { recursive: true, force: true }));
let n = 0;

const ck = (desc, cond) => assert.ok(cond, desc);
const read = (f) => readFileSync(f, 'utf8');
const has = (f, s) => read(f).includes(s);
const count = (f, s) => read(f).split('\n').filter((l) => l.includes(s)).length;
const newroot = () => { const R = join(T, `root${++n}`); mkdirSync(join(R, 'roles'), { recursive: true }); cpSync(FIX, join(R, 'roles'), { recursive: true }); return R; };
const run = (args) => (GEN.endsWith('.sh') ? spawnSync('sh', [GEN, ...args], { encoding: 'utf8' }) : spawnSync(process.execPath, [GEN, ...args], { encoding: 'utf8' }));
const gen = (R, ...args) => run(['--root', R, ...args]);
const ok = (r) => r.status === 0;
const edit = (f, fn) => writeFileSync(f, fn(read(f)));

test('1. render: lead is no agent, but in the control plane and the docs', () => {
  const R = newroot();
  ck('generate all', ok(gen(R)));
  ck('claude agent for reviewer', existsSync(`${R}/adapters/claude/agents/proofline-reviewer.md`));
  ck('claude agent for implementer', existsSync(`${R}/adapters/claude/agents/proofline-implementer.md`));
  ck('lead not a claude agent', !existsSync(`${R}/adapters/claude/agents/proofline-lead.md`));
  ck('lead not a codex agent', !existsSync(`${R}/adapters/codex/agents/proofline-lead.toml`));
  ck('lead role text exists', existsSync(`${R}/control-plane/agents/roles/lead.md`));
  ck('lead listed in docs', has(`${R}/docs/reference/roles.md`, '## lead'));
  ck('docs header', has(`${R}/docs/reference/roles.md`, 'Generated from roles/ — do not edit'));
  ck('roles.conf lists lead', has(`${R}/control-plane/agents/roles.conf`, 'lead balanced claude opus medium 2'));
});

test('2. the Claude frontmatter conforms to the agent format', () => {
  const R = newroot(); gen(R);
  const f = `${R}/adapters/claude/agents/proofline-reviewer.md`;
  const keys = read(f).split('\n').slice(1).filter((l, i, a) => a.indexOf('---') < 0 || i < a.indexOf('---')).filter((l) => /^[a-z]+:/.test(l)).map((l) => l.replace(/:.*/, ''));
  ck('claude frontmatter keys', keys.join(' ') === 'name description tools model effort');
  ck('claude name', has(f, 'name: proofline-reviewer'));
  ck('claude tools comma list', has(f, 'tools: Read, Grep, Glob, Bash'));
  ck('claude model default is balanced', has(f, 'model: sonnet'));
  ck('claude effort balanced', has(f, 'effort: medium'));
  const dl = Buffer.byteLength(read(f).split('\n').find((l) => l.startsWith('description:')) ?? '') + 1;
  ck('claude description length <= 1000', dl <= 1010);
  ck('claude description escapes quotes/backslashes', has(f, 'description: "Reviews a change against the plan. Use when: per tier (D14) | \\"quoted\\" \\\\ slash"'));
  ck('claude frontmatter closed', read(f).split('\n').filter((l) => l === '---').length === 2);
  for (const e of readdirSync(`${R}/adapters/claude/agents`)) for (const l of read(`${R}/adapters/claude/agents/${e}`).split('\n')) if (l.startsWith('model:')) ck(`claude model value ${l}`, ['sonnet', 'opus', 'haiku', 'inherit'].includes(l.slice(7)));
});

test('3. the profile switch changes models', () => {
  const R = newroot(); gen(R);
  gen(R, '--target', 'claude-plugin', '--profile', 'max');
  ck('profile max claude model', has(`${R}/adapters/claude/agents/proofline-reviewer.md`, 'model: opus'));
  ck('profile max claude effort', has(`${R}/adapters/claude/agents/proofline-reviewer.md`, 'effort: high'));
  gen(R, '--target', 'codex', '--profile', 'max');
  ck('profile max codex model', has(`${R}/adapters/codex/agents/proofline-reviewer.toml`, 'model = "gpt-x-big"'));
  gen(R, '--target', 'claude-plugin', '--profile', 'economy');
  ck('profile economy claude model', has(`${R}/adapters/claude/agents/proofline-reviewer.md`, 'model: haiku'));
  ck('bad profile rejected', !ok(gen(R, '--profile', 'turbo')));
});

test('4. {{skill:x}} per target, and the rendering into an installed project', () => {
  const R = newroot(); gen(R);
  ck('plugin skill path', has(`${R}/adapters/claude/agents/proofline-reviewer.md`, '${CLAUDE_PLUGIN_ROOT}/skills/proof-review/SKILL.md'));
  ck('codex skill path', has(`${R}/adapters/codex/agents/proofline-reviewer.toml`, '.agents/skills/proof-review/SKILL.md'));
  ck('role text skill path', has(`${R}/control-plane/agents/roles/reviewer.md`, '.agents/skills/test-trust/SKILL.md'));
  ck('role text has no plugin var', !has(`${R}/control-plane/agents/roles/reviewer.md`, 'CLAUDE_PLUGIN_ROOT'));
  const O = join(T, 'proj1');
  ck('init-style render', ok(gen(R, '--out', O, '--profile', 'economy')));
  const a = `${O}/.claude/agents/proofline-reviewer.md`;
  ck('project skill path', has(a, '.agents/skills/proof-review/SKILL.md'));
  ck('project: no .claude/skills path', !has(a, '.claude/skills'));
  ck('project agent has no plugin var', !has(a, 'CLAUDE_PLUGIN_ROOT'));
  ck('project profile applied', has(a, 'model: haiku'));
  ck('project codex agent', existsSync(`${O}/.codex/agents/proofline-reviewer.toml`));
  ck('project roles.conf', existsSync(`${O}/.agents/roles.conf`));
  ck('project role text', existsSync(`${O}/.agents/roles/lead.md`));
  ck('project owns.conf', has(`${O}/.agents/owns.conf`, 'implementer PRODUCT_SCOPE results/'));
  ck('project tools.conf', has(`${O}/.agents/tools.conf`, 'reviewer Read,Grep,Glob,Bash'));
  ck('project: no docs', !existsSync(`${O}/docs`));
  ck('project: lead not an agent', !existsSync(`${O}/.claude/agents/proofline-lead.md`));
  const all = (d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => read(join(e.parentPath, e.name)));
  ck('no unreplaced placeholders', ![...all(`${R}/adapters`), ...all(`${R}/control-plane`), ...all(O)].some((t) => t.includes('{{skill:')));
  ck('claude-plugin needs no --out', !ok(gen(R, '--out', join(T, 'x'), '--target', 'claude-plugin')));
  ck('claude-project needs --out', !ok(gen(R, '--target', 'claude-project')));
  writeFileSync(`${O}/.claude/agents/custom.md`, 'mine\n');
  gen(R, '--out', O);
  ck('foreign agent files untouched', existsSync(`${O}/.claude/agents/custom.md`));
});

const tomlCheck = (file) => {
  const lines = read(file).split('\n'); lines.pop();
  const seen = {}; let delim = '', inblk = false, closed = 0, bad = false;
  for (const l of lines) {
    const m = /^(name|description|model|model_reasoning_effort|sandbox_mode) = "/.exec(l);
    if (!inblk && m) { seen[m[1]] = (seen[m[1]] ?? 0) + 1; continue; }
    if (!inblk && (l === "developer_instructions = '''" || l === 'developer_instructions = """')) { delim = l.slice(-3); inblk = true; continue; }
    if (inblk && l === delim) { inblk = false; closed++; continue; }
    if (inblk && delim === '"""') { const x = l.replace(/\\\\/g, '').replace(/\\"/g, ''); if (x.includes('"""') || x.includes('\\')) bad = true; }
    if (inblk && delim === "'''" && l.includes(delim)) bad = true;
  }
  if (bad || inblk || closed !== 1) return false;
  if (!['name', 'description', 'model', 'model_reasoning_effort', 'sandbox_mode'].every((k) => seen[k] === 1)) return false;
  const py = spawnSync('python3', ['-I', '-c', 'import sys, tomllib\nd = tomllib.load(open(sys.argv[1], "rb"))\nassert set(d) == {"name","description","developer_instructions","model","model_reasoning_effort","sandbox_mode"}\nassert d["developer_instructions"].strip()', file], { encoding: 'utf8' });
  return py.error ? true : py.status === 0 || /No module named tomllib|ModuleNotFoundError/.test(py.stderr);
};

test('5. TOML structure and escaping', () => {
  const R = newroot(); gen(R);
  const roundtrip = (id) => {
    const t = read(`${R}/adapters/codex/agents/proofline-${id}.toml`).split('\n');
    const i = t.findIndex((l) => l.startsWith('developer_instructions = '));
    const d = t[i].slice(-3);
    let raw = t.slice(i + 1, t.indexOf(d, i + 1)).join('\n') + '\n';
    if (d === '"""') raw = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return raw === read(`${R}/control-plane/agents/roles/${id}.md`).split('\n').slice(1).join('\n');
  };
  for (const id of ['reviewer', 'implementer']) {
    ck(`toml structure ${id}`, tomlCheck(`${R}/adapters/codex/agents/proofline-${id}.toml`));
    ck(`toml round trip ${id}`, roundtrip(id));
  }
  const rv = `${R}/adapters/codex/agents/proofline-reviewer.toml`, im = `${R}/adapters/codex/agents/proofline-implementer.toml`;
  ck('literal string when no triple quote', has(rv, "developer_instructions = '''"));
  ck('basic string fallback for triple quote', has(im, 'developer_instructions = """'));
  ck('backslashes survive in literal string', has(rv, 'back\\slash and C:\\path\\n.'));
  ck('codex description escaped', has(rv, 'description = "Reviews a change against the plan. Use when: per tier (D14) | \\"quoted\\" \\\\ slash"'));
  ck('codex sandbox read-only', has(rv, 'sandbox_mode = "read-only"'));
  ck('codex sandbox workspace-write', has(im, 'sandbox_mode = "workspace-write"'));
  ck('codex default profile model', has(im, 'model = "gpt-x-mid"'));
});

test('6. roles.conf, owns.conf, tools.conf', () => {
  const R = newroot(); gen(R);
  const cp = `${R}/control-plane/agents`;
  const data = (f) => read(f).split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  ck('roles.conf has 6 fields per data line', data(`${cp}/roles.conf`).every((l) => l.split(/\s+/).length === 6));
  ck('roles.conf has 3 roles x 3 profiles x 2 runtimes', data(`${cp}/roles.conf`).length === 18);
  ck('roles.conf codex model from source', has(`${cp}/roles.conf`, 'reviewer economy codex gpt-x-small low 2'));
  ck('owns.conf reviewer line', has(`${cp}/owns.conf`, 'reviewer reviews/proof-review/'));
  ck('owns.conf cuts NNN tokens to their prefix', has(`${cp}/owns.conf`, 'implementer PRODUCT_SCOPE results/'));
  ck('owns.conf has one line per role', data(`${cp}/owns.conf`).length === 3);
  ck('tools.conf comma list', has(`${cp}/tools.conf`, 'implementer Read,Grep,Glob,Bash,Edit,Write'));
  ck('tools.conf has one line per role', data(`${cp}/tools.conf`).length === 3);
  const ow = join(T, 'ow'); mkdirSync(`${ow}/roles`, { recursive: true });
  writeFileSync(`${ow}/roles/lead.md`, read(`${R}/roles/lead.md`).split('\n').filter((l) => !l.startsWith('owns:')).join('\n'));
  ck('missing owns rejected', !ok(gen(ow)));
});

test('6c. agent names: the role id with _ -> -', () => {
  const R = newroot();
  writeFileSync(`${R}/roles/security_reviewer.md`, read(`${R}/roles/reviewer.md`).replace(/^id: reviewer .*$/m, 'id: security_reviewer'));
  gen(R);
  ck('claude agent file hyphenated', existsSync(`${R}/adapters/claude/agents/proofline-security-reviewer.md`));
  ck('claude agent name hyphenated', has(`${R}/adapters/claude/agents/proofline-security-reviewer.md`, 'name: proofline-security-reviewer'));
  ck('codex agent hyphenated', has(`${R}/adapters/codex/agents/proofline-security-reviewer.toml`, 'name = "proofline-security-reviewer"'));
  ck('role id keeps underscore in role text', existsSync(`${R}/control-plane/agents/roles/security_reviewer.md`));
  ck('role id keeps underscore in roles.conf', has(`${R}/control-plane/agents/roles.conf`, 'security_reviewer balanced claude'));
  ck('role id keeps underscore in owns.conf', has(`${R}/control-plane/agents/owns.conf`, 'security_reviewer reviews/proof-review/'));
  ck('no underscore agent file', !existsSync(`${R}/adapters/claude/agents/proofline-security_reviewer.md`));
});

test('7. determinism and --check', () => {
  const R = newroot(); gen(R);
  const again = join(T, 'again'); cpSync(R, again, { recursive: true }); gen(again);
  const tree = (d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(d.length)).sort().map((f) => [f, read(join(d, f))]);
  assert.deepEqual(tree(`${R}/adapters`), tree(`${again}/adapters`), 'deterministic output');
  ck('--check passes when in sync', ok(gen(R, '--check')));
  ck('--check says so', gen(R, '--check').stdout === 'generated files in sync\n');
  writeFileSync(`${R}/adapters/codex/agents/proofline-reviewer.toml`, `${read(`${R}/adapters/codex/agents/proofline-reviewer.toml`)}x\n`);
  const d = gen(R, '--check');
  ck('--check detects an edited file', !ok(d)); ck('--check names the file', d.stderr.includes('out of sync: adapters/codex/agents/proofline-reviewer.toml'));
  gen(R);
  writeFileSync(`${R}/control-plane/agents/owns.conf`, `${read(`${R}/control-plane/agents/owns.conf`)}x\n`);
  ck('--check detects an edited owns.conf', !ok(gen(R, '--check')));
  gen(R); rmSync(`${R}/control-plane/agents/tools.conf`);
  ck('--check detects a missing tools.conf', !ok(gen(R, '--check')));
  gen(R); rmSync(`${R}/control-plane/agents/roles/reviewer.md`);
  const m = gen(R, '--check');
  ck('--check detects a missing file', !ok(m) && m.stderr.includes('missing: control-plane/agents/roles/reviewer.md'));
  gen(R); writeFileSync(`${R}/adapters/claude/agents/proofline-ghost.md`, 'x\n');
  const s = gen(R, '--check');
  ck('--check detects a stale file', !ok(s) && s.stderr.includes('stale: adapters/claude/agents/proofline-ghost.md'));
  gen(R);
  ck('regenerate removes stale file', !existsSync(`${R}/adapters/claude/agents/proofline-ghost.md`));
  ck('--check passes again', ok(gen(R, '--check')));
  edit(`${R}/roles/reviewer.md`, (t) => t.replace(/^purpose: .*$/m, 'purpose: Changed purpose.'));
  ck('--check detects a source change', !ok(gen(R, '--check')));
  ck('--check and --out are exclusive', !ok(gen(R, '--check', '--out', join(T, 'y'))));
});

test('8. source validation', () => {
  const bad = (desc, fn) => { const R = newroot(); fn(R); ck(desc, !ok(gen(R))); };
  bad('missing frontmatter key rejected', (R) => edit(`${R}/roles/reviewer.md`, (t) => t.replace(/^stop_condition:.*\n/m, '')));
  bad('id must match file name', (R) => edit(`${R}/roles/reviewer.md`, (t) => t.replace(/^id: reviewer/m, 'id: other')));
  bad('missing codex model rejected', (R) => edit(`${R}/roles/reviewer.md`, (t) => t.replace('  max: claude=opus codex=gpt-x-big', '  max: claude=opus')));
  bad('bad sandbox rejected', (R) => edit(`${R}/roles/reviewer.md`, (t) => t.replace(/^sandbox: read-only/m, 'sandbox: full')));
  bad('malformed skill reference rejected', (R) => edit(`${R}/roles/reviewer.md`, (t) => `${t}See {{skill:Bad Name}}.\n`));
  bad('overlong description rejected', (R) => edit(`${R}/roles/reviewer.md`, (t) => t.replace(/^purpose: .*$/m, `purpose: ${'x'.repeat(1000)}`)));
  bad('frontmatter not closed rejected', (R) => edit(`${R}/roles/reviewer.md`, (t) => t.replace(/^---\n(?=#)/m, '')));
  bad('a first line that is not --- rejected', (R) => edit(`${R}/roles/reviewer.md`, (t) => `\n${t}`));
  bad('a bad role file name rejected', (R) => writeFileSync(`${R}/roles/Bad.md`, read(`${R}/roles/reviewer.md`)));
  const none = join(T, 'noroles'); mkdirSync(none);
  ck('no roles/ directory rejected', !ok(gen(none)));
});

test('9. role-source conformance: the real roles/ conform, and 25 mutations of a copy are each rejected', () => {
  const REAL = join(repo, 'roles');
  ck('real roles conform', !conform(REAL).fail);
  const neg = (desc, from, to, file) => {
    const d = join(T, 'negroot'); rmSync(d, { recursive: true, force: true }); mkdirSync(`${d}/roles`, { recursive: true });
    for (const f of readdirSync(REAL)) cpSync(join(REAL, f), `${d}/roles/${f}`);
    const t = read(`${d}/roles/${file}`);
    const u = typeof from === 'string' ? t.replace(from, to) : t.replace(from, to);
    assert.notEqual(u, t, `conformance negative did not mutate: ${desc}`);
    writeFileSync(`${d}/roles/${file}`, u);
    ck(`conformance rejects: ${desc}`, conform(`${d}/roles`).fail);
  };
  neg('key order', /^name: /m, 'nom: ', 'reviewer.md');
  neg('spawn tool', /^tools: .*$/m, '$& Agent', 'reviewer.md');
  neg('bad effort enum', /^ {2}balanced: high$/m, '  balanced: huge', 'reviewer.md');
  neg('security reviewer below opus', /^ {2}economy: claude=opus/m, '  economy: claude=sonnet', 'security_reviewer.md');
  neg('tier floor above model', /^tier_floor: 3/m, 'tier_floor: 4', 'security_reviewer.md');
  neg('sandbox parity', /^sandbox: workspace-write/m, 'sandbox: read-only', 'implementer.md');
  neg('unknown skill reference', '{{skill:proof-review}}', '{{skill:nope}}', 'reviewer.md');
  neg('inline hash in frontmatter', /^name: .*$/m, '$& # x', 'qa.md');
  neg('body section order', /^## Method$/m, '## Steps', 'explorer.md');
  neg('old severity value', 'severity `blocking`', 'severity `CRITICAL`', 'data_architect.md');
  neg('uppercase severity word', 'Severity is `info`', 'Severity is INFO', 'explorer.md');
  neg('README severity set', '`severity` is exactly `blocking` or `info`', '`severity` is CRITICAL to INFO', 'README.md');
  neg('gate finding id', '`SECURITY-<n>`', '`SEC-<n>`', 'security_reviewer.md');
  neg('task finding id', '`explorer-<n>`', '`EXPLORER-<n>`', 'explorer.md');
  neg('qa plan-step id', 'plan step `qa-<n>`', 'plan step `QA-<n>`', 'qa.md');
  neg('gate RESULT set', /^RESULT: <PASS\|FAIL\|BLOCKED>$/m, 'RESULT: <PASS|FAIL>', 'verifier.md');
  neg('task role with gate RESULT', /^RESULT: <DONE\|BLOCKED\|NEEDS_INPUT>$/m, 'RESULT: <PASS|FAIL|BLOCKED>', 'explorer.md');
  neg('no-spawn rule missing', ', spawn agents |', ' |', 'qa.md');
  neg('lead no-dispatch rule missing', 'Let a specialist dispatch another', 'Let anyone dispatch', 'lead.md');
  neg('owns without Write', /^tools: Read Grep Glob Bash Write Edit$/m, 'tools: Read Grep Glob Bash', 'reviewer.md');
  neg('Write without workspace-write', /^sandbox: workspace-write/m, 'sandbox: read-only', 'qa.md');
  neg('writes_code on a design role', /^writes_code: no/m, 'writes_code: yes', 'designer.md');
  neg('PRODUCT_SCOPE outside implementer', /^owns: .*$/m, '$& PRODUCT_SCOPE', 'reviewer.md');
  neg('implementer without PRODUCT_SCOPE', /^owns: PRODUCT_SCOPE /m, 'owns: ', 'implementer.md');
  neg('project code path owned by a non-implementer', /^owns: .*$/m, '$& /src/', 'designer.md');
  const few = join(T, 'neg'); mkdirSync(`${few}/roles`, { recursive: true });
  for (const f of readdirSync(REAL)) if (f !== 'lead.md') cpSync(join(REAL, f), `${few}/roles/${f}`);
  ck('conformance rejects wrong role count', conform(`${few}/roles`).fail);
  const cli = spawnSync(process.execPath, [join(repo, 'tests/generator/role-conformance.mjs'), 'roles'], { cwd: repo, encoding: 'utf8' });
  ck('the command line form exits 0 on the real roles', cli.status === 0 && /^ok lead \(\d+ lines\)$/m.test(cli.stdout));
  ck('problems() is empty for a conforming role', problems(read(`${REAL}/lead.md`), 'lead').length === 0);
});

test('10. parseRole: the rules of the frontmatter reader that the roles rely on', () => {
  const p = (text) => parseRole(text, 'x.md');
  assert.equal(p('---\na: "q"\nb: v   # c\npurpose: x  # y\n---\nbody\r\n').meta.get('a'), 'q');
  assert.equal(p('---\nb: v   # c\n---\n').meta.get('b'), 'v');
  assert.equal(p('---\npurpose: a # not a comment  # a comment\n---\n').meta.get('purpose'), 'a # not a comment');
  assert.equal(p('---\nm:\n  max: claude=o codex=g\n---\n').meta.get('m.max'), 'claude=o codex=g');
  assert.equal(p('---\na: 1\n---\nl1\r\nl2').body, 'l1\nl2\n');
  assert.equal(p('---\na: 1\n---\n').body, '');
  assert.throws(() => p('a: 1\n'), /first line must be ---/);
  assert.throws(() => p('---\na: 1\n'), /frontmatter not closed/);
});

test('11. nothing is written through a symbolic link, a stale agent file is replaced', () => {
  const R = newroot(); gen(R);
  const outside = join(T, 'outside'); mkdirSync(outside);
  writeFileSync(`${outside}/victim`, 'untouched\n');
  unlinkSync(`${R}/adapters/claude/agents/proofline-reviewer.md`);
  symlinkSync(`${outside}/victim`, `${R}/adapters/claude/agents/proofline-reviewer.md`);
  unlinkSync(`${R}/control-plane/agents/owns.conf`);
  symlinkSync(`${outside}/victim`, `${R}/control-plane/agents/owns.conf`);
  ck('a re-run succeeds', ok(gen(R)));
  ck('the link target is untouched', read(`${outside}/victim`) === 'untouched\n');
  ck('the names are regular files again', !lstatSync(`${R}/adapters/claude/agents/proofline-reviewer.md`).isSymbolicLink() && !lstatSync(`${R}/control-plane/agents/owns.conf`).isSymbolicLink());
  // a directory that is a link: refused
  rmSync(`${R}/adapters/codex`, { recursive: true }); symlinkSync(outside, `${R}/adapters/codex`);
  const r = gen(R);
  ck('a generated folder under a link is refused', !ok(r) && /symbolic link/.test(r.stderr));
  ck('nothing was written into the link target', readdirSync(outside).join() === 'victim');
});
