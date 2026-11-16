// @ts-check
// The program text(s) a review role hands to an interpreter, a shell, a runner or a tool that runs commands (A290), split out of readonly-git.mjs. Pure text work: no
// verdict is given here; the guard judges each text with its PROG_GIT / PROG_VERB classes. A tripwire for honest mistakes, not a boundary.
//   programTexts(base, words)   the program texts of one command, [] when it runs no text

/** Commands that only print or search their arguments and may be run safely inside `find -exec`. */
const SAFE_EXEC = new Set(['grep', 'egrep', 'fgrep', 'rg', 'cat', 'echo', 'printf', 'ls', 'wc', 'head', 'tail', 'stat', 'file', 'basename', 'dirname', 'readlink', 'realpath', 'diff', 'cmp', 'shasum', 'sha256sum', 'md5sum', 'md5']);
/** The shells the command scanner unwraps itself (`sh -c '...'` is already judged as the command it runs). */
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
/** Every other shell with a program-text option (-c, -Command, -EncodedCommand, /c): the scanner does not unwrap these, so the text after the option is judged here. */
export const OTHER_SHELLS = new Set(['csh', 'tcsh', 'pwsh', 'powershell', 'fish', 'xonsh', 'nu', 'elvish', 'rc', 'es', 'mksh', 'yash', 'posh', 'oksh', 'pdksh', 'rksh', 'rbash', 'cmd']);
/** Multi-call binaries: `busybox sh -c '...'` runs its first word as the program. */
const MULTICALL = new Set(['busybox', 'toybox']);

/** The program text of a shell that the scanner does not unwrap: the words after -c / -C / -e (also in a cluster such as -lc), --command, --commands, --execute, pwsh -Command and -EncodedCommand (base64 of UTF-16LE, decoded here), cmd /c and /k. @param {string} base @param {string[]} w */
function shellTexts(base, w) {
  /** @type {string[]} */ const out = [];
  for (let k = 0; k < w.length; k++) {
    const x = /** @type {string} */ (w[k]);
    const rest = w.slice(k + 1).join(' ');
    if (base === 'cmd') { if (/^\/[ck]$/i.test(x)) { out.push(rest); break; } continue; }
    if (base === 'pwsh' || base === 'powershell') {
      if (/^[-/](e|ec|en[a-z]*|encodedcommand)$/i.test(x)) { out.push(rest, Buffer.from(w[k + 1] ?? '', 'base64').toString('utf16le')); continue; }
      if (/^[-/](c|co[a-z]*|command)$/i.test(x)) { out.push(rest); continue; }
    }
    if (/^--(command|commands|execute|init-command)$/.test(x)) out.push(rest);
    else if (/^--(command|commands|execute|init-command)=/.test(x)) out.push(x.slice(x.indexOf('=') + 1));
    else if (/^-[A-Za-z]+$/.test(x) && 'cCe'.includes(x.slice(-1))) out.push(rest);
  }
  return out;
}

/** The program text(s) an interpreter, a runner or a tool that runs commands is given, not its file operands (a script path or a document named git-push.md is not a program). @param {string} base @param {string[]} w */
export function programTexts(base, w) {
  /** @type {string[]} */ const out = [];
  if (OTHER_SHELLS.has(base)) return shellTexts(base, w);
  if (MULTICALL.has(base) && w.length > 0) {
    const inner = /** @type {string} */ (w[0]);
    const ib = inner.slice(inner.lastIndexOf('/') + 1);
    return SHELLS.has(ib) ? shellTexts(ib, w.slice(1)) : programTexts(ib, w.slice(1));
  }
  const flagLetters = /^(node|nodejs|bun|deno)$/.test(base) ? 'ep' : /^python[0-9.]*$/.test(base) ? 'c' : base === 'perl' ? 'eE' : (base === 'ruby' || base === 'lua' || base === 'Rscript') ? 'e' : base === 'php' ? 'r' : '';
  if (flagLetters !== '') {
    // -c / -e / -p / -r as a word or as the last letter of a cluster (python -Bc, perl -we, ruby -ne, node -pe): the next word is the program
    for (let k = 0; k < w.length; k++) {
      const x = /** @type {string} */ (w[k]);
      if (/^--(eval|print|command)$/.test(x)) out.push(w[k + 1] ?? '');
      else if (/^--(eval|print)=/.test(x)) out.push(x.slice(x.indexOf('=') + 1));
      else if (/^-[A-Za-z]+$/.test(x) && flagLetters.includes(x.slice(-1))) out.push(w[k + 1] ?? '');
    }
  } else if (/^(awk|gawk|mawk|nawk)$/.test(base)) {
    // options that take a value are skipped before the program is taken; -f names a program file (not read: a gap)
    const VAL = new Set(['-v', '-F', '-i', '-l', '-W', '--assign', '--field-separator', '--include', '--load']);
    let fromOpt = false; let first = null;
    for (let k = 0; k < w.length; k++) {
      const x = /** @type {string} */ (w[k]);
      if (x === '-e' || x === '--source') { out.push(w[k + 1] ?? ''); fromOpt = true; k++; } else if (x.startsWith('--source=')) { out.push(x.slice(9)); fromOpt = true; } else if (x === '-f' || x === '--file') { fromOpt = true; k++; } else if (VAL.has(x)) k++;
      else if (x.startsWith('-') && x !== '-') continue;
      else if (first === null) first = x;
    }
    if (!fromOpt && first !== null) out.push(first);
  } else if (base === 'sed') {
    let fromOpt = false; let first = null;
    for (let k = 0; k < w.length; k++) {
      const x = /** @type {string} */ (w[k]);
      if (x === '-e' || x === '--expression') { out.push(w[k + 1] ?? ''); fromOpt = true; k++; } else if (x.startsWith('--expression=')) { out.push(x.slice(13)); fromOpt = true; } else if (x === '-f' || x === '--file') { fromOpt = true; k++; } else if (x.startsWith('-') && x !== '-') continue;
      else if (first === null) first = x;
    }
    if (!fromOpt && first !== null) out.push(first);
    // only the `e` command and the `e` flag of s/// run a command; any other script is text
    for (let k = out.length - 1; k >= 0; k--) {
      const t = /** @type {string} */ (out[k]);
      const m = /(^|[;{}\s\d,$!])e\s+(.*)$/s.exec(t);
      if (m) out[k] = m[2] ?? ''; else if (!/s(.).*\1.*\1[a-zA-Z]*e/s.test(t)) out.splice(k, 1);
    }
  } else if (base === 'find') {
    let on = false;
    for (const x of w) {
      if (/^-(exec|execdir|ok|okdir)$/.test(x)) { on = true; out.push(''); continue; }
      if (on && out[out.length - 1] === '' && SAFE_EXEC.has(x)) { on = false; out.pop(); continue; }
      if (x === ';' || x === '\\;' || x === '+') { on = false; continue; }
      if (on) out[out.length - 1] += ` ${x}`;
    }
  } else if (base === 'tar') { for (const x of w) if (/^--(to-command|checkpoint-action|use-compress-program|rsh-command)=/.test(x)) out.push(x.slice(x.indexOf('=') + 1)); } else if (base === 'rsync') {
    for (let k = 0; k < w.length; k++) { const x = /** @type {string} */ (w[k]); if (x === '-e' || x === '--rsh') out.push(w[k + 1] ?? ''); else if (x.startsWith('--rsh=')) out.push(x.slice(6)); }
  } else if (base === 'ssh' || base === 'eval' || base === 'env' || base === 'watch' || base === 'script' || base === 'su' || base === 'parallel') out.push(w.join(' '));
  return out;
}
