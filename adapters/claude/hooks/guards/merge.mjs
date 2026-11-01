// @ts-check
// The merge guard (A136, A180, A200): merging is possible only through `proofline merge <PR>` (bin/lib/merge.sh), which merges a pull request only
// when a fresh check shows every check green on its current head. Every other merge path is denied for every caller, a run open or not, proofline
// installed in the project or not: gh/glab/az merges, gh api merge endpoints, HTTP clients aimed at them, git push to a protected branch (or a bare
// push while one is checked out), git merge/reset/rebase/... on one. Token matching on the scan's command records, like the rest of the hook.
// Port of proofline-hook.sh (mg_*, merge_guard); the texts are the shell hook's.
//   mergeGuard(ctx, cmd, scan)   throws Deny (guards/kit.mjs) where the shell hook called `deny`; scan = scanCommand(cmd)
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cmdSubst } from '../lib/text.mjs';
import { cParts, deny, ereToJs, git, grepq, hcfgLoad, mcFail, stashPath, stateOf } from './kit.mjs';

const MG_MSG = 'merging a pull request goes only through `proofline merge <PR-NUMBER> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]`, which checks that every check is green on the current head and then merges (A136); --admin and --auto are never allowed';
const BT = '`';

/** @param {string} s ERE text (POSIX classes allowed) @param {string} [flags] */
const re = (s, flags = '') => /** @type {RegExp} */ (ereToJs(s, flags));

const RE_ENV_CHDIR = re(String.raw`(env|sudo|doas)[[:space:]]+([^;&|]*[[:space:]])?(-[A-Za-z]*[CD]|--chdir)`);
const RE_SUBCMD = re(String.raw`(^|[^[:alnum:]_./-])(gh|glab)([[:space:]]+(-R|--repo)[[:space:]]+[^[:space:]]+)?([[:space:]]+[A-Za-z][A-Za-z-]*)?[[:space:]]+["']?[$${BT}]`);
const RE_PAY = re(String.raw`(^|[^[:alnum:]_])(pr|mr)["'[:space:]]+merge([^[:alnum:]_]|$)|repos[[:space:]]+pr[[:space:]]+update[^;&|]*(completed|auto-complete)|/merge_requests/[^[:space:]]*merge|/pulls/[^[:space:]]*merge|mergePullRequest|enablePullRequestAutoMerge|git[[:space:]]+([^;&|]*[[:space:]])?push[^;&|]*[[:space:]:/+](main|master)([^[:alnum:]_.-]|$)|git[[:space:]]+merge`);
const RE_SINK = re(String.raw`\|[[:space:]]*((env|sudo|command|exec)[[:space:]]+)*(/[^[:space:]|;&]*/)?(sh|bash|zsh|dash|ksh|ash)([[:space:]]|;|&|\)|$)|(^|[^[:alnum:]_.-])(sh|bash|zsh|dash|ksh)([[:space:]]+-[A-Za-z]+)*[[:space:]]*<<|(sh|bash|zsh|dash|ksh)[[:space:]]+(-[A-Za-z]+[[:space:]]+)*-s([[:space:]]|$)|(^|[^[:alnum:]_.-])(python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|lua)[[:space:]]+(-[A-Za-z]*[ceErp]|--eval)([[:space:]]|$)|awk[^|;&]*system[[:space:]]*\(|(^|[;&|({[:space:]])eval[[:space:]]|alias\.[A-Za-z0-9_-]+=["']?!`);
const RE_API_WRITE = re(String.raw`^(-X|--method|-f|-F|--field|--raw-field|--input)(=.*)?$|^-X.`);
const RE_API_DENY = re(String.raw`^--input|=@|mutation|/pulls/[^/[:space:]]*/merge|/merge_requests/[^/[:space:]]*/(merge|cancel_merge)|merge_when_pipeline_succeeds|state_event|/pullrequests/|/merges?([[:space:]?#]|$)|mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|auto_merge|git/refs/heads/(main|master)`, 'i');
const RE_GH_ENDPOINT = re(String.raw`/pulls/[^[:space:]]*/merge|/merges|git/refs|/contents/|graphql|mergePull|auto_merge`, 'i');
const RE_ANY_ENDPOINT = re(String.raw`/pulls/[^[:space:]]*/merge|/merge_requests/[^[:space:]]*(merge|state_event)|state_event|merge_when_pipeline_succeeds|/pullrequests/|_apis/git/[^[:space:]]*pullrequests`, 'i');
const RE_PATH_GH = re(String.raw`merge|proofline|(^|[^[:alnum:]_.-])gh([^[:alnum:]_]|$)`);
const RE_SWITCH_VAR = re(String.raw`(checkout|switch)[[:space:]]+([^;&|]*[[:space:]])?[$${BT}]`);

/** The exempt command words: they cannot merge or push by themselves, so they do not load the protected-branch list. */
const NO_LOAD = new Set(['ls', 'pwd', 'cd', 'pushd', 'popd', 'echo', 'printf', 'cat', 'true', 'false', 'test', '[', 'node', 'nodejs', 'mkdir', 'touch', 'date', 'sleep', 'wc', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'tr', 'cut', 'sort', 'uniq', 'jq', 'diff', 'which', 'type', 'agent.sh', 'proofline', '<']);
const SKIP_WORDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'man', 'sed', 'awk', 'head', 'tail', 'wc', 'tr', 'cut', 'sort', 'uniq', 'jq', 'diff', 'ls', 'test', 'type', 'which', 'true', 'agent.sh', 'proofline', '<']);

/** The git dir of a working directory: walks up to the nearest `.git` (a folder, or a `gitdir:` file). null when none. @param {string} start */
function findGitDir(start) {
  let d = start;
  for (;;) {
    const g = `${d}/.git`;
    try {
      const st = statSync(g);
      if (st.isDirectory()) return g;
      if (st.isFile()) {
        const m = /^gitdir: (.*)$/m.exec(readFileSync(g, 'utf8'));
        if (!m) return null;
        return resolve(d, /** @type {string} */ (m[1]));
      }
    } catch { /* keep walking */ }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** `git -C DIR symbolic-ref -q --short HEAD` without a process where the answer is plain; a process otherwise. @param {import('../lib/context.mjs').HookContext} ctx @param {string} dir */
async function currentBranch(ctx, dir) {
  if (ctx.env.GIT_DIR || ctx.env.GIT_WORK_TREE) {
    const r = await git(ctx, ['-C', dir, 'symbolic-ref', '-q', '--short', 'HEAD']);
    return r && r.status === 0 ? cmdSubst(r.stdout) : '';
  }
  const gd = findGitDir(dir);
  if (!gd) return '';
  let head;
  try { head = readFileSync(`${gd}/HEAD`, 'utf8'); } catch { return ''; }
  const m = /^ref: (.*)\n?$/.exec(head);
  if (!m) return ''; // detached
  const ref = /** @type {string} */ (m[1]);
  if (ref.startsWith('refs/heads/')) return ref.slice(11);
  const r = await git(ctx, ['-C', dir, 'symbolic-ref', '-q', '--short', 'HEAD']);
  return r && r.status === 0 ? cmdSubst(r.stdout) : '';
}

/** The short name origin/HEAD points to (the remote name stripped; the shell asked symbolic-ref --short for refs/remotes/origin/HEAD). @param {import('../lib/context.mjs').HookContext} ctx */
async function originHead(ctx) {
  /** @type {string | null} */ let short = null;
  if (!ctx.env.GIT_DIR) {
    const gd = findGitDir(ctx.root);
    if (gd) {
      let common = gd;
      try { common = resolve(gd, readFileSync(`${gd}/commondir`, 'utf8').replace(/\n+$/, '')); } catch { /* not a linked worktree */ }
      let txt = null;
      try { txt = readFileSync(`${common}/refs/remotes/origin/HEAD`, 'utf8'); } catch { txt = null; }
      if (txt === null) short = '';
      else {
        const m = /^ref: refs\/remotes\/(.*)\n?$/.exec(txt);
        if (m) short = /** @type {string} */ (m[1]);
      }
    } else short = '';
  }
  if (short === null) {
    const r = await git(ctx, ['-C', ctx.root, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
    short = r && r.status === 0 ? cmdSubst(r.stdout) : '';
  }
  return short.replace(/^[^/]*\//, '');
}

/**
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} cmd the command text
 * @param {import('../command-scan.mjs').ScanResult} scan
 */
export async function mergeGuard(ctx, cmd, scan) {
  let prot = '';
  const isProt = (/** @type {string} */ b) => ` ${prot} `.includes(` ${b} `);
  const load = async () => {
    if (prot !== '') return;
    let cb = '';
    if (ctx.installed) {
      if (await hcfgLoad(ctx)) cb = stateOf(ctx).hc.branch;
      else {
        const r = await ctx.agent(['config-get', 'canonical_branch']);
        if (r.status === 0) cb = cmdSubst(r.stdout); else mcFail(ctx, 'config-get', 'any', r.status, 'merge guard');
      }
    }
    prot = `main master ${cb} ${await originHead(ctx)}`;
  };
  const mgRef = (/** @type {string} */ r0) => {
    let r = r0.startsWith('+') ? r0.slice(1) : r0;
    if (r.startsWith('refs/heads/')) r = r.slice(11);
    if (r.includes('$') || r.includes(BT)) return true;
    return isProt(r);
  };
  const switchesProt = () => {
    const alt = prot.replace(/ +/g, '|').replace(/^\|/, '').replace(/\|$/, '');
    if (alt === '') return false;
    const norm = cmd.replace(/["']/g, '').replace(/[(){}]/g, ';');
    const r1 = ereToJs(String.raw`(checkout|switch)[[:space:]]+([^;&|]*[[:space:]])?(refs/heads/)?(${alt})([[:space:]]|;|&|\||$)`);
    if (r1 && grepq(r1, norm)) return true;
    return grepq(RE_SWITCH_VAR, norm);
  };
  const chainSwitch = (/** @type {string} */ what) => {
    if (switchesProt()) deny(`${what} in a command that switches to a protected branch advances it without proofline merge: ${MG_MSG}`);
  };

  let mgCd = ctx.cwd;
  let envu = false;

  /** `mg_git ARGS` @param {string[]} a */
  const mgGit = async (a) => {
    let dir = mgCd;
    if (envu) dir = '@unknown';
    let sub = '';
    let i = 0;
    scanArgs: while (i < a.length) {
      const w = /** @type {string} */ (a[i]);
      if (w === '-C') {
        if (a.length - i < 2) break scanArgs;
        if (dir !== '@unknown') { dir = stashPath(ctx, /** @type {string} */ (a[i + 1]), dir); if (dir === '') dir = '@unknown'; }
        i++;
      } else if (w.startsWith('--git-dir=') || w.startsWith('--work-tree=')) dir = '@unknown';
      else if (w === '--git-dir' || w === '--work-tree') { dir = '@unknown'; i++; } else if (['-c', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source'].includes(w)) i++;
      else if (w.startsWith('-')) { /* an option without a value */ } else { sub = w; i++; break scanArgs; }
      i++;
    }
    const rest = a.slice(Math.min(i, a.length));
    const cur = async () => (dir === '@unknown' ? '' : currentBranch(ctx, dir));
    switch (sub) {
      case 'push': {
        let skip = false;
        for (const x of rest) {
          if (skip) { skip = false; continue; }
          if (x === '-n' || x === '--dry-run') return;
          if (['-o', '--push-option', '--receive-pack', '--exec', '--repo'].includes(x)) skip = true;
        }
        await load();
        let np = 0; let head = false; skip = false;
        for (const x of rest) {
          if (skip) { skip = false; continue; }
          if (x === '--all' || x === '--mirror') deny(`git push ${x} would push the protected branch: ${MG_MSG}`);
          if (x === '--repo') { np = 1; skip = true; continue; }
          if (x.startsWith('--repo=')) { np = 1; continue; }
          if (['-o', '--push-option', '--receive-pack', '--exec'].includes(x)) { skip = true; continue; }
          if (x.startsWith('-')) continue;
          np++;
          if (np < 2) continue;
          if (x.includes(':')) { if (mgRef(x.slice(x.indexOf(':') + 1))) deny(`git push to the protected branch (${x}): ${MG_MSG}`); } else if (x === 'HEAD' || x === '@') head = true;
          else if (mgRef(x)) deny(`git push of the protected branch (${x}): ${MG_MSG}`);
        }
        if (np < 2 || head) {
          if (dir === '@unknown') deny(`git push whose directory cannot be read from the command text (cd -, a variable, GIT_DIR, env -C, a cd in a subshell or pipe) pushes an unknown branch: ${MG_MSG}`);
          const c = await cur();
          if (isProt(c)) deny(`git push while the protected branch ${c} is checked out: ${MG_MSG}`);
        }
        return;
      }
      case 'merge': {
        for (const x of rest) if (x === '--abort' || x === '--quit' || x === '--continue') return;
        await load();
        if (dir === '@unknown') deny(`git merge whose directory cannot be read from the command text may merge into a protected branch: ${MG_MSG}`);
        const c = await cur();
        if (isProt(c)) deny(`git merge on the protected branch ${c}: ${MG_MSG}`);
        if (switchesProt()) deny(`git merge in a command that switches to a protected branch: ${MG_MSG}`);
        return;
      }
      case 'update-ref':
        await load();
        for (const x of rest) if (x.startsWith('refs/heads/') && mgRef(x)) deny(`git update-ref of a protected branch: ${MG_MSG}`);
        return;
      case 'branch': {
        await load();
        let f = false;
        for (const x of rest) {
          if (x === '--force' || x === '--move' || x === '--copy') f = true;
          else if (x.startsWith('--')) continue;
          else if (/^-.*[fMC]/.test(x)) f = true;
        }
        if (f) for (const x of rest) if (!x.startsWith('-') && mgRef(x)) deny(`git branch -f/-M/-C on the protected branch ${x} moves it without proofline merge: ${MG_MSG}`);
        return;
      }
      case 'checkout': case 'switch': {
        await load();
        let take = false;
        const fc = sub === 'switch' ? 'C' : 'B';
        for (const x of rest) {
          if (take) {
            if (x.startsWith('-')) continue;
            if (mgRef(x)) deny(`git ${sub} -B/-C on the protected branch ${x} resets it without proofline merge: ${MG_MSG}`);
            take = false; continue;
          }
          if (x === '--force-create') take = true;
          else if (x.startsWith('--force-create=')) { if (mgRef(x.slice(15))) deny(`git ${sub} --force-create on the protected branch resets it without proofline merge: ${MG_MSG}`); } else if (x.startsWith('--')) continue;
          else if (x.startsWith('-')) {
            const cl = x.slice(1);
            const k = cl.indexOf(fc);
            if (k >= 0) {
              const val = cl.slice(k + 1);
              if (val !== '') { if (mgRef(val)) deny(`git ${sub} -${fc} on the protected branch ${val} resets it without proofline merge: ${MG_MSG}`); } else take = true;
            }
          }
        }
        return;
      }
      case 'fetch':
        await load();
        for (const x of rest) if (!x.startsWith('-') && x.includes(':') && mgRef(x.slice(x.indexOf(':') + 1))) deny(`git fetch into the protected branch (${x}) moves it without proofline merge: ${MG_MSG}`);
        return;
      case 'reset': case 'cherry-pick': case 'rebase': case 'am': case 'revert': {
        for (const x of rest) if (['--abort', '--quit', '--continue', '--skip'].includes(x)) return;
        if (sub === 'reset') {
          let mv = false; let fl = false;
          for (const x of rest) {
            if (['--hard', '--soft', '--keep', '--merge'].includes(x)) fl = true;
            else if (x.startsWith('-')) continue;
            else if (x === 'HEAD' || x.startsWith('HEAD~') || x.startsWith('HEAD^') || x === '@' || x.startsWith('@~')) continue;
            else mv = true;
          }
          if (!(fl && mv)) return;
        }
        await load();
        if (dir === '@unknown') deny(`git ${sub} whose directory cannot be read from the command text may move a protected branch: ${MG_MSG}`);
        const c = await cur();
        if (isProt(c)) deny(`git ${sub} while the protected branch ${c} is checked out advances it without proofline merge: ${MG_MSG}`);
        chainSwitch(`git ${sub}`);
        return;
      }
      case 'pull':
        await load();
        for (const x of rest) {
          if (x === '.' || x === './' || x === '..' || x.startsWith('../') || x.startsWith('/')) {
            const c = await cur();
            if (isProt(c)) deny(`git pull from a local path onto the protected branch ${c} merges a task branch without proofline merge: ${MG_MSG}`);
            chainSwitch('git pull from a local path');
          }
        }
        return;
      default:
    }
  };

  /** `mg_api ARGS` @param {string} text the arguments, one per line */
  const mgApi = (text) => {
    const txt = text.replace(/\n/g, ' ');
    const write = grepq(RE_API_WRITE, text);
    if (grepq(RE_API_DENY, text)) deny(`gh api call with a merge endpoint, a GraphQL mutation, --input or a field read from a file (=@) is denied: ${MG_MSG}`);
    if (write) {
      if (grepq(re('/contents/', 'i'), txt)) deny(`gh api write to repository contents (default branch included) is denied: ${MG_MSG}`);
      if (grepq(re('/git/(refs|commits|trees)', 'i'), txt) && grepq(re(`main|master|[$${BT}]`, 'i'), txt)) deny(`gh api write to git refs of a protected branch (or to a ref built from a variable) is denied: ${MG_MSG}`);
    }
  };

  const flat = cmd.replace(/\n/g, ' ');
  if (cmd.includes('PROOFLINE_SELFTEST')) deny(`PROOFLINE_SELFTEST is a self-test switch (it lifts the wrapper's PATH-shadowing rule); a model command never names it: ${MG_MSG}`);
  // (a) a variable, substitution or backtick where the gh subcommand goes
  if (RE_SUBCMD.test(flat)) deny(`a variable or substitution where the gh subcommand goes cannot be checked (gh pr $m, gh $SUB ...); write the subcommand literally: ${MG_MSG}`);
  // (d) merge text piped, heredoc'd or passed to a shell / interpreter / eval / git alias
  if (RE_SINK.test(flat) && RE_PAY.test(flat)) deny(`merge text passed to a shell, an interpreter, eval or a git alias cannot be checked: ${MG_MSG}`);
  // env/sudo -C, --chdir move the directory away from what the text says
  if (RE_ENV_CHDIR.test(flat)) envu = true;
  const nl = cmd.split('\n').map((l) => l.replace(/&&/g, '').replace(/[0-9]*>&[0-9-]*/g, '').replace(/&>/g, '')).join('\n');
  const nonlin = /[(|&{`]/.test(nl);

  for (const rec of scan.records) {
    if (rec.kind !== 'C') continue;
    const { cw, rest } = cParts(rec);
    const args = cmdSubst(rest.replace(/[\x03\x02]/g, '\n'));
    const argLines = args.split('\n');
    if (!NO_LOAD.has(cw)) await load();
    switch (cw) {
      case 'cd': {
        const first = argLines.find((l) => !l.startsWith('-')) ?? '';
        if (first === '' || mgCd === '@unknown') mgCd = '@unknown';
        else { mgCd = stashPath(ctx, first, mgCd); if (mgCd === '') mgCd = '@unknown'; }
        if (nonlin) mgCd = '@unknown';
        continue;
      }
      case 'pushd': case 'popd': mgCd = '@unknown'; continue;
      case 'env': case 'export':
        if (argLines.some((l) => /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=/.test(l))) envu = true;
        if (argLines.some((l) => l.startsWith('PATH=')) && RE_PATH_GH.test(flat)) deny(`setting PATH in a command that runs gh or proofline merge could substitute a fake gh: ${MG_MSG}`);
        continue;
      case 'curl': case 'wget': case 'http': case 'https': case 'xh': case 'xhs': case 'aria2c':
        if (grepq(/github/i, args) && grepq(RE_GH_ENDPOINT, args)) deny(`${cw} aimed at a GitHub merge, refs, contents or graphql endpoint is denied: ${MG_MSG}`);
        if (grepq(RE_ANY_ENDPOINT, args)) deny(`${cw} aimed at a pull request / merge request merge or completion endpoint is denied: ${MG_MSG}`);
        continue;
      default:
    }
    if (SKIP_WORDS.has(cw)) continue;
    if (cw === 'git') { await mgGit(args.split('\n').filter((l) => l !== '')); continue; }
    // every other command word (gh itself, ssh, xargs, a variable): the words pr merge, api, alias
    let pr = false; let mg = false; let ap = false; let al = false; let mr = false; let cp = false; let rs = false; let vb = false; let sc = false;
    for (const l of argLines) {
      const t = l.replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (t === 'pr') pr = true; else if (t === 'mr') mr = true;
      else if (t === 'merge' || t === 'accept') mg = true;
      else if (t === 'api') ap = true; else if (t === 'alias') al = true;
      else if (t === 'update' || t === 'create' || t === 'set-vote') vb = true;
      else if (t === 'completed' || t === '--status=completed') sc = true;
      else if (t === '--auto-complete' || t.startsWith('--auto-complete=') || t === '--bypass-policy' || t.startsWith('--bypass-policy=')) cp = true;
      else if (t === 'rest' || t === 'invoke') rs = true;
    }
    if (pr && mg) deny(`${cw} pr merge is denied: ${MG_MSG}`);
    if (mr && mg) deny(`${cw} mr merge is denied: ${MG_MSG}`);
    if (cw === 'az' && pr && cp) deny(`az repos pr with --auto-complete or --bypass-policy (any verb) completes or merges a pull request and is denied: ${MG_MSG}`);
    if (cw === 'az' && pr && vb && sc) deny(`az repos pr update/create/set-vote with --status completed completes a pull request and is denied: ${MG_MSG}`);
    if (cw === 'az' && rs && grepq(re('pullrequest|_apis/git', 'i'), flat)) deny(`az rest / az devops invoke aimed at a pull request is denied: ${MG_MSG}`);
    if (cw === 'gh' && al) deny(`gh alias could hide a merge command: ${MG_MSG}`);
    if (cw === 'glab' && al) deny(`glab alias could hide a merge command: ${MG_MSG}`);
    if (ap) mgApi(args);
  }
}
