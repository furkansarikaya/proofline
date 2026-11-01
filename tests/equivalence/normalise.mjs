// @ts-check
// The CLOSED normalisation list of the equivalence rig (ADR 0001 section 6). Only values that differ between two correct runs are
// masked, each in the field named, and a time or a derived hash is masked only after the checks of its kind passed on its own side.
// A value that fails its check is NOT masked: it stays in the text, so the comparison also reports it, and a problem is recorded.
// Adding a rule needs the maintainer's approval (.out-of-scope/weakening-core-invariants.md); rules.test.mjs pins RULE_IDS.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** The eight rules of the table in ADR 6. Do not add one without approval. */
export const RULE_IDS = Object.freeze(['times', 'derived-hashes', 'process-ids', 'temp-dirs', 'nonces', 'durations', 'file-metadata', 'archives']);

/** @typedef {{ mode: number, data: Buffer }} FileEntry */
/** @typedef {{ code: number|null, stdout: string, stderr: string }} Output */
/** @typedef {{ outputs: Output[], files: Map<string, FileEntry>, window: [number, number], tmpdir?: string, git?: string }} Side */
/** @typedef {{ id: string, t: number }} Rank */

export const sha256 = (/** @type {Buffer|string} */ b) => createHash('sha256').update(b).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)Z$/;

/** ISO `YYYY-MM-DDTHH:MM:SSZ` that is also a real instant; returns epoch seconds or null. */
export function isoToEpoch(/** @type {string} */ v) {
  if (!ISO.test(v)) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) + 'Z' !== v) return null;
  return ms / 1000;
}
const epochOf = (/** @type {string} */ v) => (/^\d{1,12}$/.test(v) ? Number(v) : null);

/**
 * Time fields that a full run lifecycle writes and that the closed list of ADR 6 does not name. They are NOT part of the closed list: they are masked
 * only when a caller passes { pendingApproval: true } (the alternating-engine lifecycle test does, and says so), until the maintainer approves them:
 * `epoch:` in gate records (it must name the second of the record's `timestamp:`), the time column of the metrics files, the line-leading time of
 * status-block.log, the epoch column of the hook timing spool.
 */
export const PENDING_APPROVAL = Object.freeze(['gate-record epoch:', 'metrics time (history.tsv, records.jsonl)', 'status-block.log time', 'hook-times epoch column', 'approve.log line-leading time', 'HOOKS.log ts= and epoch=']);
const EPOCH_FIELDS = ['requested_at', 'approved_at', 'consumed_at', 'asked_at', 'answered_epoch', 'amended_at'];
const dirOf = (/** @type {string} */ p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (/** @type {string} */ p) => p.slice(p.lastIndexOf('/') + 1);
const stateFile = (/** @type {string} */ p) => p.startsWith('.agents/runs/') || p.startsWith('.agents/local/');
const lat = (/** @type {Buffer} */ b) => b.toString('latin1');

/**
 * Mask one side. `files` of the result holds the masked bytes; `problems` lists every failed check; `ranks` is the list of masked times.
 * @param {Side} side
 * @param {string} label
 * @param {{ pendingApproval?: boolean }} [opts] pendingApproval: also mask the time fields in PENDING_APPROVAL (not part of the closed list until the maintainer approves them)
 */
export function normaliseSide(side, label, opts = {}) {
  /** @type {string[]} */ const problems = [];
  /** @type {Rank[]} */ const ranks = [];
  const [lo, hi] = side.window;
  const bad = (/** @type {string} */ m) => problems.push(`${label}: ${m}`);
  const text = new Map(/** @type {[string, string][]} */ ([...side.files].map(([p, e]) => [p, lat(e.data)])));
  const inWindow = (/** @type {string} */ where, /** @type {number} */ t) => { if (t < lo || t > hi) bad(`${where}: time ${t} is outside the case window ${lo}..${hi}`); };
  /** @type {Map<string, Map<string, number>>} */ const fields = new Map(); // file -> field -> epoch seconds
  const note = (/** @type {string} */ p, /** @type {string} */ f, /** @type {number} */ t) => { let m = fields.get(p); if (!m) fields.set(p, (m = new Map())); m.set(f, t); };

  // ---- pass 1: parse and check the named time fields of record files (never the ledger) ----
  /** @type {Map<string, string>} */ const masked = new Map();
  for (const [p, body] of text) {
    if (!stateFile(p) || baseOf(p) === 'LEDGER.log') continue;
    const isAnswer = /\.answer\.md$/.test(p);
    const out = body.split('\n').map((line) => {
      let m = /^(requested_at|approved_at|consumed_at|asked_at|answered_epoch|amended_at):([ ]*)(.*)$/.exec(line);
      if (m) {
        const v = m[3].replace(/^"(.*)"$/, '$1'); const t = epochOf(v);
        if (t === null) { bad(`${p}: ${m[1]} is not epoch digits: ${m[3]}`); return line; }
        inWindow(`${p} ${m[1]}`, t); note(p, m[1], t); ranks.push({ id: `${p}:${m[1]}`, t });
        return `${m[1]}:${m[2]}<T>`;
      }
      m = /^(decided_at)=(.*)$/.exec(line);
      if (m) {
        const t = epochOf(m[2]);
        if (t === null) { bad(`${p}: decided_at is not epoch digits: ${m[2]}`); return line; }
        inWindow(`${p} decided_at`, t); note(p, 'decided_at', t); ranks.push({ id: `${p}:decided_at`, t });
        return 'decided_at=<T>';
      }
      m = /^(timestamp|time):([ ]*)(.*)$/.exec(line);
      if (m && (m[1] === 'timestamp' || isAnswer)) {
        const v = m[3].replace(/^"(.*)"$/, '$1'); const t = isoToEpoch(v);
        if (t === null) { bad(`${p}: ${m[1]} is not an ISO time YYYY-MM-DDTHH:MM:SSZ: ${m[3]}`); return line; }
        inWindow(`${p} ${m[1]}`, t); note(p, m[1], t); ranks.push({ id: `${p}:${m[1]}`, t });
        return `${m[1]}:${m[2]}<T>`;
      }
      m = /^capture_time:[ ]*(\d+)\s*$/.exec(line); // the user's prompt capture: not masked, used for the order checks only
      if (m) note(p, 'capture_time', Number(m[1]));
      if (opts.pendingApproval) {
        m = /^epoch:[ ]*(.*)$/.exec(line);
        if (m && /\/gates\/[^/]+\.yaml$/.test(p)) {
          const t = epochOf(m[1]);
          if (t === null) { bad(`${p}: epoch is not digits: ${m[1]}`); return line; }
          const ts = fields.get(p)?.get('timestamp'); if (ts !== undefined && ts !== t) bad(`${p}: timestamp and epoch=${t} name different seconds`);
          inWindow(`${p} epoch`, t); note(p, 'epoch', t); ranks.push({ id: `${p}:epoch`, t });
          return 'epoch: <T>';
        }
        if (/\/metrics\/history\.tsv$/.test(p)) return line.replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(\t|$)/, (all, iso, tab) => { const t = isoToEpoch(iso); if (t === null) return all; inWindow(`${p} time`, t); return `<T>${tab}`; });
        if (/\/metrics\/records\.jsonl$/.test(p)) return line.replace(/("time":")(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(")/, (all, a, iso, c) => { const t = isoToEpoch(iso); if (t === null) return all; inWindow(`${p} time`, t); return `${a}<T>${c}`; });
        if (baseOf(p) === 'status-block.log') return line.replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)( |$)/, (all, iso, sp) => { const t = isoToEpoch(iso); if (t === null) return all; inWindow(`${p} time`, t); return `<T>${sp}`; });
        if (baseOf(p) === 'approve.log') return line.replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)( |$)/, (all, iso, sp) => { const t = isoToEpoch(iso); if (t === null) return all; inWindow(`${p} time`, t); return `<T>${sp}`; });
        if (baseOf(p) === 'HOOKS.log') return line.replace(/^ts=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) epoch=(\d+) /, (all, iso, ep) => { const t = isoToEpoch(iso); if (t === null || t !== Number(ep)) return all; inWindow(`${p} time`, t); return 'ts=<T> epoch=<T> '; });
        if (baseOf(p) === 'hook-times') return line.replace(/^(\d+)(\|)/, (all, e, bar) => (Number(e) > 1e9 ? (inWindow(`${p} epoch`, Number(e)), `<T>${bar}`) : all));
      }
      return line;
    });
    masked.set(p, out.join('\n'));
  }

  // ---- order checks inside one side ----
  for (const [p, f] of fields) {
    const g = (/** @type {string} */ k) => f.get(k);
    const ap = g('approved_at'); const ca = g('consumed_at'); const cap = g('capture_time');
    if (ap !== undefined && ca !== undefined && ca < ap) bad(`${p}: consumed_at ${ca} is before approved_at ${ap}`);
    // a capture dated after the case (test-lib writes now+3600 so that it is newer than its request) is not an event of the case
    if (ap !== undefined && cap !== undefined && cap <= hi && cap > ap) bad(`${p}: capture_time ${cap} is after approved_at ${ap}`);
    const rq = /^\s*request:\s*"?([^"\s]+)"?\s*$/m.exec(text.get(p) ?? '')?.[1];
    if (rq && ap !== undefined) {
      const rt = fields.get(`${dirOf(p)}/${rq}`)?.get('requested_at');
      if (rt !== undefined) {
        if (ap < rt) bad(`${p}: approved_at ${ap} is earlier than requested_at ${rt} of ${rq}`);
        if (cap !== undefined && cap <= rt) bad(`${p}: capture_time ${cap} is not newer than requested_at ${rt} of ${rq}`);
      }
    }
    if (g('answered_epoch') !== undefined && p.endsWith('.answer.md')) {
      const asked = fields.get(p.replace(/\.answer\.md$/, '.md'))?.get('asked_at');
      if (asked !== undefined && /** @type {number} */ (g('answered_epoch')) < asked) bad(`${p}: answered_epoch ${g('answered_epoch')} is before asked_at ${asked}`);
    }
  }

  // ---- ledgers: format, order, chain, bindings ----
  /** @type {Set<string>} */ const doneBindings = new Set();
  for (const [p, body] of text) {
    if (baseOf(p) !== 'LEDGER.log') continue;
    const run = dirOf(p);
    const lines = body.split('\n'); const trailing = lines[lines.length - 1] === ''; if (trailing) lines.pop();
    let prevEpoch = -Infinity;
    const out = lines.map((line, i) => {
      const m = /^seq=(\d+) prev=(\S+) event=(\S*) role=(\S*) from=(\S*) to=(\S*) digest=(\S*) ts=(\S*) epoch=(\S*) detail=(.*)$/s.exec(line);
      if (!m) { bad(`${p} line ${i + 1}: not a ledger line`); return line; }
      let [, seq, prev, ev, role, from, to, digest, ts, ep, detail] = m;
      if (Number(seq) !== i + 1) bad(`${p} line ${i + 1}: seq=${seq}`);
      const want = i === 0 ? 'genesis' : sha256(lines[i - 1]);
      if (prev !== want) bad(`${p} line ${i + 1}: prev=${prev} is not the SHA-256 of the previous line`); else if (i > 0) prev = '<H>';
      const t = epochOf(ep); const tIso = isoToEpoch(ts);
      if (t === null) bad(`${p} line ${i + 1}: epoch is not digits: ${ep}`);
      if (tIso === null) bad(`${p} line ${i + 1}: ts is not an ISO time YYYY-MM-DDTHH:MM:SSZ: ${ts}`);
      if (t !== null && tIso !== null && t !== tIso) bad(`${p} line ${i + 1}: ts=${ts} and epoch=${ep} name different seconds`);
      if (t !== null) {
        if (t < prevEpoch) bad(`${p} line ${i + 1}: epoch ${t} decreases (previous ${prevEpoch})`);
        prevEpoch = t; inWindow(`${p} line ${i + 1}`, t); ranks.push({ id: `${p}:${i + 1}`, t });
        if (ev === 'decide') {
          const name = detail.split(' ')[0]; const dt = fields.get(`${run}/decisions/${name}`)?.get('decided_at');
          if (dt !== undefined && dt > t) bad(`${p} line ${i + 1}: decided_at ${dt} of ${name} is after the epoch ${t} of the line that records it`);
        }
      }
      const tsOk = t !== null && tIso !== null && t === tIso;
      detail = detail.replace(/((?:[A-Za-z0-9_.+-]+\/)+[A-Za-z0-9_.+-]+)@([0-9a-f]{64})\b/g, (all, rel, h) => {
        const f = side.files.get(`${run}/${rel}`);
        if (!f) { bad(`${p} line ${i + 1}: binding ${rel} names a file that is not there`); return all; }
        // an approval is bound when it is recorded and consumed later: consume_approval rewrites consumed: "true", adds a consumed_at line and awk ends the
        // last line with a newline. The bound form is derived from the file (both endings); any other byte that differs still fails.
        const pre = rel.startsWith('approvals/') ? lat(f.data).replace(/^consumed: "true"$/m, 'consumed: "false"').replace(/^consumed_at: .*\n?/m, '') : null;
        const boundForms = pre === null ? [] : [pre, pre.replace(/\n$/, '')].map((x) => sha256(Buffer.from(x, 'latin1')));
        if (sha256(f.data) !== h && !boundForms.includes(h)) { bad(`${p} line ${i + 1}: binding ${rel}@${h} does not match its own side's file`); return all; }
        doneBindings.add(`${p}:${i + 1}:${rel}`); return `${rel}@<H>`;
      });
      return `seq=${seq} prev=${prev} event=${ev} role=${role} from=${from} to=${to} digest=${digest} ts=${tsOk ? '<T>' : ts} epoch=${tsOk ? '<T>' : ep} detail=${detail}`;
    });
    masked.set(p, out.join('\n') + (trailing ? '\n' : ''));
  }

  // ---- other derived hashes: gate_record_sha256, message/body_sha256, bound: (masked only when re-verified) ----
  const bySha = new Map(); // sha256 -> true for delivery files of this side
  for (const [p, e] of side.files) if (p.startsWith('.agents/local/deliver/')) bySha.set(sha256(e.data), p);
  for (const [p, body] of [...masked, ...[...text].filter(([p]) => stateFile(p) && !masked.has(p))]) {
    if (!stateFile(p)) continue;
    const run = dirOf(p).replace(/\/(waivers|approvals|deliver)(\/.*)?$/, '');
    const out = body.split('\n').map((line) => {
      let m = /^(gate_record_sha256:[ ]*)"?([0-9a-f]{64})"?\s*$/.exec(line);
      if (m) {
        const rec = /^gate_record:[ ]*"?([^"\n]+)"?\s*$/m.exec(body)?.[1];
        const f = rec && (side.files.get(`${run}/gates/${rec}`) ?? side.files.get(`${dirOf(p)}/${rec}`));
        if (!f) { bad(`${p}: gate_record_sha256 names ${rec} which is not there`); return line; }
        if (sha256(f.data) !== m[2]) { bad(`${p}: gate_record_sha256 does not match its own side's ${rec}`); return line; }
        return `${m[1]}"<H>"`;
      }
      m = /^((?:message_sha256|body_sha256|bound):[ ]*)"?([0-9a-f]{64})"?\s*$/.exec(line);
      if (m && (m[1].startsWith('bound') ? true : p.startsWith('.agents/local/deliver/'))) {
        if (!bySha.has(m[2])) { if (!m[1].startsWith('bound')) bad(`${p}: ${m[1].trim()} does not match any file of its own side`); return line; } // an unverified bound: stays exact
        return `${m[1]}<H>`;
      }
      return line;
    });
    masked.set(p, out.join('\n'));
  }

  // ---- text-level rules: process ids, durations, file metadata, nonces ----
  const maskName = (/** @type {string} */ p) => p
    .replace(/(^|\/)nonce-[0-9a-f]+$/, '$1nonce-<NONCE>')
    .replace(/\.(tmp|brk)\.\d+(?=$|\/)/g, '.$1.<PID>').replace(/(^|\/)result\.\d+\.md$/, '$1result.<PID>.md')
    .replace(/(^|\/)\d{10,}-\d+\.json$/, '$1<MS>-<PID>.json')
    .replace(/(^|\/)([A-Za-z0-9_-]+)-\d{8}T\d{6}Z\.tar\.gz$/, '$1$2-<UTC>.tar.gz');
  /** @param {string} p @param {string} body */
  const maskBody = (p, body) => {
    let b = body;
    if (stateFile(p)) {
      if (/(^|\/)pid$/.test(p)) b = b.replace(/^\d+$/m, '<PID>');
      if (p.startsWith('.agents/local/dispatch/')) b = b.replace(/\bpid=\d+/g, 'pid=<PID>');
      if (/(^|\/)nonce-[0-9a-f]+$/.test(p)) b = b.replace(/^\d+/, '<PID>');
      if (baseOf(p) === 'HOOKS.log') b = b.replace(/\b(total_ms|max_ms)=\d+/g, '$1=<MS>');
      if (baseOf(p) === 'hook-times') b = b.replace(/^([^|\n]*\|[^|\n]*\|)\d+(\|)/gm, '$1<MS>$2');
      if (/metrics/.test(p)) b = b.replace(/("duration_s":)[0-9.]+/g, '$1<MS>');
      if (/\/metrics\/history\.tsv$/.test(p)) b = b.replace(/^((?:[^\t\n]*\t){5})\d+(?=\t|$)/gm, '$1<MS>'); // the duration_s column (the header line holds no digits there)
      if (baseOf(p) === 'fp-cache') b = b.replace(/^([^|\t\n]*\|\d+\|)[\d.]+\|\d+\|[\d.]+(\t)/gm, '$1<META>|<META>|<META>$2');
      if (p.startsWith('.agents/local/deliver/')) b = b.replace(/^(\s*nonce:\s*)[0-9a-f-]+/gm, '$1<NONCE>');
    }
    return b;
  };
  /** @type {Map<string, FileEntry>} */ const files = new Map();
  for (const p of [...side.files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const e = /** @type {FileEntry} */ (side.files.get(p));
    let data = e.data;
    if (/\/[^/]+-\d{8}T\d{6}Z\.tar\.gz$/.test(p) && stateFile(p)) data = Buffer.from(tarMembers(e.data));
    else if (masked.has(p) || stateFile(p)) data = Buffer.from(maskBody(p, masked.get(p) ?? text.get(p) ?? ''), 'latin1');
    files.set(maskName(p), { mode: e.mode, data });
  }
  // a command that prints a record shows the same named time fields: masked there too, after the same format and window checks
  const outText = (/** @type {string} */ s, /** @type {number} */ i) => maskOutput(s, side.tmpdir).replace(/^(requested_at: |approved_at: |consumed_at: |asked_at: |answered_epoch: |amended_at: |decided_at=)(\S*)$/gm, (all, k, v) => {
    const t = epochOf(v); if (t === null) { bad(`step ${i} output: ${k.trim()} is not epoch digits: ${v}`); return all; }
    inWindow(`step ${i} output ${k.trim()}`, t); return `${k}<T>`;
  });
  const outputs = side.outputs.map((o, i) => ({ code: o.code, stdout: outText(o.stdout, i), stderr: outText(o.stderr, i) }));
  return { files, outputs, problems, ranks, git: side.git };
}

/** Temp dirs `$TMPDIR/<name>.XXXXXX`, nonces and `$$` temp names in a message. */
export function maskOutput(/** @type {string} */ s, /** @type {string|undefined} */ tmpdir) {
  let b = s;
  if (tmpdir) {
    const t = tmpdir.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    b = b.replace(new RegExp(`(${t}/[A-Za-z0-9_-]+\\.)[A-Za-z0-9]{6}\\b`, 'g'), '$1<RAND>');
  }
  return b.replace(/\.(tmp|brk)\.\d+\b/g, '.$1.<PID>').replace(/^(\s*nonce:\s*)[0-9a-f-]{16,}/gm, '$1<NONCE>');
}

/** Archives are compared by member list and member bytes, not by gzip bytes. */
export function tarMembers(/** @type {Buffer} */ gz) {
  let tar; try { tar = gunzipSync(gz); } catch { return `<not gzip: ${sha256(gz)}>`; }
  const rows = [];
  for (let o = 0; o + 512 <= tar.length;) {
    const h = tar.subarray(o, o + 512); if (h.every((x) => x === 0)) break;
    const name = h.subarray(0, 100).toString('latin1').replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    rows.push(`${type}\t${name}\t${size}\t${type === '0' ? sha256(tar.subarray(o + 512, o + 512 + size)) : '-'}`);
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return rows.join('\n') + '\n';
}

/** Strictly reversed pairs between the masked times of two sides (equal times never conflict). @returns {string[]} */
export function rankConflicts(/** @type {Rank[]} */ a, /** @type {Rank[]} */ b) {
  const tb = new Map(b.map((r) => [r.id, r.t])); const out = [];
  const pairs = a.filter((r) => tb.has(r.id)).map((r) => ({ id: r.id, ta: r.t, tb: /** @type {number} */ (tb.get(r.id)) })).sort((x, y) => x.ta - y.ta);
  let prevMax = -Infinity, prevId = ''; let i = 0;
  while (i < pairs.length) {
    let j = i; let gMin = Infinity, gMinId = ''; let gMax = -Infinity, gMaxId = '';
    while (j < pairs.length && pairs[j].ta === pairs[i].ta) { const p = pairs[j]; if (p.tb < gMin) { gMin = p.tb; gMinId = p.id; } if (p.tb > gMax) { gMax = p.tb; gMaxId = p.id; } j++; }
    if (gMin < prevMax) out.push(`order differs: ${prevId} is before ${gMinId} on one side and after it on the other`);
    if (gMax > prevMax) { prevMax = gMax; prevId = gMaxId; }
    i = j;
  }
  return out;
}
