// @ts-check
// `proofline merge <PR>` in Node (stage 6B, A216; the former shell launcher is gone, bin/proofline calls this), the only allowed way to merge a pull request (A136). The runtime hook denies every
// other merge path. Fail closed: whatever cannot be seen or parsed is a refusal that says what was seen. The merge happens only when the pull request is open, not
// a draft, and EVERY check is a success on the head that is merged: that head is read twice (the check and right before the merge) and must be equal, and the merge
// itself is pinned to it (--match-head-commit / --sha). --admin and --auto are never allowed. A pull request with no checks at all is merged only after the
// project's build and test pass in a clean copy of the commit ("verified locally, no CI"). Bitbucket, an unrecognized host and a missing tool are not merged by
// proofline: the branch is pushed, the link is printed and the USER merges (exit 1). The tool (gh, glab, az) comes from an absolute PATH entry and is refused when
// it resolves into the working directory, the project or a temporary folder; no environment value lifts that (D14). The tools get argument arrays; their JSON is
// read in process (no jq).
import { existsSync, statSync } from 'node:fs';
import { buildRecord } from './buildrecord.mjs';
import { Context } from './context.mjs';
import { ProoflineError } from './errors.mjs';
import { cleanToolEnv, detectPlatform, linkText, parseJson, platformEnv, resolveToolIn } from './platform.mjs';
import * as proc from './proc.mjs';


/** The end of the command with an exit code (output already written). */
class Stop extends Error {
  /** @param {number} code */
  constructor(code) { super(''); this.name = 'Stop'; this.code = code; }
}

const USAGE = 'usage: proofline merge <PR-NUMBER> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]';

/** `git` in the working directory; the output without the trailing newline, or ''. @param {Context} ctx @param {string[]} args */
function gitOut(ctx, args) {
  const r = proc.run('git', args, { cwd: ctx.cwd, env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.toString('utf8').replace(/\n+$/, '') : '';
}

/** @param {unknown} x */
const str = (x) => (x === undefined || x === null ? '' : String(x));

/**
 * `proofline merge`: returns the exit code.
 * @param {Context} ctx @param {string[]} argv the arguments after `merge`
 * @returns {number}
 */
export function mergeCommand(ctx, argv) {
  try {
    run(ctx, argv);
    return 0;
  } catch (e) {
    if (e instanceof Stop) return e.code;
    throw e;
  }
}

/** @param {Context} ctx @param {string[]} argv */
function run(ctx, argv) {
  /** `mg_refuse` @param {string} msg @returns {never} */
  const refuse = (msg) => { ctx.err(`proofline merge: REFUSED: ${msg}\n`); throw new Stop(1); };
  /** `die` of the front end @param {string} msg @returns {never} */
  const die = (msg) => { throw new ProoflineError(msg, 1); };
  const say = (/** @type {string} */ m) => ctx.out(`${m}\n`);

  let pr = ''; let method = '--merge'; let del = ''; let repo = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--merge' || a === '--squash' || a === '--rebase') method = a;
    else if (a === '--delete-branch' || a === '-d') del = '--delete-branch';
    else if (a === '-R' || a === '--repo') { if (i + 1 >= argv.length) die(USAGE); repo = argv[++i]; }
    else if (a === '--admin' || a === '--auto' || a === '--disable-auto') refuse(`${a} is never allowed: --admin overrides the checks and --auto merges later without a fresh check`);
    else if (a.startsWith('-')) die(`unknown option for merge: ${a}`);
    else { if (pr !== '') die('merge takes one pull request number'); pr = a; }
  }
  if (pr === '' || /[^0-9]/.test(pr)) die('usage: proofline merge <PR-NUMBER> ... (a plain number: a URL or branch name cannot be verified)');
  if (/[^A-Za-z0-9_./-]/.test(repo)) die(`invalid repository: ${repo}`);

  // the platform of the origin remote decides (A180); no origin at all keeps the old gh behaviour (gh resolves the repository, or -R names it)
  const info = detectPlatform(ctx, { dir: ctx.cwd });
  let plat = 'github'; let cli = 'gh';
  if (info.url !== '' || info.source !== 'auto') { plat = info.platform; cli = info.cli; }
  const toolEnv = { ...cleanToolEnv(ctx), ...platformEnv(info) }; // a private host (A186): the tool talks to the origin's host
  const org = plat === 'azure' ? info.orgUrl : '';
  const wantTool = plat === 'gitlab' ? 'glab' : plat === 'azure' ? 'az' : 'gh';
  const top = gitOut(ctx, ['rev-parse', '--show-toplevel']) || ctx.cwd;

  /** `mg_manual`: the user merges; nothing is merged here. @param {string} why @returns {never} */
  const manual = (why) => {
    const br = gitOut(ctx, ['branch', '--show-current']);
    const base = gitOut(ctx, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).replace(/^[^/]*\//, '') || 'main';
    ctx.err(`proofline merge: NOT MERGED: platform ${plat}: ${why}. proofline does not merge a pull request here; YOU merge it.\n`);
    ctx.err(`manual steps: 1. push the branch (git push -u origin ${br || '<branch>'})  2. open the pull request / merge request: ${linkText(info, br || 'BRANCH', base)}  3. wait for its checks, or run the project's build and test yourself when there are none  4. merge it in the web page of your hosting service.\n`);
    throw new Stop(1);
  };
  if ((plat === 'github' && cli === 'gh') || (plat === 'gitlab' && cli === 'glab') || (plat === 'azure' && cli === 'az')) { /* a supported pair */ }
  else if (plat === 'github' || plat === 'gitlab' || plat === 'azure') manual(`the command line tool for it (${wantTool}) is not installed or not on PATH`);
  else manual('proofline has no merge adapter for this host');

  // PATH shadowing: an empty or relative PATH entry that could hold a fake is refused
  for (const d of (ctx.env.PATH ?? '').split(':')) {
    if (d.startsWith('/')) continue;
    const bad = d === '' || d === '.' || d === '..' || (() => { try { return statSync(d).isDirectory(); } catch { return false; } })();
    if (bad) refuse(`PATH holds an empty or relative entry ('${d}'); a gh found there could be a fake`);
  }
  const t = resolveToolIn(ctx.env, cli, [ctx.cwd, top, ctx.env.TMPDIR ?? '/nonexistent', '/tmp', '/private/tmp', '/var/folders', '/dev/shm']);
  if ('shadowed' in t) refuse(`${cli} resolves to ${t.shadowed}, a project, working or temp directory; refusing a possibly shadowed ${cli}`);
  if ('unreadable' in t) refuse(`${cli} is not installed or not on PATH; cannot check the pull request`);
  const tool = t.path;
  say(`proofline merge: using ${cli} at ${tool}`);

  /** One call of the tool (stdin closed); `-R REPO` after the arguments for gh and glab (`mg_gh`). @param {string[]} args @param {boolean} [withRepo] */
  const call = (args, withRepo = true) => {
    const r = proc.run(tool, repo !== '' && withRepo ? [...args, '-R', repo] : args, { cwd: ctx.cwd, env: toolEnv, input: '', stdio: ['pipe', 'pipe', 'pipe'], timeoutMs: 180000 });
    return { status: r.status, out: r.stdout.toString('utf8'), err: r.stderr.toString('utf8') };
  };
  /** The output with stderr merged (`2>&1`). @param {{ out: string, err: string }} r */
  const both = (r) => (r.out + r.err).replace(/\n+$/, '');
  const head200 = (/** @type {string} */ s) => Buffer.from(s, 'utf8').subarray(0, 200).toString('utf8');
  const sha40 = (/** @type {string} */ sha, /** @type {string} */ what) => { if (!/^[0-9a-f]*$/.test(sha) || sha === '') refuse(`head commit of ${what} is not a SHA (saw: ${sha})`); if (sha.length !== 40) refuse(`head commit of ${what} is not a 40-digit SHA (saw: ${sha})`); };

  /** `mg_local_verify SHA`: no checks exist; the project's build and test must pass in a clean export of exactly the commit. Returns the note for the pull request. @param {string} sha */
  const localVerify = (sha) => {
    if (proc.run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ctx.cwd, env: ctx.env, stdio: 'ignore' }).status !== 0) refuse(`pull request ${pr} has no checks and its head commit ${sha} is not in this clone, so it cannot be verified locally (git fetch it first)`);
    const script = `${top}/.agents/scripts/agent.sh`;
    if (!existsSync(script)) refuse(`pull request ${pr} has no checks and proofline is not installed here (no .agents/scripts/agent.sh), so there is nothing to verify the commit with locally`);
    // the record of exactly that commit, made by this core for the project at TOP (its config names the commands)
    const r = buildRecord(new Context({ ...ctx.io, cwd: top, scriptPath: script }, script), 'run', sha);
    const out = (r.out + r.err).replace(/\n+$/, '');
    if (r.status === 2) refuse(`pull request ${pr} has no checks and the verification commands are not configured (commands.build / commands.test in .agents/config.yaml): ${head200(out.split('\n')[0] ?? '')}`);
    if (r.status !== 0) refuse(`pull request ${pr} has no checks and the verification commands FAILED in a clean copy of ${sha}: ${out.split('\n').filter((l) => /^(build|test|install)|^failed:/.test(l)).slice(0, 4).map((l) => `${l} `).join('')}(see the record: sh .agents/scripts/agent.sh build-record <ID> show)`);
    const key = (out.split('\n').find((l) => l.startsWith('key: ')) ?? '').slice(5);
    say(`proofline merge: no CI for pull request ${pr}: verified locally at ${sha} (build record ${key})`);
    return `verified locally, no CI (proofline merge: commands.build and commands.test passed in a clean copy of ${sha}, build record ${key})`;
  };

  if (cli === 'glab') return mergeGlab();
  if (cli === 'az') { if (repo !== '') refuse('-R is not supported with az; run proofline merge inside the clone'); return mergeAz(); }

  // ---- GitHub (gh) -------------------------------------------------------------------------------------------------------------
  const v1 = call(['pr', 'view', pr, '--json', 'number,state,isDraft,headRefOid,statusCheckRollup']);
  if (v1.status !== 0) refuse(`gh pr view ${pr} failed (offline, not logged in or no such pull request): ${both(v1)}`);
  const j = parseJson(v1.out);
  if (!j || typeof j !== 'object' || Array.isArray(j) || (j.statusCheckRollup !== null && j.statusCheckRollup !== undefined && !Array.isArray(j.statusCheckRollup))) refuse(`gh pr view output is not parseable JSON of the expected shape: ${head200(v1.out)}`);
  const row = `${str(j.number)} ${str(j.state)} ${str(j.isDraft)} ${str(j.headRefOid)}`;
  if (str(j.number) !== pr) refuse(`gh pr view did not return pull request ${pr} (saw: ${row})`);
  if (str(j.state) !== 'OPEN') refuse(`pull request ${pr} is ${str(j.state)}, not OPEN`);
  if (str(j.isDraft) !== 'false') refuse(`pull request ${pr} is a draft`);
  const sha = str(j.headRefOid);
  sha40(sha, `pull request ${pr}`);
  let n = 0; let bad = ''; const seen = new Set();
  for (const c of /** @type {any[]} */ (j.statusCheckRollup ?? [])) {
    const type = str(c?.__typename) || '?'; const name = str(c?.name ?? c?.context) || '?';
    const st = str(c?.status) || '-'; const con = str(c?.conclusion) || '-'; const state = str(c?.state) || '-';
    n++; seen.add(name);
    if ((type === 'CheckRun' && st === 'COMPLETED' && con === 'SUCCESS') || (type === 'StatusContext' && state === 'SUCCESS')) continue;
    if (type === 'CheckRun' && st === 'COMPLETED' && con === 'SKIPPED') continue; // judged with the required checks below
    if (type === 'CheckRun') bad += `\n  ${name}: status ${st}, conclusion ${con}`;
    else if (type === 'StatusContext') bad += `\n  ${name}: state ${state}`;
    else bad += `\n  ${name}: unknown check type ${type}`;
  }
  if (bad !== '') refuse(`pull request ${pr} is not green (${n} checks seen); not SUCCESS:${bad}`);
  // Required checks (branch protection): each must be in the rollup AND a pass. A required check missing from the rollup has not registered yet; skipped checks are judged here too.
  const rq = call(['pr', 'checks', pr, '--required', '--json', 'name,bucket']);
  let req = /** @type {any[]} */ ([]);
  if (rq.status !== 0) {
    // only gh's own sentence, whole and alone (A220): a proxy can put "no required checks" into a transport error (`Post "https://...": no required checks`)
    if (/^no required checks reported on the '[^\n]*' branch$/.test(both(rq))) req = [];
    else refuse(`gh pr checks --required failed, so the required checks cannot be judged: ${both(rq)}`);
  } else {
    const p = parseJson(rq.out);
    if (!Array.isArray(p)) refuse(`gh pr checks --required output is not parseable: ${head200(rq.out)}`);
    req = p;
  }
  const reqBad = req.filter((x) => x?.bucket !== 'pass').map((x) => `${str(x?.name)} (${str(x?.bucket)})`);
  if (reqBad.length > 0) refuse(`pull request ${pr} has required checks that did not pass: ${reqBad.join(' ')} `);
  const reqNames = req.map((x) => str(x?.name)).filter((x) => x !== '');
  const miss = reqNames.filter((x) => !seen.has(x)).map((x) => ` ${x}`).join('');
  if (miss !== '') refuse(`required checks missing from the rollup (not registered yet?):${miss}`);
  let vnote = '';
  if (n === 0) {
    if (reqNames.length > 0) refuse(`pull request ${pr} shows no checks although checks are required; green cannot be proven`);
    vnote = localVerify(sha);
  }
  const v2 = call(['pr', 'view', pr, '--json', 'headRefOid']);
  const now = str(parseJson(v2.out)?.headRefOid);
  if (now !== sha) refuse(`the head of pull request ${pr} moved after the check (checked ${sha}, now ${now !== '' ? now : 'unreadable'}); run the merge again`);
  if (vnote !== '') {
    if (call(['pr', 'comment', pr, '--body', vnote]).status !== 0) refuse(`could not record "verified locally, no CI" on pull request ${pr} (gh pr comment failed); nothing was merged`);
    say(`proofline merge: pull request ${pr} has no checks; ${vnote}; merging (${method})`);
  } else say(`proofline merge: pull request ${pr} is green at ${sha} (${n} checks); merging (${method})`);
  return finish(call(['pr', 'merge', pr, method, '--match-head-commit', sha, ...(del !== '' ? ['--delete-branch'] : [])]));

  /** The merge call's own output and status are the command's. @param {{ status: number, out: string, err: string }} r */
  function finish(r) {
    if (r.out !== '') ctx.out(r.out);
    if (r.err !== '') ctx.err(r.err);
    if (r.status !== 0) throw new Stop(r.status);
  }

  // ---- GitLab (glab) -------------------------------------------------------------------------------------------------------------
  function mergeGlab() {
    const v = call(['mr', 'view', pr, '-F', 'json']);
    if (v.status !== 0) refuse(`glab mr view ${pr} failed (offline, not logged in or no such merge request): ${both(v)}`);
    const m = parseJson(v.out);
    if (!m || typeof m !== 'object' || Array.isArray(m)) refuse(`glab mr view output is not parseable JSON of the expected shape: ${head200(v.out)}`);
    const pl = m.head_pipeline ?? m.pipeline ?? null;
    const dv = m.draft; const draft = str((dv === false || dv == null) ? (m.work_in_progress ?? false) : dv); // jq `.draft // .work_in_progress // false`, fail closed: only false or absent falls through
    const msha = str(m.sha) || '?';
    const pst = pl === null ? 'none' : (str(pl.status) || '?');
    const psha = pl === null ? '-' : (str(pl.sha) || '-');
    const rows = `${str(m.iid) || '?'} ${str(m.state) || '?'} ${draft} ${msha} ${pst} ${psha}`;
    if (str(m.iid) !== pr) refuse(`glab mr view did not return merge request ${pr} (saw: ${rows})`);
    if (str(m.state) !== 'opened') refuse(`merge request ${pr} is ${str(m.state) || '?'}, not opened`);
    if (draft !== 'false') refuse(`merge request ${pr} is a draft`);
    sha40(msha === '?' ? '?' : msha, `merge request ${pr}`);
    let nochk = false;
    if (pst === 'none') nochk = true;
    else if (pst === 'success') { if (psha !== msha) refuse(`the pipeline of merge request ${pr} ran on ${psha}, not on the head ${msha}; wait for the pipeline of the current head`); } else refuse(`merge request ${pr} is not green: the pipeline of its head is ${pst}`);
    const note = nochk ? localVerify(msha) : '';
    const v2 = call(['mr', 'view', pr, '-F', 'json']);
    const now = str(parseJson(v2.out)?.sha);
    if (now !== msha) refuse(`the head of merge request ${pr} moved after the check (checked ${msha}, now ${now !== '' ? now : 'unreadable'}); run the merge again`);
    if (note !== '' && call(['mr', 'note', pr, '-m', note]).status !== 0) refuse(`could not record "verified locally, no CI" on merge request ${pr} (glab mr note failed); nothing was merged`);
    say(`proofline merge: merge request ${pr} at ${msha}: ${note !== '' ? note : 'green pipeline'}; merging (${method})`);
    // only a final pipeline (success) or none reaches this line, so glab has nothing to wait for
    return finish(call(['mr', 'merge', pr, '--sha', msha, '--yes', ...(method === '--squash' ? ['--squash'] : method === '--rebase' ? ['--rebase'] : []), ...(del !== '' ? ['--remove-source-branch'] : [])]));
  }

  // ---- Azure DevOps (az repos) ---------------------------------------------------------------------------------------------------
  function mergeAz() {
    const orgArgs = org !== '' ? ['--org', org] : [];
    const v = call(['repos', 'pr', 'show', '--id', pr, ...orgArgs, '-o', 'json'], false);
    if (v.status !== 0) refuse(`az repos pr show ${pr} failed (offline, not logged in or no such pull request): ${both(v)}`);
    const m = parseJson(v.out);
    if (!m || typeof m !== 'object' || Array.isArray(m)) refuse(`az repos pr show output is not parseable JSON of the expected shape: ${head200(v.out)}`);
    const msha = str(m.lastMergeSourceCommit?.commitId) || '?';
    const rows = `${str(m.pullRequestId) || '?'} ${str(m.status) || '?'} ${str(m.isDraft ?? false)} ${msha}`;
    if (str(m.pullRequestId) !== pr) refuse(`az repos pr show did not return pull request ${pr} (saw: ${rows})`);
    if (str(m.status) !== 'active') refuse(`pull request ${pr} is ${str(m.status) || '?'}, not active`);
    if (str(m.isDraft ?? false) !== 'false') refuse(`pull request ${pr} is a draft`);
    sha40(msha === '?' ? '?' : msha, `pull request ${pr}`);
    const pol = call(['repos', 'pr', 'policy', 'list', '--id', pr, ...orgArgs, '-o', 'json'], false);
    if (pol.status !== 0) refuse(`az repos pr policy list ${pr} failed, so the checks cannot be judged: ${both(pol)}`);
    const pj = parseJson(pol.out);
    if (!Array.isArray(pj)) refuse(`az repos pr policy list output is not parseable: ${head200(pol.out)}`);
    // build and status policies are the checks; every one must be approved (a queued, running, rejected or broken one refuses)
    const checks = pj.filter((x) => /build|status/i.test(str(x?.configuration?.type?.displayName)));
    const badP = checks.filter((x) => (str(x?.status) || '?') !== 'approved').map((x) => ` ${str(x?.configuration?.type?.displayName).replace(/ /g, '_') || '?'}=${str(x?.status) || '?'}`).join('');
    if (badP !== '') refuse(`pull request ${pr} is not green (${checks.length} checks seen); not approved:${badP}`);
    const note = checks.length === 0 ? localVerify(msha) : '';
    const v2 = call(['repos', 'pr', 'show', '--id', pr, ...orgArgs, '-o', 'json'], false);
    const now = str(parseJson(v2.out)?.lastMergeSourceCommit?.commitId);
    if (now !== msha) refuse(`the head of pull request ${pr} moved after the check (checked ${msha}, now ${now !== '' ? now : 'unreadable'}); run the merge again`);
    if (note !== '') { // the note is appended to the description (update replaces it, so the old text is read first)
      const desc = str(m.description);
      if (call(['repos', 'pr', 'update', '--id', pr, ...orgArgs, '--description', `${desc !== '' ? `${desc}\n\n` : ''}${note}`], false).status !== 0) refuse(`could not record "verified locally, no CI" on pull request ${pr} (az repos pr update failed); nothing was merged`);
    }
    say(`proofline merge: pull request ${pr} at ${msha}: ${note !== '' ? note : 'all build and status policies approved'}; merging (${method})`);
    // az has no match-head option; the head is read twice (above) and Azure completes against the head it holds at that moment
    return finish(call(['repos', 'pr', 'update', '--id', pr, '--status', 'completed', ...(method === '--squash' ? ['--squash', 'true'] : method === '--rebase' ? ['--merge-strategy', 'rebase'] : []), ...(del !== '' ? ['--delete-source-branch', 'true'] : []), ...orgArgs], false));
  }
}
