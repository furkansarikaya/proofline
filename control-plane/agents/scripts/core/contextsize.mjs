// @ts-check
// Context size (A202, A230; the former bin/lib/context-size.sh): the size of the text proofline puts into the model's context without being asked.
// One module, three users: `proofline doctor`, `proofline insights` and the budget test (tests/context/context-budget-test.sh).
// Items: the proofline block of AGENTS.md and CLAUDE.md, the text the SessionStart hook adds, the entry skill, and per role its agent file and the first SKILL.md the
// role reads (the first name of `skills:` in roles/<role>.md). The lead has no agent file: its first skill is proofline-lead. Estimated tokens are bytes / 4.
// The SessionStart text is the file adapters/claude/hooks/lib/session-head.txt (a template, placeholders unexpanded), which the hook fills in: nothing here reads
// the hook's source code.
//   repo     ROOT is a proofline checkout (control-plane/, adapters/, roles/, skills/)
//   project  ROOT is an installed project; a file missing there falls back to the proofline checkout HOME
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

/** @typedef {{ name: string, bytes: number, tokens: number, path: string }} Row */

/** @param {string} f */
const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
/** @param {string} d */
const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
/** @param {string} f */
const size = (f) => statSync(f).size;

/** The bytes of the marked proofline block of a project file, or of the whole file plus its two markers (48) for a repo template. @param {string} f */
function blockBytes(f) {
  const t = readFileSync(f, 'latin1');
  const lines = t.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.includes('<!-- proofline:begin -->')) return size(f) + 48;
  let n = 0; let inside = false;
  for (const l of lines) {
    if (l === '<!-- proofline:begin -->') inside = true;
    if (inside) n += l.length + 1;
    if (l === '<!-- proofline:end -->') inside = false;
  }
  return n;
}

/** The first skill a role reads: the first token after `skills:` on its first such line. @param {string} f */
function firstSkill(f) {
  for (const l of readFileSync(f, 'latin1').split('\n')) {
    const m = /^skills:[ \t\n\v\f\r]*([^ \t\n\v\f\r]*)/.exec(l);
    if (m) return m[1];
  }
  return '';
}

/** The size of the SessionStart template: the file without one trailing newline. @param {string} f */
function headBytes(f) { const t = readFileSync(f, 'latin1'); return t.endsWith('\n') ? t.length - 1 : t.length; }

/**
 * The measured items of a checkout or an installed project.
 * @param {'repo' | 'project'} mode @param {string} root @param {string} home the proofline checkout a project falls back to
 * @returns {Row[]}
 */
export function contextRows(mode, root, home) {
  /** @type {Row[]} */ const rows = [];
  /** @param {string} name @param {number} bytes @param {string} p */
  const row = (name, bytes, p) => rows.push({ name, bytes, tokens: Math.floor((bytes + 3) / 4), path: p });
  /** @param {string} a @param {string} b */
  const pick = (a, b) => (isFile(`${root}/${a}`) ? `${root}/${a}` : isFile(`${home}/${b}`) ? `${home}/${b}` : '');
  let fa; let fc; let fh; let fe; let roles; let agents; let skills;
  if (mode === 'repo') {
    fa = `${root}/control-plane/AGENTS.md`; fc = `${root}/control-plane/CLAUDE.md`; fh = `${root}/adapters/claude/hooks/lib/session-head.txt`;
    fe = `${root}/skills/proofline/SKILL.md`; roles = `${root}/roles`; agents = `${root}/adapters/claude/agents`; skills = `${root}/skills`;
  } else {
    fa = `${root}/AGENTS.md`; fc = `${root}/CLAUDE.md`;
    fh = pick('.agents/hooks/lib/session-head.txt', 'adapters/claude/hooks/lib/session-head.txt');
    fe = pick('.claude/skills/proofline/SKILL.md', 'skills/proofline/SKILL.md');
    roles = `${root}/.agents/roles`; agents = `${root}/.claude/agents`; skills = `${root}/.agents/skills`;
    if (!isDir(roles)) roles = `${home}/roles`;
    if (!isDir(agents)) agents = `${home}/adapters/claude/agents`;
    if (!isDir(skills)) skills = `${home}/skills`;
  }
  if (isFile(fa)) row('agents_md', blockBytes(fa), fa);
  if (isFile(fc)) row('claude_md', blockBytes(fc), fc);
  if (fh !== '' && isFile(fh)) row('session_start', headBytes(fh), fh);
  if (fe !== '' && isFile(fe)) row('entry_skill', size(fe), fe);
  if (isFile(`${skills}/proofline-lead/SKILL.md`)) row('role.lead.skill', size(`${skills}/proofline-lead/SKILL.md`), `${skills}/proofline-lead/SKILL.md`);
  /** @type {string[]} */ let files = [];
  try { files = readdirSync(roles).filter((n) => n.endsWith('.md')).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); } catch { files = []; }
  for (const n of files) {
    const f = `${roles}/${n}`;
    if (!isFile(f)) continue;
    const r = n.slice(0, -3);
    if (r === 'lead' || r === 'README') continue;
    const a = `${agents}/proofline-${r.replace(/_/g, '-')}.md`;
    if (isFile(a)) row(`role.${r}.agent`, size(a), a);
    const s = firstSkill(f);
    if (s !== '' && isFile(`${skills}/${s}/SKILL.md`)) row(`role.${r}.skill`, size(`${skills}/${s}/SKILL.md`), `${skills}/${s}/SKILL.md`);
  }
  return rows;
}

/** `tsv`: name TAB bytes TAB tokens TAB path. @param {Row[]} rows */
export const tsvText = (rows) => rows.map((r) => `${r.name}\t${r.bytes}\t${r.tokens}\t${r.path}\n`).join('');

/** `report`: what loads without being asked, for the lead session and each role. @param {Row[]} rows */
export function reportText(rows) {
  /** @type {Map<string, Row>} */ const by = new Map(rows.map((r) => [r.name, r]));
  const b = (/** @type {string} */ n) => by.get(n)?.bytes ?? 0;
  const t = (/** @type {string} */ n) => by.get(n)?.tokens ?? 0;
  const line = (/** @type {string} */ label, /** @type {number} */ bytes, /** @type {number} */ tok) => `  ${label.padEnd(34)} ${String(bytes).padStart(7)} bytes  ~${String(tok).padStart(5)} tokens\n`;
  const common = b('agents_md') + b('claude_md');
  let out = 'context loaded without being asked (estimated tokens = bytes / 4):\n';
  out += line('AGENTS.md proofline block', b('agents_md'), t('agents_md'));
  out += line('CLAUDE.md proofline block', b('claude_md'), t('claude_md'));
  out += line('SessionStart text (template)', b('session_start'), t('session_start'));
  out += line('entry skill', b('entry_skill'), t('entry_skill'));
  let c = common + b('session_start') + b('entry_skill') + b('role.lead.skill');
  out += line('lead session (all of the above + lead skill)', c, Math.floor((c + 3) / 4));
  for (const r of rows) {
    const m = /^role\.(.*)\.agent$/.exec(r.name);
    if (!m) continue;
    c = common + b(`role.${m[1]}.agent`) + b(`role.${m[1]}.skill`);
    out += line(`${m[1]} (blocks + agent file + first skill)`, c, Math.floor((c + 3) / 4));
  }
  return out;
}

/**
 * `check`: the lines that fail (an item above its budget, an item without a budget line, a budget line whose item is not measured).
 * @param {Row[]} rows @param {string} budgetText the budget file: name TAB max-bytes, `#` comments and blank lines skipped @returns {string[]}
 */
export function checkBudget(rows, budgetText) {
  /** @type {Map<string, number>} */ const max = new Map();
  for (const l of budgetText.split('\n')) {
    if (l.startsWith('#') || /^[ \t\n\v\f\r]*$/.test(l)) continue;
    const p = l.split('\t');
    max.set(p[0], Number.parseInt(p[1] ?? '', 10) || 0);
  }
  /** @type {string[]} */ const bad = [];
  /** @type {Set<string>} */ const seen = new Set();
  for (const r of rows) {
    const m = max.get(r.name);
    if (m === undefined) { bad.push(`FAIL ${r.name}: ${r.bytes} bytes and no budget line (add one to the budget file, with a reason in the PR)`); continue; }
    seen.add(r.name);
    if (r.bytes > m) bad.push(`FAIL ${r.name}: ${r.bytes} bytes is above its budget of ${m} (+${r.bytes - m})`);
  }
  for (const k of max.keys()) if (!seen.has(k)) bad.push(`FAIL ${k}: budget line but the item is not measured any more`);
  return bad;
}

/** Does the path exist? Used by the command to refuse a missing root. @param {string} p */
export const rootExists = (p) => existsSync(p) && isDir(p);
