// @ts-check
// The read-only roles never push and never create a branch or a tag (A293; the incident: a review agent pushed from the wrong directory and created `Main` on origin).
// qa, reviewer, security_reviewer, verifier and explorer only read and report; the lead alone pushes, with the user's approval. This is the runtime guard: it blocks earlier
// than the git side (core/githooks.mjs prePush refuses the same roles when AGENT_ROLE reaches the hook). It reads the scan's command records like the merge guard, so the
// wrappers the scanner strips (`command`, `env`, `sudo`, `exec`, `timeout`, `xargs`, `sh -c`, `cd x &&`) are judged on the command they run. A tripwire, not a boundary: a
// program that pushes from inside (a script, a build tool) is not read. It is judged on the exact text and in the lower-case world (bash.mjs check), whatever the branch is called.
//   readonlyGit(ctx, cmd, scan)   throws Deny; nothing for any other role
import { cmdSubst } from '../lib/text.mjs';
import { cParts, deny } from './kit.mjs';
import { programTexts, SHELLS, OTHER_SHELLS } from './readonly-git-programs.mjs';

/** The roles that never push and never create a branch or a tag. core/githooks.mjs NO_PUSH_ROLES is the same list. */
export const NO_PUSH_ROLES = ['qa', 'reviewer', 'security_reviewer', 'verifier', 'explorer'];

const TAIL = 'the review roles only read and report: they never push and never create a branch or a tag (A293). Report the finding to the lead, who pushes with the user\'s approval; for evidence use a detached worktree (git worktree add --detach "$TMPDIR/<name>" HEAD)';

/** Every git command word that is not an alias or an external git-<name> (git --list-cmds=main,others,nohelpers). Any other subcommand may be an alias for push. */
const BUILTIN = new Set(('add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool worktree fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch format-rev fsck fsck-objects whatchanged gc get-tar-commit-id grep hash-object help history hook index-pack init init-db interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull range-diff read-tree rebase reflog refs remote repack replace replay repo request-pull rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule verify-tag subtree switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive verify-pack upload-pack var verify-commit version write-tree').split(' '));
/** Builtins that push by themselves. */
const PUSHERS = new Set(['push', 'send-pack', 'http-push', 'svn', 'p4', 'cvsexportcommit', 'imap-send', 'send-email', 'fast-import']);
/** Subcommands that run a command line of the caller. */
const RUNNERS = new Set(['submodule', 'rebase', 'bisect', 'filter-branch', 'difftool', 'mergetool', 'for-each-repo', 'hook', 'maintenance', 'stash']);
/** Class: push text. `git ... push|send-pack|http-push` (anything between the words), and the gh forms that create a pull request, a repository, a fork, a release or a branch. Tested on the text with quotes removed. */
const PUSH_TEXT = /(^|[^A-Za-z0-9_.-])git(\.exe)?([^;&|\n]*[\s'"])?(push|send-pack|http-push)([^A-Za-z0-9_-]|$)|(^|[^A-Za-z0-9_.-])gh[\s'"]+(pr[\s'"]+create|repo[\s'"]+(sync|create|fork)|release[\s'"]+create|issue[\s'"]+develop)/;
/** Class: a sink that runs text. A pipe, here-document or eval that feeds a shell: the text is judged as a command. */
const SINK = /\|[\s]*((env|sudo|command|exec)\s+)*(\/[^\s|;&]*\/)?(sh|bash|zsh|dash|ksh|ash)(\s|;|&|\)|$)|(^|[^A-Za-z0-9_.-])(sh|bash|zsh|dash|ksh)(\s+-[A-Za-z]+)*\s*<<|(^|[^A-Za-z0-9_.-])eval(\s|$)/;
/** A function definition whose body mentions git or gh: `function g { git "$@"; }`, `g() { git "$@"; }`. */
const FUNC_DEF = /(\bfunction\s+[A-Za-z_][\w.-]*|[A-Za-z_][\w.-]*\s*\(\s*\))[^{;]*\{[^}]*\b(git|gh)\b/;
/** git in a program text, written with quotes, plus signs or commas between its letters; and what makes it dangerous. */
const PROG_GIT = /(^|[^A-Za-z0-9_])g["'+\s,\\]{0,6}i["'+\s,\\]{0,6}t([^A-Za-z0-9_]|$)|(^|[^A-Za-z0-9_])gh([^A-Za-z0-9_]|$)/;
const PROG_VERB = /push|send-pack|fast-import|update-ref|\bbranch\b|\bcheckout\b|\bswitch\b|\btag\b|worktree|subtree|pu[^A-Za-z]{0,8}sh|create|develop|\bsync\b/;
/** A substitution at the command position with arguments behind it: `\`echo git\` push`. The scanner reads the substitution as a command of its own and the next word as another, so the word that runs is lost. */
const SUBST_CW = /(^|[;&|(){}\n])\s*(`[^`]{0,500}`|\$\((?:[^()]|\([^()]{0,100}\)){0,500}\))\s+[^\s;&|)]/;
/** Class: interpreters and shells that read a program from stdin or from an option. */
const INTERP = '(?:sh|bash|zsh|dash|ksh|ash|node|nodejs|bun|deno|python[0-9.]*|perl|ruby|php|lua|awk|gawk|mawk)';
/** Class: `interp <<EOF` (the program is the here-document text). */
const HERE_PROG = new RegExp(`(^|[^A-Za-z0-9_.-])${INTERP}(\\s+[^<;&|\\n]{0,200})?<<-?[ \\t]*(.*)$`, 's');
/** Class: `echo|printf|cat <text> | interp` (the program is the echoed text). */
const PIPE_PROG = new RegExp(`(?:echo|printf|cat)\\s+((?:\"[^\"]{0,2000}\"|'[^']{0,2000}'|[^|;&\\n\"']){0,2000})\\|\\s*(?:(?:env|sudo|command)\\s+)*(?:\\S*/)?${INTERP}(?:\\s|;|&|\\)|$)`);
/** Class: words that only print, search or page their arguments: git or gh among them is text. */
const TEXT_ONLY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'echo', 'printf', 'cat', 'less', 'more', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'tr', 'cut', 'man', 'which', 'type', 'command', 'ls', 'tee', 'stat', 'file', 'test', 'jq', 'cd', 'pushd', 'popd', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'basename', 'dirname', 'realpath', 'readlink']);

/** A pipe into any interpreter of the table, `source`/`.` of stdin: the text before it is run (SINK covers the shells). */
const SINK_EXT = new RegExp(`\\|\\s*((env|sudo|command|exec)\\s+)*(\\S*/)?${INTERP}(\\s|;|&|\\)|$)|(^|[;&|(\\s])(source|\\.)\\s+(/dev/stdin|/dev/fd/0|/proc/self/fd/0|-)(\\s|;|&|\\)|$)`);
const FILE = '[^\\s|;&<>`()]+';
/** The only consumers whose here-document body is DATA: `cat [> file]`, `tee [-a] file`, `sh <path>/agent.sh <subcommand> ...`. Anything else (an interpreter, an unknown program, any option list) is scanned. */
const DATA_CAT = new RegExp(`^(\\w+=\\S+\\s+)*cat(\\s+-\\w+)*(\\s*>>?\\s*${FILE})?$`);
const DATA_TEE = new RegExp(`^(\\w+=\\S+\\s+)*tee(\\s+-a)?(\\s+${FILE})+$`);
const DATA_AGENT = /^(\w+=\S+\s+)*(sh|bash)\s+(?:(?:\.|\$PWD|\"\$PWD\"|\/[\w.~-]+(?:\/[\w.~-]+)*)\/)?\.agents\/scripts\/agent\.sh\s+[\w-]+(\s+[^|;&<>`()]*)?$/;
/** The here-document operator of a line: delimiter, whether it is quoted (the body is then taken literally), text before and after. @param {string} line */
function hereOf(line) {
  const t = line.replace(/<<</g, '   ');
  const m = /<<-?[ \t]*(?:(['"])([A-Za-z_][\w-]*)\1|(\\?)([A-Za-z_][\w-]*))/.exec(t);
  if (!m) return null;
  return { t, delim: /** @type {string} */ (m[2] ?? m[4]), quoted: m[1] !== undefined || m[3] === '\\', before: t.slice(0, m.index).trim(), after: t.slice(m.index + m[0].length).trim() };
}
/** Whether a line with a here-document hands its body to a data sink and nothing else (no pipe, no substitution, no continuation); an unquoted body must hold no substitution and no nested here-document, since the shell runs those. @param {string} line @param {string} body */
function isDataHeredoc(line, body) {
  const h = hereOf(line);
  if (!h) return false;
  if (/[\\|&]\s*$/.test(h.t) || (h.t.match(/<</g) ?? []).length !== 1) return false;
  if (!h.quoted && /\$\(|`|\$\{|<</.test(body)) return false;
  if (!new RegExp(`^(\\d*>>?\\s*${FILE})?$`).test(h.after)) return false;
  if (/[|`()]|\$\(/.test(h.before)) return false;
  const consumer = /** @type {string} */ (h.before.split(/&&|;/).pop()).trim();
  return DATA_CAT.test(consumer) || DATA_TEE.test(consumer) || DATA_AGENT.test(consumer);
}
/** The command with the bodies of data here-documents removed (a report written with `cat > file <<'EOF'`, `tee`, `agent.sh submit --report - <<'EOF'`). When the rest of the command runs text (eval, source, a pipe into a shell or interpreter, a variable as command word, xargs) nothing is removed. @param {string} cmd */
function withoutDataBodies(cmd) {
  const lines = cmd.split('\n');
  /** @type {string[]} */ const out = [];
  let dropped = false;
  for (let i = 0; i < lines.length; i++) {
    const l = /** @type {string} */ (lines[i]);
    out.push(l);
    const h = hereOf(l);
    if (h === null) continue;
    let j = i + 1;
    while (j < lines.length && /** @type {string} */ (lines[j]).trim() !== h.delim) j++;
    if (!isDataHeredoc(l, lines.slice(i + 1, j).join('\n'))) continue;
    i = j - 1; dropped = true;
  }
  if (!dropped) return cmd;
  const rest = out.join('\n').replace(/\\\n/g, ' ').replace(/\n/g, ' ');
  if (SINK.test(rest) || SINK_EXT.test(rest) || /(^|[^A-Za-z0-9_.-])(eval|xargs|parallel)(\s|$)/.test(rest) || /(^|[;&|(]\s*)["']?\$\{?\w/.test(rest)) return cmd;
  return out.join('\n');
}

/** Class: git hosting CLIs judged by read verbs (gh, glab and their older wrappers hub and lab). */
const HOSTS = new Set(['gh', 'glab', 'hub', 'lab']);
/** The subcommand of a dashed git command (`git-push` -> `push`), or null. @param {string} b */
const dashedSub = (b) => /^git-([a-z0-9][a-z0-9-]*)$/.exec(b)?.[1] ?? null;

/** @param {string} x */
const isShort = (x) => x.length > 1 && x.startsWith('-') && !x.startsWith('--');

/**
 * @param {import('../lib/context.mjs').HookContext} ctx
 * @param {string} cmd
 * @param {import('../command-scan.mjs').ScanResult} scan
 */
export function readonlyGit(ctx, cmd, scan) {
  if (!NO_PUSH_ROLES.includes(ctx.role)) return;
  const stripped = withoutDataBodies(cmd);
  const flat = stripped.replace(/\\\n/g, ' ').replace(/\n/g, ' ');
  const bare = flat.replace(/["'\\]/g, '');
  if ((SINK.test(flat) || SINK_EXT.test(flat)) && PUSH_TEXT.test(bare)) deny(`push text passed to a shell, eval or a pipe cannot be checked: ${TAIL}`);
  // xargs and parallel given git or gh with the subcommand on stdin
  if (/\b(xargs|parallel)\b[^|;&]*\s(git|gh|glab|hub|lab)(\s+(-C|-c|--git-dir|--work-tree)\s+\S+|\s+-\S+)*\s*($|[|;&)])/m.test(stripped) || /\b(xargs|parallel)\b[^|;&]*\s(git|gh|glab|hub|lab)(\s+(-C|-c|--git-dir|--work-tree)\s+\S+|\s+-\S+)*\s*($|[|;&)])/.test(flat)) deny(`xargs or parallel given git or gh without a subcommand takes it from stdin and cannot be checked: ${TAIL}`);
  // an interpreter or shell fed its program by a here-document, a here-string or an echo: the text is judged as a program
  const fed = HERE_PROG.exec(stripped)?.[3] ?? PIPE_PROG.exec(flat)?.[1] ?? '';
  if (fed !== '' && PROG_GIT.test(fed) && PROG_VERB.test(fed)) deny(`a program fed to an interpreter or shell on stdin that runs git push, a branch or tag creator or gh pull request create cannot be checked: ${TAIL}`);
  if (SUBST_CW.test(flat)) deny(`a substitution where the command word goes cannot be checked (it may be git): ${TAIL}`);
  // a shell function or alias that wraps git or gh hides the subcommand (`g() { git "$@"; }; g push`)
  if (FUNC_DEF.test(flat) || /(^|[;&|(\s])alias\s+[^=\s]+=\S*\b(git|gh)\b/.test(flat)) deny(`a shell function or alias that wraps git or gh cannot be checked: ${TAIL}`);
  for (const rec of scan.records) {
    if (rec.kind !== 'C') continue;
    const { cw, rest } = cParts(rec);
    const words = cmdSubst(rest.replace(/[\x03\x02]/g, '\n')).split('\n').filter((w) => w !== '');
    // a command word that is a variable, a substitution or a brace expansion cannot be read (`$g push`, `\`echo git\` push`, `git{,} push`)
    if (cw.startsWith('$') || cw.startsWith('`') || /[{}]/.test(cw)) deny(`a command word that is a variable, a substitution or a brace expansion cannot be checked (it may be git): ${TAIL}`);
    // lower case: on a case-insensitive file system (macOS, Windows) `GIT push` runs git
    const base = cw.slice(cw.lastIndexOf('/') + 1).replace(/\.exe$/i, '').toLowerCase();
    if (base === 'git') { gitJudge(words); continue; }
    // a dashed git command (`git-push`, `/usr/lib/git-core/git-push`) is `git push`
    const dashed = dashedSub(base);
    if (dashed !== null) { gitJudge([dashed, ...words]); continue; }
    if (HOSTS.has(base) || base === 'az') { cliJudge(base, words); continue; }
    if (['curl', 'wget', 'http', 'https', 'xh', 'xhs', 'aria2c'].includes(base)) { netJudge(base, words); continue; }
    const prog = programTexts(base, words);
    // find -exec git <args>: the exec'd line is a real git command line, judged as one (`-exec git checkout -- {}` restores files, it creates no branch)
    const execGit = (/** @type {string} */ t) => base === 'find' && /^\s*git\s/.test(t) && !/[;&|`$(){}]/.test(t.replace(/\{\}/g, ''));
    for (const t of prog) if (execGit(t)) gitJudge(t.trim().split(/\s+/).slice(1));
    if (prog.some((t) => !execGit(t) && PROG_GIT.test(t) && PROG_VERB.test(t))) deny(`${base} given a program or command line that runs git push, a branch or tag creator or gh pull request create cannot be checked: ${TAIL}`);
    // any other program in front of git or gh (`caffeinate git push`, `arch -arm64 git push`, `xcrun git push`): the tokens from git on are judged as that command
    if (!TEXT_ONLY.has(base)) {
      const toks = [cw, ...words];
      const nameOf = (/** @type {string} */ t) => t.slice(t.lastIndexOf('/') + 1).replace(/\.exe$/, '');
      const at = toks.findIndex((t, idx) => idx > 0 && (nameOf(t) === 'git' || dashedSub(nameOf(t)) !== null || HOSTS.has(nameOf(t)) || nameOf(t) === 'az'));
      if (at > 0) {
        const name = nameOf(/** @type {string} */ (toks[at]));
        const ds = dashedSub(name);
        if (name === 'git') gitJudge(toks.slice(at + 1)); else if (ds !== null) gitJudge([ds, ...toks.slice(at + 1)]); else cliJudge(name, toks.slice(at + 1));
      }
    }
    if ((SHELLS.has(base) || OTHER_SHELLS.has(base)) && words.includes('-c') && words.some((w) => w === '{}' || w.startsWith('$') || w.startsWith('`'))) deny(`a shell given its program from xargs, a variable or a substitution cannot be checked: ${TAIL}`);
  }
}


/** `-c key=value` keys that run nothing. Any other key can name a program (core.fsmonitor, core.sshCommand, credential.helper, core.pager, core.editor, diff.external, gpg.program, include.path, core.hooksPath, alias.*, protocol.ext.allow ...). */
const HARMLESS_KEY = /^(color\.[a-z.]+|core\.quotepath|safe\.directory|advice\.[a-z]+|core\.abbrev|log\.abbrevcommit|log\.date|diff\.renames|diff\.algorithm)$/i;
/** An option written in full or as an unambiguous prefix (git accepts `--crea` for `--create`): at least `min` letters. @param {string} x @param {string} full @param {number} [min] */
const opt = (x, full, min = 3) => { if (!x.startsWith('--')) return false; const n = x.slice(2).split('=')[0] ?? ''; return n.length >= min && full.startsWith(n); };

/** The arguments of one `git` command, global options included. @param {string[]} a */
function gitJudge(a, needSub = false) {
  let i = 0;
  let sub = '';
  while (i < a.length) {
    const w = /** @type {string} */ (a[i]);
    if (w === '-c' || w === '--config-env' || w.startsWith('--config-env=')) {
      const v = w === '-c' || w === '--config-env' ? (a[i + 1] ?? '') : w.slice(13);
      const key = v.split('=')[0] ?? '';
      if (!HARMLESS_KEY.test(key)) deny(`git -c ${key} can name a program that runs git push, or an alias: only color.*, core.quotepath, safe.directory and advice.* are set on the command line: ${TAIL}`);
      i += w === '-c' || w === '--config-env' ? 2 : 1; continue;
    }
    if (['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--attr-source'].includes(w)) { i += 2; continue; }
    if (w.startsWith('-')) { i++; continue; }
    sub = w; i++; break;
  }
  const rest = a.slice(i);
  if (sub === '') { if (needSub) deny(`git given its subcommand by xargs or parallel cannot be checked: ${TAIL}`); return; }
  if (sub.includes('$') || sub.includes('`')) deny(`git with a variable or substitution as the subcommand cannot be checked (it may be push): ${TAIL}`);
  if (PUSHERS.has(sub) || sub === 'subtree') deny(`git ${sub} pushes or writes branches and is never run by a review role: ${TAIL}`);
  if (!BUILTIN.has(sub)) deny(`git ${sub} is not a git command of its own, so it is an alias or an external program that may push: ${TAIL}`);
  // the options that name a program run by the transport (fetch, ls-remote, pull, clone ...)
  for (const x of rest) if (x === '--') break; else if (opt(x, 'upload-pack') || opt(x, 'receive-pack') || opt(x, 'exec', 2) || (x === '-u' && (sub === 'ls-remote' || sub === 'clone'))) deny(`git ${sub} ${x.split('=')[0]} runs a program of the caller: ${TAIL}`);
  if (RUNNERS.has(sub) && PROG_GIT.test(rest.join(' ')) && PROG_VERB.test(rest.join(' '))) deny(`git ${sub} given a command line that runs git push or a branch or tag creator cannot be checked: ${TAIL}`);
  const pos = rest.filter((x) => !x.startsWith('-'));
  const has = (/** @type {string[]} */ ...names) => rest.some((x) => names.includes(x));
  const cluster = (/** @type {string} */ letters) => rest.some((x) => isShort(x) && [...x.slice(1)].some((c) => letters.includes(c)));
  const long = (/** @type {string[]} */ ...fulls) => rest.some((x) => fulls.some((f) => opt(x, f)));
  const detach = has('-d') || long('detach') || cluster('d');
  switch (sub) {
    case 'branch': {
      const list = has('-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at') || cluster('l') || long('list', 'contains', 'merged', 'points-at');
      const bad = rest.some((x) => (isShort(x) && [...x.slice(1)].some((c) => !'lavrqi'.includes(c))) || ['--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog'].includes(x) || /^--(set-upstream-to|track)=/.test(x));
      if (bad || (pos.length > 0 && !list)) deny(`git branch creates, moves, copies or deletes a branch here: ${TAIL}`);
      return;
    }
    case 'tag': {
      const list = has('-l', '--list', '-n', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '-v', '--verify') || cluster('lnv') || long('list', 'contains', 'merged', 'points-at', 'verify');
      const bad = rest.some((x) => (isShort(x) && [...x.slice(1)].some((c) => !'lnvi0123456789'.includes(c))) || ['--annotate', '--sign', '--force', '--delete', '--local-user', '--message', '--file', '--edit', '--cleanup'].includes(x) || /^--(message|file|local-user|cleanup)=/.test(x));
      if (bad || (pos.length > 0 && !list)) deny(`git tag creates, moves or deletes a tag here: ${TAIL}`);
      return;
    }
    case 'checkout':
      // a review role has no reason to move HEAD to a branch: `git checkout side` creates a tracking branch from a remote-only name. Allowed: --detach, and paths after `--`
      if (long('orphan', 'track', 'no-track', 'create') || cluster('bBt')) deny(`git checkout creates a branch here: ${TAIL}`);
      if (!detach && !rest.includes('--')) deny(`git checkout of a name may create a local branch from a remote one; use --detach <commit>: ${TAIL}`);
      return;
    case 'switch':
      if (long('create', 'force-create', 'orphan', 'track', 'no-track') || cluster('cCt')) deny(`git switch creates a branch here: ${TAIL}`);
      if (!detach) deny(`git switch of a name may create a local branch from a remote one; use --detach <commit>: ${TAIL}`);
      return;
    case 'worktree': {
      if (pos[0] !== 'add') return;
      if (rest.some((x) => x === '-b' || x === '-B' || long('orphan') || (isShort(x) && /[bB]/.test(x)))) deny(`git worktree add creates a branch here; use git worktree add --detach <path> HEAD: ${TAIL}`);
      // a path and a name that exists only on the remote create a tracking branch, a path alone creates a branch named like the folder
      if (!detach) deny(`git worktree add without --detach may create a branch; use git worktree add --detach <path> HEAD: ${TAIL}`);
      return;
    }
    case 'update-ref': case 'replace': case 'replay':
      deny(`git ${sub} moves, creates or deletes a ref here: ${TAIL}`);
      break;
    case 'symbolic-ref':
      if (pos.length >= 2 || has('-d', '--delete')) deny(`git symbolic-ref sets a ref here: ${TAIL}`);
      return;
    case 'fetch': case 'pull': {
      // a refspec with a destination creates or moves a local ref unless it lands under refs/remotes/; --refmap does the same
      if (rest.some((x) => opt(x, 'refmap', 4) && x !== '--refmap=')) deny(`git ${sub} --refmap maps fetched refs onto local refs: ${TAIL}`);
      if (pos.slice(1).some((x) => x.includes(':') && !x.slice(x.indexOf(':') + 1).startsWith('refs/remotes/'))) deny(`git ${sub} with a destination refspec creates or moves a local ref here: ${TAIL}`);
      return;
    }
    case 'stash':
      if (pos[0] === 'branch') deny(`git stash branch creates a branch here: ${TAIL}`);
      return;
    case 'notes':
      if (['add', 'append', 'edit', 'copy', 'merge', 'remove', 'prune'].includes(pos[0] ?? '')) deny(`git notes ${pos[0]} writes a notes ref here: ${TAIL}`);
      return;
    case 'remote':
      if (['add', 'rename', 'remove', 'rm', 'set-head', 'set-branches', 'set-url', 'prune'].includes(pos[0] ?? '')) deny(`git remote ${pos[0]} changes where a push goes or what a fetch creates: ${TAIL}`);
      return;
    case 'config': {
      // every write is refused (a key can name a program, an alias, a push target or a fetch refspec); reads stay
      const sc = pos[0] ?? '';
      if (['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(sc) || has('--unset', '--unset-all', '--replace-all', '--add', '--edit', '-e', '--rename-section', '--remove-section')) deny(`git config writes the configuration here: ${TAIL}`);
      if (sc !== 'get' && sc !== 'list' && pos.length >= 2 && !rest.some((x) => /^--(get|get-all|get-regexp|get-urlmatch|list|default|show-origin|type)$/.test(x) || x === '-l')) deny(`git config ${sc} sets a value here: ${TAIL}`);
      return;
    }
    default:
  }
}

/** The read verbs of gh, glab, hub and lab; anything else is a write (an allow-list, so a verb nobody listed is refused). */
const READ_VERBS = new Set(['list', 'ls', 'view', 'diff', 'checks', 'status', 'get', 'check', 'watch', 'download', 'show']);

/** gh and glab: only the read verbs; `api` is judged by apiJudge. az: the verbs that create a pull request or a ref. @param {string} tool @param {string[]} a */
function cliJudge(tool, a) {
  /** @type {string[]} */ const n = [];
  for (let k = 0; k < a.length; k++) { const x = /** @type {string} */ (a[k]); if (x === '-R' || x === '--repo' || x === '--hostname') { k++; continue; } if (!x.startsWith('-')) n.push(x.toLowerCase()); }
  const [v1 = '', v2 = ''] = n;
  if (n.some((x) => x.startsWith('$') || x.startsWith('`'))) deny(`${tool} with a variable or substitution where the subcommand goes cannot be checked: ${TAIL}`);
  if (HOSTS.has(tool)) {
    if (v1 === 'api') { apiJudge(a); return; }
    if (v1 === '' || ['search', 'status', 'help', 'version', 'browse', 'completion', ...(tool === 'hub' ? ['ci-status', 'compare'] : [])].includes(v1)) return;
    if ((v1 === 'auth' && v2 === 'status') || (v1 === 'config' && (v2 === 'get' || v2 === 'list')) || (v1 === 'repo' && v2 === 'clone')) return;
    if (READ_VERBS.has(v2)) return;
    deny(`${tool} ${v1} ${v2} is not a read verb (list, view, diff, checks, status, get, watch, download); it can push, create a branch, a tag or a pull request, or change the repository: ${TAIL}`);
  }
  // az repos pr create / az repos ref create|delete
  if (v1 === 'repos' && ((v2 === 'pr' && n.includes('create')) || v2 === 'ref')) deny(`az repos ${v2} creates a pull request or a ref: ${TAIL}`);
  if (n.includes('rest') || n.includes('invoke')) deny(`az rest / az devops invoke is a write to the platform: ${TAIL}`);
}

/** `gh api` / `glab api`: GET reads; a write method, --input, or fields sent to a ref, branch, tag, commit, content, pull or release endpoint is refused. @param {string[]} a */
function apiJudge(a) {
  const txt = a.join(' ');
  let method = '';
  for (let k = 0; k < a.length; k++) {
    const x = /** @type {string} */ (a[k]);
    if (x === '-X' || x === '--method') method = (a[k + 1] ?? '').toUpperCase();
    else if (x.startsWith('--method=')) method = x.slice(9).toUpperCase();
    else if (/^-X./.test(x)) method = x.slice(2).toUpperCase();
  }
  const fields = a.some((x) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(x) || /^-[fF]./.test(x) || /^--(field|raw-field|input)=/.test(x));
  if (/mutation|createRef|createBranch|updateRef|deleteRef|createCommitOnBranch|createTag/i.test(txt)) deny(`gh api with a mutation of refs or commits is a write to the repository: ${TAIL}`);
  if (method !== '' && method !== 'GET') deny(`gh api -X ${method} writes to the platform: ${TAIL}`);
  if (method === '' && fields && !/\bgraphql\b/.test(txt)) deny(`gh api with -f/-F fields is a POST unless -X GET is written: ${TAIL}`);
  if (a.includes('--input') || a.some((x) => x.startsWith('--input='))) deny(`gh api --input sends a request body: ${TAIL}`);
  if (method === '' && fields && /git\/(refs|commits|trees|tags)|\/branches|\/contents\/|\/pulls|\/releases|\/tags|\/merges|\/forks|\/dispatches|\/protected_branches|merge-upstream|update-branch/i.test(txt)) deny(`gh api with fields is a POST to a ref, branch, tag, content, pull or release endpoint: ${TAIL}`);
}

/** curl and its kin aimed at a platform endpoint with a body or a write method. @param {string} tool @param {string[]} a */
function netJudge(tool, a) {
  const txt = a.join(' ');
  if (!/github|gitlab|bitbucket|dev\.azure|visualstudio/i.test(txt)) return;
  const write = a.some((x, k) => (/^(-X|--request|--method)$/.test(x) && !/^get$/i.test(a[k + 1] ?? '')) || /^--(request|method)=(?!get$)/i.test(x) || /^-X(?!GET$)./.test(x) || /^(-d|-F|-T|--data|--data-raw|--data-binary|--data-urlencode|--form|--json|--upload-file|--post-data|--post-file|--body-data)(=|$)/.test(x) || /^-d./.test(x) || /^(POST|PUT|PATCH|DELETE)$/i.test(x) || /^[A-Za-z_][A-Za-z0-9_]*(:=|=@|==?)/.test(x) && (tool === 'http' || tool === 'https' || tool === 'xh' || tool === 'xhs'));
  if (write) deny(`${tool} with a body or a write method aimed at a git platform could push or create a ref: ${TAIL}`);
}
