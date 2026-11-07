// @ts-check
// The pure text rules of the dispatcher (A226; the former helper functions of dispatch.sh): what a runtime's log says about a failure, the token totals it
// reports, the final message of `claude -p --output-format json`, the --agents JSON of a role without a generated agent, a command template. Text is a byte
// string (latin1, one char per byte), as the logs are read. Nothing here touches a file, a process or the clock, so each rule is tested on its own.

const WS = '[ \\t\\n\\v\\f\\r]';

/** The last N lines of a text as `tail -n N` gives them (a last line without a newline counts). @param {string} text @param {number} n @returns {string[]} */
export function tailLines(text, n) {
  if (text === '') return [];
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows.slice(Math.max(0, rows.length - n));
}

const RE_NETWORK = /error sending request|workspace routing discovery failed|Reconnecting\.\.\. 5\/5/i;
const RE_LIMIT = /usage limit|rate[ _-]?limit|quota|too many requests|(^|[^0-9])429([^0-9]|$)|limit (reached|exceeded)|hit your limit|overloaded/i;
const RE_AUTH = /not logged in|unauthori[sz]ed|authentication (failed|error|required)|invalid api key|please (run )?.*login|(^|[^0-9])401([^0-9]|$)/i;

/**
 * D7: the runtime could not do the step (limit, quota, rate limit, auth, no network) vs a task failure (it ran and failed). The last 60 lines of the log decide.
 * @param {string} log @returns {'runtime_unavailable:network' | 'limit' | 'auth' | 'none'}
 */
export function runtimeFailureReason(log) {
  const t = tailLines(log, 60);
  if (t.some((l) => RE_NETWORK.test(l))) return 'runtime_unavailable:network';
  if (t.some((l) => RE_LIMIT.test(l))) return 'limit';
  if (t.some((l) => RE_AUTH.test(l))) return 'auth';
  return 'none';
}

const RE_TRANSIENT = /(^|[^a-z])(ssl|tls)([^a-z]|$)|certificate verify|connection (was )?(reset|closed|aborted|lost|dropped)|reset by peer|econnreset|econnaborted|etimedout|epipe|socket hang up|stream (disconnected|closed)|unexpected eof|broken pipe|temporary failure in name resolution|network is unreachable|error sending request|Reconnecting\.\.\./i;

/** A200: a transient network error (a dropped connection, an SSL/TLS failure) is retried; a sandbox that blocks the network is not transient. @param {string} log */
export function transientNetwork(log) {
  const t = tailLines(log, 60);
  if (t.some((l) => /workspace routing discovery failed/i.test(l))) return false;
  return t.some((l) => RE_TRANSIENT.test(l));
}

/** A203: the Codex sandbox refused a git worktree or git metadata write (the last 200 lines). @param {string} log */
export function worktreeSandboxRefusal(log) {
  const nws = '[^ \\t\\n\\v\\f\\r]';
  const re = new RegExp(`worktrees?${nws}*.*(not permitted|read-only|denied)|(not permitted|read-only|denied).*worktrees?`, 'i');
  return tailLines(log, 200).some((l) => re.test(l));
}

/** Digits only? (the metrics accumulators) @param {string} v */
const isNum = (v) => /^[0-9]+$/.test(v);

/** `add_n VALUE ACC`: the sum when VALUE is a number, else ACC. @param {string} value @param {string} acc */
export function addN(value, acc) { return isNum(value) ? String((acc === '' ? 0 : Number(acc)) + Number(value)) : acc; }

/** The first `"NAME":<digits>` of a text (optional blanks after the colon), digits only; '' when none (`num_first`). @param {string} log @param {string} name */
export function numFirst(log, name) {
  const m = new RegExp(`"${name}":[ \\t\\v\\f\\r]*([0-9]+)`).exec(log);
  return m ? m[1] : '';
}

/**
 * Claude's result JSON carries the run's own `usage`; its `iterations` list repeats the fields per turn, so the LAST input_tokens/output_tokens in the log is one
 * turn, not the total. The last `"usage":{` object of the last line that has one, its first 400 characters.
 * shortcut: fields are found by text, not parsed; use a JSON parser if the result JSON ever reorders them past 400 characters.
 * @param {string} log
 */
export function claudeUsage(log) {
  let last = '';
  for (const l of log.split('\n')) { const i = l.lastIndexOf('"usage":{'); if (i >= 0) last = l.slice(i + '"usage":{'.length); }
  return last.slice(0, 400);
}

/** The first `"NAME":<digits>` of a usage text (no blanks), digits only. @param {string} usage @param {string} name */
export function usageNumber(usage, name) {
  const m = new RegExp(`"${name}":([0-9]+)`).exec(usage);
  return m ? m[1] : '';
}

/**
 * `codex_total`: the number after the "tokens used" trailer line, in the runtime's local format (285.242, 285,242, 285 242). The trailer sits right before the
 * final message, which is also in OUT: when the log ends with that message it is dropped first, then the last three non-empty lines are read (a "tokens used"
 * line earlier in the log is model text). Codex writes the final message WITHOUT a trailing newline, so the separator gets its own line (A200).
 * @param {string} out the final message file (may be '') @param {string} log
 * @returns {string} digits or ''
 */
export function codexTotal(out, log) {
  const trim = (/** @type {string} */ s) => s.replace(new RegExp(`${WS}+$`), '');
  const input = `${out === '' ? '' : out}\n\u0001\n${log}`;
  const rows = input.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  /** @type {string[]} */ const b = []; /** @type {string[]} */ const a = [];
  let sep = false;
  for (const r of rows) {
    if (!sep && r === '\u0001') { sep = true; continue; }
    (sep ? a : b).push(trim(r));
  }
  let n = b.length;
  while (n > 0 && b[n - 1] === '') n--;
  let e = a.length;
  while (e > 0 && a[e - 1] === '') e--;
  if (n > 0 && e >= n) {
    let ok = true;
    for (let k = 1; k <= n; k++) if (a[e - n + k - 1] !== b[k - 1]) { ok = false; break; }
    if (ok) e -= n;
  }
  /** @type {number[]} */ const l = [];
  for (let i = e; i >= 1 && l.length < 3; i--) if (a[i - 1] !== '') l.push(i);
  let v = '';
  let f = false;
  for (let j = l.length - 1; j >= 0; j--) {
    const s = a[l[j] - 1];
    if (f) {
      const t = s.replace(/[^0-9]/g, '');
      if (t !== '' && new RegExp(`^[0-9][0-9.,${WS.slice(1, -1)}]*$`).test(s)) v = t;
      f = false;
    }
    if (/tokens used/.test(s.toLowerCase())) {
      const t = s.replace(/^[^]*[Uu]sed/, '').replace(/[^0-9]/g, '');
      if (t !== '') v = t; else f = true;
    }
  }
  return v;
}

/**
 * The top-level "result" string of `claude --output-format json`, unescaped: the text after the first `"result":"` up to its closing quote. \n, \t and \r are
 * decoded, a \uXXXX escape is kept as written, any other escaped character stands for itself. null when the log has no `"result":"`.
 * @param {string} log @returns {string | null}
 */
export function claudeResult(log) {
  const i = log.indexOf('"result":"');
  if (i < 0) return null;
  let s = log.slice(i + 10);
  let o = '';
  while (s.length > 0) {
    const c = s[0];
    if (c === '"') break;
    if (c === '\\') {
      const n = s[1] ?? '';
      s = s.slice(2);
      if (n === 'n') o += '\n'; else if (n === 't') o += '\t'; else if (n === 'r') o += '\r';
      else if (n === 'u') { o += `\\u${s.slice(0, 4)}`; s = s.slice(4); } else o += n;
      continue;
    }
    o += c;
    s = s.slice(1);
  }
  return `${o}\n`;
}

/** `grep -q '"is_error":[[:space:]]*true'` @param {string} log */
export function claudeIsError(log) { return /"is_error":[ \t\v\f\r]*true/.test(log); }

/**
 * JSON string of a text as the former awk program wrote it: backslash, quote, tab and carriage return escaped, the lines joined by \n (the final newline of the
 * text is not a line). Other control characters are escaped too, which the awk program left raw (it produced invalid JSON for them).
 * @param {string} text
 */
export function jsonStr(text) {
  const rows = text === '' ? [] : text.split('\n');
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  const esc = (/** @type {string} */ r) => r.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
    .replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${rows.map(esc).join('\\n')}"`;
}

/** A tool list that grants an agent-spawning tool (Agent or Task, with or without a pattern): never granted to a dispatched role (no recursion). @param {string} list */
export function spawnTool(list) { return list.split(/[, ]+/).some((t) => /^(Agent|Task)([(]|$)/.test(t)); }

/** The default tools of a role without a tools.conf row. */
export const DEFAULT_TOOLS = 'Read,Grep,Glob,Bash,Write,Edit';

/**
 * `agents_json`: the --agents JSON for a role without a generated .claude agent: instructions plus the tools.conf list minus Agent/Task.
 * @param {string} name @param {string} instructions the instructions file's text @param {string} role @param {string} toolsRow what follows the role on its tools.conf row ('' when none)
 */
export function agentsJson(name, instructions, role, toolsRow) {
  let tools = toolsRow;
  if (tools.replace(/[ ,]/g, '') === '') tools = DEFAULT_TOOLS;
  const kept = tools.replace(/,/g, ' ').split(/[ \t\n]+/).filter((x) => x !== '' && !spawnTool(x)).map(jsonStr);
  return `{"${name}":{"description":${jsonStr(`proofline ${role}`)},"prompt":${jsonStr(instructions)},"tools":[${kept.join(',')}]}}`;
}

/** The tools.conf row of a role: what follows the role's name, fields joined by one blank with a leading one (`$1 = ""; print`). @param {string} conf @param {string} role */
export function toolsRow(conf, role) {
  for (const l of conf.split('\n')) {
    const f = l.split(/[ \t]+/).filter((x) => x !== '');
    if (f[0] === role) return f.length > 1 ? ` ${f.slice(1).join(' ')}` : '';
  }
  return '';
}

/** A string as one shell word, single-quoted. @param {string} s */
export function shellQuote(s) { return `'${s.replace(/'/g, "'\\''")}'`; }

/** `subst TEMPLATE NAME VALUE`: every {NAME} replaced; the inserted text is not scanned again. @param {string} template @param {string} name @param {string} value */
export function subst(template, name, value) { return template.split(`{${name}}`).join(value); }

/** The mode/permission words allowed for a Claude worker. */
export const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'default'];

/** `tok NAME VALUE`: an override or an id that may reach an argument list: letters, digits and . _ + : -, never a leading dash. @param {string} v */
export function validToken(v) { return v !== '' && !/[^A-Za-z0-9._+:-]/.test(v) && !v.startsWith('-'); }

/** The value of the first line `KEY=...` of a block of key=value lines, '' when none. @param {string} text @param {string} key */
export function kv(text, key) {
  const p = `${key}=`;
  for (const l of text.split('\n')) if (l.startsWith(p)) return l.slice(p.length);
  return '';
}
