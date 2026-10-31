// @ts-check
// Readers of a task file, a plan and a run folder for the leaf commands (task-type, task-scope-entries, scope-covers, human-checks,
// questions). Each function is the awk or shell program of agent.sh, line for line; text is a byte string.
import { readFileSync } from 'node:fs';
import { BridgeToShell } from './errors.mjs';
import { asciiLower, caseMatch, trimSpace } from './shellglob.mjs';

/** The lines of a file as awk reads records (a last line without a newline is a record). @param {string} text */
export function records(text) {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** @param {string} file @returns {string | null} null: not readable */
export function readBytes(file) {
  try { return readFileSync(file, 'latin1'); } catch { return null; }
}

/** `task_type TASK.md` -> feature | bug | refactor | content | docs | chore | invalid @param {string} text null-safe: pass '' for a file that cannot be read */
export function taskType(text) {
  let fm = false; let n = 0; let r = '';
  for (let line of records(text)) {
    line = line.replace(/\r$/, '');
    if (line.startsWith('##')) break;
    if (!fm && line === '---') { fm = true; continue; }
    if (fm && line === '---') break;
    if (fm && /^type[ \t\n\v\f\r]*:/.test(asciiLower(line))) {
      let v = line.replace(/^[^:]*:[ \t\n\v\f\r]*/, '');
      v = v.replace(/[ \t\n\v\f\r]+#[^]*$/, '');
      v = v.replace(/["' \t\n\v\f\r]/g, '');
      n++; r = v === '' ? '?' : asciiLower(v);
    }
  }
  const v = n > 1 ? '?' : n === 1 ? r : '';
  switch (v) {
    case '': case 'feature': return 'feature';
    case 'defect': return 'bug';
    case 'bug': case 'refactor': case 'content': case 'docs': case 'chore': return v;
    default: return 'invalid';
  }
}

/**
 * `task_section_lines FILE HEADING prefix`: the lines of a `##` or `###` section, HTML comments dropped.
 * @param {string} text @param {string} heading
 */
export function sectionLines(text, heading) {
  if (heading === '') throw new BridgeToShell('empty heading: index() of an empty string differs between awks');
  if (heading.includes('\\')) throw new BridgeToShell('awk -v reads backslash escapes');
  const want = asciiLower(heading);
  let inc = false; let on = false;
  /** @type {string[]} */ const out = [];
  /** @param {string} str */
  const strip = (str) => {
    let o = ''; let s = str;
    for (;;) {
      if (inc) { const p = s.indexOf('-->'); if (p < 0) return o; s = s.slice(p + 3); inc = false; } else {
        const p = s.indexOf('<!--'); if (p < 0) return o + s;
        o += s.slice(0, p); s = s.slice(p + 4); inc = true;
      }
    }
  };
  for (const line of records(text)) {
    const s = strip(line);
    if (/^#+[ \t]/.test(s)) {
      const t = s.replace(/^#+[ \t]+/, '').replace(/[ \t\r]+$/, '');
      const lt = asciiLower(t);
      on = /^###?[ \t]/.test(s) && (lt === want || (lt.indexOf(want) === 0 && !/[a-z0-9]/.test(lt.charAt(want.length))));
      continue;
    }
    if (on) out.push(s);
  }
  return out;
}

const BAD_RE = /[ \t()<>|;{}"'$&\\]/;
const PATH_RE = /[\][/*?]|\.[A-Za-z0-9]/;

/**
 * `task_scope_entries FILE HEADING`: one path, folder or glob per line (mode ok of task_scope_parse).
 * @param {string} text @param {string} heading
 */
export function scopeEntries(text, heading) {
  /** @type {string[]} */ const out = [];
  /** @param {string} tok @param {boolean} ticked */
  const emit = (tok, ticked) => {
    let t = tok.replace(/^[ \t]+|[ \t]+$/g, '').replace(/[,;:]+$/, '');
    if (t === '') return;
    if (BAD_RE.test(t) || /^[./]+$/.test(t) || (!ticked && !PATH_RE.test(t))) return;
    t = t.replace(/^\.\//, '').replace(/^\//, '');
    out.push(t);
  };
  for (const raw of sectionLines(text, heading).map((l) => l)) {
    const line = raw.replace(/\r/g, '');
    if (/^[ \t]*$/.test(line)) continue;
    const bullet = /^[ \t]*(?:[-*]|[0-9]+[.)])[ \t]+/.exec(line);
    if (!bullet) continue;
    const l = line.slice(bullet[0].length);
    if (asciiLower(l).replace(/^[ \t]+|[ \t]+$/g, '') === 'none') continue;
    if (l.includes('`')) {
      let rest = l;
      for (;;) {
        const m = /`[^`]*`/.exec(rest);
        if (!m) break;
        const tk = m[0].slice(1, -1);
        rest = rest.slice(m.index + m[0].length);
        for (const part of tk.split(',')) emit(part, true);
      }
    } else for (const part of l.split(/[ \t,]+/)) emit(part, false);
  }
  return out;
}

/** `norm_rel_path` for one line: no `.` segments or doubled slashes, `..` resolved lexically. @param {string} p */
export function normRelPath(p) {
  if (p.includes('\n')) throw new BridgeToShell('newline in a path');
  /** @type {string[]} */ const s = [];
  for (const a of p.split('/')) {
    if (a === '' || a === '.') continue;
    if (a === '..') { s.pop(); continue; }
    s.push(a);
  }
  return s.join('/');
}

/** `scope_entry_covers ENTRY PATH` @param {string} entry @param {string} p */
export function scopeEntryCovers(entry, p) {
  const e = normRelPath(entry); const q = normRelPath(p);
  if (e === '') return false;
  if (/[*?[]/.test(e)) return caseMatch(e, q);
  if (q === e) return true;
  return q.startsWith(`${e}/`);
}

/** `human_checks`: the first three bullets of `## Human checks` in QA_REPORT.md. @param {string} text */
export function humanChecks(text) {
  /** @type {string[]} */ const out = [];
  let inside = false; let n = 0;
  for (const line of records(text)) {
    if (/^## Human checks[ \t]*$/.test(line)) { inside = true; continue; }
    if (line.startsWith('## ')) inside = false;
    if (inside && /^[-*][ \t]+[^ \t]/.test(line)) {
      const v = line.replace(/^[-*][ \t]+/, '').replace(/[ \t]+$/, '');
      if (n < 3) out.push(v);
      n++;
    }
  }
  return out;
}

/** `evidence_field FILE KEY` over the text: the first `key:` line, leading spaces and all double quotes dropped; null when absent. @param {string} text @param {string} key */
export function evidenceField(text, key) {
  const pre = `${key}:`;
  for (const l of records(text)) {
    if (!l.startsWith(pre)) continue;
    return l.slice(pre.length).replace(/^ +/, '').replace(/"/g, '');
  }
  return null;
}

/** `sed '1,/^---$/d'`: the question body after the first `---` line (searched from line 2). @param {string} text */
export function afterFrontMatter(text) {
  const rows = records(text);
  let i = 1;
  while (i < rows.length && rows[i] !== '---') i++;
  return rows.slice(i + 1);
}

export { trimSpace };
