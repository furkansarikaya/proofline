// @ts-check
// The records of a run, read the way agent.sh reads them (the shell is the specification): RUN.yaml sections (`sv_load`), `key: value`
// record files (gate records, evidence, results: `evidence_field`, `field_from`), ledger lines, manifests (`path|hash`), TSV, PLAN.md
// scope mappings and sections. Text is kept as byte strings (latin1, one char per byte) because agent.sh runs with LC_ALL=C.
// Every file is read ONCE per invocation through the context (`ctx.once`); a writer calls `ctx.forget('file:')`.
import { readFileSync } from 'node:fs';

/** @typedef {import('./context.mjs').Context} Context */

/** POSIX [[:space:]] in the C locale (not JavaScript's \s, which also matches non-breaking spaces of a byte string) */
export const WS = '[ \\t\\n\\v\\f\\r]';

/** The text of a file as a byte string, or null when it cannot be read. @param {string} file @returns {string | null} */
export function readBytes(file) {
  try { return readFileSync(file, 'latin1'); } catch { return null; }
}

/** A file read once per invocation: its bytes as a string, or null. @param {Context} ctx @param {string} file */
export function fileText(ctx, file) {
  return ctx.once(`file:${file}`, () => readBytes(file));
}

/** The lines of a text like `while read` sees them (a final line without a newline counts; no phantom empty line). @param {string} text */
export function textLines(text) {
  if (text === '') return [];
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** The lines of a file, read once, [] when it cannot be read. @param {Context} ctx @param {string} file */
export function fileLines(ctx, file) {
  return ctx.once(`file:lines:${file}`, () => { const t = fileText(ctx, file); return t === null ? [] : textLines(t); });
}

const reSection = new RegExp(`^[a-z_]+:${WS}*$`);
const reTop = new RegExp(`^[^ \\t\\n\\v\\f\\r#]`);
const reKeyLine = /^ {2}[a-z_0-9]+:/;
const reValueHead = new RegExp(`^[^:]*:${WS}*`);
const reValueComment = new RegExp(`${WS}+#[^]*$`);

/** `sv_load`: "section.key=value" rows of a RUN.yaml, the first occurrence of a key winning. @param {string} text @returns {string[]} */
export function runSections(text) {
  /** @type {string[]} */ const out = [];
  const seen = new Set();
  let s = '';
  for (const line of text.split('\n')) {
    if (reSection.test(line)) { s = line.replace(new RegExp(`${WS}[^]*$`), '').replace(/:[^]*$/, ''); continue; }
    if (reTop.test(line)) { s = ''; continue; }
    if (s !== '' && reKeyLine.test(line)) {
      const k = line.slice(2).replace(/:[^]*$/, '');
      const v = line.replace(reValueHead, '').replace(reValueComment, '').replace(/"/g, '');
      if (!seen.has(`${s}.${k}`)) { seen.add(`${s}.${k}`); out.push(`${s}.${k}=${v}`); }
    }
  }
  return out;
}

/** A RUN.yaml, parsed once: section_value / section_key_present. */
export class RunYaml {
  /** @param {string | null} text null: the file is not there (the awk program prints nothing) */
  constructor(text) {
    /** @type {Map<string, string>} */ this.map = new Map();
    for (const r of runSections(text ?? '')) {
      const eq = r.indexOf('=');
      this.map.set(r.slice(0, eq), r.slice(eq + 1));
    }
  }

  /** `section_value DIR SECTION KEY`: '' when absent. @param {string} section @param {string} key */
  value(section, key) { return this.map.get(`${section}.${key}`) ?? ''; }

  /** `section_key_present` @param {string} section @param {string} key */
  has(section, key) { return this.map.has(`${section}.${key}`); }
}

/** The RUN.yaml of a run directory, read once per invocation. @param {Context} ctx @param {string} dir */
export function runYaml(ctx, dir) {
  return ctx.once(`file:runyaml:${dir}`, () => new RunYaml(fileText(ctx, `${dir}/RUN.yaml`)));
}

/** `section_value DIR SECTION KEY` @param {Context} ctx @param {string} dir @param {string} section @param {string} key */
export function sectionValue(ctx, dir, section, key) { return runYaml(ctx, dir).value(section, key); }

/** `section_key_present DIR SECTION KEY` @param {Context} ctx @param {string} dir @param {string} section @param {string} key */
export function sectionKeyPresent(ctx, dir, section, key) { return runYaml(ctx, dir).has(section, key); }

/** `gates_enforced ID`: the run carries lifecycle_gates.required. @param {Context} ctx @param {string} dir */
export function gatesEnforced(ctx, dir) { return sectionKeyPresent(ctx, dir, 'lifecycle_gates', 'required'); }

/**
 * `evidence_field` / `gate_field`: the value of the first line that starts with `KEY:`, leading blanks removed and every `"` removed.
 * '' when the key is absent or the file is not readable. @param {string[]} lines @param {string} key
 */
export function fieldOf(lines, key) {
  const pre = `${key}:`;
  for (const l of lines) {
    if (l.startsWith(pre)) return l.slice(pre.length).replace(/^ +/, '').replace(/"/g, '');
  }
  return '';
}

/** `gate_field FILE KEY` over a file read once. @param {Context} ctx @param {string} file @param {string} key */
export function gateField(ctx, file, key) { return fieldOf(fileLines(ctx, file), key); }

/** `field_from FILE KEY`: `sed -n "s/^KEY: *//p" | head -1` (quotes stay). @param {Context} ctx @param {string} file @param {string} key */
export function fieldFrom(ctx, file, key) {
  const pre = `${key}:`;
  for (const l of fileLines(ctx, file)) if (l.startsWith(pre)) return l.slice(pre.length).replace(/^ */, '');
  return '';
}

/**
 * @typedef {object} LedgerLine
 * @property {number} seq @property {string} prev @property {string} event @property {string} role @property {string} from @property {string} to
 * @property {string} digest @property {string} ts @property {string} epoch @property {string} detail
 */

/**
 * One ledger line: `seq=N prev=H event=E role=R from=F to=T digest=D ts=T epoch=E detail=...`. null when it does not have the shape.
 * @param {string} line @returns {LedgerLine | null}
 */
export function parseLedgerLine(line) {
  const m = /^seq=([0-9]+) prev=(\S+) event=(\S*) role=(\S*) from=(\S*) to=(\S*) digest=(\S*) ts=(\S*) epoch=(\S*) detail=([^]*)$/.exec(line);
  if (!m) return null;
  return { seq: Number(m[1]), prev: m[2], event: m[3], role: m[4], from: m[5], to: m[6], digest: m[7], ts: m[8], epoch: m[9], detail: m[10] };
}

/** The ledger lines of a run, read once. @param {Context} ctx @param {string} dir */
export function ledgerLines(ctx, dir) { return fileLines(ctx, `${dir}/LEDGER.log`); }

/** A manifest (`path|hash` per line, as `patch_manifest` writes it): [path, hash] rows. @param {string} text @returns {Array<[string, string]>} */
export function parseManifest(text) {
  /** @type {Array<[string, string]>} */ const rows = [];
  for (const l of textLines(text)) {
    if (l === '') continue;
    const i = l.indexOf('|');
    rows.push(i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]);
  }
  return rows;
}

/** TSV rows (tab separated, no quoting). @param {string} text @returns {string[][]} */
export function parseTsv(text) { return textLines(text).map((l) => l.split('\t')); }

/** The `.proofline-manifest` of a project: rows with at least two blank-separated fields, comment lines dropped. @param {Context} ctx @returns {string[][]} */
export function installedManifest(ctx) {
  return ctx.once('installed-manifest', () => {
    const rows = [];
    for (const l of fileLines(ctx, `${ctx.agents}/.proofline-manifest`)) {
      if (l.startsWith('#')) continue;
      const f = l.split(new RegExp(`${WS}+`)).filter((x) => x !== '');
      rows.push(f);
    }
    return rows;
  });
}

/**
 * `scope_mappings PLAN`: the `path|criteria` pairs of the `scope:` block of a PLAN.md. null when the file is malformed (the awk program
 * exits 1) or cannot be read; the pairs read before the fault are `partial`.
 * @param {string | null} text @returns {{ ok: boolean, rows: Array<[string, string]> }}
 */
export function scopeMappings(text) {
  /** @type {Array<[string, string]>} */ const rows = [];
  if (text === null) return { ok: false, rows };
  let inside = false;
  let p = '';
  let bad = false;
  for (const line of textLines(text)) {
    if (!inside) { if (line === 'scope:') inside = true; continue; }
    if (line === '---') break;
    if (line.startsWith('  - path: ')) { if (p !== '') bad = true; p = line.slice('  - path: '.length); continue; }
    const m = /^ {4}criteria: \[/.exec(line);
    if (m) {
      const c = line.slice(m[0].length).replace(/\]$/, '');
      if (p === '' || c === '') bad = true; else rows.push([p, c]);
      p = '';
    }
  }
  return { ok: !(bad || p !== ''), rows };
}

/** The scope mappings of a run's PLAN.md, read once. @param {Context} ctx @param {string} dir */
export function planScope(ctx, dir) {
  return ctx.once(`plan-scope:${dir}`, () => scopeMappings(fileText(ctx, `${dir}/PLAN.md`)));
}

/** The paths of a scope mapping list (`cut -d '|' -f1`, which keeps what stands before the first `|` of a `path|criteria` row). @param {Array<[string, string]>} rows */
export function scopePaths(rows) { return rows.map(([p]) => (p.includes('|') ? p.slice(0, p.indexOf('|')) : p)); }

/** `authorized_path MAPPINGS PATH`: the path is exactly one of the mapped paths. @param {Array<[string, string]>} rows @param {string} p */
export function authorizedPath(rows, p) { return scopePaths(rows).includes(p); }

/** `plan_section_present PLAN SECTION`: a `## SECTION` heading line. @param {string | null} text @param {string} name */
export function planSectionPresent(text, name) {
  if (text === null) return false;
  const re = new RegExp(`^## ${name}${WS}*$`);
  return text.split('\n').some((l) => re.test(l));
}

/** `plan_destructive PLAN` -> yes | no | invalid | absent. @param {string | null} text */
export function planDestructive(text) {
  if (text === null || !planSectionPresent(text, 'Data')) return 'absent';
  let inside = false;
  for (const line of textLines(text)) {
    if (!inside) { if (new RegExp(`^## Data${WS}*$`).test(line)) inside = true; continue; }
    if (new RegExp(`^${WS}*$`).test(line)) continue;
    const m = new RegExp(`^destructive:${WS}*(yes|no)${WS}*$`).exec(line);
    return m ? m[1] : 'invalid';
  }
  return 'invalid';
}

/** `valid_task_id` @param {string} id */
export function validTaskId(id) { return /^[A-Za-z0-9_-]+$/.test(id); }
