#!/usr/bin/env node
// Renders roles/<id>.md (single source, D11) into runtime formats (D6). Node since A234 (it was adapters/generate.sh).
// Usage: node adapters/generate.mjs [--check] [--target T] [--profile P] [--out DIR] [--root DIR]
//   T: claude-plugin | claude-project | codex | control-plane | docs | all   (default all)
//   --check    render in memory and fail if any generated file differs or a stale generated file exists (CI)
//   --profile  max | balanced | economy: model/effort written into the agent files (default balanced)
//   --out DIR  render into an installed project: DIR/.claude/agents, DIR/.codex/agents, DIR/.agents/roles,
//              DIR/.agents/roles.conf, owns.conf, tools.conf (used by `proofline init`)
//   --root DIR repository root holding roles/ (default: the parent of this script's directory)
// Output is deterministic: sorted roles, no timestamps. Nothing is written through a symbolic link.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILES = ['max', 'balanced', 'economy'];
const RUNTIMES = ['claude', 'codex'];

export class GenerateError extends Error {}
const die = (msg) => { throw new GenerateError(`generate.mjs: ${msg}`); };

/** The frontmatter of a role file as ordered [key, value] pairs, and its body. Same rules as the awk of generate.sh. @param {string} text @param {string} file */
export function parseRole(text, file) {
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  const lines = all.map((l) => l.replace(/\r$/, ''));
  if (lines.length === 0 || lines[0] !== '---') die(`${file}: first line must be ---`);
  const meta = new Map();
  let block = '';
  let closed = -1;
  const emit = (k, rawValue, free, top) => {
    let v = rawValue.replace(/^[ \t]+/, '');
    v = free ? v.replace(/[ \t][ \t]+#.*$/s, '') : v.replace(/[ \t]+#.*$/s, '');
    v = v.replace(/[ \t]+$/, '');
    if (v.length >= 2 && /^".*"$/s.test(v)) v = v.slice(1, -1);
    if (v === '' && top) block = k;
    else if (!meta.has(k)) meta.set(k, v);
  };
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l === '---') { closed = i; break; }
    const top = /^[A-Za-z_][A-Za-z0-9_]*:/.exec(l);
    if (top) {
      const key = top[0].slice(0, -1);
      block = '';
      emit(key, l.slice(top[0].length), key === 'purpose' || key === 'conditional' || key === 'stop_condition', true);
    } else if (block !== '' && /^[ \t]+[A-Za-z_][A-Za-z0-9_]*:/.test(l)) {
      const s = l.replace(/^[ \t]+/, '');
      const colon = s.indexOf(':');
      emit(`${block}.${s.slice(0, colon)}`, s.slice(colon + 1), false, false);
    }
  }
  if (closed < 0) die(`${file}: frontmatter not closed with ---`);
  const body = lines.slice(closed + 1);
  return { meta, body: body.length ? `${body.join('\n')}\n` : '' };
}

/** @param {string} root */
export function loadRoles(root) {
  const dir = join(root, 'roles');
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch { /* none */ }
  const roles = [];
  for (const name of names) {
    if (name === 'README.md') continue;
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    const id = name.slice(0, -3);
    if (!/^[a-z]/.test(id) || /[^a-z0-9_]/.test(id)) die(`bad role file name: ${file}`);
    const { meta, body } = parseRole(readFileSync(file, 'utf8'), file);
    const get = (k) => meta.get(k) ?? '';
    if (get('id') !== id) die(`roles/${id}.md: 'id' must equal the file name`);
    for (const k of ['name', 'purpose', 'conditional', 'owns', 'tools', 'result', 'sandbox', 'tier_floor', 'stop_condition']) if (get(k) === '') die(`roles/${id}.md: missing frontmatter key '${k}'`);
    for (const p of PROFILES) {
      for (const k of ['model', 'effort']) if (get(`${k}.${p}`) === '') die(`roles/${id}.md: missing frontmatter key '${k}.${p}'`);
      for (const rt of RUNTIMES) if (pair(get(`model.${p}`), rt) === '') die(`roles/${id}.md: model.${p} lacks ${rt}=...`);
    }
    if (!['read-only', 'workspace-write'].includes(get('sandbox'))) die(`roles/${id}.md: bad sandbox`);
    if (!['1', '2', '3'].includes(get('tier_floor'))) die(`roles/${id}.md: tier_floor must be 1..3`);
    if (Buffer.byteLength(`${get('purpose')} ${get('conditional')}`) > 900) die(`roles/${id}.md: purpose + conditional too long for a 1000-char description`);
    roles.push({ id, get, body });
  }
  if (roles.length === 0 && names.filter((n) => n !== 'README.md').length === 0) die(`no roles/*.md under ${root}`);
  return roles;
}

/** `key=value` words: the value of the first word with that key. */
function pair(words, key) {
  for (const w of words.split(' ')) if (w.startsWith(`${key}=`)) return w.slice(key.length + 1);
  return '';
}
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const cell = (s) => s.replace(/\|/g, '\\|');
const squeeze = (s) => s.replace(/ +/g, ' ');
const aname = (id) => `proofline-${id.replace(/_/g, '-')}`;
const stamp = (id) => `Generated from roles/${id}.md by adapters/generate.mjs. Do not edit.`;

/** {{skill:x}} -> prefix + x + suffix; a reference that stays malformed is an error. */
function bodyFor(role, prefix, suffix) {
  const out = role.body.replace(/\{\{skill:([A-Za-z0-9_-]+)\}\}/g, (_, name) => `${prefix}${name}${suffix}`);
  if (out.includes('{{skill:')) die(`roles/${role.id}.md: malformed {{skill:...}} reference`);
  return out;
}
const description = (r) => `${r.get('purpose').replace(/\.$/, '')}. Use when: ${r.get('conditional')}`;

function renderClaude(r, mode, profile) {
  const pre = mode === 'plugin' ? '${CLAUDE_PLUGIN_ROOT}/skills/' : '.agents/skills/';
  return [
    `---\nname: ${aname(r.id)}\n`,
    `description: "${esc(description(r))}"\n`,
    `tools: ${squeeze(r.get('tools')).replace(/ /g, ', ')}\n`,
    `model: ${pair(r.get(`model.${profile}`), 'claude')}\n`,
    `effort: ${r.get(`effort.${profile}`)}\n`,
    `---\n<!-- ${stamp(r.id)} -->\n`,
    bodyFor(r, pre, '/SKILL.md'),
  ].join('');
}

function renderCodex(r, profile) {
  const cx = bodyFor(r, '.agents/skills/', '/SKILL.md');
  const head = [
    `# ${stamp(r.id)}\n`,
    `name = "${aname(r.id)}"\n`,
    `description = "${esc(description(r))}"\n`,
    `model = "${esc(pair(r.get(`model.${profile}`), 'codex'))}"\n`,
    `model_reasoning_effort = "${esc(r.get(`effort.${profile}`))}"\n`,
    `sandbox_mode = "${r.get('sandbox')}"\n`,
  ].join('');
  // a literal string cannot hold ''' : fall back to a basic multi-line string
  if (cx.includes("'''")) return `${head}developer_instructions = """\n${esc(cx)}"""\n`;
  return `${head}developer_instructions = '''\n${cx}'''\n`;
}

const renderRoleText = (r) => `<!-- ${stamp(r.id)} -->\n${bodyFor(r, '.agents/skills/', '/SKILL.md')}`;

function renderOwns(roles) {
  return [
    '# Paths each role may write (PreToolUse hook, dispatch.sh). Generated from roles/<role>.md owns:; do not edit.\n',
    '# <role> <token>...  token: run-relative path | /project-relative path | PRODUCT_SCOPE (frozen PLAN scope);\n',
    '# a token ending in / covers its subtree, any other token is one exact file; NNN = three digits\n',
    ...roles.map((r) => `${r.id} ${squeeze(r.get('owns'))}\n`),
  ].join('');
}

const renderTools = (roles) => ['# Claude tools per role. Generated from roles/<role>.md tools:; do not edit.\n',
  ...roles.map((r) => `${r.id} ${r.get('tools').replace(/ +/g, ',')}\n`)].join('');

function renderConf(roles) {
  const out = [
    '# Execution policy per role (D5). Generated from roles/<role>.md by adapters/generate.mjs; do not edit.\n',
    '# One line per role, profile and runtime: role profile runtime model effort tier_floor\n',
    '# model: the model name of that runtime. effort: reasoning effort for the profile.\n',
    '# tier_floor: minimum capability tier the role may run on (failover and overrides never go below it).\n',
  ];
  for (const r of roles) for (const p of PROFILES) for (const rt of RUNTIMES) out.push(`${r.id} ${p} ${rt} ${pair(r.get(`model.${p}`), rt)} ${r.get(`effort.${p}`)} ${r.get('tier_floor')}\n`);
  return out.join('');
}

function renderDoc(roles) {
  const out = [
    '<!-- Generated from roles/ — do not edit. Run adapters/generate.mjs. -->\n\n# Roles reference\n\n',
    'Generated from roles/ — do not edit.\n\n',
    '| Role | Purpose | Dispatched | Result | Gates | Skills | Writes code | Sandbox | Tier floor |\n',
    '|---|---|---|---|---|---|---|---|---|\n',
  ];
  for (const r of roles) {
    const g = r.get;
    out.push(`| [\`${r.id}\`](#${r.id}) | ${cell(g('purpose'))} | ${cell(g('conditional'))} | ${g('result')} | ${cell(g('gate'))} | ${cell(g('skills'))} | ${g('writes_code')} | ${g('sandbox')} | ${g('tier_floor')} |\n`);
  }
  for (const r of roles) {
    const g = r.get;
    out.push(`\n## ${r.id}\n\n${g('purpose')}\n\n`);
    out.push(`- Name: ${g('name')}\n- Agent: ${r.id === 'lead' ? 'none (main session)' : aname(r.id)}\n- Dispatched: ${g('conditional')}\n- Reads: ${g('reads')}\n- Owns: ${g('owns')}\n- Skills: ${g('skills')}\n`);
    out.push(`- Gates: ${g('gate')}\n- Result protocol: ${g('result')}\n- Tools: ${g('tools')}\n- Sandbox: ${g('sandbox')}\n- Tier floor: ${g('tier_floor')}\n`);
    out.push(`- Timeout: ${g('timeout_seconds')} s\n- Stop condition: ${g('stop_condition')}\n\n`);
    out.push('| Profile | Claude model | Codex model | Effort |\n|---|---|---|---|\n');
    for (const p of PROFILES) out.push(`| ${p} | ${pair(g(`model.${p}`), 'claude')} | ${pair(g(`model.${p}`), 'codex')} | ${g(`effort.${p}`)} |\n`);
  }
  return out.join('');
}

/**
 * What a run writes: `files` (relative path -> text) and `clean` (directories whose generated files a real run removes first).
 * @param {ReturnType<typeof loadRoles>} roles @param {{ layout: 'repo' | 'project', targets: string[], profile: string }} o
 */
export function plan(roles, { layout, targets, profile }) {
  const repo = layout === 'repo';
  const P = repo
    ? { claude: 'adapters/claude/agents', codex: 'adapters/codex/agents', roles: 'control-plane/agents/roles', ag: 'control-plane/agents', doc: 'docs/reference/roles.md' }
    : { claude: '.claude/agents', codex: '.codex/agents', roles: '.agents/roles', ag: '.agents', doc: '' };
  /** @type {Map<string, string>} */ const files = new Map();
  /** @type {{ dir: string, match: RegExp }[]} */ const clean = [];
  for (const t of targets) {
    if (t === 'claude-plugin' || t === 'claude-project') {
      clean.push({ dir: P.claude, match: /^proofline-.*\.md$/ });
      for (const r of roles) if (r.id !== 'lead') files.set(`${P.claude}/${aname(r.id)}.md`, renderClaude(r, t.slice('claude-'.length), profile));
    } else if (t === 'codex') {
      clean.push({ dir: P.codex, match: /^proofline-.*\.toml$/ });
      for (const r of roles) if (r.id !== 'lead') files.set(`${P.codex}/${aname(r.id)}.toml`, renderCodex(r, profile));
    } else if (t === 'control-plane') {
      clean.push({ dir: P.roles, match: /\.md$/ });
      for (const r of roles) files.set(`${P.roles}/${r.id}.md`, renderRoleText(r));
      files.set(`${P.ag}/roles.conf`, renderConf(roles));
      files.set(`${P.ag}/owns.conf`, renderOwns(roles));
      files.set(`${P.ag}/tools.conf`, renderTools(roles));
    } else if (t === 'docs') files.set(P.doc, renderDoc(roles));
  }
  return { files, clean };
}

/** Refuses a path that is, or sits under, a symbolic link (below base). @param {string} base @param {string} rel */
function assertPlain(base, rel) {
  let p = base;
  for (const seg of rel.split('/')) {
    p = join(p, seg);
    let st = null;
    try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink() && seg !== rel.split('/').at(-1)) die(`${join(base, rel)} is a symbolic link or sits under one; not written`);
  }
}

/** Writes a plan under base: stale generated files go first, each file is replaced (never written through a link). */
export function write(base, { files, clean }) {
  for (const { dir } of clean) assertPlain(base, `${dir}/x`);
  for (const rel of files.keys()) assertPlain(base, rel);
  for (const { dir, match } of clean) {
    mkdirSync(join(base, dir), { recursive: true });
    for (const n of readdirSync(join(base, dir))) if (match.test(n)) { try { if (!lstatSync(join(base, dir, n)).isDirectory()) unlinkSync(join(base, dir, n)); } catch { /* gone */ } }
  }
  for (const [rel, text] of files) {
    const to = join(base, rel);
    mkdirSync(dirname(to), { recursive: true });
    try { unlinkSync(to); } catch { /* new file */ }
    writeFileSync(to, text, { flag: 'wx' });
  }
}

/** The differences between a plan and the files under root: lines for stderr. */
export function drift(root, { files, clean }) {
  const out = [];
  for (const rel of [...files.keys()].sort()) {
    const f = join(root, rel);
    if (!existsSync(f) || !statSync(f).isFile()) out.push(`missing: ${rel}`);
    else if (readFileSync(f, 'utf8') !== files.get(rel)) out.push(`out of sync: ${rel}`);
  }
  for (const { dir, match } of clean) {
    let names = [];
    try { names = readdirSync(join(root, dir)).sort(); } catch { /* none */ }
    for (const n of names) {
      if (!match.test(n)) continue;
      let isFile = false; try { isFile = statSync(join(root, dir, n)).isFile(); } catch { /* dangling */ }
      if (isFile && !files.has(`${dir}/${n}`)) out.push(`stale: ${dir}/${n}`);
    }
  }
  return out;
}

const USAGE = `Usage: node adapters/generate.mjs [--check] [--target T] [--profile P] [--out DIR] [--root DIR]
  T: claude-plugin | claude-project | codex | control-plane | docs | all   (default all)
  --check    render in memory and fail if any generated file differs or a stale generated file exists (CI)
  --profile  max | balanced | economy: model/effort written into the agent files (default balanced)
  --out DIR  render into an installed project (used by \`proofline init\`)
  --root DIR repository root holding roles/ (default: the parent of this script's directory)
`;

/** @param {string[]} argv @returns {{ code: number, out: string, err: string }} */
export function main(argv) {
  const o = { check: false, target: 'all', profile: 'balanced', out: '', root: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--check') o.check = true;
      else if (['--target', '--profile', '--out', '--root'].includes(a)) { if (i + 1 >= argv.length) die(`${a} needs a value`); o[a.slice(2)] = argv[++i]; }
      else if (a === '-h' || a === '--help') return { code: 0, out: USAGE, err: '' };
      else die(`unknown argument: ${a}`);
    }
    if (!PROFILES.includes(o.profile)) die(`bad --profile: ${o.profile}`);
    if (!existsSync(join(o.root, 'roles')) || !statSync(join(o.root, 'roles')).isDirectory()) die(`no roles/ directory under ${o.root}`);
    if (o.check && o.out !== '') die('--check and --out cannot be combined');
    const layout = o.out !== '' ? 'project' : 'repo';
    let targets;
    if (o.target === 'all') targets = layout === 'repo' ? ['claude-plugin', 'codex', 'control-plane', 'docs'] : ['claude-project', 'codex', 'control-plane'];
    else {
      if (['claude-plugin', 'docs'].includes(o.target)) { if (layout !== 'repo') die(`target ${o.target} renders into the repository (no --out)`); }
      else if (o.target === 'claude-project') { if (layout !== 'project') die('target claude-project needs --out DIR'); }
      else if (!['codex', 'control-plane'].includes(o.target)) die(`unknown --target: ${o.target}`);
      targets = [o.target];
    }
    const roles = loadRoles(o.root);
    const p = plan(roles, { layout, targets, profile: o.profile });
    if (o.out !== '') { mkdirSync(o.out, { recursive: true }); write(o.out, p); return { code: 0, out: '', err: '' }; }
    if (!o.check) { write(o.root, p); return { code: 0, out: '', err: '' }; }
    const d = drift(o.root, p);
    if (d.length) return { code: 1, out: '', err: `${d.join('\n')}\ngenerate.mjs: generated files are out of sync; run node adapters/generate.mjs\n` };
    return { code: 0, out: 'generated files in sync\n', err: '' };
  } catch (e) {
    if (e instanceof GenerateError) return { code: 1, out: '', err: `${e.message}\n` };
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = main(process.argv.slice(2));
  process.stdout.write(r.out); process.stderr.write(r.err);
  process.exitCode = r.code;
}
