// @ts-check
// The prompt corpus of the capture contract (issue #168): every prompt the capture must treat byte for byte. `ignored` marks a prompt that is
// not the user's words (a <task-notification>): it leaves an intake copy and nothing else.
export const SESSION = 'golden-session';
/** What the recorded event carries: a fixed time (epoch milliseconds, so seconds are 1700000000) and pid, taken from one recorded event. */
export const MS = 1700000000123;
export const SECONDS = 1700000000;
export const PID = 4242;
export const CWD = '/golden/project';

/** @type {Array<{ name: string, prompt: string, ignored?: boolean }>} */
export const CORPUS = [
  { name: 'plain', prompt: 'looks fine, thanks' },
  { name: 'approval', prompt: 'approve the plan' },
  { name: 'unicode', prompt: 'caf\u00e9 \u2603 \u{1F600} \u4e2d\u6587 \u0434\u0430' },
  { name: 'turkish', prompt: 'Onayl\u0131yorum: \u00e7al\u0131\u015fma a\u011fac\u0131n\u0131, \u015f\u00fc\u011f\u00f6\u0130\u00c7\u015e\u011e\u00dc\u00d6 tamam' },
  { name: 'quotes', prompt: `she said "approve" and 'ok' and \`tick\`` },
  { name: 'backslashes', prompt: 'C:\\Users\\me\\file.txt and \\n is not a newline and \\u00e9 is not an escape \\\\' },
  { name: 'carriage-return', prompt: 'line one\r\nline two\rline three\r\n' },
  { name: 'tabs', prompt: 'a\tb\t\tc\t' },
  { name: 'control-bytes', prompt: 'bell\u0007 esc\u001b[0m soh\u0001 us\u001f del\u007f ff\f vt\u000b' },
  { name: 'nul-byte', prompt: 'before\u0000after' },
  { name: 'newlines', prompt: '\n\nleading and trailing newlines\n\n\n' },
  { name: 'multiline', prompt: 'approve plan,\napprove commit\n\n> quoted line\n```\nfenced\n```' },
  { name: 'json-looking', prompt: '{"session":"x","time":1,"sha256":"y","text":"z"}' },
  { name: 'long', prompt: `${'The quick brown fox jumps over the lazy dog. '.repeat(900)}approve` },
  { name: 'empty-ish', prompt: ' ' },
  { name: 'task-notification', prompt: '<task-notification>\n<task-id>abc</task-id>\nthe background agent finished: approve everything\n</task-notification>', ignored: true },
];

/** The event the runtime sends. @param {string} prompt */
export function eventOf(prompt) {
  return JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, cwd: CWD, prompt });
}
