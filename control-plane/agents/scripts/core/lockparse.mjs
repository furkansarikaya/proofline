// @ts-check
// The lock file parsers of `agent.sh advisory-check` (A373, A375, issue 338 C10): each reads ONE lock file as DATA and returns the package names and versions the advisory request may carry.
// Nothing is run and nothing else is read: no package manager, no project script, no project config. The lock is untrusted (an agent can write it), so every parser is bounded and fails closed:
//   - the text formats are read line by line with a line length and a line count bound (MAX_LINE, MAX_LINES); a tab in an indentation, a NUL byte, an odd indentation or a structure the parser does
//     not know at the level of an entry is a refusal of the whole lock (`lock_unreadable`, never a clean result), an oddity inside an entry is a skipped entry (counted with its reason);
//   - every pattern is linear (no repetition inside a repetition over unbounded text) and every string is length-bounded before a pattern runs;
//   - the results are Maps and null-prototype objects (a `__proto__` or `constructor` key is an ordinary string and fails the name grammar);
//   - a name must pass the npm package-name grammar and a version the semver grammar, so a URL, a path, a git spec or a control character never reaches the request.
// The format of each lock is DATA (`advisory.formats` of ecosystems.json, parallel to `advisory.locks`); the code names formats, never an ecosystem or a file.
//
//   npm-json   lockfileVersion 2 or 3 (`packages` map; JSON).
//   pnpm-yaml  lockfileVersion 5.x, 6.x, 7.x and 9.x (`packages:` section of every YAML document; keys `/name/version_peers` (5), `/name@version(peers)` (6, 7), `name@version` (9)); an entry is a
//              registry package only when its `resolution` holds an `integrity` and nothing else (a `tarball`, `type: git`, `directory` or `repo` is not).
//   yarn       the classic format (`# yarn lockfile v1`; name from the entry's specs, an `npm:` alias resolved, `version`, `resolved` a registry tarball) and the berry format (`__metadata:`; name and
//              version from `resolution: "<name>@npm:<version>"`, a `patch:` of a registry package counts as that package; `workspace:` entries are the project itself and not counted).
//   bun-jsonc  the text lock of bun (JSON with comments and trailing commas, lockfileVersion 0 or 1; `packages` values `["<name>@<version>", "<registry>", {...}, "<integrity>"]`; `workspace:` entries
//              are the project itself and not counted). A binary lock is refused by data (`advisory.refused`), never parsed.

export const MAX_LINE = 16384;
export const MAX_LINES = 1000000;
const MAX_RESOLVED = 4096;
/** The npm package-name grammar the request is built from: URL-safe characters (legacy names with capitals, dots and tildes included), optional `@scope/`, no other slash, no leading dot or underscore, at most 214 characters. */
const NAME_OK = /^(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const VERSION_OK = /^(?:0|[1-9][0-9]{0,15})\.(?:0|[1-9][0-9]{0,15})\.(?:0|[1-9][0-9]{0,15})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+){0,15})?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+){0,15})?$/;
/** @param {unknown} n */
export const nameOk = (n) => typeof n === 'string' && n.length <= 214 && NAME_OK.test(n);
/** @param {unknown} v */
export const versionOk = (v) => typeof v === 'string' && v.length <= 64 && VERSION_OK.test(v);
/** A `resolved` of a registry tarball has the layout `<host>/<name>/-/<file>.tgz`; a git, file, http or other spec is not a registry package. Length-bounded before the pattern. @param {string} r */
export const registryResolved = (r) => r.length <= MAX_RESOLVED && /^https:\/\/[^\s/]+\/[^\s]*\/-\/[^\s/]+\.tgz(?:#[0-9a-f]{0,64})?$/.test(r);

/** @typedef {{ packages: Map<string, string[]>, skipped: number, reasons: Record<string, number>, total: number, versions: number }} LockResult */
/** @typedef {LockResult | { error: string, kind: string }} LockParse */

/** The accumulator every parser fills: entries counted, skipped by reason, names merged with their versions. */
function collector() {
  /** @type {Map<string, Set<string>>} */ const byName = new Map();
  /** @type {Record<string, number>} */ const reasons = Object.create(null);
  let skipped = 0; let total = 0;
  return {
    entry() { total++; },
    /** @param {string} why */
    skip(why) { skipped++; reasons[why] = (reasons[why] ?? 0) + 1; },
    /** @param {unknown} name @param {unknown} version */
    add(name, version) {
      if (!nameOk(name) || !versionOk(version)) { this.skip('invalid'); return; }
      const n = /** @type {string} */ (name);
      const set = byName.get(n) ?? new Set();
      set.add(/** @type {string} */ (version));
      byName.set(n, set);
    },
    /** @returns {LockResult} */
    done() {
      /** @type {Map<string, string[]>} */ const packages = new Map();
      let versions = 0;
      for (const name of [...byName.keys()].sort()) { const v = [...(byName.get(name) ?? [])].sort(); packages.set(name, v); versions += v.length; }
      return { packages, skipped, reasons, total, versions };
    },
  };
}

/** @param {Buffer | string} lock */
const textOf = (lock) => { const s = typeof lock === 'string' ? lock : lock.toString('utf8'); return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; };

/**
 * The lines of a text lock, `\r` removed, or null when one is longer than MAX_LINE, there are more than MAX_LINES, the text holds a NUL byte or an indentation holds a tab.
 * @param {string} text @returns {string[] | null}
 */
export function linesOf(text) {
  if (text.includes('\u0000')) return null;
  let count = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) if (++count > MAX_LINES) return null; // counted before the split: a lock of empty lines never becomes a huge array
  const ls = text.split('\n');
  for (let i = 0; i < ls.length; i++) {
    let l = ls[i];
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (l.length > MAX_LINE) return null;
    const ind = indentOf(l);
    if (l[ind] === '\t') return null;
    ls[i] = l;
  }
  return ls;
}

/** @param {string} l */
function indentOf(l) { let i = 0; while (i < l.length && l.charCodeAt(i) === 0x20) i++; return i; }
/** @param {string} l */
const blankOrComment = (l) => { const t = l.trim(); return t === '' || t.startsWith('#'); };

/**
 * A YAML scalar of the subset the lock writers use: plain, 'single' or "double" quoted. null for an anchor, alias, tag, block scalar, flow collection, an escape or an inner quote, so nothing the
 * subset does not hold is guessed at.
 * @param {string} raw @returns {string | null}
 */
export function yamlScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  const q = s[0];
  if (q === "'" || q === '"') {
    if (s.length < 2 || s[s.length - 1] !== q) return null;
    const inner = s.slice(1, -1);
    if (inner.includes("'") || inner.includes('"') || inner.includes('\\')) return null;
    return inner;
  }
  if ('&*!|>%@`{[,?-'.includes(q) && !(q === '-' && s.length > 1 && s[1] !== ' ')) return null;
  if (s.includes(' #')) return null;
  return s;
}

/** The index of the quote that closes the quoted scalar opening at `i` (double: `\\` escapes; single: `''` escapes), or -1 when it is not closed on this line. @param {string} s @param {number} i */
function quotedEnd(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (q === '"' && s[j] === '\\') { j++; continue; }
    if (s[j] === q) { if (q === "'" && s[j + 1] === "'") { j++; continue; } return j; }
  }
  return -1;
}
/** A plain scalar of ONE line that cannot start or continue anything else: no indicator first, no quote, no comment, no `: `. @param {string} v */
function plainOk(v) {
  if (v === '' || '|>&*!%@`?#,[]{}"\''.includes(v[0]) || (v[0] === '-' && (v.length === 1 || v[1] === ' '))) return false;
  return !v.includes(' #') && !v.includes(': ') && !v.endsWith(':') && !v.includes('"') && !v.includes("'");
}
/** A one-line flow collection: brackets and quotes balanced on the line, nothing after the last bracket, no anchor, alias or tag. @param {string} v */
function flowOk(v) {
  let depth = 0;
  for (let j = 0; j < v.length; j++) {
    const c = v[j];
    if (c === '"' || c === "'") { const e = quotedEnd(v, j); if (e < 0) return false; j = e; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth < 0 || (depth === 0 && j !== v.length - 1)) return false; }
    else if ((c === '&' || c === '*' || c === '!' || c === '#' || c === '|' || c === '>') && ' {[,:'.includes(v[j - 1] ?? ' ')) return false;
  }
  return depth === 0;
}
/** A value that is complete on its line: empty (a block mapping follows), a closed quoted scalar, a balanced flow collection or a one-line plain scalar. @param {string} v */
function valueOk(v) {
  if (v === '') return true;
  if (v[0] === '"' || v[0] === "'") return quotedEnd(v, 0) === v.length - 1;
  if (v[0] === '{' || v[0] === '[') return flowOk(v);
  return plainOk(v);
}
/**
 * Whether a YAML line (indentation removed) is inside the strict subset the parsers read: `key:`, `key: value` or `- value`, each complete on the line. A quote not closed on the line, a block scalar
 * (`|`, `>`), a plain scalar that continues on the next line, an anchor, alias, tag, `?` key or comment after a value is NOT: the lock is then refused, never read past it (a multi-line scalar could
 * otherwise make the next line look like a new key and end a section early).
 * @param {string} t
 */
export function yamlLineOk(t) {
  if (t.startsWith('- ')) return valueOk(t.slice(2).trim());
  let rest;
  if (t[0] === '"' || t[0] === "'") {
    const e = quotedEnd(t, 0);
    if (e < 0 || t[e + 1] !== ':') return false;
    rest = t.slice(e + 2);
  } else {
    const at = t.indexOf(': ');
    const key = at >= 0 ? t.slice(0, at) : (t.endsWith(':') ? t.slice(0, -1) : '');
    if (!plainOk(key)) return false;
    rest = at >= 0 ? t.slice(at + 1) : '';
  }
  if (rest === '') return true;
  return rest[0] === ' ' && valueOk(rest.trim());
}
/** A yarn classic line: every `"` string closed on the line (`\\` escapes). @param {string} t */
function classicLineOk(t) {
  for (let j = 0; j < t.length; j++) if (t[j] === '"') { const e = quotedEnd(t, j); if (e < 0) return false; j = e; }
  return true;
}
const SUBSET = 'a line outside the strict subset (an unclosed quote, a multi-line or block scalar, an anchor, alias, tag or comment)';

/** `key: value` (value may be empty) of a YAML line without its indentation, or null. @param {string} t @returns {{ k: string, v: string } | null} */
function yamlPair(t) {
  let k; let rest;
  if (t[0] === "'" || t[0] === '"') {
    const end = t.indexOf(t[0], 1);
    if (end < 0) return null;
    k = yamlScalar(t.slice(0, end + 1));
    rest = t.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    rest = rest.slice(1);
  } else {
    const at = t.indexOf(': ');
    const head = at >= 0 ? t.slice(0, at) : (t.endsWith(':') ? t.slice(0, -1) : null);
    if (head === null) return null;
    k = yamlScalar(head);
    rest = at >= 0 ? t.slice(at + 1) : '';
  }
  if (k === null || k === '') return null;
  if (rest !== '' && !rest.startsWith(' ')) return null;
  return { k, v: rest.trim() };
}

/** The keys of a one-line YAML flow map `{a: x, b: y}` without nesting, or null. @param {string} v @returns {string[] | null} */
function flowKeys(v) {
  if (!v.startsWith('{') || !v.endsWith('}')) return null;
  const inner = v.slice(1, -1);
  if (inner.includes('{') || inner.includes('}') || inner.includes('[')) return null;
  /** @type {string[]} */ const keys = [];
  for (const part of inner.split(',')) {
    const t = part.trim();
    if (t === '') continue;
    const at = t.indexOf(':');
    if (at <= 0) return null;
    const k = t.slice(0, at).trim();
    if (!/^[A-Za-z]{1,32}$/.test(k)) return null;
    keys.push(k);
  }
  return keys;
}

/** A registry package's resolution holds an integrity and nothing else. @param {string[] | null | undefined} keys */
const registryResolution = (keys) => Array.isArray(keys) && keys.length > 0 && keys.every((k) => k === 'integrity');

/**
 * npm: lockfileVersion 2 or 3. Only the `packages` map is read, and of an entry only its `name` (the real package when the entry is an alias, else the part of the path after its last
 * `node_modules/`), `version`, `link` and `resolved`: a link, an entry whose `resolved` is not a registry tarball (git, file, http), an entry without a version, a name or version that fails the
 * grammar, or a path outside `node_modules/` is skipped and counted with its reason; `total` is every entry but the root.
 * @param {Buffer | string} lock @returns {LockParse}
 */
export function npmPackages(lock) {
  let doc;
  try { doc = JSON.parse(textOf(lock)); } catch { return { error: 'the lock file is not valid JSON', kind: 'lock_unreadable' }; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'the lock file is not a JSON object', kind: 'lock_unreadable' };
  const pk = doc.packages;
  if (pk === null || typeof pk !== 'object' || Array.isArray(pk)) return { error: 'the lock file has no `packages` map (lockfileVersion 1 is not supported: regenerate it with a current npm)', kind: 'lock_unsupported' };
  const c = collector();
  for (const key of Object.keys(pk)) {
    if (key === '') continue; // the root project itself
    c.entry();
    const e = pk[key];
    const at = key.lastIndexOf('node_modules/');
    const pathName = at === 0 || (at > 0 && key[at - 1] === '/') ? key.slice(at + 'node_modules/'.length) : '';
    if (pathName === '') { c.skip('outside-node_modules'); continue; }
    if (e === null || typeof e !== 'object' || Array.isArray(e)) { c.skip('invalid'); continue; }
    if (e.link === true || (e.resolved !== undefined && (typeof e.resolved !== 'string' || !registryResolved(e.resolved)))) { c.skip('non-registry'); continue; }
    if (typeof e.version !== 'string') { c.skip('no-version'); continue; }
    c.add(e.name !== undefined ? e.name : pathName, e.version);
  }
  return c.done();
}

/** The name and version of a pnpm `packages` key. @param {string} key @param {number} major @returns {{ name: string, version: string } | null} */
export function pnpmIdent(key, major) {
  let k = key.startsWith('/') ? key.slice(1) : key;
  if (major >= 6) {
    const p = k.indexOf('(');
    if (p >= 0) k = k.slice(0, p);
    const at = k.lastIndexOf('@');
    if (at <= 0) return null;
    return { name: k.slice(0, at), version: k.slice(at + 1) };
  }
  const sl = k.lastIndexOf('/');
  if (sl <= 0) return null;
  let v = k.slice(sl + 1);
  const u = v.indexOf('_');
  if (u >= 0) v = v.slice(0, u);
  return { name: k.slice(0, sl), version: v };
}

/**
 * pnpm: the `packages:` section of every YAML document of the lock (pnpm writes two-space indentation: an entry key at two spaces, its fields at four, a block resolution's fields at six).
 * @param {Buffer | string} lock @returns {LockParse}
 */
export function pnpmPackages(lock) {
  const ls = linesOf(textOf(lock));
  if (ls === null) return { error: `the lock file has a line longer than ${MAX_LINE} characters, more than ${MAX_LINES} lines, a NUL byte or a tab in an indentation`, kind: 'lock_unreadable' };
  /** @type {number | null} */ let major = null;
  let section = '';
  /** @type {Array<{ key: string, res: string[] | null | undefined }>} */ const entries = [];
  /** @type {{ key: string, res: string[] | null | undefined } | null} */ let cur = null;
  let inRes = false;
  /** @type {number[]} */ const headers = []; // the entry count when each block `packages:` began
  const bad = (/** @type {number} */ i, /** @type {string} */ why) => ({ error: `the lock file is not a pnpm lock this parser reads (line ${i + 1}: ${why})`, kind: 'lock_unreadable' });
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (blankOrComment(l)) continue;
    const ind = indentOf(l);
    if (!(ind === 0 && (l === '---' || l === '...')) && !yamlLineOk(l.slice(ind))) return bad(i, SUBSET);
    if (ind === 0) {
      cur = null; inRes = false;
      if (l === '---' || l === '...') { section = ''; continue; }
      const p = yamlPair(l);
      if (p === null) return bad(i, 'a top-level line that is not `key:` or `key: value`');
      if (p.k === 'lockfileVersion') {
        const m = /^([0-9]{1,2})(?:\.[0-9]{1,3})?$/.exec(yamlScalar(p.v) ?? '');
        if (m === null) return { error: 'the lockfileVersion of the pnpm lock is not a number', kind: 'lock_unsupported' };
        const v = Number(m[1]);
        if (major !== null && major !== v) return { error: 'the documents of the pnpm lock name different lockfileVersions', kind: 'lock_unsupported' };
        major = v;
      }
      section = '';
      if (p.k === 'packages') {
        // the section header is `packages:` (block entries follow) or `packages: {}` (none); a comment, anchor, tag or a flow map after it would hide the entries: the lock is refused, never read as empty
        if (p.v === '{}') continue;
        if (p.v !== '') return bad(i, '`packages:` followed by something other than its block entries or `{}`');
        section = 'packages'; headers.push(entries.length);
      }
      continue;
    }
    if (section !== 'packages') continue;
    if (ind % 2 !== 0) return bad(i, 'an odd indentation');
    const t = l.slice(ind);
    if (ind === 2) {
      const p = yamlPair(t);
      if (p === null || p.v !== '') return bad(i, 'an entry of `packages:` that is not `<key>:`');
      cur = { key: p.k, res: undefined };
      entries.push(cur);
      inRes = false;
      continue;
    }
    if (cur === null) return bad(i, 'a field without an entry');
    if (ind === 4) {
      inRes = false;
      const p = yamlPair(t);
      if (p === null || p.k !== 'resolution') continue;
      if (cur.res !== undefined) { cur.res = null; continue; } // twice: not trusted
      if (p.v === '') { cur.res = []; inRes = true; } else cur.res = flowKeys(p.v);
      continue;
    }
    if (ind === 6 && inRes && Array.isArray(cur.res)) {
      const p = yamlPair(t);
      if (p === null || !/^[A-Za-z]{1,32}$/.test(p.k)) cur.res = null; else cur.res.push(p.k);
    }
  }
  if (major === null) return { error: 'the pnpm lock has no lockfileVersion', kind: 'lock_unsupported' };
  // a block `packages:` with no entry under it is not an empty lock (pnpm writes `packages: {}` for that): something the parser did not read is there
  for (let h = 0; h < headers.length; h++) if ((h + 1 < headers.length ? headers[h + 1] : entries.length) === headers[h]) return { error: 'the lock file is not a pnpm lock this parser reads (a `packages:` section without entries)', kind: 'lock_unreadable' };
  if (major < 5 || major > 9) return { error: `pnpm lockfileVersion ${major} is not supported (5 to 9 are read)`, kind: 'lock_unsupported' };
  const c = collector();
  for (const e of entries) {
    c.entry();
    if (!registryResolution(e.res)) { c.skip('non-registry'); continue; }
    const id = pnpmIdent(e.key, major);
    if (id === null) { c.skip('invalid'); continue; }
    c.add(id.name, id.version);
  }
  return c.done();
}

/** The package name a yarn classic spec (`name@range`, `alias@npm:real@range`) is for, or null. @param {string} spec */
export function yarnSpecName(spec) {
  const at = spec.indexOf('@', 1);
  if (at <= 0) return null;
  const range = spec.slice(at + 1);
  if (range.startsWith('npm:')) {
    const r = range.slice(4);
    const at2 = r.indexOf('@', 1);
    return at2 < 0 ? r : r.slice(0, at2);
  }
  return spec.slice(0, at);
}

/** The value of a yarn classic field: `"quoted"` (no escape, no inner quote) or bare. @param {string} raw */
function classicValue(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) { if (s.length < 2 || !s.endsWith('"')) return null; const inner = s.slice(1, -1); return inner.includes('"') || inner.includes('\\') ? null : inner; }
  return s.includes(' ') ? null : s;
}

/** A berry `resolution`: `<name>@npm:<version>` is a registry package; a `patch:` whose base is that package counts as it; `workspace:` is the project itself. @param {string} r */
export function berryIdent(r) {
  const at = r.indexOf('@', 1);
  if (at <= 0) return { kind: 'other' };
  const name = r.slice(0, at);
  const ref = r.slice(at + 1);
  if (ref.startsWith('npm:')) return { kind: 'npm', name, version: ref.slice(4) };
  if (ref.startsWith('workspace:')) return { kind: 'workspace' };
  if (ref.startsWith('patch:')) {
    const inner = ref.slice(6);
    const h = inner.indexOf('#');
    const base = (h < 0 ? inner : inner.slice(0, h)).replace(/%3A/gi, ':');
    const at2 = base.indexOf('@', 1);
    if (at2 > 0 && base.slice(0, at2) === name && base.slice(at2 + 1).startsWith('npm:')) return { kind: 'npm', name, version: base.slice(at2 + 1 + 4) };
  }
  return { kind: 'other' };
}

/**
 * yarn: the classic format or the berry format, told apart by the lock itself (`# yarn lockfile v1` or a `__metadata:` entry); neither is a refusal.
 * @param {Buffer | string} lock @returns {LockParse}
 */
export function yarnPackages(lock) {
  const ls = linesOf(textOf(lock));
  if (ls === null) return { error: `the lock file has a line longer than ${MAX_LINE} characters, more than ${MAX_LINES} lines, a NUL byte or a tab in an indentation`, kind: 'lock_unreadable' };
  const berry = ls.some((l) => l === '__metadata:');
  const classic = ls.some((l) => /^# yarn lockfile v1\s*$/.test(l));
  if (berry === classic) return { error: 'the lock file is neither a yarn classic lock (`# yarn lockfile v1`) nor a yarn berry lock (`__metadata:`)', kind: 'lock_unsupported' };
  /** @type {Array<{ head: string, f: Record<string, string | null> }>} */ const entries = [];
  /** @type {{ head: string, f: Record<string, string | null> } | null} */ let cur = null;
  const bad = (/** @type {number} */ i, /** @type {string} */ why) => ({ error: `the lock file is not a yarn lock this parser reads (line ${i + 1}: ${why})`, kind: 'lock_unreadable' });
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (blankOrComment(l)) continue;
    const ind = indentOf(l);
    if (!(berry ? yamlLineOk(l.slice(ind)) : classicLineOk(l))) return bad(i, SUBSET);
    if (ind % 2 !== 0) return bad(i, 'an odd indentation');
    if (ind === 0) {
      if (!l.endsWith(':')) return bad(i, 'an entry that does not end with `:`');
      cur = { head: l.slice(0, -1), f: Object.create(null) };
      entries.push(cur);
      continue;
    }
    if (cur === null) return bad(i, 'a field without an entry');
    if (ind !== 2) continue;
    const t = l.slice(2);
    let k; let v;
    if (berry) { const p = yamlPair(t); if (p === null) continue; k = p.k; v = p.v === '' ? '' : yamlScalar(p.v); } else {
      const sp = t.indexOf(' ');
      if (sp < 0) { if (t.endsWith(':')) continue; k = t; v = null; } else { k = classicValue(t.slice(0, sp)) ?? ''; v = classicValue(t.slice(sp + 1)); }
    }
    if (k !== 'version' && k !== 'resolved' && k !== 'resolution') continue;
    cur.f[k] = Object.hasOwn(cur.f, k) ? null : v; // twice: not trusted
  }
  const c = collector();
  for (const e of entries) {
    if (berry) {
      if (e.head === '__metadata') continue;
      const r = e.f.resolution;
      const id = typeof r === 'string' ? berryIdent(r) : { kind: 'other' };
      if (id.kind === 'workspace') continue; // the project itself, as the root of an npm lock
      c.entry();
      if (id.kind !== 'npm') { c.skip('non-registry'); continue; }
      c.add(id.name, id.version);
      continue;
    }
    c.entry();
    /** @type {Set<string | null>} */ const names = new Set();
    for (const part of e.head.split(',')) names.add(yarnSpecName(classicValue(part) ?? ''));
    const resolved = e.f.resolved;
    if (typeof resolved !== 'string' || !registryResolved(resolved)) { c.skip('non-registry'); continue; }
    if (typeof e.f.version !== 'string') { c.skip('no-version'); continue; }
    if (names.size !== 1 || names.has(null)) { c.skip('invalid'); continue; }
    c.add([...names][0], e.f.version);
  }
  return c.done();
}

/**
 * JSON with comments and trailing commas made plain JSON in one linear pass: `//` and `/* *\/` comments outside strings removed, a comma before `}` or `]` removed. null on an unterminated string or
 * comment. Strings are copied as they are (JSON.parse checks them).
 * @param {string} s @returns {string | null}
 */
export function stripJsonc(s) {
  /** @type {Array<[number, number]>} */ const drop = [];
  let lastSig = -1;
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x22) { // a string
      let j = i + 1;
      while (j < n) { const d = s.charCodeAt(j); if (d === 0x5c) { j += 2; continue; } if (d === 0x22) break; j++; }
      if (j >= n) return null;
      lastSig = j; i = j + 1;
      continue;
    }
    if (c === 0x2f && s.charCodeAt(i + 1) === 0x2f) { const j = s.indexOf('\n', i); const end = j < 0 ? n : j; drop.push([i, end]); i = end; continue; }
    if (c === 0x2f && s.charCodeAt(i + 1) === 0x2a) { const j = s.indexOf('*/', i + 2); if (j < 0) return null; drop.push([i, j + 2]); i = j + 2; continue; }
    if ((c === 0x7d || c === 0x5d) && lastSig >= 0 && s.charCodeAt(lastSig) === 0x2c) drop.push([lastSig, lastSig + 1]);
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) lastSig = i;
    i++;
  }
  if (drop.length === 0) return s;
  drop.sort((a, b) => a[0] - b[0]);
  /** @type {string[]} */ const parts = [];
  let at = 0;
  for (const [a, b] of drop) { parts.push(s.slice(at, a), ' '); at = b; }
  parts.push(s.slice(at));
  return parts.join('');
}

/**
 * bun: the text lock. `packages` values are arrays whose first element is `<name>@<version>`; a registry package has a string second element (the registry: empty for the default one, else an
 * https url); a git, github, file, link or tarball package has not, and is skipped as `non-registry`; `workspace:` entries are the project itself and not counted.
 * @param {Buffer | string} lock @returns {LockParse}
 */
export function bunPackages(lock) {
  const plain = stripJsonc(textOf(lock));
  if (plain === null) return { error: 'the lock file has an unterminated string or comment', kind: 'lock_unreadable' };
  let doc;
  try { doc = JSON.parse(plain); } catch { return { error: 'the lock file is not valid JSON with comments', kind: 'lock_unreadable' }; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'the lock file is not a JSON object', kind: 'lock_unreadable' };
  if (doc.lockfileVersion !== 0 && doc.lockfileVersion !== 1) return { error: 'the bun lock has no lockfileVersion 0 or 1', kind: 'lock_unsupported' };
  const pk = doc.packages;
  if (pk === null || typeof pk !== 'object' || Array.isArray(pk)) return { error: 'the bun lock has no `packages` map', kind: 'lock_unsupported' };
  const c = collector();
  for (const key of Object.keys(pk)) {
    const e = pk[key];
    if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length > 1024) { c.entry(); c.skip('invalid'); continue; }
    const ident = e[0];
    const at = ident.indexOf('@', 1);
    const ref = at > 0 ? ident.slice(at + 1) : '';
    if (ref.startsWith('workspace:')) continue; // the project itself
    c.entry();
    if (at <= 0) { c.skip('invalid'); continue; }
    if (e.length < 2 || typeof e[1] !== 'string' || !(e[1] === '' || (e[1].length <= MAX_RESOLVED && e[1].startsWith('https://'))) || /^[a-z+]{1,16}:/.test(ref)) { c.skip('non-registry'); continue; }
    c.add(ident.slice(0, at), ref);
  }
  return c.done();
}

/** The parser of each lock format that `advisory.formats` may name. @type {Record<string, (lock: Buffer | string) => LockParse>} */
export const LOCK_FORMATS = Object.freeze(Object.assign(Object.create(null), { 'npm-json': npmPackages, 'pnpm-yaml': pnpmPackages, yarn: yarnPackages, 'bun-jsonc': bunPackages }));
