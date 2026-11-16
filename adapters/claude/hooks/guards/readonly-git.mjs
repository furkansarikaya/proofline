// @ts-check
// The read-only roles never push and never create a branch or a tag (A290; the incident: a review agent pushed from the wrong directory and created `Main` on origin).
// qa, reviewer, security_reviewer, verifier and explorer only read and report; the lead alone pushes, with the user's approval. This is the runtime guard: it blocks earlier
// than the git side (core/githooks.mjs prePush refuses the same roles when AGENT_ROLE reaches the hook). It reads the scan's command records like the merge guard, so the
// wrappers the scanner strips (`command`, `env`, `sudo`, `exec`, `timeout`, `xargs`, `sh -c`, `cd x &&`) are judged on the command they run. A tripwire, not a boundary: a
// program that pushes from inside (a script, a build tool) is not read. It is judged on the exact text and in the lower-case world (bash.mjs check), whatever the branch is called.
//   readonlyGit(ctx, cmd, scan)   throws Deny; nothing for any other role
import { cmdSubst } from '../lib/text.mjs';
import { cParts, deny } from './kit.mjs';

/** The roles that never push and never create a branch or a tag. core/githooks.mjs NO_PUSH_ROLES is the same list. */
export const NO_PUSH_ROLES = ['qa', 'reviewer', 'security_reviewer', 'verifier', 'explorer'];

const TAIL = 'the review roles only read and report: they never push and never create a branch or a tag (A290). Report the finding to the lead, who pushes with the user\'s approval; for evidence use a detached worktree (git worktree add --detach "$TMPDIR/<name>" HEAD)';

/** Every git command word that is not an alias or an external git-<name> (git --list-cmds=main,others,nohelpers). Any other subcommand may be an alias for push. */
const BUILTIN = new Set(('add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects credential describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool worktree fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch format-rev fsck fsck-objects whatchanged gc get-tar-commit-id grep hash-object help history hook index-pack init init-db interpret-trailers last-modified log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull range-diff read-tree rebase reflog refs remote repack replace replay repo request-pull rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule verify-tag subtree switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive verify-pack upload-pack var verify-commit version write-tree').split(' '));
/** Builtins that push by themselves. */
const PUSHERS = new Set(['push', 'send-pack', 'http-push', 'svn', 'p4', 'cvsexportcommit', 'imap-send', 'send-email']);
/** Subcommands that run a command line of the caller. */
const RUNNERS = new Set(['submodule', 'rebase', 'bisect', 'filter-branch', 'difftool', 'mergetool', 'for-each-repo', 'hook', 'maintenance', 'stash']);
const PUSH_TEXT = /(^|[^A-Za-z0-9_.-])git(\.exe)?([^;&|\n]*[\s'"])?(push|send-pack|http-push)([^A-Za-z0-9_-]|$)|(^|[^A-Za-z0-9_.-])gh[\s'"]+(pr[\s'"]+create|repo[\s'"]+(sync|create|fork)|release[\s'"]+create|issue[\s'"]+develop)/;
/** A pipe, here-document or eval that feeds a shell: the text is judged as a command. */
const SINK = /\|[\s]*((env|sudo|command|exec)\s+)*(\/[^\s|;&]*\/)?(sh|bash|zsh|dash|ksh|ash)(\s|;|&|\)|$)|(^|[^A-Za-z0-9_.-])(sh|bash|zsh|dash|ksh)(\s+-[A-Za-z]+)*\s*<<|(^|[^A-Za-z0-9_.-])eval(\s|$)/;
/** Words whose arguments are text or paths, never a command (their arguments may name git push). */
const TEXT_WORDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'man', 'sed', 'awk', 'head', 'tail', 'wc', 'tr', 'cut', 'sort', 'uniq', 'jq', 'diff', 'ls', 'test', 'type', 'which', 'true', 'cd', 'pushd', 'popd', 'tee', 'tree', 'find', 'stat', 'file', 'git', 'gh', 'glab', 'az', 'curl', 'wget', 'http', 'https', 'xh', 'xhs', 'aria2c']);
/** Words that run their arguments or a program text. */
const RUN_WORDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'eval', 'node', 'nodejs', 'bun', 'deno', 'perl', 'python', 'python2', 'python3', 'ruby', 'php', 'lua', 'Rscript', 'ssh', 'watch', 'script', 'su', 'setsid', 'parallel', 'make', 'npx', 'npm', 'pnpm', 'yarn']);

/** @param {string} x */
const isShort = (x) => x.length > 1 && x.startsWith('-') && !x.startsWith('--');

/**
 * @param {import('../lib/context.mjs').HookContext} ctx
 * @param {string} cmd
 * @param {import('../command-scan.mjs').ScanResult} scan
 */
export function readonlyGit(ctx, cmd, scan) {
  if (!NO_PUSH_ROLES.includes(ctx.role)) return;
  const flat = cmd.replace(/\n/g, ' ');
  if (SINK.test(flat) && PUSH_TEXT.test(flat.replace(/["'\\]/g, ''))) deny(`push text passed to a shell, eval or a pipe cannot be checked: ${TAIL}`);
  for (const rec of scan.records) {
    if (rec.kind !== 'C') continue;
    const { cw, rest } = cParts(rec);
    const words = cmdSubst(rest.replace(/[\x03\x02]/g, '\n')).split('\n').filter((w) => w !== '');
    const base = cw.slice(cw.lastIndexOf('/') + 1);
    if (base === 'git' || base === 'git.exe') { gitJudge(words); continue; }
    if (base === 'gh' || base === 'glab' || base === 'az') { cliJudge(base, words); continue; }
    if (['curl', 'wget', 'http', 'https', 'xh', 'xhs', 'aria2c'].includes(base)) { netJudge(base, words); continue; }
    // a command word that is a variable or a substitution: `$g push`, `$(echo git) push`
    if ((cw.startsWith('$') || cw.startsWith('`')) && words.some((w) => w === 'push' || w === 'send-pack')) deny(`a variable or substitution as the command word of a push cannot be checked: ${TAIL}`);
    if (TEXT_WORDS.has(base)) continue;
    // an interpreter, a remote shell, a runner: the program text or the command line it is given
    if (PUSH_TEXT.test(words.join(' ').replace(/["'\\]/g, '')) && (RUN_WORDS.has(base) || ['env', 'xargs', 'time', 'nohup', 'command', 'exec', 'sudo', 'doas', 'timeout', 'nice'].includes(base))) deny(`${base} given a git push or a gh pull request create cannot be checked: ${TAIL}`);
  }
}

/** The arguments of one `git` command, global options included. @param {string[]} a */
function gitJudge(a) {
  let i = 0;
  let sub = '';
  while (i < a.length) {
    const w = /** @type {string} */ (a[i]);
    if (w === '-c' || w === '--config-env') {
      const v = a[i + 1] ?? '';
      if (/^alias\./i.test(v)) deny(`git -c ${v.split('=')[0]} defines an alias, which can hide a push: ${TAIL}`);
      i += 2; continue;
    }
    if (w.startsWith('--config-env=') && /^--config-env=alias\./i.test(w)) deny(`git ${w.split('=').slice(0, 2).join('=')} defines an alias, which can hide a push: ${TAIL}`);
    if (['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--attr-source'].includes(w)) { i += 2; continue; }
    if (w.startsWith('-')) { i++; continue; }
    sub = w; i++; break;
  }
  const rest = a.slice(i);
  if (sub === '') return;
  if (sub.includes('$') || sub.includes('`')) deny(`git with a variable or substitution as the subcommand cannot be checked (it may be push): ${TAIL}`);
  if (PUSHERS.has(sub)) deny(`git ${sub} is never run by a review role: ${TAIL}`);
  if (!BUILTIN.has(sub)) deny(`git ${sub} is not a git command of its own, so it is an alias or an external program that may push: ${TAIL}`);
  if (RUNNERS.has(sub) && PUSH_TEXT.test(rest.join(' ').replace(/["'\\]/g, ''))) deny(`git ${sub} given a push command cannot be checked: ${TAIL}`);
  const pos = rest.filter((x) => !x.startsWith('-'));
  const has = (/** @type {string[]} */ ...names) => rest.some((x) => names.includes(x));
  const cluster = (/** @type {string} */ letters) => rest.some((x) => isShort(x) && [...x.slice(1)].some((c) => letters.includes(c)));
  switch (sub) {
    case 'branch': {
      const list = has('-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at') || cluster('l');
      const bad = rest.some((x) => (isShort(x) && [...x.slice(1)].some((c) => !'lavrqi'.includes(c))) || ['--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog'].includes(x) || /^--(set-upstream-to|track)=/.test(x));
      if (bad || (pos.length > 0 && !list)) deny(`git branch creates, moves, copies or deletes a branch here: ${TAIL}`);
      return;
    }
    case 'tag': {
      const list = has('-l', '--list', '-n', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '-v', '--verify') || cluster('lnv');
      const bad = rest.some((x) => (isShort(x) && [...x.slice(1)].some((c) => !'lnvi0123456789'.includes(c))) || ['--annotate', '--sign', '--force', '--delete', '--local-user', '--message', '--file', '--edit', '--cleanup'].includes(x) || /^--(message|file|local-user|cleanup)=/.test(x));
      if (bad || (pos.length > 0 && !list)) deny(`git tag creates, moves or deletes a tag here: ${TAIL}`);
      return;
    }
    case 'checkout':
      if (has('--orphan', '--track', '--no-track') || cluster('bBt') || rest.some((x) => /^--(orphan|track)=/.test(x))) deny(`git checkout creates a branch here: ${TAIL}`);
      return;
    case 'switch':
      if (has('--create', '--force-create', '--orphan', '--track', '--no-track') || cluster('cCt') || rest.some((x) => /^--(create|force-create|orphan|track)=/.test(x))) deny(`git switch creates a branch here: ${TAIL}`);
      return;
    case 'worktree': {
      if (pos[0] !== 'add') return;
      let n = 0;
      for (let k = 0; k < rest.length; k++) {
        const x = /** @type {string} */ (rest[k]);
        if (x === '-b' || x === '-B' || x === '--orphan' || (isShort(x) && /[bB]/.test(x))) deny(`git worktree add ${x} creates a branch here; use a detached worktree: ${TAIL}`);
        if (x === '--reason') { k++; continue; }
        if (!x.startsWith('-') && x !== 'add') n++;
      }
      // `git worktree add <path>` with no commit-ish creates a branch named like the folder
      if (n < 2) deny(`git worktree add without a commit-ish creates a branch named like the folder; use --detach <path> HEAD: ${TAIL}`);
      return;
    }
    case 'update-ref':
      deny(`git update-ref moves, creates or deletes a ref here: ${TAIL}`);
      break;
    case 'symbolic-ref':
      if (pos.length >= 2 || has('-d', '--delete')) deny(`git symbolic-ref sets a ref here: ${TAIL}`);
      return;
    case 'fetch':
      // `git fetch origin x:y` creates the local branch y (a refspec with a destination); a plain fetch is allowed
      if (pos.slice(1).some((x) => x.includes(':'))) deny(`git fetch with a destination refspec creates or moves a branch here: ${TAIL}`);
      return;
    case 'config':
      if (pos.length >= 2 && /^(alias\.|remote\.[^.]*\.(push|pushurl)$|push\.)/i.test(pos[0] ?? '')) deny(`git config ${pos[0]} sets an alias or a push target: ${TAIL}`);
      if (has('--unset', '--unset-all', '--replace-all', '--add') && pos.some((x) => /^(alias\.|remote\.[^.]*\.push)/i.test(x))) deny(`git config ${pos[0]} changes an alias or a push target: ${TAIL}`);
      return;
    default:
  }
}

/** gh, glab and az: the verbs that push or create a branch or a tag, and a write through the API. @param {string} tool @param {string[]} a */
function cliJudge(tool, a) {
  const w = a.map((x) => x.toLowerCase());
  const nonOpt = w.filter((x) => !x.startsWith('-'));
  const [v1 = '', v2 = ''] = nonOpt;
  if (nonOpt.some((x) => x.startsWith('$') || x.startsWith('`'))) deny(`${tool} with a variable or substitution where the subcommand goes cannot be checked: ${TAIL}`);
  if (tool === 'gh') {
    if ((v1 === 'pr' && v2 === 'create') || (v1 === 'repo' && ['sync', 'create', 'fork'].includes(v2)) || (v1 === 'release' && v2 === 'create') || (v1 === 'issue' && v2 === 'develop') || (v1 === 'alias' && ['set', 'import'].includes(v2))) deny(`gh ${v1} ${v2} pushes a branch, creates a branch or a tag, or hides a command: ${TAIL}`);
    if (v1 === 'api') apiJudge(a);
    return;
  }
  if (tool === 'glab') {
    if ((v1 === 'mr' && v2 === 'create') || (v1 === 'repo' && ['create', 'fork', 'mirror'].includes(v2)) || (v1 === 'release' && v2 === 'create') || (v1 === 'alias' && v2 === 'set')) deny(`glab ${v1} ${v2} pushes a branch, creates a branch or a tag, or hides a command: ${TAIL}`);
    if (v1 === 'api') apiJudge(a);
    return;
  }
  // az repos pr create / az repos ref create|delete
  if (v1 === 'repos' && ((v2 === 'pr' && w.includes('create')) || v2 === 'ref')) deny(`az repos ${v2} creates a pull request or a ref: ${TAIL}`);
  if (nonOpt.includes('rest') || nonOpt.includes('invoke')) deny(`az rest / az devops invoke is a write to the platform: ${TAIL}`);
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
  if (a.includes('--input') || a.some((x) => x.startsWith('--input='))) deny(`gh api --input sends a request body: ${TAIL}`);
  if (method === '' && fields && /git\/(refs|commits|trees|tags)|\/branches|\/contents\/|\/pulls|\/releases|\/tags|\/merges|\/forks|\/dispatches|\/protected_branches/i.test(txt)) deny(`gh api with fields is a POST to a ref, branch, tag, content, pull or release endpoint: ${TAIL}`);
}

/** curl and its kin aimed at a platform endpoint with a body or a write method. @param {string} tool @param {string[]} a */
function netJudge(tool, a) {
  const txt = a.join(' ');
  if (!/github|gitlab|bitbucket|dev\.azure|visualstudio/i.test(txt)) return;
  const write = a.some((x, k) => (/^(-X|--request|--method)$/.test(x) && !/^get$/i.test(a[k + 1] ?? '')) || /^--(request|method)=(?!get$)/i.test(x) || /^-X(?!GET$)./.test(x) || /^(-d|-F|-T|--data|--data-raw|--data-binary|--data-urlencode|--form|--json|--upload-file|--post-data|--post-file|--body-data)(=|$)/.test(x) || /^-d./.test(x) || /^(POST|PUT|PATCH|DELETE)$/i.test(x) || /^[A-Za-z_][A-Za-z0-9_]*(:=|=@|==?)/.test(x) && (tool === 'http' || tool === 'https' || tool === 'xh' || tool === 'xhs'));
  if (write) deny(`${tool} with a body or a write method aimed at a git platform could push or create a ref: ${TAIL}`);
}
