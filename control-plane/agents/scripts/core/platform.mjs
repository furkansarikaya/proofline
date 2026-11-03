// @ts-check
// The hosting platform of the project's remote (A180, A186), in Node (stage 6). Which pull request system a delivery talks to, which command line tool
// is installed for it and so who merges. Nothing here opens, merges or changes a pull request; `ciFailed` only reads. The platform tools (gh, glab, az)
// are started with an argument array (never a shell string), with stdin closed; their JSON is parsed in process (no jq). A tool that resolves into the
// project, the working directory or a temporary folder is refused (A180): no environment value lifts that (D14).
//   detect   platform, source, host, cli, merge, owner, repo_path, web          (`agent.sh platform`)
//   field    one value of detect, and local, org_url, project
//   link     the address that opens a pull request for BRANCH into BASE
//   env      GH_HOST / GITLAB_HOST for a private host
//   warn     one warning line when git.platform is set without git.platform_host for an origin that is not a known host of it
//   ciFailed the failed check of a pull request's head (A186)
import { accessSync, constants, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { asciiLower } from './shellglob.mjs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/**
 * @typedef {object} PlatformInfo
 * @property {string} platform github | gitlab | azure | bitbucket | other
 * @property {string} source config | env | auto
 * @property {string} host
 * @property {string} cli gh | glab | az | none
 * @property {string} merge cli | manual
 * @property {string} owner
 * @property {string} repoPath
 * @property {string} web
 * @property {boolean} local the origin is a local repository (a path or a file URL)
 * @property {string} orgUrl
 * @property {string} project
 * @property {boolean} loose git.platform without git.platform_host applies to an origin that is not a known host of it
 * @property {string} cfgPlatform
 * @property {string} url
 */

/** the text after the first slash @param {string} s */
const cutFirst = (s) => { const i = s.indexOf('/'); return i < 0 ? s : s.slice(i + 1); };
/** the text before the first slash @param {string} s */
const beforeFirst = (s) => { const i = s.indexOf('/'); return i < 0 ? s : s.slice(0, i); };
/** the text after the last slash @param {string} s */
const afterLast = (s) => { const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); };
/** the text after the last /_git/ segment @param {string} s */
const afterLastGit = (s) => { const i = s.lastIndexOf('/_git/'); return i < 0 ? s : s.slice(i + 6); };

/** The lower-case ASCII form of a string. @param {string} s */
const lower = asciiLower;

/**
 * `git.platform` and `git.platform_host` of the project's config, read without the agent.sh parser (the awk of platform.sh).
 * @param {string} file @returns {{ platform: string, host: string }}
 */
export function readPlatformConfig(file) {
  let text;
  try { text = readFileSync(file, 'latin1'); } catch { return { platform: '', host: '' }; }
  let inGit = false;
  /** @type {Record<string, string>} */ const found = {};
  for (const line of text.split('\n')) {
    if (/^[ \t\n\v\f\r]*#/.test(line) || /^[ \t\n\v\f\r]*$/.test(line)) continue;
    if (line.startsWith('git:')) { inGit = true; continue; }
    if (/^[^ \t\n\v\f\r]/.test(line)) inGit = false;
    const m = inGit ? /^[ \t\n\v\f\r]+(platform|platform_host):/.exec(line) : null;
    if (!m) continue;
    let v = line.replace(/^[^:]*:/, '').replace(/[ \t\n\v\f\r]+#.*$/, '').replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');
    if ((/^".*"$/.test(v) || /^'.*'$/.test(v)) && v.length >= 2) v = v.slice(1, -1);
    if (!(m[1] in found)) found[m[1]] = v;
  }
  return { platform: found.platform ?? '', host: lower(found.platform_host ?? '') };
}

/**
 * `command -v NAME` over the PATH of the environment: the first executable regular file, as the PATH entry spelled it.
 * @param {string} name @param {NodeJS.ProcessEnv} env @returns {string | null}
 */
function commandV(name, env) {
  if (name.includes('/')) return null;
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const entry of (env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const f = `${entry === '' ? '.' : entry}/${name}${ext}`;
      try {
        if (!statSync(f).isFile()) continue;
        accessSync(f, constants.X_OK);
        return f;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** @param {string} p */
function realOr(p) { try { return realpathSync(p); } catch { return p; } }

/** Is FILE inside the folder DIR? By text of the real paths and by (device, inode) of every ancestor of FILE. @param {string} file @param {string} dir */
function insideFolder(file, dir) {
  let ds;
  try { ds = statSync(dir); } catch { return false; }
  for (const d of new Set([dir, realOr(dir)])) if (file.startsWith(`${d}/`)) return true;
  for (let cur = path.dirname(file); ; cur = path.dirname(cur)) {
    try { const s = statSync(cur); if (s.dev === ds.dev && s.ino === ds.ino) return true; } catch { /* an ancestor that cannot be read is no match */ }
    if (cur === '/' || cur === '.' || cur === path.dirname(cur)) break;
  }
  return false;
}

/**
 * `deliver_cli_path NAME` (A180): the absolute real path of the platform tool, or a refusal text. The tool must come from an absolute PATH entry and must not
 * resolve into the project, the working directory or a temporary folder (a model could put a fake there). Same rule as `proofline merge`.
 * @param {Context} ctx @param {string} name @returns {{ path: string } | { unreadable: string }}
 */
export function resolveTool(ctx, name) {
  const r = resolveToolIn(ctx.env, name, [ctx.root, ctx.cwd, ctx.env.TMPDIR ?? '/nonexistent', '/tmp', '/var/folders', '/dev/shm']);
  if ('path' in r) return r;
  return 'shadowed' in r ? { unreadable: `unreadable (${name} at ${r.shadowed} may be shadowed)` } : r;
}

/**
 * The tool NAME found first on the PATH of ENV, as its real absolute path, unless that is inside one of the folders DIRS (compared by folder identity, see
 * insideFolder). `{ shadowed: path }` for a tool inside one of them, `{ unreadable }` for none or a relative match.
 * @param {NodeJS.ProcessEnv} env @param {string} name @param {string[]} dirs @returns {{ path: string } | { shadowed: string } | { unreadable: string }}
 */
export function resolveToolIn(env, name, dirs) {
  const found = commandV(name, env);
  if (found === null || !found.startsWith('/')) return { unreadable: 'unreadable' };
  let g = found;
  for (let n = 0; n < 20; n++) {
    let l;
    try { l = readlinkSync(g); } catch { break; }
    g = l.startsWith('/') ? l : `${path.dirname(g)}/${l}`;
  }
  try { g = `${realpathSync.native(path.dirname(g))}/${path.basename(g)}`; } catch { return { unreadable: 'unreadable' }; }
  for (const d of dirs) if (insideFolder(g, d)) return { shadowed: g };
  return { path: g };
}

/**
 * The platform of the origin remote (or of URL). Reads the config of the repository that holds DIR (default the project root).
 * @param {Context} ctx @param {{ url?: string, dir?: string }} [opt] @returns {PlatformInfo}
 */
export function detectPlatform(ctx, opt = {}) {
  const dir = opt.dir ?? ctx.root;
  const g = (/** @type {string[]} */ a) => proc.run('git', ['-C', dir, ...a], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  let url = opt.url ?? '';
  if (url === '') { const r = g(['remote', 'get-url', 'origin']); url = r.status === 0 ? r.stdout.toString('latin1').replace(/\n+$/, '') : ''; }
  let hp = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^[^@/]*@/, '').replace(/^([^/:]*):[0-9]+\//, '$1/').replace(/^([^/:]*):/, '$1/').replace(/\/*$/, '').replace(/\.git$/, '');
  let local = false;
  // a local path starts with / ./ or ../ (or is . or ..), a file URL with file:/// (an empty host); `.evil.example:org/repo` and file://host/path are not local
  if (/^(\/|\.\/|\.\.\/)/.test(url) || url === '.' || url === '..' || url.startsWith('file:///')) { hp = ''; local = true; }
  if (url !== '' && !local && !/^-|:|@/.test(url)) {
    // a bare name that is a folder next to the main working tree (git accepts it as a path)
    const wl = g(['worktree', 'list', '--porcelain']).stdout.toString('latin1').split('\n')[0] ?? '';
    const mb = wl.startsWith('worktree ') && wl.length > 9 ? wl.slice(9) : dir;
    try { if (statSync(`${mb}/${url}`).isDirectory()) { hp = ''; local = true; } } catch { /* not a folder */ }
  }
  let host = beforeFirst(hp);
  let p = cutFirst(hp);
  if (hp === host) p = '';
  host = lower(host);
  let platform = 'other';
  let owner = ''; let org = ''; let orgUrl = ''; let proj = ''; let repo = ''; let web = ''; let src = 'auto';
  // exact hosts only: a look-alike (github.com.evil.example) or a self-hosted name is `other` unless git.platform or PROOFLINE_PLATFORM names it
  if (host === 'github.com' || host === 'www.github.com') platform = 'github';
  else if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) platform = 'azure';
  else if (host === 'bitbucket.org') platform = 'bitbucket';
  else if (host === 'gitlab.com') platform = 'gitlab';
  if (host === '' || p === '') platform = 'other';
  const autoPlatform = platform;
  // config (A186)
  // the project's own root is the top of its working tree: no git call to ask (a caller that names another directory, `cli platform-info`, still asks)
  let top = '';
  if (opt.dir === undefined) top = ctx.root;
  else { const topR = g(['rev-parse', '--show-toplevel']); top = topR.status === 0 ? topR.stdout.toString('latin1').replace(/\n+$/, '') : ''; }
  const cfg = top !== '' ? readPlatformConfig(`${top}/.agents/config.yaml`) : { platform: '', host: '' };
  const KNOWN = ['github', 'gitlab', 'azure', 'bitbucket', 'other'];
  const envPlatform = ctx.env.PROOFLINE_PLATFORM ?? '';
  if (KNOWN.includes(envPlatform)) { platform = envPlatform; src = 'env'; }
  if (KNOWN.includes(cfg.platform) && (cfg.host === '' || (host !== '' && host === cfg.host))) { platform = cfg.platform; src = 'config'; }
  // A185: git.platform without git.platform_host applies to ANY origin; untrusted when the host is not an exact known host of that platform
  const loose = src === 'config' && cfg.host === '' && cfg.platform !== 'other' && autoPlatform !== cfg.platform;
  if (platform === 'azure') {
    if (host.endsWith('.visualstudio.com')) {
      org = beforeFirst(host.replace('.', '/'));
      let q = p;
      if (q.startsWith('v3/')) { q = q.slice(3); org = beforeFirst(q); q = cutFirst(q); proj = beforeFirst(q); repo = cutFirst(q); }
      else { q = q.replace(/^DefaultCollection\//, ''); proj = beforeFirst(q); repo = afterLastGit(q); }
      orgUrl = `https://${host}`;
    } else if (host === 'ssh.dev.azure.com') {
      let q = p.startsWith('v3/') ? p.slice(3) : p;
      org = beforeFirst(q); q = cutFirst(q); proj = beforeFirst(q); repo = cutFirst(q); orgUrl = `https://dev.azure.com/${org}`;
    } else if (host === 'dev.azure.com') {
      org = beforeFirst(p); const q = cutFirst(p); proj = beforeFirst(q); repo = afterLastGit(q); orgUrl = `https://dev.azure.com/${org}`;
    } else if (p.includes('/_git/')) {
      // Azure DevOps Server: host/<collection path>/<project>/_git/<repo>; the organization URL is https://host/<collection path>
      const before = p.slice(0, p.indexOf('/_git/'));
      repo = afterLastGit(p); proj = afterLast(before);
      org = before.includes('/') ? before.slice(0, before.lastIndexOf('/')) : '';
      if (org !== '') orgUrl = `https://${host}/${org}`;
    }
    owner = org;
    web = `https://dev.azure.com/${org}/${proj}/_git/${repo}`;
    if (!(host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com'))) web = `https://${host}/${org}/${proj}/_git/${repo}`;
  } else {
    owner = beforeFirst(p); repo = afterLast(p);
    web = host === '' || p === '' ? '' : `https://${host}/${p}`;
  }
  if (src === 'auto') {
    // an Azure URL that did not parse is not trusted: the manual path with the remote as it is
    if (platform === 'azure' && (org === '' || proj === '' || repo === '')) { platform = 'other'; owner = ''; web = ''; }
    if (platform === 'github' && owner === '') platform = 'other';
  }
  let cli = 'none';
  if (platform === 'github' && commandV('gh', ctx.env) !== null) cli = 'gh';
  else if (platform === 'gitlab' && commandV('glab', ctx.env) !== null) cli = 'glab';
  else if (platform === 'azure' && commandV('az', ctx.env) !== null) cli = 'az';
  let merge = cli === 'none' ? 'manual' : 'cli';
  if (platform === 'bitbucket' || platform === 'other') merge = 'manual';
  return { platform, source: src, host, cli, merge, owner, repoPath: p, web, local, orgUrl, project: proj, loose, cfgPlatform: cfg.platform, url };
}

/** The key: value lines of `platform.sh detect`. @param {PlatformInfo} i */
export function detectText(i) {
  return `platform: ${i.platform}\nsource: ${i.source}\nhost: ${i.host}\ncli: ${i.cli}\nmerge: ${i.merge}\nowner: ${i.owner}\nrepo_path: ${i.repoPath}\nweb: ${i.web}\n`;
}

/** One value of the platform (`platform.sh field KEY`); null for an unknown key. @param {PlatformInfo} i @param {string} key @returns {string | null} */
export function fieldOf(i, key) {
  switch (key) {
    case 'platform': return i.platform; case 'cli': return i.cli; case 'merge': return i.merge; case 'owner': return i.owner;
    case 'repo_path': return i.repoPath; case 'web': return i.web; case 'local': return i.local ? 'yes' : 'no'; case 'source': return i.source;
    case 'host': return i.host; case 'org_url': return i.orgUrl; case 'project': return i.project;
    default: return null;
  }
}

/** The address that opens a pull request for BRANCH into BASE. @param {PlatformInfo} i @param {string} br @param {string} base */
export function linkText(i, br, base) {
  switch (i.platform) {
    case 'github': return `${i.web}/compare/${base}...${br}?expand=1`;
    case 'gitlab': return `${i.web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${br}&merge_request%5Btarget_branch%5D=${base}`;
    case 'azure': return `${i.web}/pullrequestcreate?sourceRef=${br}&targetRef=${base}`;
    case 'bitbucket': return `${i.web}/pull-requests/new?source=${br}&dest=${base}`;
    default: return i.web !== '' ? i.web : `(the remote ${i.url !== '' ? i.url : 'origin'} is not a web address: open a pull request or merge request for ${br} into ${base} in your hosting service)`;
  }
}

/** `platform.sh env`: GH_HOST or GITLAB_HOST for a private host, else nothing. @param {PlatformInfo} i @returns {Record<string, string>} */
export function platformEnv(i) {
  if (i.loose) return {};
  if (i.host === '' || /[^a-z0-9.-]/.test(i.host)) return {};
  if (i.platform === 'github' && i.host !== 'github.com' && i.host !== 'www.github.com') return { GH_HOST: i.host };
  if (i.platform === 'gitlab' && i.host !== 'gitlab.com') return { GITLAB_HOST: i.host };
  return {};
}

/** `platform.sh warn` @param {PlatformInfo} i */
export function warnText(i) {
  if (!i.loose) return '';
  return `warning: git.platform is ${i.cfgPlatform} without git.platform_host, and the origin host (${i.host !== '' ? i.host : 'none'}) is not a known ${i.cfgPlatform} host, so the setting applies to whatever the origin is; set git.platform_host to the exact host name of the origin in .agents/config.yaml (proofline then also exports no host variable for it until you do)\n`;
}

// ---- the tools --------------------------------------------------------------------------------------------------------------

const TOOL_TIMEOUT_MS = 180000;

/**
 * One call of a platform tool: an argument array, stdin closed, the environment of the control plane plus the private-host variables. Returns the
 * exit status and the output; stderr is dropped unless `merge` (the shell's 2>&1).
 * @param {Context} ctx @param {PlatformInfo} info @param {string} tool @param {string[]} args @param {boolean} [merge]
 */
export function runTool(ctx, info, tool, args, merge = false) {
  const r = proc.run(tool, args, { cwd: ctx.root, env: { ...ctx.childEnv(), ...platformEnv(info) }, input: '', stdio: ['pipe', 'pipe', merge ? 'pipe' : 'ignore'], timeoutMs: TOOL_TIMEOUT_MS });
  return { status: r.status, out: r.stdout.toString('latin1'), err: r.stderr.toString('latin1') };
}

/** JSON.parse that returns undefined for text that is not JSON. @param {string} t @returns {any} */
export function parseJson(t) { try { return JSON.parse(t); } catch { return undefined; } }

/** `pf_clean N`: one line of plain characters (a name or a status from a CI system is data). @param {string} s @param {number} n */
function clean(s, n) { return s.replace(/[^A-Za-z0-9 ._/=()#:-]/g, ' ').replace(/ +/g, ' ').slice(0, n); }

/** A failed check whose log could not be read: name and status only, said in the log text. @param {PlatformInfo} i @param {string} id @param {string} name @param {string} status @param {string} why */
function noLog(i, id, name, status, why) {
  return `RED\t${id}\t${clean(name, 80)}\t${clean(status, 30)}\tnone\nLOG\ncheck ${clean(name, 80)}: ${clean(status, 30)}. The log could not be read here (${why}); this round starts from the check name and status only: open the check in ${i.web !== '' ? i.web : 'the hosting service'} for its output.\n`;
}

/** `$(...)`: the output without trailing newlines. @param {string} s */
const sub = (s) => s.replace(/\n+$/, '');

/**
 * The failed check of the head of a pull request (A186), per platform. Prints nothing when no failed check is readable, else
 * `RED<TAB>run or job id, or -<TAB>check name<TAB>status<TAB>read|none`, a `LOG` line and the log text. Every failure leaves the log unread, never stops.
 * @param {Context} ctx @param {PlatformInfo} info @param {string} pr @param {string} sha @param {string} cli the absolute path of the tool
 */
export function ciFailed(ctx, info, pr, sha, cli) {
  if (!/^[0-9]+$/.test(pr) || !/^[0-9a-f]+$/.test(sha)) return '';
  const call = (/** @type {string[]} */ a, merge = false) => runTool(ctx, info, cli, a, merge);
  if (info.platform === 'github') {
    const runs = call(['run', 'list', '--commit', sha, '--limit', '30', '--json', 'databaseId,status,conclusion,name']);
    const list = runs.status === 0 ? parseJson(runs.out) : undefined;
    const bad = Array.isArray(list) ? list.find((r) => r && r.status === 'completed' && ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion)) : undefined;
    if (bad) {
      const id = String(bad.databaseId ?? '');
      const name = String(bad.name ?? '');
      const cc = String(bad.conclusion);
      if (!/^[0-9]+$/.test(id)) return '';
      const log = call(['run', 'view', id, '--log-failed'], true);
      if (log.status === 0 && log.out !== '') return `RED\t${id}\t${clean(name, 80)}\t${cc}\tread\nLOG\n${sub(log.out)}\n`;
      return noLog(info, id, name, cc, 'gh run view --log-failed gave no log');
    }
    const checks = call(['pr', 'checks', pr]);
    const rows = checks.out.split('\n').map((l) => l.split('\t')).filter((f) => f[1] === 'fail').map((f) => `${f[0]}: fail ${f[3] ?? ''}`);
    if (rows.length === 0) return '';
    const nm = rows[0].split(':')[0];
    return `RED\t-\t${clean(nm, 80)}\tfail\tread\nLOG\n${rows.join('\n')}\n`;
  }
  if (info.platform === 'gitlab') {
    const view = call(['mr', 'view', pr, '-F', 'json']);
    if (view.status !== 0) return '';
    const j = parseJson(view.out);
    const pl = j?.head_pipeline ?? j?.pipeline ?? null;
    if (!pl) return '';
    const pid = pl.id === undefined || pl.id === null ? '' : String(pl.id);
    if (!/^[0-9]+$/.test(pid) || String(pl.status ?? '-') !== 'failed') return '';
    const jobs = call(['api', `projects/:id/pipelines/${pid}/jobs?scope[]=failed&per_page=20`]);
    const arr = parseJson(jobs.out);
    const job = Array.isArray(arr) ? arr.find((x) => x && x.allow_failure !== true) : undefined;
    if (!job) return noLog(info, pid, `pipeline ${pid}`, 'failed', 'no failed job could be read');
    const jid = String(job.id ?? '');
    if (!/^[0-9]+$/.test(jid)) return noLog(info, pid, `pipeline ${pid}`, 'failed', 'no failed job could be read');
    const trace = call(['ci', 'trace', jid], true);
    if (trace.status === 0 && trace.out !== '') return `RED\t${jid}\t${clean(String(job.name ?? ''), 80)}\t${clean(String(job.status ?? ''), 30)}\tread\nLOG\n${sub(trace.out)}\n`;
    return noLog(info, jid, String(job.name ?? ''), String(job.status ?? ''), 'glab ci trace gave no log');
  }
  if (info.platform === 'azure') {
    if (info.orgUrl === '') return '';
    const pol = call(['repos', 'pr', 'policy', 'list', '--id', pr, '--org', info.orgUrl, '-o', 'json']);
    if (pol.status !== 0) return '';
    const arr = parseJson(pol.out);
    const hit = Array.isArray(arr) ? arr.find((x) => x && (x.status === 'rejected' || x.status === 'broken') && x.context?.buildId !== undefined && x.context.buildId !== null && x.context.buildId !== '' && x.context.buildId !== false) : undefined;
    if (!hit) return '';
    const bid = String(hit.context.buildId);
    if (!/^[0-9]+$/.test(bid)) return '';
    const bname = String(hit.configuration?.settings?.displayName ?? hit.configuration?.type?.displayName ?? 'build policy');
    const bstatus = String(hit.status);
    // the messages the build recorded for its failed tasks (build timeline); the raw task logs are not read
    const tl = call(['devops', 'invoke', '--area', 'build', '--resource', 'timeline', '--route-parameters', `project=${info.project}`, `buildId=${bid}`, '--org', info.orgUrl, '--api-version', '7.0', '-o', 'json']);
    const recs = tl.status === 0 ? parseJson(tl.out)?.records : undefined;
    /** @type {string[]} */ const lines = [];
    if (Array.isArray(recs)) {
      for (const r of recs) {
        if (!r || (r.result !== 'failed' && r.result !== 'canceled')) continue;
        for (const is of Array.isArray(r.issues) ? r.issues : []) if (is && is.type === 'error') lines.push(`${r.name ?? 'task'}: ${is.message ?? ''}`);
      }
    }
    if (lines.length > 0) return `RED\t${bid}\t${clean(bname, 80)}\t${clean(bstatus, 30)}\tread\nLOG\n${lines.join('\n')}\n`;
    return noLog(info, bid, bname, bstatus, 'az devops invoke gave no task errors');
  }
  return '';
}
