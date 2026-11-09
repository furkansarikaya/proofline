// @ts-check
// The decision helpers of the e2e harness (tests/e2e/run.mjs), the Node form of pending-kind.sh, question-open.sh and reply-decision.sh (176-C2).
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const KINDS = 'plan|destructive|single_step|scope|budget|commit|push|waive:[^ ]+';

/**
 * The approval kind the run waits for, from the output of `agent.sh next <ID>`: a `request-approval <ID> <kind>` step, or a `reason=<kind> approval ...`
 * line; else (A128) the newest file of the approvals folder when it is an unanswered `NNN-request-<kind>.yaml` (agent.sh turns ':' into '-': waive-F-1
 * is waive:F-1). Empty when none.
 * @param {string} state @param {string} [approvalsDir]
 */
export function pendingKind(state, approvalsDir) {
  for (const line of state.split('\n')) {
    const f = line.split(/[ \t]+/).filter((x) => x !== '');
    if (new RegExp(`request-approval [^ ]+ (${KINDS})`).test(line)) {
      const i = f.indexOf('request-approval');
      if (i >= 0) return f[i + 2] ?? '';
    }
    if (line.startsWith('reason=')) {
      const a = line.slice('reason='.length).split(/[ \t]+/).filter((x) => x !== '');
      if (a.length >= 2 && a[1] === 'approval') return a[0] ?? '';
    }
  }
  if (approvalsDir && existsSync(approvalsDir)) {
    const newest = readdirSync(approvalsDir).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).at(-1) ?? '';
    if (/^[0-9].*-request-.*\.yaml$/.test(newest)) {
      let kind = newest.slice(newest.indexOf('-request-') + '-request-'.length).replace(/\.yaml$/, '');
      if (kind.startsWith('waive-')) kind = `waive:${kind.slice('waive-'.length)}`;
      return kind;
    }
  }
  return '';
}

/**
 * Is a question open: the run names a pending question, or the lead's last message asks one (it holds a question mark) while the run has no step of its
 * own to take: no task yet, or `next` names no `agent.sh` step (A131/A120).
 * @param {string} state @param {string} lastFile @param {string} [id]
 */
export function questionOpen(state, lastFile, id = 'none') {
  if (state.includes('a question is pending')) return true;
  if (id !== '' && id !== 'none' && /^next=agent\.sh /m.test(state)) return false;
  try { return /[?？]/.test(readFileSync(lastFile, 'utf8')); } catch { return false; }
}

/**
 * What the harness does at a stop (A128): `plan` (answer the approval), `question` (the scripted question reply may be sent) or `stop` (never answer).
 * With no kind, a commit or push request in the text decides (the accepted-answers line of an approval question is skipped).
 * @param {string} kind @param {string} [text]
 * @returns {'plan' | 'question' | 'stop'}
 */
export function replyDecision(kind, text = '') {
  if (kind === 'plan') return 'plan';
  if (kind !== '') return 'stop';
  const hit = text.split('\n').filter((l) => !/accepted answers:|kabul edilen onay/i.test(l)).some((l) => /approve (the )?(commit|push)|commit approval|push approval|commit it|push it/i.test(l));
  return hit ? 'stop' : 'question';
}
