// @ts-check
// Path classification of agent.sh for the leaf commands: the ecosystem sets (read as data from ecosystems.tsv, never branching on an
// ecosystem), the knowledge scope, document paths, test paths, path kinds, scope-kind rows and design surfaces. Local to the tools package;
// the run library has its own readers of the same facts (NEEDS-LATER: one copy).
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BridgeToShell } from './errors.mjs';
import { isFile } from './paths.mjs';
import { asciiLower, caseMatch, expandWords, pathMatches } from './shellglob.mjs';

/** @typedef {import('./context.mjs').Context} Context */

export const TEST_PATH_GLOBS = '**/test/** **/tests/** **/__tests__/** *_test.* *.test.* *.spec.* test_*.* *Test.* *Tests.*';
export const EXECUTABLE_CODE_DEFAULT = '*.go *.py *.pyw *.js *.mjs *.cjs *.jsx *.ts *.mts *.cts *.tsx *.java *.kt *.kts *.scala *.groovy *.rs *.c *.cc *.cpp *.cxx *.h *.hh *.hpp *.cs *.fs *.vb *.rb *.php *.swift *.m *.mm *.dart *.lua *.pl *.pm *.r *.jl *.ex *.exs *.erl *.hs *.ml *.clj *.sh *.bash *.zsh *.fish *.ps1 *.bat *.cmd *.sql *.vue *.svelte *.gradle';

/** `[ -s F ]` @param {string} f */
function nonEmptyFile(f) { try { return statSync(f).size > 0; } catch { return false; } }

/**
 * The ecosystem sets of agent.sh's start (eco_risky_set, eco_dependency_set, eco_loaded).
 * @param {Context} ctx
 * @returns {{ loaded: boolean, risky: string, dependency: string }}
 */
export function ecoSets(ctx) {
  let tsv = `${ctx.agents}/ecosystems.tsv`;
  let sh = `${ctx.scripts}/ecosystems.sh`;
  if (!nonEmptyFile(tsv) || !isFile(sh)) {
    const ship = path.resolve(ctx.scriptDir, '..');
    if (ship !== ctx.agents && nonEmptyFile(`${ship}/ecosystems.tsv`) && isFile(`${ship}/scripts/ecosystems.sh`)) { tsv = `${ship}/ecosystems.tsv`; sh = `${ship}/scripts/ecosystems.sh`; }
  }
  if (!isFile(sh) || !nonEmptyFile(tsv)) return { loaded: false, risky: '', dependency: '' };
  let text;
  try { text = readFileSync(tsv, 'latin1'); } catch { return { loaded: false, risky: '', dependency: '' }; }
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const RD = new Set(['risky_paths', 'manifests', 'locks', 'settings']);
  const DEP = new Set(['manifests', 'locks', 'settings']);
  const rs = new Set(); const ds = new Set();
  let rl = ''; let dl = '';
  for (const row of rows) {
    const f = row.split('\t');
    const id = f[0] ?? ''; const key = f[1] ?? ''; const val = f[2] ?? '';
    if ((id === '*' && key === 'risky_paths') || (id !== '*' && RD.has(key))) { if (!rs.has(val)) { rs.add(val); rl = `${rl}${rl === '' ? '' : ' '}${val}`; } }
    if (id !== '*' && DEP.has(key)) { if (!ds.has(val)) { ds.add(val); dl = `${dl}${dl === '' ? '' : ' '}${val}`; } }
  }
  const both = `${rl}\n${dl}`.replace(/\n+$/, '');
  const nl = both.indexOf('\n');
  return { loaded: true, risky: nl < 0 ? both : both.slice(0, nl), dependency: nl < 0 ? both : both.slice(nl + 1) };
}

/** The per-invocation view the classifiers need. */
export class PathKinds {
  /** @param {Context} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.config();
    /** @type {ReturnType<typeof ecoSets> | null} */ this._eco = null;
    /** @type {string[] | null} */ this._ks = null;
    /** @type {string[] | null} */ this._docEntries = null;
  }

  eco() { if (!this._eco) this._eco = ecoSets(this.ctx); return this._eco; }

  /** `design_surface_names`: the surface names in config order. */
  surfaceNames() {
    const prefix = 'design_docs.design.surfaces.';
    /** @type {string[]} */ const out = [];
    for (const l of this.cfg.lines) {
      if (!l.startsWith(prefix)) continue;
      const r = l.slice(prefix.length);
      const n = r.indexOf('.');
      if (n > 0) { const s = r.slice(0, n); if (!out.includes(s)) out.push(s); }
    }
    for (const s of out) if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new BridgeToShell('unusual surface name');
    return out;
  }

  /** `design_doc_paths`, one entry per output line. */
  designDocPaths() {
    const c = this.cfg;
    /** @type {string[]} */ const out = [];
    for (const k of ['architecture', 'data_model', 'api']) { const v = c.get(`design_docs.${k}`, ''); if (v !== '') out.push(v); }
    const names = this.surfaceNames();
    if (names.length === 0) { const v = c.get('design_docs.design', ''); if (v !== '') out.push(v); return out; }
    let v = c.get('design_docs.design.shared', ''); if (v !== '') out.push(v);
    for (const s of names) { v = c.get(`design_docs.design.surfaces.${s}.doc`, ''); if (v !== '') out.push(v); }
    return out;
  }

  /** The words of the loop in `in_knowledge_scope` (knowledge_scope_entries, then field splitting and pathname expansion). */
  knowledgeEntries() {
    if (this._ks) return this._ks;
    let r = this.cfg.get('knowledge_scope_root', 'docs/design/ docs/adr/ docs/wiki/ docs/product/');
    for (const p of this.designDocPaths().join('\n').split(/[ \t\n]+/)) if (p !== '') r = `${r} ${p}`;
    const adr = this.cfg.get('design_docs.adr_dir', '');
    if (adr !== '') r = `${r} ${adr.replace(/\/$/, '')}/`;
    this._ks = expandWords(r, this.ctx.cwd);
    return this._ks;
  }

  /** `in_knowledge_scope PATH` @param {string} p */
  inKnowledgeScope(p) {
    for (const e of this.knowledgeEntries()) {
      if (e.endsWith('/')) { if (p.startsWith(e)) return true; } else if (p === e) return true;
    }
    return false;
  }

  /** `is_doc_path PATH` @param {string} p */
  isDocPath(p) {
    if (this.inKnowledgeScope(p)) return true;
    if (!this._docEntries) this._docEntries = expandWords(this.cfg.get('verification.doc_paths', 'docs/ *.md *.mdx *.rst *.adoc'), this.ctx.cwd);
    for (const e of this._docEntries) {
      if (e.endsWith('/')) { if (p.startsWith(e)) return true; } else if (e.startsWith('*.')) { if (p.endsWith(e.slice(1))) return true; } else if (p === e) return true;
    }
    return false;
  }

  /** `path_kind PATH` -> content | code @param {string} p */
  pathKind(p) {
    if (p.includes('\n')) throw new BridgeToShell('newline in a path');
    if (p !== '' && pathMatches(p, this.cfg.get('review.executable_code', EXECUTABLE_CODE_DEFAULT))) return 'code';
    return this.isDocPath(p) ? 'content' : 'code';
  }

  /** `test_code_path PATH` @param {string} p */
  testCodePath(p) {
    const b = p.slice(p.lastIndexOf('/') + 1);
    if (!pathMatches(p, TEST_PATH_GLOBS)) return false;
    const eco = this.eco();
    if (!eco.loaded) return false;
    if (pathMatches(p, `${eco.risky} ${eco.dependency} ${this.cfg.get('review.risky_paths', '')}`)) return false;
    const deny = ['*lock*', '.env*', '*.env', 'Dockerfile*', 'docker-compose*', 'compose.*', 'Makefile', '*config*', '*.conf', '*.cfg', '*.ini', '*.toml', '*require*', '*constrain*', '*depend*', 'openapi*', 'swagger*', '*.proto', '*.graphql', '*.gql', '*.sql', '*.json', '*.yaml', '*.yml', '*.xml', '*.properties', '.*rc'];
    if (deny.some((g) => caseMatch(g, b))) return false;
    const allow = ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.py', '*.go', '*.rs', '*.java', '*.kt', '*.rb', '*.php', '*.cs', '*.swift', '*.sh', '*.scala', '*.ex', '*.exs', '*_test.*', '*.test.*', '*.spec.*', 'test_*.*', '*Test.*', '*Tests.*'];
    return allow.some((g) => caseMatch(g, b));
  }

  /** `derived_kind PATH` @param {string} p */
  derivedKind(p) { return this.testCodePath(p) ? 'test' : this.pathKind(p); }

  /** `effective_kind PATH CLAIM` @param {string} p @param {string} claim */
  effectiveKind(p, claim) {
    const d = this.derivedKind(p);
    const c = claim === 'doc' ? 'content' : claim;
    return c === '' || c === d ? d : 'code';
  }
}

/**
 * The scope section of a PLAN.md as the awk programs of agent.sh read it: lines between `scope:` and the first `---`.
 * @param {string} text @returns {string[]}
 */
function scopeLines(text) {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  /** @type {string[]} */ const out = [];
  let inside = false;
  for (const l of rows) {
    if (!inside) { if (l === 'scope:') inside = true; continue; }
    if (l === '---') break;
    out.push(l);
  }
  return out;
}

/** `scope_mappings` paths (the output lines, whatever the exit status): `path|criteria` for each entry. @param {string} text */
export function scopeMappingPaths(text) {
  /** @type {string[]} */ const out = [];
  let p = '';
  for (const l of scopeLines(text)) {
    if (l.startsWith('  - path: ')) { p = l.slice(10); continue; }
    if (l.startsWith('    criteria: [')) {
      let c = l.slice(15);
      c = c.replace(/\]$/, '');
      if (!(p === '' || c === '')) out.push(`${p}|${c}`);
      p = '';
    }
  }
  return out;
}

/** `plan_kind_claims`: `path|kind`. @param {string} text */
export function planKindClaims(text) {
  /** @type {string[]} */ const out = [];
  let p = '';
  for (const l of scopeLines(text)) {
    if (l.startsWith('  - path: ')) { p = l.slice(10); continue; }
    if (l.startsWith('    kind: ')) out.push(`${p}|${l.slice(10).replace(/["' ]/g, '')}`);
  }
  return out;
}

/** `parse_tdd_exemptions`: `path|reason`. @param {string} text */
export function tddExemptions(text) {
  /** @type {string[]} */ const out = [];
  let p = '';
  for (const l of scopeLines(text)) {
    if (l.startsWith('  - path: ')) { p = l.slice(10); continue; }
    if (l.startsWith('    tdd_exemption: ')) out.push(`${p}|${l.slice(18)}`);
  }
  return out;
}

/**
 * `scope_kind_rows PLAN`: path, claimed, derived, effective, exempt per scope path.
 * @param {PathKinds} pk @param {string} text the PLAN.md
 */
export function scopeKindRows(pk, text) {
  const claims = planKindClaims(text);
  const exempt = tddExemptions(text);
  // `for p in $(... | cut -d '|' -f1)`: split into words
  const words = scopeMappingPaths(text).map((l) => l.split('|')[0]).join('\n').split(/[ \t\n]+/).filter((w) => w !== '');
  for (const w of words) if (/[*?[\\]/.test(w)) throw new BridgeToShell('glob character in a scope path');
  /** @type {string[]} */ const rows = [];
  for (const p of words) {
    const cl = claims.find((l) => l.includes(`${p}|`));
    const claim = cl === undefined ? '' : (cl.split('|')[1] ?? '');
    const ex = exempt.find((l) => l.includes(`${p}|`));
    const x = ex !== undefined && ex.slice(ex.indexOf('|') + 1) !== '' ? 'yes' : 'no';
    rows.push(`${p}\t${claim === '' ? '-' : claim}\t${pk.derivedKind(p)}\t${pk.effectiveKind(p, claim)}\t${x}\n`);
  }
  return rows.join('');
}

/**
 * `design_glob_one PATH GLOB`: the glob as a case pattern, `**` followed by `/` also matching zero directories.
 * @param {string} p @param {string} g
 * @returns {boolean}
 */
function designGlobOne(p, g) {
  if (caseMatch(g, p)) return true;
  const i = g.indexOf('**/');
  if (i < 0) return false;
  return designGlobOne(p, g.slice(0, i) + g.slice(i + 3));
}

/** `design_glob_match PATH GLOBS` @param {string} p @param {string} globs */
export function designGlobMatch(p, globs) {
  let rest = globs;
  for (;;) {
    rest = rest.replace(/^ +/, '');
    if (rest === '') return false;
    const sp = rest.indexOf(' ');
    let g = sp < 0 ? rest : rest.slice(0, sp);
    rest = sp < 0 ? '' : rest.slice(sp);
    if (g.startsWith('./')) g = g.slice(2);
    if (g.endsWith('/')) g = `${g}*`;
    if (designGlobOne(p, g)) return true;
  }
}

/** Lower-case helper re-exported for the callers that fold ASCII. */
export { asciiLower };
