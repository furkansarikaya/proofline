// @ts-check
// The prompt capture contract (GATES.md "Approvals"; the writer side of what proofline-hook.sh did in its `prompt` event, the reader side of
// agent.sh capture_field / latest_capture). The BYTES are the contract: an approval is only ever recorded from a capture this module (or the
// old shell hook) wrote, and the old `approve` and the new one must accept each other's captures.
//   <shared>/.agents/local/prompts/<session>.json          {"session":"<id>","time":<epoch s>,"sha256":"<sha256 of text>","text":"<text>"}\n
//   <shared>/.agents/local/prompts/history/<s>-<sha8>.txt  the prompt, byte for byte
//   <project>/.agents/local/prompts/intake/<ms>-<pid>.json the raw event, as the runtime sent it (a safety net)
// The capture id an approval stores is `<session>:<time>:<sha256>`.
import { copyFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { sha256 } from './hash.mjs';

/** The prompt as the shell hook held it: a command substitution cannot hold a NUL byte, so it was dropped. @param {string} text */
export function promptText(text) { return text.replace(/\0/g, ''); }

/** `safe`: every byte outside A-Za-z0-9_.- of the session id becomes `_` (tr works on bytes, so a UTF-8 letter becomes several). @param {string} s */
export function safeSession(s) {
  const out = Buffer.from(s, 'utf8').toString('latin1').replace(/[^A-Za-z0-9_.-]/g, '_');
  return out === '' ? 'unknown' : out;
}

/** `jesc`: a JSON string body: only backslash, quote, tab, carriage return and newline are escaped; every other byte passes unchanged. @param {string} text */
export function jsonBody(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** A prompt that is not the user's: a finished background agent arrives as a prompt. @param {string} text */
export function isTaskNotification(text) { return text.startsWith('<task-notification>'); }

/** The bytes of the capture file. @param {string} session a safe session name @param {number} time epoch seconds @param {string} text */
export function captureBytes(session, time, text) {
  return Buffer.from(`{"session":"${session}","time":${time},"sha256":"${sha256(Buffer.from(text, 'utf8'))}","text":"${jsonBody(text)}"}\n`, 'utf8');
}

/**
 * The raw event, copied once into <project>/.agents/local/prompts/intake before anything else (only when <project>/.agents/local exists).
 * @param {string} projectDir @param {number} ms epoch milliseconds @param {number} pid @param {Buffer} raw @returns {string | null} the file written
 */
export function writeIntake(projectDir, ms, pid, raw) {
  const dir = `${projectDir}/.agents/local/prompts/intake`;
  try {
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/${ms}-${pid}.json`;
    writeFileSync(file, raw);
    return file;
  } catch { return null; }
}

/** Same as writeIntake, from a file (a copy, mode as the shell `cp`). @param {string} projectDir @param {number} ms @param {number} pid @param {string} source */
export function copyIntake(projectDir, ms, pid, source) {
  const dir = `${projectDir}/.agents/local/prompts/intake`;
  try { mkdirSync(dir, { recursive: true }); copyFileSync(source, `${dir}/${ms}-${pid}.json`); return `${dir}/${ms}-${pid}.json`; } catch { return null; }
}

/**
 * Store a prompt: the capture file (written under a temporary name, then renamed) and the history copy. Returns the capture id parts.
 * @param {string} sharedLocal the main tree's .agents/local @param {string} rawSession the session id as the runtime gave it
 * @param {number} timeSec epoch seconds @param {string} rawText the prompt
 * @returns {{ session: string, time: number, sha256: string, id: string, capture: string, history: string } | null} null: the folder cannot be made
 */
export function storePrompt(sharedLocal, rawSession, timeSec, rawText) {
  const text = promptText(rawText);
  const session = safeSession(rawSession);
  const dir = `${sharedLocal}/prompts`;
  try { mkdirSync(dir, { recursive: true }); } catch { return null; }
  const sha = sha256(Buffer.from(text, 'utf8'));
  const tmp = `${dir}/.${session}.tmp`;
  const capture = `${dir}/${session}.json`;
  try { writeFileSync(tmp, captureBytes(session, timeSec, text)); renameSync(tmp, capture); } catch { return null; }
  const history = `${dir}/history/${timeSec}-${sha.slice(0, 8)}.txt`;
  try { mkdirSync(`${dir}/history`, { recursive: true }); writeFileSync(history, Buffer.from(text, 'utf8')); } catch { /* the history copy is best effort, like the shell */ }
  return { session, time: timeSec, sha256: sha, id: `${session}:${timeSec}:${sha}`, capture, history };
}

/**
 * `capture_field FILE KEY` on the text of a capture file (a latin1 byte string): a JSON string value (unescaped as awk did) or a number; null
 * when the key is absent or the value malformed. \n \t \r are decoded, `\u` stays the two characters `\u`, any other escape yields the character.
 * @param {string} buf the file as a latin1 string @param {string} key @returns {string | null}
 */
export function captureField(buf, key) {
  const b = buf.endsWith('\n') || buf === '' ? buf : `${buf}\n`;
  const pat = `"${key}"`;
  const i = b.indexOf(pat);
  if (i < 0) return null;
  let s = b.slice(i + pat.length).replace(/^[ \t\n\v\f\r]*:[ \t\n\v\f\r]*/, '');
  if (s[0] !== '"') { const m = /^[0-9]+/.exec(s); return m ? m[0] : null; }
  let out = '';
  for (let j = 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++; const d = s[j] ?? '';
      out += d === 'n' ? '\n' : d === 't' ? '\t' : d === 'r' ? '\r' : d === 'u' ? '\\u' : d;
      continue;
    }
    if (c === '"') return out;
    out += c;
  }
  return null;
}
