// @ts-check
// Stage 4, package 4C: the capability probes a record uses to refuse an UNSUPPORTED result (agent.sh 0.0.47 `probe_visual`, `probe_performance`, A102,
// A173). They only ever REFUSE an UNSUPPORTED (a present capability means the check can run), they never grant anything. There is no test seam
// (D14): the search path is the process's own PATH and the application folders are the real ones.
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { git } from './git.mjs';
import { isFile } from './paths.mjs';
import { globToRegex } from './scope.mjs';
import { grepEq } from './signals.mjs';
import { ecosystemRows } from './ecodata.mjs';
import { ecosystemSets } from './signals.mjs';
import { textLines } from './records.mjs';
import path from 'node:path';

/** @typedef {import('./context.mjs').Context} Context */

/** The flat ecosystem definition: rows `<id> TAB <path> TAB <value>` (ecodata.mjs). */
class Eco {
  /** @param {string[][]} rows */
  constructor(rows) { this.rows = rows; }
  ids() { /** @type {string[]} */ const o = []; for (const r of this.rows) if (r[0] !== '*' && !o.includes(r[0])) o.push(r[0]); return o; }
  /** @param {string} id @param {string} p */
  get(id, p) { return this.rows.filter((r) => r[0] === id && r[1] === p).map((r) => r[2] ?? ''); }
  /** @param {string} id @param {string} p */
  first(id, p) { return this.get(id, p)[0] ?? ''; }
  /** One entry per element of the object array at P: the values of KEYS, several values of one key joined by the record separator. @param {string} id @param {string} p @param {string[]} keys */
  objects(id, p, keys) {
    const pre = `${p}.`;
    /** @type {string[]} */ const order = [];
    /** @type {Map<string, Map<string, string>>} */ const byIdx = new Map();
    for (const r of this.rows) {
      if (r[0] !== id || !r[1].startsWith(pre)) continue;
      const rest = r[1].slice(pre.length);
      const dot = rest.indexOf('.');
      if (dot < 0) continue;
      const idx = rest.slice(0, dot); const key = rest.slice(dot + 1);
      if (!byIdx.has(idx)) { byIdx.set(idx, new Map()); order.push(idx); }
      if (keys.includes(key)) { const m = /** @type {Map<string, string>} */ (byIdx.get(idx)); m.set(key, m.has(key) ? `${m.get(key)}\x1e${r[2] ?? ''}` : (r[2] ?? '')); }
    }
    return order.map((i) => keys.map((k) => byIdx.get(i)?.get(k) ?? ''));
  }
}

/** The ecosystem data of the project, or null when it is not loaded (a missing definition grants no capability). @param {Context} ctx */
function loadEco(ctx) {
  if (!ecosystemSets(ctx).loaded) return null;
  const rows = ecosystemRows(ctx);
  return rows ? new Eco(rows) : null;
}

/** `[ -x F ] && [ ! -d F ]` @param {string} f */
function executableFile(f) {
  try { accessSync(f, constants.X_OK); return !statSync(f).isDirectory(); } catch { return false; }
}

const BROWSERS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'microsoft-edge', 'microsoft-edge-stable', 'msedge', 'brave-browser'];
const APPS = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser'];

/**
 * `probe_visual`: a Chromium-family binary on PATH or in the standard macOS application folder, or an installed project browser-test dependency.
 * Empty when there is none. @param {Context} ctx
 */
export function probeVisual(ctx) {
  for (const d of (ctx.env.PATH ?? '').split(':')) {
    if (d === '') continue;
    for (const n of BROWSERS) if (executableFile(`${d}/${n}`)) return `browser ${d}/${n}`;
  }
  for (const a of APPS) if (executableFile(`/Applications/${a}`)) return `browser /Applications/${a}`;
  const eco = loadEco(ctx);
  if (eco === null) return '';
  for (const e of eco.ids()) {
    const m = eco.first(e, 'browser_test.manifest'); const dd = eco.first(e, 'browser_test.deps_dir');
    if (m === '' || dd === '' || !isFile(`${ctx.root}/${m}`)) continue;
    const manifest = readFileSync(`${ctx.root}/${m}`, 'latin1');
    for (const t of eco.get(e, 'browser_test.names')) {
      let dir = false;
      try { dir = statSync(`${ctx.root}/${dd}/${t}`).isDirectory(); } catch { /* none */ }
      if (manifest.includes(`"${t}"`) && dir) return `project browser-test dependency ${t} (${m}, ${dd})`;
    }
  }
  return '';
}

/**
 * `probe_performance`: a benchmark setup the project already has (tracked files only), from the `benchmark` section of every ecosystem (A173).
 * Empty when there is none. @param {Context} ctx
 */
export function probePerformance(ctx) {
  const eco = loadEco(ctx);
  if (eco === null) return '';
  const ls = git(ctx, ['ls-files']);
  let files = ls.status === 0 ? textLines(ls.out) : [];
  if (files.length === 0) return '';
  const prune = new Set([...eco.get('*', 'prune'), ...eco.ids().flatMap((e) => eco.get(e, 'prune'))]);
  files = files.filter((f) => { const seg = f.split('/'); for (let i = 0; i < seg.length - 1; i++) if (prune.has(seg[i])) return false; return true; });
  /** @param {string[]} pats */
  const pick = (pats) => { const res = pats.filter((p) => p !== '').flatMap((p) => p.split(/[ \t\n]+/).filter((x) => x !== '')).map((p) => globToRegex(p)); return files.filter((f) => res.some((r) => r.test(f))); };
  /** The first of the given files that holds RE. @param {string[]} list @param {string} re */
  const grepFirst = (list, re) => {
    for (const f of list) {
      let t;
      try { t = readFileSync(`${ctx.root}/${f}`, 'latin1'); } catch { continue; }
      if (grepEq(ctx, re, t)) return f;
    }
    return '';
  };
  for (const m of ['Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', 'Taskfile.yml', 'Taskfile.yaml']) {
    if (!isFile(`${ctx.root}/${m}`)) continue;
    if (textLines(readFileSync(`${ctx.root}/${m}`, 'latin1')).some((l) => /^(bench|benchmark)[ \t\n\v\f\r]*:/.test(l))) return `${m} target bench/benchmark`;
  }
  for (const e of eco.ids()) {
    const sc = eco.get(e, 'benchmark.scripts').map((s) => s.replace(/\./g, '\\.').replace(/\*/g, '[A-Za-z0-9:_.-]*')).join('|');
    if (sc !== '') {
      for (const f of pick([eco.get(e, 'manifests')[0] ?? ''])) {
        let t = '';
        try { t = readFileSync(`${ctx.root}/${f}`, 'latin1'); } catch { continue; }
        // sed -n '/"scripts"[[:space:]]*:/,/}/p'
        const keep = [];
        let inRange = false;
        for (const l of textLines(t)) {
          if (!inRange && /"scripts"[ \t\n\v\f\r]*:/.test(l)) { inRange = true; keep.push(l); continue; }
          if (inRange) { keep.push(l); if (l.includes('}')) inRange = false; }
        }
        if (grepEq(ctx, `"(${sc})"[[:space:]]*:`, keep.join('\n'))) return `${f} script bench/benchmark/perf*`;
      }
    }
    const proj = eco.get(e, 'project_files').join(' ');
    for (const d of eco.get(e, 'benchmark.dirs')) {
      if (pick([proj]).length > 0 && pick([`${d}/**`, `**/${d}/**`]).length > 0) return `${e} ${d}/ directory`;
    }
    for (const c of eco.get(e, 'benchmark.config_files')) { const hit = pick([c])[0]; if (hit !== undefined) return hit; }
    for (const [gl, ct, wy] of eco.objects(e, 'benchmark.files', ['glob', 'contains', 'why'])) {
      const hit = grepFirst(pick([gl.replace(/\x1e/g, ' ')]), ct);
      if (hit !== '') return `${wy} (${hit})`;
    }
    for (const [inn, ct, wy] of eco.objects(e, 'benchmark.dependencies', ['in', 'contains', 'why'])) {
      const hit = grepFirst(pick([inn.replace(/\x1e/g, ' ')]), ct);
      if (hit !== '') return `${wy} in ${hit}`;
    }
  }
  return '';
}
