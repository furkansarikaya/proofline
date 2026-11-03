// @ts-check
// The GitHub Issues task-integration adapter in Node (stage 6B, A216; the former task-integrations/github.sh). Only the `gh` CLI is used (through an
// argument array, JSON read in process); no token is read, stored or logged here: authentication is gh's own. The task ID of a run is GH-<issue number>.
//   import <N|#N|GH-N|issue-url|owner/repo#N> <out> | publish <GH-N> <report> | verify <GH-N> <receipt|report> | followup <GH-N> <waiver-file>
//   status <GH-N> <backlog|todo|in-progress|done> | statusblock <GH-N> <block-file>
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { die, importEngine, isFile, readText, sha, statusCheck, statusComment, usage } from './lib.mjs';

/** @typedef {import('./lib.mjs').Adapter} Adapter */
/** @typedef {{ status: number, out: string, err: string }} ToolResult */
/** @typedef {Adapter & { gh: (args: string[]) => ToolResult | null }} GhAdapter gh returns null when the tool is not usable */

/** @param {unknown} t */
const parse = (t) => { try { return JSON.parse(String(t)); } catch { return undefined; } };

/** One run of the adapter. @param {GhAdapter} a @param {string[]} argv */
export function runGithub(a, argv) {
  const op = argv[0] ?? '';
  const n = argv.length;
  if (!['import', 'publish', 'verify', 'followup', 'status', 'statusblock'].includes(op)) usage(a, 'github.sh <import|publish|verify|followup|status|statusblock> ...');
  let ghRepo = '';
  /** @param {string[]} args @returns {ToolResult} */
  const ghr = (args) => {
    const r = a.gh(ghRepo !== '' ? [...args, '--repo', ghRepo] : args);
    return r ?? { status: 127, out: '', err: '' };
  };
  const ready = () => {
    if (a.gh(['--version']) === null) die(a, 'the gh CLI is not installed (https://cli.github.com); nothing was changed');
    if ((a.gh(['auth', 'status']) ?? { status: 1 }).status !== 0) die(a, "gh is not authenticated; run 'gh auth login' (this adapter never handles tokens); nothing was changed");
  };
  /** sets ghRepo; returns the issue number. @param {string} ref0 */
  const ref = (ref0) => {
    ghRepo = '';
    let gn;
    let m;
    if ((m = /^https:\/\/github\.com\/(.*)\/issues\/([0-9][^]*)$/.exec(ref0)) && m[1].includes('/')) { ghRepo = m[1]; gn = m[2].replace(/[^0-9].*$/, ''); }
    else if ((m = /^(.*\/.*)#([0-9].*)$/.exec(ref0))) { ghRepo = m[1].replace(/#.*/, ''); gn = ref0.slice(ref0.lastIndexOf('#') + 1); }
    else if (/^GH-[0-9]/.test(ref0)) gn = ref0.slice(3);
    else if (/^#[0-9]/.test(ref0)) gn = ref0.slice(1);
    else gn = ref0;
    if (gn === '' || /[^0-9]/.test(gn)) die(a, `not a GitHub issue reference (expected N, #N, GH-N, an issue URL or owner/repo#N): ${ref0}`);
    return gn;
  };
  /** the run task ID (GH-<n> only). @param {string} id */
  const idNumber = (id) => { if (!/^GH-[0-9]/.test(id)) die(a, `task id must be GH-<issue number>: ${id}`); return ref(id); };
  /** exactly one proofline:<state> label. @param {string} num @param {string} state */
  const setState = (num, state) => {
    const v = ghr(['issue', 'view', num, '--json', 'labels']);
    const j = v.status === 0 ? parse(v.out) : undefined;
    if (!j) return false;
    const have = (Array.isArray(j.labels) ? j.labels : []).map((/** @type {{ name: string }} */ l) => l.name);
    const rm = have.filter((/** @type {string} */ l) => l.startsWith('proofline:') && l !== `proofline:${state}`).join(',');
    if (have.includes(`proofline:${state}`)) { if (rm === '') return true; return ghr(['issue', 'edit', num, '--remove-label', rm]).status === 0; }
    return ghr(['issue', 'edit', num, '--add-label', `proofline:${state}`, ...(rm !== '' ? ['--remove-label', rm] : [])]).status === 0;
  };
  /** comment on the issue, editing our own earlier comment (found by the start of its body) in place. @param {string} num @param {string} id @param {string} startsWith @param {string} text */
  const upsertComment = (num, id, startsWith, text) => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'gh-comment.'));
    try {
      const file = `${tmp}/body`;
      writeFileSync(file, text, 'latin1');
      const v = ghr(['issue', 'view', num, '--json', 'comments']);
      const j = v.status === 0 ? parse(v.out) : undefined;
      const mine = (Array.isArray(j?.comments) ? j.comments : []).filter((/** @type {{ body: string }} */ c) => String(c.body).startsWith(startsWith));
      const last = mine.length > 0 ? mine[mine.length - 1] : null;
      const cid = last ? String(last.url ?? '').replace(/^.*#issuecomment-/, '') : '';
      const slug = ghRepo !== '' ? ghRepo : '{owner}/{repo}';
      if (/^[0-9]+$/.test(cid) && a.gh(['api', '-X', 'PATCH', `repos/${slug}/issues/comments/${cid}`, '-F', `body=@${file}`])?.status === 0) return;
      if (ghr(['issue', 'comment', num, '--body-file', file]).status !== 0) die(a, `could not comment on issue ${num}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  };

  switch (op) {
    case 'import': {
      if (n !== 3) usage(a, 'github.sh import <N|#N|GH-N|issue-url|owner/repo#N> <out TASK.md>');
      ready();
      const num = ref(argv[1]);
      const v = ghr(['issue', 'view', num, '--json', 'title,url,body,labels']);
      const j = v.status === 0 ? parse(v.out) : undefined;
      if (!j) die(a, `cannot read issue ${num}`);
      let work = `${Buffer.from(String(j.body ?? ''), 'utf8').toString('latin1')}\n`;
      const labels = (Array.isArray(j.labels) ? j.labels : []).map((/** @type {{ name: string }} */ l) => Buffer.from(l.name, 'utf8').toString('latin1'));
      if (labels.length > 0 && !/^#+[ \t\n\v\f\r]+labels[ \t\n\v\f\r]*$/im.test(work)) work += `\n\n## Labels\n\n${labels.map((/** @type {string} */ l) => `- ${l}\n`).join('')}`;
      const text = importEngine(a, 'github', work, `GH-${num}`, Buffer.from(String(j.title ?? ''), 'utf8').toString('latin1'), `github ${j.url}`);
      writeFileSync(path.resolve(a.cwd, argv[2]), text, 'latin1');
      return;
    }
    case 'publish': {
      if (n !== 3) usage(a, 'github.sh publish <GH-N> <report-file>');
      const id = argv[1];
      const num = idNumber(id);
      const rep = isFile(argv[2]) ? readText(argv[2]) : null;
      if (rep === null) die(a, `report file missing: ${argv[2]}`);
      ready();
      const hash = sha(rep);
      // idempotent: edit our earlier report comment (marker prefix) in place; comment anew only when there is none
      upsertComment(num, id, `<!-- proofline:completion-report:${id} `, `<!-- proofline:completion-report:${id} sha256:${hash} -->\n${rep}`);
      if (!setState(num, 'done')) a.err(`${a.name}: report published, but the proofline:done label could not be set on issue ${num}\n`);
      a.out(`${num}#${hash}\n`);
      return;
    }
    case 'verify': {
      if (n !== 3) usage(a, 'github.sh verify <GH-N> <receipt>');
      const id = argv[1];
      const num = idNumber(id);
      let receipt = argv[2];
      if (isFile(receipt)) receipt = `${num}#${sha(readText(receipt) ?? '')}`;
      const at = receipt.indexOf('#');
      const want = at < 0 ? receipt : receipt.slice(at + 1);
      if (!(receipt.slice(0, at < 0 ? receipt.length : at) === num && want !== '' && want !== receipt)) die(a, `malformed receipt: ${receipt}`);
      ready();
      const v = ghr(['issue', 'view', num, '--json', 'comments']);
      const j = v.status === 0 ? parse(v.out) : undefined;
      const bodies = (Array.isArray(j?.comments) ? j.comments : []).map((/** @type {{ body: string }} */ c) => String(c.body));
      if (!bodies.some((b) => b.includes(`<!-- proofline:completion-report:${id} sha256:${want} -->`))) die(a, `no completion-report comment with that hash on issue ${num}`);
      return;
    }
    case 'followup': {
      if (n !== 3) usage(a, 'github.sh followup <GH-N> <waiver-file>');
      const id = argv[1];
      idNumber(id);
      const wf = isFile(argv[2]) ? readText(argv[2]) : null;
      if (wf === null) die(a, `waiver file missing: ${argv[2]}`);
      ready();
      const h1 = wf.split('\n').find((l) => l.startsWith('# '));
      const title = h1 !== undefined ? h1.slice(2) : `Follow-up of ${id}`;
      const r = ghr(['issue', 'create', '--title', Buffer.from(title, 'latin1').toString('utf8'), '--body-file', argv[2]]);
      if (r.err !== '') a.err(Buffer.from(r.err, 'utf8').toString('latin1')); // what gh says (the shell adapter let it through)
      if (r.status !== 0) die(a, 'could not create the follow-up issue');
      a.out(Buffer.from(r.out, 'utf8').toString('latin1'));
      return;
    }
    case 'statusblock': {
      if (n !== 3) usage(a, 'github.sh statusblock <GH-N> <block-file>');
      const id = argv[1];
      const num = idNumber(id);
      const block = statusCheck(a, id, argv[2]);
      ready();
      // the marker is the first line of our comment: the newest comment that starts with it is edited in place; comment anew only when there is none
      upsertComment(num, id, `<!-- proofline:status:${id} -->`, statusComment(id, block));
      return;
    }
    default: { // status
      if (n !== 3) usage(a, 'github.sh status <GH-N> <backlog|todo|in-progress|done>');
      const num = idNumber(argv[1]);
      if (!['backlog', 'todo', 'in-progress', 'done'].includes(argv[2])) die(a, `unknown status: ${argv[2]} (backlog|todo|in-progress|done)`);
      ready();
      if (!setState(num, argv[2])) die(a, `could not update labels on issue ${num}`);
      a.out(`${argv[2]}\n`);
    }
  }
}
