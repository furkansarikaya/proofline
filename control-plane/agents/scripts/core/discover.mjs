// @ts-check
// Command discovery for `proofline init` and `doctor --commands` (A230, the former bin/lib/discover.sh; D8, A173, A187): which build, test and lint commands a
// project has, from its own files. proofline never assumes a folder layout: root, nested, multi-project and monorepo layouts are equal.
// Order: the project's declared scripts (package.json, composer.json) at the root, the Makefile / justfile / Taskfile, the ecosystem's build files at the root,
// the same for a single nested project, then CI configuration, then the README. The ecosystem steps add one command per ecosystem, so a .NET solution at the root
// and a nested npm frontend give a LIST of two; a Makefile, justfile or Taskfile command, or a CI or README line, covers the whole repository and is the only
// candidate. What each ecosystem looks like (marker files, workspace roots, command templates, prune dirs) is read from ecosystems.json (the single definition).
// A command is only a candidate until `verifyCommands` proves it with a trial run. With zero or several candidate targets of ONE ecosystem no command is proposed
// for it (the run asks the user once), never a command that fails; the other ecosystems still get theirs. Nothing here prints a secret: it reads names, never
// values, and a trial run's output is discarded.
import { closeSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as proc from './proc.mjs';
import { lineHoldsSecret } from './secretscan.mjs';
import { awkGlobRegExp as globToRegExp } from './shellglob.mjs';

/**
 * @typedef {{ build: string[], test: string[], lint: string[], ambig: Array<{ id: string, why: string }> }} Discovery
 * @typedef {'build' | 'test' | 'lint'} Kind
 */

/** The ecosystem definition shipped next to the scripts folder (the control plane's `ecosystems.json`, the single source of what each ecosystem looks like). */
function loadEcosystems() {
  const f = new URL('../../ecosystems.json', import.meta.url);
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new Error(`ecosystems.json is missing or invalid (${/** @type {Error} */ (e).message})`); }
}

/** @type {Kind[]} */
export const KINDS = ['build', 'test', 'lint'];

/** @param {unknown} v a scalar or an array of scalars of the definition @returns {string[]} */
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
/** @param {unknown} v @returns {string} */
const first = (v) => list(v)[0] ?? '';
/** Byte order, as `LC_ALL=C sort`. @param {string} a @param {string} b */
const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The text of a file, '' when it cannot be read. @param {string} f */
function text(f) { try { return readFileSync(f, 'latin1'); } catch { return ''; } }
/** `[ -f F ]` @param {string} f */
function isFile(f) { try { return statSync(f).isFile(); } catch { return false; } }
/** `[ -d D ]` @param {string} d */
function isDir(d) { try { return statSync(d).isDirectory(); } catch { return false; } }
/** `[ -e P ]` @param {string} p */
function exists(p) { try { statSync(p); return true; } catch { return false; } }
/** `grep -E`: does one line of the file match? @param {string} file @param {RegExp} re */
function grepFile(file, re) { return text(file).split('\n').some((l) => re.test(l)); }

/** A relative path that is safe to store unquoted in a command (no space, quote, $, backtick or leading dash). @param {string} p */
export function safePath(p) { return p !== '' && !p.startsWith('-') && /^[A-Za-z0-9._/+@-]+$/.test(p); }

/** `d_names`: up to four names, comma separated, then "...". @param {string[]} names */
function namesOf(names) { return names.slice(0, 4).join(', ') + (names.length > 4 ? ', ...' : ''); }

/** @param {string} t @param {string} name @param {string} value */
const subst = (t, name, value) => t.split(`{${name}}`).join(value);

/**
 * The body of a script of package.json (or another JSON file with `scripts`), '' when absent.
 * @param {string} unit @param {string} name @param {string} file
 */
function pkgScript(unit, name, file) {
  try {
    const v = (JSON.parse(readFileSync(path.join(unit, file), 'utf8')).scripts ?? {})[name];
    return v === undefined || v === null || v === false ? '' : String(v);
  } catch { return ''; }
}

/** `d_when`: every condition under a `when` object holds (no condition: true). An unknown key is false. @param {string} unit @param {string} root @param {Record<string, unknown> | undefined} w */
function when(unit, root, w) {
  if (!w) return true;
  for (const k of Object.keys(w)) {
    switch (k) {
      case 'file': if (!list(w.file).every((v) => isFile(path.join(unit, v)))) return false; break;
      case 'any_file': if (!list(w.any_file).some((v) => isFile(path.join(unit, v)))) return false; break;
      case 'not_file': if (list(w.not_file).some((v) => exists(path.join(unit, v)))) return false; break;
      case 'dir': if (!list(w.dir).every((v) => isDir(path.join(unit, v)))) return false; break;
      case 'root_file': if (!list(w.root_file).every((v) => isFile(path.join(root, v)))) return false; break;
      case 'in': {
        const pat = first(w.contains);
        const re = pat === '' ? null : new RegExp(pat);
        if (!list(w.in).some((v) => isFile(path.join(unit, v)) && (re === null || grepFile(path.join(unit, v), re)))) return false;
        break;
      }
      case 'contains': if (list(w.in).length === 0) return false; break;
      case 'script': {
        const body = pkgScript(unit, first(w.script), first(w.script_file) || 'package.json');
        if (body === '') return false;
        const no = first(w.script_not);
        if (no !== '' && body.split('\n').some((l) => new RegExp(no).test(l))) return false;
        break;
      }
      case 'script_file': case 'script_not': break;
      default: return false;
    }
  }
  return true;
}

/**
 * `d_members`: the members a workspace file of the ecosystem lists, each written with the definition's `members.format` ('' when the unit has no workspace file with
 * a member list, or a member path is unsafe). Which file, and how its lines are read, is data (workspace_roots[].members).
 * @param {any} eco @param {string} unit
 */
function members(eco, unit) {
  for (const w of eco.workspace_roots ?? []) {
    const m = w.members ?? {};
    const fmt = first(m.format);
    if (fmt === '') continue;
    const f = path.join(unit, first(w.file));
    if (!isFile(f)) continue;
    const c = first(w.contains);
    if (c !== '' && !grepFile(f, new RegExp(c))) continue;
    const sp = first(m.single_prefix); const bo = first(m.block_open); const bc = first(m.block_close); const bi = first(m.block_item_prefix); const cm = first(m.comment);
    /** @type {string[]} */ const raw = [];
    const emit = (/** @type {string} */ t0) => {
      let t = (t0.replace(/^ +/, '').trim().split(/\s+/)[0] ?? '');
      t = t.replace(/^["']/, '').replace(/["']$/, '');
      if (t === '' || /^[()]/.test(t)) return;
      while (t.startsWith('./')) t = t.slice(2);
      t = t.replace(/\/+$/, '');
      raw.push(t === '' ? '.' : t);
    };
    let inBlock = false;
    const t = text(f);
    for (const line of (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n')) {
      let l = line.replace(/\t/g, ' ');
      if (cm !== '') { const k = l.indexOf(cm); if (k >= 0) l = l.slice(0, k); }
      if (inBlock) {
        if (bc !== '' && new RegExp(bc).test(l)) { inBlock = false; continue; }
        emit(bi !== '' ? l.replace(new RegExp(bi), '') : l);
        continue;
      }
      if (bo !== '' && new RegExp(bo).test(l)) { inBlock = true; continue; }
      if (sp !== '' && new RegExp(sp).test(l)) emit(l.replace(new RegExp(sp), ''));
    }
    if (raw.length === 0) continue;
    if (!raw.every(safePath)) return '';
    return raw.map((r) => subst(fmt, 'member', r)).join(' ');
  }
  return '';
}

/**
 * `d_rule`: the command of the first rule of KIND whose `when` holds and that has a template for the mode (bare: `run`, targeted: `at`); null when there is none. A
 * rule with a `workspace` template applies only when the unit has a workspace file that lists members, and `{members}` becomes that list.
 * @param {any} eco @param {Kind} kind @param {'bare' | 'targeted'} mode @param {string} unit @param {string} root @param {string} dir @param {string} target
 * @returns {string | null}
 */
function rule(eco, kind, mode, unit, root, dir, target) {
  /** @type {Array<[string, string]>} */ let vars = [];
  for (const r of eco.commands?.runners ?? []) {
    if (!when(unit, root, r.when)) continue;
    vars = Object.keys(r).filter((k) => k !== 'when').map((k) => [k, first(r[k])]);
    break;
  }
  const mem = members(eco, unit);
  for (const r of eco.commands?.[kind] ?? []) {
    if (!when(unit, root, r.when)) continue;
    let t;
    if (first(r.workspace) !== '') {
      if (mem === '') continue;
      t = subst(first(mode === 'bare' ? r.workspace : r.at_workspace), 'members', mem);
    } else t = first(mode === 'bare' ? r.run : r.at);
    if (t === '') continue;
    for (const [n, v] of vars) t = subst(t, n, v);
    t = subst(subst(t, 'dir', dir), 'target', target);
    if (t.includes('{') || t.includes('}')) continue;
    return t;
  }
  return null;
}

/**
 * `d_markers`: the marker files (project files, solution files, workspace root files of every ecosystem) below ROOT, relative, in byte order, with the global prune dirs
 * not entered. `truncated` when there are more than global.limits.discover_max_markers (then nothing nested is trusted). No depth limit; symbolic links are not followed.
 * @param {string} root @param {any} data @returns {{ markers: string[], truncated: boolean }}
 */
function markers(root, data) {
  const cap = Number(first(data.global?.limits?.discover_max_markers)) || 1000;
  const prune = new Set(list(data.global?.prune));
  const names = new Set();
  for (const e of data.ecosystems) {
    for (const n of [...list(e.project_files), ...list(e.solution_files), ...(e.workspace_roots ?? []).map((/** @type {any} */ w) => first(w.file))]) if (n !== '') names.add(n);
  }
  if (names.size === 0) return { markers: [], truncated: false };
  const res = [...names].map((n) => globToRegExp(n));
  /** @type {string[]} */ const found = [];
  /** @param {string} rel */
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(rel === '' ? root : path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!prune.has(e.name)) walk(r); } else if (e.isFile() && res.some((re) => re.test(e.name))) found.push(r);
    }
  };
  walk('');
  found.sort(byBytes);
  return found.length > cap ? { markers: found.slice(0, cap), truncated: true } : { markers: found, truncated: false };
}

/**
 * `d_hits`: `[kind, path]` with P (project file), S (solution file) and W (a workspace root file name) for one ecosystem, skipping the global and the ecosystem's prune dirs.
 * @param {any} eco @param {any} data @param {string[]} marks @returns {Array<['P' | 'S' | 'W', string]>}
 */
function hits(eco, data, marks) {
  const prune = new Set([...list(data.global?.prune), ...list(eco.prune)]);
  const proj = list(eco.project_files).map((g) => globToRegExp(g));
  const sol = list(eco.solution_files).map((g) => globToRegExp(g));
  const ws = (eco.workspace_roots ?? []).map((/** @type {any} */ w) => first(w.file)).filter((/** @type {string} */ n) => n !== '').map((/** @type {string} */ g) => globToRegExp(g));
  /** @type {Array<['P' | 'S' | 'W', string]>} */ const out = [];
  for (const m of marks) {
    if (m === '' || m.split('/').slice(0, -1).some((s) => prune.has(s))) continue;
    if (proj.some((re) => re.test(m))) out.push(['P', m]);
    if (sol.some((re) => re.test(m))) out.push(['S', m]);
    if (ws.some((re) => re.test(m))) out.push(['W', m]);
  }
  return out;
}

/** `d_ws_ok`: FILE (a W hit) is a workspace root: one rule of workspace_roots names it and its `contains` matches. @param {any} eco @param {string} root @param {string} file */
function wsOk(eco, root, file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  for (const w of eco.workspace_roots ?? []) {
    if (first(w.file) !== base) continue;
    const c = first(w.contains);
    if (c === '' || grepFile(path.join(root, file), new RegExp(c))) return true;
  }
  return false;
}

/** `d_unit_dirs`: the outermost directories that hold a project file or a confirmed workspace root. @param {any} eco @param {string} root @param {Array<['P' | 'S' | 'W', string]>} hs @returns {string[]} */
function unitDirs(eco, root, hs) {
  const dirOf = (/** @type {string} */ f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.');
  const hasP = new Set(hs.filter(([k]) => k === 'P').map(([, f]) => dirOf(f)));
  /** @type {Set<string>} */ const dirs = new Set();
  for (const [k, f] of hs) {
    if (k === 'W' && hasP.has(dirOf(f))) continue;
    if (k === 'W') { if (!wsOk(eco, root, f)) continue; } else if (k !== 'P') continue;
    dirs.add(dirOf(f));
  }
  const all = [...dirs].sort(byBytes);
  return all.filter((d, i) => !all.some((o, j) => i !== j && (o === '.' || d.startsWith(`${o}/`))));
}

/**
 * `d_select`: the one target of an ecosystem: mode bare | targeted | none, the unit directory (. for the root), the file for a file-target ecosystem, and why none.
 * @param {any} eco @param {any} data @param {string} root @param {string[]} marks @param {boolean} truncated
 * @returns {{ mode: 'bare' | 'targeted' | 'none', dir: string, target: string, why: string }}
 */
function select(eco, data, root, marks, truncated) {
  const none = { mode: /** @type {'none'} */ ('none'), dir: '.', target: '', why: '' };
  let hs = hits(eco, data, marks);
  if (hs.length === 0) return none;
  if (eco.units?.target === 'file') {
    for (const l of eco.units.legacy ?? []) {
      const keep = first(l.keep); const drop = first(l.drop);
      const all = new Set(hs.map(([, f]) => f));
      hs = hs.filter(([, x]) => !(x.length > drop.length && x.endsWith(drop) && all.has(x.slice(0, x.length - drop.length) + keep)));
    }
    for (const s of list(eco.units.stages)) {
      const k = s.startsWith('solution_files@') ? 'S' : s.startsWith('project_files@') ? 'P' : '';
      if (k === '') continue;
      const w = s.slice(s.indexOf('@') + 1);
      const set = hs.filter(([hk, f]) => hk === k && ((w === 'root') === !f.includes('/'))).map(([, f]) => f);
      if (set.length === 0) {
        if (w !== 'root' && truncated) return none;   // a truncated search cannot say there is no nested candidate
        continue;
      }
      if (set.length !== 1) return { ...none, why: `several targets: ${namesOf(set)}` };
      if (!safePath(set[0])) return { ...none, why: `a path with a space or an unusual character: ${set[0]}` };
      const t = set[0];
      return { mode: s === first(eco.units.bare) ? 'bare' : 'targeted', dir: t.includes('/') ? t.slice(0, t.lastIndexOf('/')) : '.', target: t, why: '' };
    }
    return none;
  }
  const dirs = unitDirs(eco, root, hs);
  if (dirs.length === 0) return none;
  if (dirs.length === 1 && dirs[0] === '.') return { mode: 'bare', dir: '.', target: '', why: '' };
  if (truncated) return { ...none, why: 'more marker files than the search reads' };
  if (dirs.length !== 1) return { ...none, why: `several projects: ${namesOf(dirs)}` };
  if (!safePath(dirs[0])) return { ...none, why: `a path with a space or an unusual character: ${dirs[0]}` };
  return { mode: 'targeted', dir: dirs[0], target: '', why: '' };
}

/** @typedef {{ id: string, mode: 'bare' | 'targeted', dir: string, target: string }} Planned */

/** A Makefile / justfile / Taskfile: the first file of NAMES that exists decides; each target found is set for the whole repository. @param {string} root @param {string[]} files @param {(k: Kind) => RegExp} re @param {string} runner @param {(k: Kind, c: string) => void} set @param {boolean} [needTasks] */
function runnerFile(root, files, re, runner, set, needTasks = false) {
  for (const f of files) {
    const p = path.join(root, f);
    if (!isFile(p)) continue;
    if (needTasks && !grepFile(p, /^tasks:/)) return;
    for (const k of KINDS) if (grepFile(p, re(k))) set(k, `${runner} ${k}`);
    return;
  }
}

/** Could this command line carry a secret value? @param {string} l */
function carriesSecret(l) {
  return lineHoldsSecret(l) || /(token|secret|passw(or)?d|api[_-]?key|credential)[A-Za-z0-9_-]*=[^\s]/i.test(l) || /:\/\/[^/\s@]+:[^/\s@]+@/.test(l);
}

/** `d_scan`: the candidate command lines (YAML `run:` / `- ` items, README code lines) of known tools. @param {string[]} files @param {string} tools */
function scan(files, tools) {
  const toolRe = new RegExp(`^(${tools})[ \\t\\n\\v\\f\\r]`);
  /** @type {string[]} */ const out = [];
  for (const f of files) {
    const t = text(f);
    for (const line of (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n')) {
      let l = line.replace(/^\s+/, '').replace(/^-\s+/, '').replace(/^(run|script):\s*/, '').replace(/^[$]\s+/, '').replace(/^`/, '').replace(/`$/, '').replace(/^["']/, '').replace(/["']$/, '');
      // shell control operators, redirections, substitutions and templating: never a candidate (it would be trial-run)
      // a line that carries a secret (a token shape, a credential in a URL, a secret-named flag with a value) is never a candidate: the candidates are printed and written to the config
      if (toolRe.test(l) && !/[&;|<>`]|[$][{(]|\{\{/.test(l) && l.length < 80 && !carriesSecret(l)) out.push(l);
    }
  }
  return out;
}

/**
 * The commands of a project: one entry per ecosystem project found, or the one command of a Makefile / justfile / Taskfile / CI line / README line that covers the whole
 * repository (A173). `ambig` names each ecosystem that got no command because its target is ambiguous (or whose rules matched nothing while nothing at all was found).
 * @param {string} root the project folder @param {any} [definition] the parsed ecosystems.json (default: the shipped one)
 * @returns {Discovery}
 */
export function discoverCommands(root, definition) {
  const data = definition ?? loadEcosystems();
  /** @type {Record<Kind, string[]>} */ const cur = { build: [], test: [], lint: [] };
  /** @type {Set<Kind>} */ const closed = new Set();
  /** first writer wins, and a kind it writes takes no further ecosystem command @param {Kind} k @param {string} c */
  const set = (k, c) => { if (cur[k].length > 0) return; cur[k] = [c]; closed.add(k); };
  /** @param {Kind} k @param {string} c */
  const add = (k, c) => { if (!closed.has(k) && !cur[k].includes(c)) cur[k].push(c); };

  // the patterns of CI and README lines, and the tools a line may start with
  const g = data.global?.ci_scan ?? {};
  const ciBuild = new RegExp(first(g.build) || ' (build|compile|package)( |$)');
  const ciTest = new RegExp(first(g.test) || ' (test|tests|pytest)( |$)|^pytest');
  const ciLintBase = first(g.lint) || ' (lint|vet|clippy)( |$)|^(ruff|eslint)';
  const ciExtra = [...new Set(data.ecosystems.flatMap((/** @type {any} */ e) => list(e.commands?.ci_lint)))].join('|');
  const ciLint = new RegExp(ciExtra === '' ? ciLintBase : `${ciLintBase}|${ciExtra}`);
  const tools = [...list(g.tools), ...new Set(data.ecosystems.flatMap((/** @type {any} */ e) => list(e.commands?.tools)))].map((t) => t.replace(/\./g, '\\.')).join('|');

  // the plan: the one target of every ecosystem that has exactly one
  /** @type {Planned[]} */ const plan = [];
  /** @type {Array<{ id: string, why: string }>} */ const ambig = [];
  const { markers: marks, truncated } = markers(root, data);
  if (marks.length > 0) {
    for (const eco of data.ecosystems) {
      const s = select(eco, data, root, marks, truncated);
      if (s.mode === 'none') { if (s.why !== '') ambig.push({ id: eco.id, why: s.why }); continue; }
      plan.push({ id: eco.id, mode: s.mode, dir: s.dir, target: s.target });
    }
  }
  /** @param {'root' | 'nested'} where @param {'scripts' | 'tools' | 'any'} truth */
  const apply = (where, truth) => {
    for (const p of plan) {
      if ((p.dir === '.') !== (where === 'root')) continue;
      const eco = data.ecosystems.find((/** @type {any} */ e) => e.id === p.id);
      if (truth !== 'any' && first(eco.commands?.truth) !== truth) continue;
      const unit = p.dir === '.' ? root : path.join(root, p.dir);
      for (const k of KINDS) { const c = rule(eco, k, p.mode, unit, root, p.dir, p.target); if (c !== null) add(k, c); }
    }
  };

  apply('root', 'scripts');
  runnerFile(root, ['Makefile', 'makefile', 'GNUmakefile'], (k) => new RegExp(`^${k}[ \\t\\n\\v\\f\\r]*:`), 'make', set);
  runnerFile(root, ['justfile', 'Justfile', '.justfile'], (k) => new RegExp(`^${k}[ \\t\\n\\v\\f\\r]*:([^=]|$)`), 'just', set);
  runnerFile(root, ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'], (k) => new RegExp(`^[ \\t\\n\\v\\f\\r]{2,4}${k}:[ \\t\\n\\v\\f\\r]*(#.*)?$`), 'task', set, true);
  apply('root', 'tools');
  apply('nested', 'any');

  // CI configuration, then the README: one covering line per kind
  const names = [...ls(path.join(root, '.github/workflows'), /\.yml$/), ...ls(path.join(root, '.github/workflows'), /\.yaml$/), '.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'Jenkinsfile', 'bitbucket-pipelines.yml', ...ls(root, /^README/, true)];
  const files = names.map((n) => (path.isAbsolute(n) ? n : path.join(root, n))).filter(isFile);
  if (files.length > 0 && tools !== '') {
    const cands = scan(files, tools);
    for (const [k, re] of /** @type {Array<[Kind, RegExp]>} */ ([['build', ciBuild], ['test', ciTest], ['lint', ciLint]])) {
      const l = cands.find((c) => re.test(c));
      if (l !== undefined) set(k, l);
    }
  }

  // a planned ecosystem whose target was found but whose rules gave no command, while no command at all was found
  if (cur.build.length + cur.test.length + cur.lint.length === 0) {
    for (const p of plan) {
      const eco = data.ecosystems.find((/** @type {any} */ e) => e.id === p.id);
      const unit = p.dir === '.' ? root : path.join(root, p.dir);
      if (!KINDS.some((k) => rule(eco, k, p.mode, unit, root, p.dir, p.target) !== null)) ambig.push({ id: p.id, why: `found at ${p.dir} but no build, test or lint rule of it matches there` });
    }
  }
  return { ...cur, ambig };
}

/** The files of a folder matching RE, in byte order (absolute paths); a name pattern for the README files of ROOT. @param {string} dir @param {RegExp} re @param {boolean} [any] */
function ls(dir, re, any = false) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => re.test(e.name) && (any || e.isFile() || e.isSymbolicLink())).map((e) => path.join(dir, e.name)).sort(byBytes);
  } catch { return []; }
}

/**
 * `d_ambig_notes`: one line per ecosystem that got no command because its target is ambiguous. The user is asked once, after a run that proved a command, never given a guess.
 * @param {Discovery['ambig']} ambig @param {any} [definition] @returns {string[]}
 */
export function ambigNotes(ambig, definition) {
  const data = definition ?? loadEcosystems();
  return ambig.map(({ id, why }) => {
    const name = String(data.ecosystems.find((/** @type {any} */ e) => e.id === id)?.name ?? '').replace(/ \(.*$/s, '');
    return `no command proposed for ${name || id} (${why}); a run that proves one asks you once to add it`;
  });
}

/** `d_join`: the commands of a list on one line, "a; b". @param {string[]} cmds */
export const joinCommands = (cmds) => cmds.filter((c) => c !== '').join('; ');

/** `d_safe`: no shell control operator, redirection or substitution (a trial run would execute it). @param {string} c */
export function isSafeCommand(c) { return !/[&;|<>`]/.test(c) && !c.includes('$(') && !c.includes('${') && !c.includes('{{'); }

/**
 * `run_with_timeout`: run a program with its output into FILE (default: discarded) and stop it after SECONDS. The program leads a process group of its own, and the
 * whole group is killed when it ends or the time is up (no grandchild of a hung `sh -c` lingers); an expired limit is status 124 whatever status the program then
 * reports (a command that traps TERM and exits 0 is no pass).
 * @param {number} seconds @param {string[]} argv program and arguments @param {{ cwd?: string, env?: NodeJS.ProcessEnv, outFile?: string }} [o]
 * @returns {{ status: number, timedOut: boolean }}
 */
export function runWithTimeout(seconds, argv, o = {}) {
  const fd = o.outFile ? openSync(o.outFile, 'w') : -1;
  try {
    const stdio = /** @type {Array<'ignore' | number>} */ (['ignore', fd >= 0 ? fd : 'ignore', fd >= 0 ? fd : 'ignore']);
    const r = proc.run(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio, timeoutMs: seconds * 1000, group: true, killSignal: 'SIGKILL' });
    return r.timedOut === true ? { status: 124, timedOut: true } : { status: r.status, timedOut: false };
  } finally { if (fd >= 0) closeSync(fd); }
}

/** The time a trial run of one discovered command may take. */
export const TRIAL_SECONDS = 600;

/**
 * `verify_commands`: trial-run every discovered command (one by one, also inside a list); a failing one is dropped and the others of its list stay. A command with a
 * shell operator is never run. SAY gets each line of the report.
 * @param {string} root @param {Pick<Discovery, 'build' | 'test' | 'lint'>} cmds @param {(line: string) => void} say
 * @param {{ seconds?: number, env?: NodeJS.ProcessEnv }} [o] @returns {Record<Kind, string[]>}
 */
export function verifyCommands(root, cmds, say, o = {}) {
  /** @type {Record<Kind, string[]>} */ const kept = { build: [], test: [], lint: [] };
  for (const k of KINDS) {
    for (const c of cmds[k]) {
      if (c === '') continue;
      if (!isSafeCommand(c)) { say(`  commands.${k} has shell operators, not trial-run and left empty: ${c}`); continue; }
      const r = runWithTimeout(o.seconds ?? TRIAL_SECONDS, proc.userShellArgv(c), { cwd: root, env: o.env });
      if (r.status === 0) { say(`  verified commands.${k}: ${c}`); kept[k].push(c); } else say(`  commands.${k} trial failed, left empty: ${c}`);
    }
  }
  return kept;
}
