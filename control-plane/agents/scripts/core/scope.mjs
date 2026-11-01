// @ts-check
// Path questions every fingerprint and signal shares: gitignore-like globs (`path_matches`, the awk g2re), the knowledge scope and the
// design documents of the config, the files `proofline upgrade` installs (control plane, not product), the proofline block of
// AGENTS.md and CLAUDE.md. Ecosystem names never appear here (A187): ecosystem sets arrive as data (ecosystems.mjs / ecosystems.json).
import { isFile } from './paths.mjs';
import { WS, fileText, installedManifest, textLines } from './records.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The `g2re` awk function: a glob to an anchored regular expression (`**` spans directories, `*` and `?` stay in one segment, a pattern without `/` matches at any depth). @param {string} pat */
export function globToRegex(pat) {
  let p = pat;
  if (!p.includes('/')) p = `**/${p}`;
  let r = '';
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { r += '(?:[^]*/)?'; i += 2; } else { r += '[^]*'; i++; }
      } else r += '[^/]*';
    } else if (c === '?') r += '[^/]';
    else if ('.+()|^$[]{}\\'.includes(c)) r += `\\${c}`;
    else r += c;
  }
  return new RegExp(`^${r}$`);
}

/** Space (blank) separated words, like awk's split(s, a, " "). @param {string} s */
export function words(s) { return s.split(new RegExp(`${WS}+`)).filter((x) => x !== ''); }

/** @type {Map<string, RegExp>} */
const globCache = new Map();
/** @param {string} g */
function glob(g) { let re = globCache.get(g); if (!re) { re = globToRegex(g); globCache.set(g, re); } return re; }

/** `path_matches PATH "GLOB GLOB ..."` @param {string} p @param {string} pats */
export function pathMatches(p, pats) {
  for (const g of words(pats)) if (glob(g).test(p)) return true;
  return false;
}

/** The first glob of PATS that matches the path, or null. @param {string} p @param {string[]} globs */
export function firstGlob(p, globs) {
  for (const g of globs) if (g !== '' && glob(g).test(p)) return g;
  return null;
}

/** `design_surface_names`: the surface names in config order. @param {Context} ctx */
export function designSurfaceNames(ctx) {
  const prefix = 'design_docs.design.surfaces.';
  const seen = new Set();
  /** @type {string[]} */ const out = [];
  for (const line of ctx.config().lines) {
    if (!line.startsWith(prefix)) continue;
    const r = line.slice(prefix.length);
    const n = r.indexOf('.');
    if (n > 0) { const s = r.slice(0, n); if (!seen.has(s)) { seen.add(s); out.push(s); } }
  }
  return out;
}

/** `design_doc_paths`: every design document of the config. @param {Context} ctx @returns {string[]} */
export function designDocPaths(ctx) {
  const cfg = ctx.config();
  /** @type {string[]} */ const out = [];
  for (const k of ['architecture', 'data_model', 'api']) { const v = cfg.get(`design_docs.${k}`, ''); if (v !== '') out.push(v); }
  const names = designSurfaceNames(ctx);
  if (names.length === 0) { const v = cfg.get('design_docs.design', ''); if (v !== '') out.push(v); return out; }
  let v = cfg.get('design_docs.design.shared', ''); if (v !== '') out.push(v);
  for (const s of names) { v = cfg.get(`design_docs.design.surfaces.${s}.doc`, ''); if (v !== '') out.push(v); }
  return out;
}

/** `knowledge_scope_entries`: the entries (a directory entry ends in /). @param {Context} ctx @returns {string[]} */
export function knowledgeScopeEntries(ctx) {
  return ctx.once('knowledge-scope', () => {
    const cfg = ctx.config();
    let r = cfg.get('knowledge_scope_root', 'docs/design/ docs/adr/ docs/wiki/ docs/product/');
    for (const p of designDocPaths(ctx)) r += ` ${p}`;
    const adr = cfg.get('design_docs.adr_dir', '');
    if (adr !== '') r += ` ${adr.replace(/\/$/, '')}/`;
    return words(r);
  });
}

/** `in_knowledge_scope PATH` @param {Context} ctx @param {string} p */
export function inKnowledgeScope(ctx, p) {
  for (const e of knowledgeScopeEntries(ctx)) {
    if (e.endsWith('/')) { if (p.startsWith(e)) return true; } else if (p === e) return true;
  }
  return false;
}

/** `installed_control_path PATH`: a file `proofline init/upgrade` installs outside .agents/. @param {Context} ctx @param {string} p */
export function installedControlPath(ctx, p) {
  if (p.startsWith('.claude/agents/proofline-') && p.endsWith('.md') && p.length >= '.claude/agents/proofline-.md'.length) return true;
  if (p.startsWith('.codex/agents/proofline-') && p.endsWith('.toml') && p.length >= '.codex/agents/proofline-.toml'.length) return true;
  if (!isFile(`${ctx.agents}/.proofline-manifest`)) return false;
  return installedManifest(ctx).some((f) => f[1] === p);
}

/** `installed_control_paths`: the manifest-listed files outside .agents/. @param {Context} ctx @returns {string[]} */
export function installedControlPaths(ctx) {
  if (!isFile(`${ctx.agents}/.proofline-manifest`)) return [];
  return installedManifest(ctx).filter((f) => f.length >= 2 && !f[1].startsWith('.agents/')).map((f) => f[1]);
}

/** `is_block_file` @param {string} p */
export function isBlockFile(p) { return p === 'AGENTS.md' || p === 'CLAUDE.md'; }

const BEGIN = '<!-- proofline:begin -->';
const END = '<!-- proofline:end -->';

/** The lines of a file (a final line without a newline counts). @param {string} text */
function recordsOf(text) { return textLines(text); }

/** Both marker lines are present as whole lines (`grep -qx`). @param {string} text */
export function hasBlockMarkers(text) {
  const ls = text.split('\n');
  return ls.includes(BEGIN) && ls.includes(END);
}

/**
 * `strip_proofline_block FILE`: the text without its FIRST marked block. Without both markers the file is whole and verbatim; with them
 * awk prints every kept record plus a newline (also for a last line that had none).
 * @param {string} text
 */
export function stripProoflineBlock(text) {
  if (!hasBlockMarkers(text)) return text;
  let s = false; let d = false;
  let out = '';
  for (const l of recordsOf(text)) {
    if (l === BEGIN && !d && !s) { s = true; continue; }
    if (l === END && s) { s = false; d = true; continue; }
    if (!s) out += `${l}\n`;
  }
  return out;
}

/** `block_only_file`: both markers and nothing but whitespace outside them. @param {string} text */
export function blockOnlyText(text) {
  if (!hasBlockMarkers(text)) return false;
  return !new RegExp(`[^ \\t\\n\\v\\f\\r]`).test(stripProoflineBlock(text));
}

/** `block_only_file PATH` @param {Context} ctx @param {string} abs */
export function blockOnlyFile(ctx, abs) {
  const t = fileText(ctx, abs);
  return t !== null && blockOnlyText(t);
}
