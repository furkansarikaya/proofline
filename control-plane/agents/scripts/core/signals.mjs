// @ts-check
// Pipeline, tier and risk signals (agent.sh lines 941-1440): what a run's class requires, which tier its changes put it in, which risk
// signals its diff, its plan scope and its plan flags raise, and the focuses and gates they add. Read-only. Values that depend on the
// working tree (changed paths, tier, signals) are computed once per invocation (ctx.once keys `changed:`, `tier:`, `risk:`); a command
// that changes the tree or RUN.yaml calls ctx.forget('changed:'), ctx.forget('tier:'), ctx.forget('risk:') first.
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ereToRegExp } from './ere.mjs';
import { BridgeToShell } from './errors.mjs';
import { baselineFingerprint, pathFingerprint } from './fingerprint.mjs';
import { addedLines, catBatch, diffNames, numstat, objectExists, show, trackedSet, untrackedPaths, sortUnique } from './git.mjs';
import { sha256 } from './hash.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { WS, authorizedPath, fileText, gatesEnforced, planDestructive, planScope, planSectionPresent, scopePaths, sectionKeyPresent, sectionValue, textLines } from './records.mjs';
import { blockOnlyText, firstGlob, inKnowledgeScope, installedControlPath, isBlockFile, pathMatches, stripProoflineBlock, words } from './scope.mjs';

/** @typedef {import('./context.mjs').Context} Context */

// ---- ecosystem data (A173): the risky and dependency globs, read from ecosystems.tsv as data ----------------------------------------

/**
 * `eco_sets`: the risky set and the dependency set, space-joined, from the flat ecosystem definition. `loaded` is false when the
 * definition is not readable (the config globs alone apply, and `pipeline` prints a warning).
 * @param {Context} ctx @returns {{ loaded: boolean, risky: string, dependency: string }}
 */
export function ecosystemSets(ctx) {
  return ctx.once('eco-sets', () => {
    let tsv = `${ctx.agents}/ecosystems.tsv`;
    let sh = `${ctx.scripts}/ecosystems.sh`;
    const nonEmptyFile = (/** @type {string} */ f) => { try { return statSync(f).size > 0; } catch { return false; } };
    if (!nonEmptyFile(tsv) || !isFile(sh)) {
      const ship = path.dirname(ctx.scriptDir);
      if (ship !== ctx.agents && nonEmptyFile(`${ship}/ecosystems.tsv`) && isFile(`${ship}/scripts/ecosystems.sh`)) { tsv = `${ship}/ecosystems.tsv`; sh = `${ship}/scripts/ecosystems.sh`; }
    }
    if (!isFile(sh) || !nonEmptyFile(tsv)) return { loaded: false, risky: '', dependency: '' };
    let text;
    try { text = readFileSync(tsv, 'latin1'); } catch { return { loaded: false, risky: '', dependency: '' }; }
    const r = new Set(); const d = new Set();
    /** @type {string[]} */ const rl = []; /** @type {string[]} */ const dl = [];
    for (const line of textLines(text)) {
      const f = line.split('\t');
      const [id, key, val] = [f[0], f[1], f[2]];
      if ((id === '*' && key === 'risky_paths') || (id !== '*' && (key === 'risky_paths' || key === 'manifests' || key === 'locks' || key === 'settings'))) { if (!r.has(val)) { r.add(val); rl.push(val); } }
      if (id !== '*' && (key === 'manifests' || key === 'locks' || key === 'settings')) { if (!d.has(val)) { d.add(val); dl.push(val); } }
    }
    return { loaded: true, risky: rl.join(' '), dependency: dl.join(' ') };
  });
}

/** `eco_warning`: the line `pipeline` prints without the "warning: " head. */
export const ECO_WARNING = '.agents/ecosystems.tsv is missing or empty, so the risky-path and dependency sets are empty and only the config.yaml globs apply: run proofline upgrade (proofline doctor shows it)';

// ---- pipeline -------------------------------------------------------------------------------------------------------------------

/** `pipeline_value CLASS KEY` @param {Context} ctx @param {string} cls @param {string} key */
export function pipelineValue(ctx, cls, key) { return ctx.config().get(`pipelines.${cls}.${key}`, ''); }
/** @param {string} c */
export function pipelineClassValid(c) { return c === 'TRIVIAL' || c === 'STANDARD' || c === 'COMPLEX' || c === 'CRITICAL'; }
/** @param {Context} ctx @param {string} dir */
export function pipelineClass(ctx, dir) { return sectionValue(ctx, dir, 'pipeline', 'classification'); }
/** @param {Context} ctx @param {string} dir */
export function pipelineDeclared(ctx, dir) { return gatesEnforced(ctx, dir) && sectionKeyPresent(ctx, dir, 'pipeline', 'classification'); }

/** `pipeline_needs ID evidence|qa|architect` @param {Context} ctx @param {string} dir @param {string} what */
export function pipelineNeeds(ctx, dir, what) {
  const cls = pipelineClass(ctx, dir);
  if (pipelineDeclared(ctx, dir) && pipelineClassValid(cls)) return pipelineValue(ctx, cls, what);
  return what === 'evidence' ? 'yes' : 'no';
}

/** `pipeline_review ID` @param {Context} ctx @param {string} dir */
export function pipelineReview(ctx, dir) {
  const cls = pipelineClass(ctx, dir);
  const v = pipelineValue(ctx, cls, 'review');
  if (v === 'yes' || v === 'no') return v;
  if (v === 'optional') return sectionValue(ctx, dir, 'pipeline', 'review') === 'yes' ? 'yes' : 'no';
  return 'no';
}

/** `run_autonomy ID` @param {Context} ctx @param {string} dir */
export function runAutonomy(ctx, dir) {
  const a = sectionValue(ctx, dir, 'execution', 'autonomy');
  if (a === 'supervised' || a === 'autonomous') return a;
  return ctx.config().get(`autonomy.${pipelineClass(ctx, dir)}`, 'supervised');
}

// ---- changed paths and the tier -------------------------------------------------------------------------------------------------

/** `repository_base_sha`, HEAD when pending. @param {Context} ctx @param {string} dir */
function baseOrHead(ctx, dir) {
  const b = sectionValue(ctx, dir, 'repository', 'base_sha');
  return b === '' || b === 'PENDING' ? 'HEAD' : b;
}

/** `control_plane_only PATH`: an installed file, or AGENTS.md/CLAUDE.md whose text outside the proofline block equals HEAD's. @param {Context} ctx @param {string} p */
export function controlPlaneOnly(ctx, p) {
  if (installedControlPath(ctx, p)) return true;
  if (!isBlockFile(p)) return false;
  const f = `${ctx.root}/${p}`;
  let l; try { l = lstatSync(f); } catch { return false; }
  if (!l.isFile()) return false;
  const head = show(ctx, `HEAD:${p}`);
  const cur = fileText(ctx, f) ?? '';
  if (head === null) {
    if (objectExists(ctx, `HEAD:${p}`)) return false;
    return blockOnlyText(cur);
  }
  return sha256(stripProoflineBlock(head)) === sha256(stripProoflineBlock(cur));
}

/** `knowledge_doc_file PATH`: a regular, non-executable, non-symlink file with a documentation extension, with no linked folder on the way. @param {Context} ctx @param {string} p */
function knowledgeDocFile(ctx, p) {
  const f = `${ctx.root}/${p}`;
  try {
    const l = lstatSync(f);
    if (!l.isFile()) return false;
    try { accessSync(f, constants.X_OK); return false; } catch { /* not executable */ }
  } catch { return false; }
  if (!/\.(md|mdx|rst|adoc|html|txt|png|jpg|jpeg|gif|svg|webp)$/.test(p)) return false;
  try { return realpathSync(path.dirname(f)) === `${realpathSync(ctx.root)}/${path.posix.dirname(p)}`.replace(/\/\.$/, ''); } catch { return false; }
}

/** `fingerprint_path` where a failure is printed and read as empty (a `$(...)` inside a test). @param {Context} ctx @param {string} p */
function fpOrEmpty(ctx, p) {
  try { return pathFingerprint(ctx, p); } catch (e) {
    if (e instanceof Error && e.name === 'ProoflineError') { ctx.err(`${e.message}\n`); return ''; }
    throw e;
  }
}

/**
 * `task_changed_paths ID`: the paths the task changed against repository.base_sha (tracked, staged or not, plus untracked), minus the run
 * directory, .agents/local/, the task files directory, control-plane files the plan does not name, the knowledge step's documents after
 * CODE_DONE and baseline files whose content is unchanged.
 * @param {Context} ctx @param {string} dir @returns {string[]}
 */
export function taskChangedPaths(ctx, dir) {
  return ctx.once(`changed:${dir}`, () => {
    const base = baseOrHead(ctx, dir);
    const tasks = ctx.config().get('tasks.dir', '.agents/tasks');
    const sc = planScope(ctx, dir);
    const maps = sc.ok ? sc.rows : [];
    const hs = sectionValue(ctx, dir, 'handoff', 'state');
    const ks = hs === 'CODE_DONE' || hs === 'DONE';
    const list = sortUnique([...diffNames(ctx, base), ...untrackedPaths(ctx)]);
    /** @type {string[]} */ const out = [];
    for (const p of list) {
      if (p === '') continue;
      if (p.startsWith('.agents/runs/') || p.startsWith('.agents/local/') || p.startsWith(`${tasks}/`)) continue;
      const named = authorizedPath(maps, p);
      if (ks && inKnowledgeScope(ctx, p) && !named && knowledgeDocFile(ctx, p)) continue;
      if (p.startsWith('.agents/') && !named) continue;
      if (!named && controlPlaneOnly(ctx, p)) continue;
      let prior = baselineFingerprint(ctx, 'tracked', p, dir);
      if (prior === '') prior = baselineFingerprint(ctx, 'untracked', p, dir);
      if (prior !== '' && prior === fpOrEmpty(ctx, p)) continue;
      out.push(p);
    }
    return out;
  });
}

/**
 * The changed line count (added + deleted) of each path against the base; a binary file counts as large. Batched: the same numbers as
 * `path_changed_lines` for every path, with a handful of git calls in all.
 * @param {Context} ctx @param {string} dir @param {string[]} paths @returns {Map<string, number>}
 */
export function pathChangedLines(ctx, dir, paths) {
  const base = baseOrHead(ctx, dir);
  /** @type {Map<string, number>} */ const out = new Map();
  if (paths.length === 0) return out;
  const tracked = trackedSet(ctx, paths);
  const rest = paths.filter((p) => !tracked.has(p));
  const atBase = catBatch(ctx, rest.map((p) => `${base}:${p}`));
  const diffable = paths.filter((p) => tracked.has(p) || atBase.get(`${base}:${p}`) !== null && atBase.get(`${base}:${p}`) !== undefined);
  const stats = numstat(ctx, base, diffable);
  for (const p of paths) {
    if (tracked.has(p) || (atBase.get(`${base}:${p}`) ?? null) !== null) { out.set(p, stats.get(p) ?? 0); continue; }
    const f = `${ctx.root}/${p}`;
    if (isFile(f)) {
      const buf = readFileSync(f);
      if (buf.length === 0) { out.set(p, 0); continue; }
      const text = !buf.includes(0) && buf.some((b) => b !== 0x0a);
      out.set(p, text ? buf.filter((b) => b === 0x0a).length : 100000);
    } else out.set(p, 0);
  }
  return out;
}

/** @param {string} t */
export function tierRank(t) { return t === 'docs' ? 0 : t === 'small' ? 1 : t === 'full' ? 2 : -1; }
/** @param {string} a @param {string} b */
export function tierMax(a, b) { return tierRank(a) >= tierRank(b) ? a : b; }

/** `risk_names`: the signal names that have a paths or content key with a value, sorted. @param {Context} ctx @returns {string[]} */
export function riskNames(ctx) {
  return ctx.once('risk-names', () => {
    const s = new Set();
    for (const l of riskConfigLines(ctx)) {
      const key = l.split('=')[0];
      const val = l.split('=')[1] ?? '';
      const m = /^risk\.([a-z_]+)\.(paths|content)$/.exec(key);
      if (m && val !== '') s.add(m[1]);
    }
    return [...s].sort();
  });
}

/** A config number that feeds a comparison; a value the shell's `[` would reject leaves the command to the shell. @param {string} v */
function numberOrBridge(v) {
  if (!/^[0-9]+$/.test(v) || v.length > 15) throw new BridgeToShell(`not a number: ${v}`);
  return Number(v);
}

/**
 * `tier_compute ID`: docs | small | full from the changed paths.
 * @param {Context} ctx @param {string} dir
 */
export function tierCompute(ctx, dir) {
  return ctx.once(`tier:compute:${dir}`, () => {
    const cfg = ctx.config();
    if (pipelineClass(ctx, dir) === 'CRITICAL') return 'full';
    const eco = ecosystemSets(ctx);
    const cl = cfg.get('review.code_like_markdown', '.agents/** skills/** roles/** adapters/** .claude/** .codex/** AGENTS.md CLAUDE.md **/SKILL.md **/*.prompt.md');
    let rp = `${cfg.get('review.risky_paths', '')} ${eco.risky}`;
    if (rp.startsWith(' ')) rp = rp.slice(1);
    let mg = '';
    for (const n of riskNames(ctx)) if (cfg.get(`risk.${n}.check`, '') === 'migration') mg += ` ${cfg.get(`risk.${n}.paths`, '')}`;
    const changed = taskChangedPaths(ctx, dir);
    const lines = pathChangedLines(ctx, dir, changed);
    let docs = true; let risky = false; let files = 0; let total = 0;
    for (const p of changed) {
      files++; total += lines.get(p) ?? 0;
      if (rp !== '' && pathMatches(p, rp)) { risky = true; docs = false; }
      else if (mg.slice(1) !== '' && pathMatches(p, mg) && !pathMatches(p, '*.md *.mdx *.rst *.adoc')) { risky = true; docs = false; }
      else if (pathMatches(p, cl) || !pathMatches(p, '*.md *.mdx *.rst *.adoc *.txt')) docs = false;
    }
    let t;
    if (docs) t = 'docs';
    else if (files <= numberOrBridge(cfg.get('review.small_max_files', '2')) && total <= numberOrBridge(cfg.get('review.small_max_lines', '30')) && !risky) t = 'small';
    else t = 'full';
    if (pipelineReview(ctx, dir) === 'yes') t = tierMax(t, 'small');
    return t;
  });
}

/** `tier_effective ID`: the recorded tier or the computed one, whichever is higher. @param {Context} ctx @param {string} dir */
export function tierEffective(ctx, dir) {
  const rec = sectionValue(ctx, dir, 'pipeline', 'tier');
  const now = tierCompute(ctx, dir);
  return rec === 'docs' || rec === 'small' || rec === 'full' ? tierMax(rec, now) : now;
}

// ---- risk signals (A78) ---------------------------------------------------------------------------------------------------------

export const RISK_PLAN_FLAGS = 'contract_change concurrency performance_critical';
const RISK_FLAGS = `${RISK_PLAN_FLAGS} data_change destructive ui`;

/** `risk_focus_role FOCUS` @param {string} f */
export function riskFocusRole(f) {
  switch (f) {
    case 'contract': case 'concurrency': case 'performance': case 'config': case 'migration': return 'reviewer';
    case 'visual': return 'qa';
    case 'dependencies': case 'logging': return 'security_reviewer';
    default: return '';
  }
}

/** `risk_focus_on_gate FOCUS GATE` @param {string} f @param {string} g */
export function riskFocusOnGate(f, g) {
  switch (`${f}:${g}`) {
    case 'contract:REVIEW_RULES': case 'concurrency:REVIEW_RULES': case 'performance:REVIEW_RULES': case 'config:REVIEW_RULES':
    case 'contract:REVIEW_SMALL': case 'concurrency:REVIEW_SMALL': case 'performance:REVIEW_SMALL': case 'config:REVIEW_SMALL':
    case 'migration:REVIEW_DATA': case 'visual:QA': case 'dependencies:SECURITY': case 'logging:SECURITY': return true;
    default: return false;
  }
}

/** `plan_flag PLAN FLAG` -> yes | no. @param {string | null} plan @param {string} flag */
export function planFlag(plan, flag) {
  if (plan === null) return 'no';
  if (flag === 'data_change') return planSectionPresent(plan, 'Data') ? 'yes' : 'no';
  if (flag === 'ui') return planSectionPresent(plan, 'UI') ? 'yes' : 'no';
  if (flag === 'destructive') return planDestructive(plan) === 'yes' ? 'yes' : 'no';
  let inRisk = false;
  const yes = new RegExp(`^${flag}:${WS}*yes(${WS}|$)`);
  for (const line of textLines(plan)) {
    if (line.startsWith('## ')) { inRisk = new RegExp(`^## Risk${WS}*$`).test(line); continue; }
    if (inRisk && yes.test(line.replace(new RegExp(`^[-*]${WS}*`), ''))) return 'yes';
  }
  return 'no';
}

/** The `risk_config` block: the lines the freeze binds (risk., performance., non-empty security. and contract. keys, the ecosystem set). @param {Context} ctx @returns {string[]} */
export function riskConfigLines(ctx) {
  return ctx.once('risk-config', () => {
    const lines = ctx.config().lines.filter((l) => /^(risk\.|performance\.|security\..*=.|contract\..*=.)/.test(l));
    const dep = ecosystemSets(ctx).dependency;
    if (dep !== '') lines.push(`risk.ecosystems.dependencies=${dep}`);
    return lines;
  });
}

/** @param {string[]} lines */
const hashLines = (lines) => sha256(lines.length === 0 ? '' : `${lines.join('\n')}\n`);

/** `risk_freeze_ok RECORDED` -> the hash is the current block or one of the bounded legacy forms. @param {Context} ctx @param {string} h */
export function riskFreezeOk(ctx, h) {
  const all = riskConfigLines(ctx);
  const noeco = all.filter((l) => !l.startsWith('risk.ecosystems.'));
  const legacy = all.filter((l) => !/^risk\.log_sensitive[.=]/.test(l));
  const legacyNoeco = legacy.filter((l) => !l.startsWith('risk.ecosystems.'));
  return [all, noeco, legacy, legacyNoeco].some((x) => hashLines(x) === h);
}

/** `risk_eco_unbound ID`: the run was frozen on a block without the ecosystem set (it keeps its own paths). @param {Context} ctx @param {string} dir */
function riskEcoUnbound(ctx, dir) {
  const h = sectionValue(ctx, dir, 'freeze', 'risk_sha256');
  if (h === '') return false;
  const all = riskConfigLines(ctx);
  const noeco = all.filter((l) => !l.startsWith('risk.ecosystems.'));
  const legacyNoeco = all.filter((l) => !/^risk\.log_sensitive[.=]/.test(l)).filter((l) => !l.startsWith('risk.ecosystems.'));
  return h !== hashLines(all) && (h === hashLines(noeco) || h === hashLines(legacyNoeco));
}

/** `risk_legacy_frozen ID`: frozen on the block without risk.log_sensitive. @param {Context} ctx @param {string} dir */
export function riskLegacyFrozen(ctx, dir) {
  const h = sectionValue(ctx, dir, 'freeze', 'risk_sha256');
  if (h === '') return false;
  const all = riskConfigLines(ctx);
  const noeco = all.filter((l) => !l.startsWith('risk.ecosystems.'));
  const legacy = all.filter((l) => !/^risk\.log_sensitive[.=]/.test(l));
  const legacyNoeco = legacy.filter((l) => !l.startsWith('risk.ecosystems.'));
  return h !== hashLines(all) && h !== hashLines(noeco) && (h === hashLines(legacy) || h === hashLines(legacyNoeco));
}

/** `risk_paths ID NAME`: the globs of one signal, plus the ecosystem set when its check is `dependencies`. @param {Context} ctx @param {string} dir @param {string} name */
export function riskPaths(ctx, dir, name) {
  const cfg = ctx.config();
  let g = cfg.get(`risk.${name}.paths`, '');
  const dep = ecosystemSets(ctx).dependency;
  if (cfg.get(`risk.${name}.check`, '') === 'dependencies' && dep !== '' && !riskEcoUnbound(ctx, dir)) g = `${g} ${dep}`;
  return g.startsWith(' ') ? g.slice(1) : g;
}

/** Verbatim copy of contract-proof's NOT_A_CONTRACT (risk-test asserts equality, A92). */
export const RISK_NOT_CONTRACT = '(^|\\/)(package(-lock)?\\.json|npm-shrinkwrap\\.json|composer\\.json|(ts|js)config[^/]*\\.json|openapitools\\.json|openapi-generator-config\\.ya?ml|\\.eslintrc[^/]*|\\.prettierrc[^/]*|\\.babelrc[^/]*|babel\\.config\\.json|\\.stylelintrc[^/]*|\\.markdownlint[^/]*|lerna\\.json|nx\\.json|turbo\\.json|renovate\\.json|deno\\.jsonc?|bower\\.json|pnpm-(lock|workspace)\\.yaml|\\.pre-commit-config\\.yaml|\\.gitlab-ci\\.yml|docker-compose[^/]*\\.ya?ml|compose\\.ya?ml|mkdocs\\.ya?ml|\\.readthedocs\\.ya?ml|codecov\\.ya?ml|dependabot\\.ya?ml)$|^\\.github\\/(workflows|actions|ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE|DISCUSSION_TEMPLATE)\\/|^\\.github\\/(dependabot|labeler|release|stale|FUNDING|config)\\.ya?ml$|^(\\.vscode|\\.idea|\\.agents|\\.devcontainer)\\/';

/** @param {string} c */
const isAlpha = (c) => /[A-Za-z]/.test(c);
/** ASCII-only lower case (awk's tolower in the C locale). @param {string} s */
const lower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * One line against the words rule of `risk_words_match`: the line names one of the words as a whole identifier part (case-insensitive,
 * not inside a longer lowercase run: `password`, `user_password`, `userPassword`, `passwords` match; `classname` has no `ssn`).
 * @param {string} line @param {string[]} ws lower-case words
 */
function lineNamesWord(line, ws) {
  const l = lower(line);
  for (const w of ws) {
    let s = 0;
    for (;;) {
      const j = l.indexOf(w, s);
      if (j < 0) break;
      const e = j + w.length;
      const pc = j > 0 ? line[j - 1] : '';
      const c = line[j];
      const okb = pc === '' || !isAlpha(pc) || (/[A-Z]/.test(c) && /[a-z]/.test(pc));
      const n1 = line[e] ?? '';
      const n2 = /[sS]/.test(n1) ? (line[e + 1] ?? '') : 'x';
      const oka = !/[a-z]/.test(n1) || (/[sS]/.test(n1) && !/[a-z]/.test(n2));
      if (okb && oka) return true;
      s = j + 1;
    }
  }
  return false;
}

/**
 * `risk_words_match CONTENT WORDS` over lines: some line matches CONTENT (an extended regular expression) and names one of WORDS.
 * A pattern the translator does not cover is matched by the platform's awk, as the shell did.
 * @param {Context} ctx @param {string} content @param {string} wordList @param {string[]} lines
 */
export function riskWordsMatch(ctx, content, wordList, lines) {
  const ws = words(lower(wordList));
  const re = ereToRegExp(content);
  if (re !== null) return lines.some((l) => re.test(l) && lineNamesWord(l, ws));
  const prog = `
    BEGIN { re = ENVIRON["RISK_RE"]; n = split(tolower(ENVIRON["RISK_WORDS"]), w, " ") }
    $0 ~ re {
      l = tolower($0)
      for (i = 1; i <= n && !found; i++) {
        s = 1
        while ((j = index(substr(l, s), w[i])) > 0) {
          pos = s + j - 1; e = pos + length(w[i])
          pc = (pos > 1) ? substr($0, pos - 1, 1) : ""; c = substr($0, pos, 1)
          okb = (pc == "" || pc !~ /[A-Za-z]/ || (c ~ /[A-Z]/ && pc ~ /[a-z]/))
          n1 = substr($0, e, 1); n2 = (n1 ~ /[sS]/) ? substr($0, e + 1, 1) : "x"
          oka = (n1 !~ /[a-z]/ || (n1 ~ /[sS]/ && n2 !~ /[a-z]/))
          if (okb && oka) { found = 1; break }
          s = pos + 1
        }
      }
    }
    END { exit found ? 0 : 1 }`;
  const r = proc.run('awk', [prog], { env: { ...ctx.childEnv(), RISK_RE: Buffer.from(content, 'latin1').toString('utf8'), RISK_WORDS: wordList }, input: Buffer.from(`${lines.join('\n')}\n`, 'latin1'), stdio: ['pipe', 'ignore', 'ignore'] });
  return r.status === 0;
}

/** `grep -Eq PATTERN` over a text (some line matches). @param {Context} ctx @param {string} pattern @param {string} text @param {boolean} [ci] */
function grepEq(ctx, pattern, text, ci = false) {
  const re = ereToRegExp(pattern, ci);
  if (re !== null) return text.split('\n').some((l) => re.test(l));
  const r = proc.run('grep', [ci ? '-Eiq' : '-Eq', '--', Buffer.from(pattern, 'latin1').toString('utf8')], { env: ctx.childEnv(), input: Buffer.from(text, 'latin1'), stdio: ['pipe', 'ignore', 'ignore'] });
  return r.status === 0;
}

/**
 * @typedef {object} RiskSignal
 * @property {string} name @property {string} source diff | scope | plan @property {string} path @property {string} why
 */

/**
 * `risk_compute ID`: the signals of a run: from the changed paths (diff), the plan scope paths (scope) and the plan flags (plan).
 * Plain documentation never carries a path or content signal.
 * @param {Context} ctx @param {string} dir @returns {RiskSignal[]}
 */
function riskCompute(ctx, dir) {
  const cfg = ctx.config();
  const base = baseOrHead(ctx, dir);
  const doc = /\.(md|mdx|rst|adoc)$/;
  const changed = taskChangedPaths(ctx, dir).filter((p) => !doc.test(p) && !p.startsWith('.agents/'));
  const scope = scopePaths(planScope(ctx, dir).rows).filter((p) => !doc.test(p));
  /** @type {Array<[string, string]>} */ const tagged = [...changed.map((p) => /** @type {[string, string]} */ (['diff', p])), ...scope.map((p) => /** @type {[string, string]} */ (['scope', p]))];
  const legacy = riskLegacyFrozen(ctx, dir);
  /** @type {RiskSignal[]} */ const out = [];
  /** @type {Map<string, string | null> | null} */ let blobs = null;
  /** @type {Map<string, string[]> | null} */ let added = null;
  const baseBlobs = () => (blobs ??= catBatch(ctx, changed.map((x) => `${base}:${x}`)));
  /** the lines each changed path adds against the base (the whole file when it is new), computed once */
  const addedOf = () => {
    if (added !== null) return added;
    const b = baseBlobs();
    const old = changed.filter((x) => b.get(`${base}:${x}`) !== null && b.get(`${base}:${x}`) !== undefined);
    added = addedLines(ctx, base, old);
    for (const x of changed) {
      if (old.includes(x)) { if (!added.has(x)) added.set(x, addedLines(ctx, base, [x]).get(x) ?? []); }
      else { const t = fileText(ctx, `${ctx.root}/${x}`); added.set(x, t === null ? [] : textLines(t)); }
    }
    return added;
  };
  for (const n of riskNames(ctx)) {
    if (n === 'log_sensitive' && legacy) continue;
    const g = riskPaths(ctx, dir, n);
    if (g !== '') {
      const globs = words(g);
      for (const [src, p] of tagged) {
        const hit = firstGlob(p, globs);
        if (hit !== null) out.push({ name: n, source: src, path: p, why: hit });
      }
    }
    const c = cfg.get(`risk.${n}.content`, '');
    const w = cfg.get(`risk.${n}.words`, '');
    if (c === '' || changed.length === 0) continue;
    for (const p of changed) {
      if (g !== '' && pathMatches(p, g)) continue;
      if (w !== '') {
        if (riskWordsMatch(ctx, c, w, addedOf().get(p) ?? [])) out.push({ name: n, source: 'diff', path: p, why: `added line matching risk.${n}.content with a word of risk.${n}.words` });
        continue;
      }
      if (n === 'contract_file') {
        if (grepEq(ctx, RISK_NOT_CONTRACT, p, true)) continue;
        const ig = cfg.get('contract.ignore', '');
        if (ig !== '' && pathMatches(p, ig)) continue;
      }
      const cur = fileText(ctx, `${ctx.root}/${p}`);
      const text = (baseBlobs().get(`${base}:${p}`) ?? '') + (cur ?? '');
      if (grepEq(ctx, c, text)) out.push({ name: n, source: 'diff', path: p, why: `content /${c.replace(/\|/g, '/')}/` });
    }
  }
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  for (const f of RISK_FLAGS.split(' ')) {
    if (cfg.get(`risk.${f}.check`, '') === '' || planFlag(plan, f) !== 'yes') continue;
    const why = f === 'data_change' ? '## Data section' : f === 'destructive' ? '## Data destructive: yes' : f === 'ui' ? '## UI section' : `## Risk ${f}: yes`;
    out.push({ name: f, source: 'plan', path: 'PLAN.md', why });
  }
  return out;
}

/** `risk_signals ID`, computed once per invocation. @param {Context} ctx @param {string} dir @returns {RiskSignal[]} */
export function riskSignals(ctx, dir) { return ctx.once(`risk:signals:${dir}`, () => riskCompute(ctx, dir)); }

/** `risk_focuses_of ID`: the focuses of the signals, sorted. @param {Context} ctx @param {string} dir @returns {string[]} */
export function riskFocusesOf(ctx, dir) {
  return ctx.once(`risk:focuses:${dir}`, () => {
    const names = [...new Set(riskSignals(ctx, dir).map((s) => s.name))].sort();
    return [...new Set(names.map((n) => ctx.config().get(`risk.${n}.check`, '')).filter((x) => x !== ''))].sort();
  });
}

/** `risk_gate_focuses ID GATE`: the risk focuses the gate carries for this run. @param {Context} ctx @param {string} dir @param {string} gate */
export function riskGateFocuses(ctx, dir, gate) { return riskFocusesOf(ctx, dir).filter((f) => riskFocusOnGate(f, gate)); }

/** `risk_ui_exempt ID SIGNAL`: a UI signal of a class without a design phase. @param {Context} ctx @param {string} dir @param {string} name */
export function riskUiExempt(ctx, dir, name) { return ctx.config().get(`risk.${name}.check`, '') === 'visual' && pipelineClass(ctx, dir) === 'TRIVIAL'; }

/**
 * `risk_missing_flags ID [FOCUS]`: for each path signal (of FOCUS) whose flag is not yes: name, source, path, flag.
 * @param {Context} ctx @param {string} dir @param {string} [focus] @returns {Array<[string, string, string, string]>}
 */
export function riskMissingFlags(ctx, dir, focus = '') {
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  /** @type {Array<[string, string, string, string]>} */ const out = [];
  for (const s of riskSignals(ctx, dir)) {
    if (s.source === 'plan' || riskUiExempt(ctx, dir, s.name)) continue;
    if (focus !== '' && ctx.config().get(`risk.${s.name}.check`, '') !== focus) continue;
    const fl = ctx.config().get(`risk.${s.name}.flag`, '');
    if (fl === '' || planFlag(plan, fl) === 'yes') continue;
    out.push([s.name, s.source, s.path, fl]);
  }
  return out;
}

// ---- input validation at entry points (A162) ------------------------------------------------------------------------------------

const VALIDATION_REMOVED = '^[ `*_]*(remove[sd]?|drop(s|ped)?|deprecate[sd]?|retire[sd]?)([^A-Za-z0-9_]|$)|(is|are|was|will be|has been|gets?) +(now +)?(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)|[(:`] *(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)|no +longer +(exists?|available|supported|served|routed)|/[^ ]*`? +(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)';
const VALIDATION_BL = '(^|[^A-Za-z0-9_.-])';
const VALIDATION_BR = '($|[^A-Za-z0-9_.-]|[.]([^A-Za-z0-9_]|$))';

/** `grep -Eiq PATTERN` over a text. @param {Context} ctx @param {string} pattern @param {string} text */
function grepEi(ctx, pattern, text) { return grepEq(ctx, pattern, text, true); }

/** `entry_has KEY TEXT`: the key's words occur in TEXT as whole words. @param {Context} ctx @param {string} key @param {string} text */
function entryHas(ctx, key, text) {
  const w = ctx.config().get(`validation.${key}`, '');
  return w !== '' && grepEi(ctx, `${VALIDATION_BL}(${w})${VALIDATION_BR}`, text);
}

/** `entry_tier BULLET`: mandatory | information | '' (nothing). @param {Context} ctx @param {string} text */
export function entryTier(ctx, text) {
  if (entryHas(ctx, 'entry_words', text)) {
    if (grepEi(ctx, VALIDATION_REMOVED, text)) return '';
    if (entryHas(ctx, 'entry_skip', text)) return 'information';
    return entryHas(ctx, 'entry_input', text) || (entryHas(ctx, 'entry_new', text) && !entryHas(ctx, 'entry_output', text)) ? 'mandatory' : 'information';
  }
  if (entryHas(ctx, 'entry_candidates', text) && !grepEi(ctx, VALIDATION_REMOVED, text)) return 'information';
  return '';
}

/** `entry_name BULLET`: the entry point's name. @param {string} b */
function entryName(b) {
  const q = b.indexOf('`');
  const n = q >= 0 && b.indexOf('`', q + 1) >= 0 ? b.slice(q + 1).replace(/`[^]*$/, '') : b.replace(/:[^]*$/, '');
  return n.replace(/^[ \t\n\v\f\r]*/, '').replace(/[ \t\n\v\f\r]*$/, '');
}

/** `plan_entries PLAN TIER`: one entry point name per line, deduplicated. @param {Context} ctx @param {string | null} plan @param {string} tier */
export function planEntries(ctx, plan, tier) {
  if (plan === null) return [];
  let inC = false;
  /** @type {string[]} */ const out = [];
  for (const l of textLines(plan)) {
    if (l.startsWith('## ')) { inC = new RegExp(`^## Contracts${WS}*$`).test(l); continue; }
    if (!inC || !new RegExp(`^${WS}*[-*]${WS}+[^ \\t\\n\\v\\f\\r]`).test(l)) continue;
    const b = l.replace(new RegExp(`^${WS}*[-*]${WS}*`), '');
    if (entryTier(ctx, b) !== tier) continue;
    const n = entryName(b);
    if (n !== '' && !out.includes(n)) out.push(n);
  }
  return out;
}

/** `plan_validation_missing PLAN`: the mandatory entry points without a complete `## Validation` line. @param {Context} ctx @param {string | null} plan */
export function planValidationMissing(ctx, plan) {
  if (plan === null) return [];
  let inV = false;
  /** @type {string[]} */ const vl = [];
  for (const l of textLines(plan)) {
    if (l.startsWith('## ')) { inV = new RegExp(`^## Validation${WS}*$`).test(l); continue; }
    if (inV && new RegExp(`^${WS}*[-*]${WS}`).test(l)) vl.push(l);
  }
  return planEntries(ctx, plan, 'mandatory').filter((n) => !vl.some((l) => l.includes(n) && /accepts/i.test(l) && /limits/i.test(l) && /rejected at/i.test(l)));
}

/** @param {string[]} a */
const commaJoin = (a) => a.join(',').replace(/,$/, '').replace(/,/g, ', ');

/** `validation_candidates ID`: "scope|path" or "diff|path" for code that looks like an entry point (information only). @param {Context} ctx @param {string} dir @returns {string[]} */
function validationCandidates(ctx, dir) {
  const pat = ctx.config().get('validation.code_patterns', '');
  if (pat === '') return [];
  const base = baseOrHead(ctx, dir);
  /** @type {string[]} */ const out = [];
  const doc = /\.(md|mdx|rst|adoc)$/;
  for (const x of scopePaths(planScope(ctx, dir).rows).filter((p) => !doc.test(p))) {
    const t = isFile(`${ctx.root}/${x}`) ? fileText(ctx, `${ctx.root}/${x}`) : null;
    if (t !== null && grepEq(ctx, pat, t)) out.push(`scope|${x}`);
  }
  const changed = taskChangedPaths(ctx, dir).filter((p) => !doc.test(p) && !p.startsWith('.agents/'));
  const tracked = trackedSet(ctx, changed);
  const rest = changed.filter((p) => !tracked.has(p));
  const atBase = catBatch(ctx, rest.map((p) => `${base}:${p}`));
  const old = changed.filter((p) => tracked.has(p) || (atBase.get(`${base}:${p}`) ?? null) !== null);
  const added = addedLines(ctx, base, old);
  for (const x of changed) {
    if (old.includes(x)) {
      const ls = (added.get(x) ?? addedLines(ctx, base, [x]).get(x) ?? []).filter((l) => !l.startsWith('++'));
      if (grepEq(ctx, pat, ls.join('\n'))) out.push(`diff|${x}`);
    } else if (isFile(`${ctx.root}/${x}`)) {
      const t = fileText(ctx, `${ctx.root}/${x}`);
      if (t !== null && grepEq(ctx, pat, t)) out.push(`diff|${x}`);
    }
  }
  return [...new Set(out)];
}

/** `validation_show ID`: the lines `pipeline` prints only when there is something to say. @param {Context} ctx @param {string} dir */
export function validationShow(ctx, dir) {
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  const n = commaJoin(planEntries(ctx, plan, 'mandatory'));
  const m = commaJoin(planValidationMissing(ctx, plan));
  const c = commaJoin(validationCandidates(ctx, dir).map((x) => x.replace('|', ':')));
  let out = '';
  if (n !== '') out += `validation.entry_points=${n} (PLAN.md ## Contracts; each needs a ## Validation line and an [invalid-input] QA scenario)\n`;
  if (m !== '') out += `validation.missing=${m} (no complete ## Validation line: the freeze refuses)\n`;
  const i = commaJoin(planEntries(ctx, plan, 'information').map((x) => x.slice(0, 60)));
  if (i !== '') out += `validation.possible=${i} (information only: ## Contracts bullets that mention an entry point without new input; if one takes new or changed external input, say so in the bullet and give it a ## Validation line)\n`;
  if (c !== '') out += `validation.candidates=${c} (information only: code that looks like an entry point; declare it in ## Contracts when it takes external input)\n`;
  return out;
}
