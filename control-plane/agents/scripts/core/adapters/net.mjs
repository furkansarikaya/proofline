// @ts-check
// The Jira Cloud and Linear task-integration adapters in Node (stage 6B, A216; the former jira.sh and linear.sh). NOT TESTED against a real service:
// written to the adapter contract (task-integrations/README.md) and tested with a fake `fetch`. They use `fetch` (no curl, no jq). The credential is
// put into a request header and nowhere else: no argument list, no log, no error message ever holds it, and an HTTP failure reports only the status.
//   jira:   JIRA_BASE_URL (https), JIRA_EMAIL, JIRA_API_TOKEN       the task ID is the issue key
//   linear: LINEAR_API_KEY (and LINEAR_API_URL, https only)         the task ID is the issue identifier
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkId, die, importEngine, isFile, readText, sha, statusCheck, statusComment, usage } from './lib.mjs';

/** @typedef {import('./lib.mjs').Adapter} Adapter */

const TIMEOUT_MS = 30000;
const utf8 = (/** @type {string} */ s) => Buffer.from(s, 'latin1').toString('utf8'); // a byte string as the JS text the API takes
const bs = (/** @type {unknown} */ s) => Buffer.from(String(s ?? ''), 'utf8').toString('latin1'); // API text as a byte string

/** Does the text hold a character the shell adapters refused in a credential? @param {string} s */
const unsupported = (s) => s.includes('"') || s.includes('\\');

/**
 * One HTTP call: the parsed JSON (or the text) of a 2xx answer; any other answer or a transport error is an Error whose message holds the status only.
 * @param {Adapter} a @param {string} method @param {string} url @param {Record<string, string>} headers @param {unknown} [json]
 * @returns {Promise<any>}
 */
async function http(a, method, url, headers, json) {
  const f = a.fetch ?? fetch;
  let res;
  try {
    res = await f(url, { method, headers: { Accept: 'application/json', ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: json !== undefined ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch { throw new Error('the request failed'); }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return text === '' ? {} : JSON.parse(text); } catch { return text; }
}

/** The minimal ADF document: one paragraph per non-empty line. @param {string} text a JS text */
function adf(text) {
  return { type: 'doc', version: 1, content: text.split('\n').filter((l) => l.length > 0).map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })) };
}
/** The pull of a list. @param {unknown} x */
const arr = (x) => (Array.isArray(x) ? x : []);

// ---- Jira -----------------------------------------------------------------------------------------------------------------------

/** @param {Adapter} a @param {string[]} argv */
export async function runJira(a, argv) {
  const op = argv[0] ?? '';
  const n = argv.length;
  if (!['import', 'publish', 'verify', 'followup', 'status', 'statusblock'].includes(op)) usage(a, 'jira.sh <import|publish|verify|followup|status|statusblock> ...');
  const keyOk = (/** @type {string} */ k) => { checkId(a, k); if (!/^[A-Z].*-[0-9]/s.test(k)) die(a, `not a Jira issue key (expected PROJ-123): ${k}`); };
  const base = a.env.JIRA_BASE_URL ?? ''; const email = a.env.JIRA_EMAIL ?? ''; const token = a.env.JIRA_API_TOKEN ?? '';
  const ready = () => {
    if (base === '' || email === '' || token === '') die(a, 'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must be set');
    if (!base.startsWith('https://')) die(a, 'JIRA_BASE_URL must start with https://');
    if (unsupported(email + token)) die(a, 'JIRA_EMAIL / JIRA_API_TOKEN contain unsupported characters');
  };
  const auth = { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
  /** @param {string} method @param {string} p @param {unknown} [json] */
  const api = (method, p, json) => http(a, method, `${base.replace(/\/$/, '')}${p}`, auth, json);
  /** @param {string} key @param {string} state */
  const transition = async (key, state) => {
    const names = /** @type {Record<string, string>} */ ({ backlog: 'backlog', todo: 'to do', 'in-progress': 'in progress', done: 'done' });
    const tn = names[state];
    if (tn === undefined) die(a, `unknown status: ${state} (backlog|todo|in-progress|done)`);
    try {
      const t = await api('GET', `/rest/api/3/issue/${key}/transitions`);
      const hit = arr(t?.transitions).find((x) => String(x?.name ?? '').toLowerCase() === tn);
      if (!hit) return false;
      await api('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: String(hit.id) } });
      return true;
    } catch { return false; }
  };
  const id = argv[1];
  switch (op) {
    case 'import': {
      if (n !== 3) usage(a, 'jira.sh import <KEY-N> <out TASK.md>');
      keyOk(id); ready();
      let raw;
      try { raw = await api('GET', `/rest/api/2/issue/${id}?fields=summary,description,labels,components`); } catch { die(a, `cannot read issue ${id}`); }
      const f = raw?.fields ?? {};
      const desc = typeof f.description === 'string' ? f.description : f.description ? JSON.stringify(f.description) : '';
      const work = `## Description\n\n${bs(desc)}\n\n\n## Labels\n\n${arr(f.labels).map((l) => `- ${bs(l)}\n`).join('')}\n\n## Components\n\n${arr(f.components).map((c) => `- ${bs(c?.name)}\n`).join('')}`;
      const text = importEngine(a, 'jira', work, id, bs(f.summary), `jira ${base.replace(/\/$/, '')}/browse/${id}`);
      writeFileSync(path.resolve(a.cwd, argv[2]), text, 'latin1');
      return;
    }
    case 'publish': {
      if (n !== 3) usage(a, 'jira.sh publish <KEY-N> <report-file>');
      keyOk(id);
      const rep = isFile(argv[2]) ? readText(argv[2]) : null;
      if (rep === null) die(a, `report file missing: ${argv[2]}`);
      ready();
      const hash = sha(rep);
      try { await api('POST', `/rest/api/3/issue/${id}/comment`, { body: adf(utf8(`proofline-completion-report ${id} sha256:${hash}\n${rep}`)) }); } catch { die(a, `could not comment on ${id}`); }
      if (!(await transition(id, 'done'))) a.err(`${a.name}: report published, but the Done transition could not be applied to ${id}\n`);
      a.out(`${id}#${hash}\n`);
      return;
    }
    case 'verify': {
      if (n !== 3) usage(a, 'jira.sh verify <KEY-N> <receipt>');
      keyOk(id);
      let receipt = argv[2];
      if (isFile(receipt)) receipt = `${id}#${sha(readText(receipt) ?? '')}`;
      const at = receipt.indexOf('#');
      const want = at < 0 ? receipt : receipt.slice(at + 1);
      if (!(receipt.slice(0, at < 0 ? receipt.length : at) === id && want !== '' && want !== receipt)) die(a, `malformed receipt: ${receipt}`);
      ready();
      let text;
      try { text = JSON.stringify(await api('GET', `/rest/api/3/issue/${id}/comment?maxResults=1000`)); } catch { die(a, `no completion-report comment with that hash on ${id}`); }
      if (!text.includes(`proofline-completion-report ${id} sha256:${want}`)) die(a, `no completion-report comment with that hash on ${id}`);
      return;
    }
    case 'followup': {
      if (n !== 3) usage(a, 'jira.sh followup <KEY-N> <waiver-file>');
      keyOk(id);
      const wf = isFile(argv[2]) ? readText(argv[2]) : null;
      if (wf === null) die(a, `waiver file missing: ${argv[2]}`);
      ready();
      const h1 = wf.split('\n').find((l) => l.startsWith('# '));
      const title = h1 !== undefined ? h1.slice(2) : `Follow-up of ${id}`;
      let created;
      try { created = await api('POST', '/rest/api/3/issue', { fields: { project: { key: id.split('-')[0] }, summary: utf8(title), issuetype: { name: 'Task' }, description: adf(utf8(wf)) } }); } catch { die(a, 'could not create the follow-up issue'); }
      if (!created?.key) die(a, 'Jira returned no issue key');
      a.out(`${created.key}\n`);
      return;
    }
    case 'statusblock': {
      if (n !== 3) usage(a, 'jira.sh statusblock <KEY-N> <block-file>');
      keyOk(id);
      const block = statusCheck(a, id, argv[2]);
      ready();
      const payload = { body: adf(utf8(statusComment(id, block))) };
      // the marker text opens our comment: the newest comment whose body starts with it is edited in place (PUT); a new one only when there is none
      let cid = '';
      try {
        const c = await api('GET', `/rest/api/3/issue/${id}/comment?maxResults=1000`);
        const mine = arr(c?.comments).filter((x) => String(x?.body?.content?.[0]?.content?.[0]?.text ?? '').startsWith(`<!-- proofline:status:${id} -->`));
        cid = mine.length > 0 ? String(mine[mine.length - 1].id ?? '') : '';
      } catch { cid = ''; }
      if (/[^0-9]/.test(cid)) cid = '';
      if (cid !== '') { try { await api('PUT', `/rest/api/3/issue/${id}/comment/${cid}`, payload); } catch { die(a, `could not update the status comment on ${id}`); } } else { try { await api('POST', `/rest/api/3/issue/${id}/comment`, payload); } catch { die(a, `could not comment on ${id}`); } }
      return;
    }
    default: {
      if (n !== 3) usage(a, 'jira.sh status <KEY-N> <backlog|todo|in-progress|done>');
      keyOk(id); ready();
      if (!(await transition(id, argv[2]))) die(a, `no matching workflow transition for ${argv[2]} on ${id}`);
      a.out(`${argv[2]}\n`);
    }
  }
}

// ---- Linear ---------------------------------------------------------------------------------------------------------------------

/** @param {Adapter} a @param {string[]} argv */
export async function runLinear(a, argv) {
  const op = argv[0] ?? '';
  const n = argv.length;
  if (!['import', 'publish', 'verify', 'followup', 'status', 'statusblock'].includes(op)) usage(a, 'linear.sh <import|publish|verify|followup|status|statusblock> ...');
  const keyOk = (/** @type {string} */ k) => { checkId(a, k); if (!/^[A-Za-z].*-[0-9]/s.test(k)) die(a, `not a Linear issue identifier (expected TEAM-123): ${k}`); };
  const key = a.env.LINEAR_API_KEY ?? '';
  const url = a.env.LINEAR_API_URL || 'https://api.linear.app/graphql'; // an empty value is unset (the shell's :-)
  const ready = () => {
    if (key === '') die(a, 'LINEAR_API_KEY must be set');
    if (unsupported(key)) die(a, 'LINEAR_API_KEY contains unsupported characters');
    if (!url.startsWith('https://')) die(a, 'LINEAR_API_URL must start with https:// (the API key is sent there)');
  };
  /** the response data; fails on a transport error and on a GraphQL `errors` member. @param {string} query @param {Record<string, unknown>} variables @returns {Promise<any>} */
  const gql = async (query, variables) => {
    const r = await http(a, 'POST', url, { Authorization: key }, { query, variables });
    if (r === null || typeof r !== 'object' || r.errors !== undefined && r.errors !== null) throw new Error('GraphQL error');
    return r;
  };
  /** @param {string} id @param {string} state */
  const setState = async (id, state) => {
    const types = /** @type {Record<string, string>} */ ({ backlog: 'backlog', todo: 'unstarted', 'in-progress': 'started', done: 'completed' });
    const st = types[state];
    if (st === undefined) die(a, `unknown status: ${state} (backlog|todo|in-progress|done)`);
    try {
      const r = await gql('query($id:String!){issue(id:$id){team{states{nodes{id type}}}}}', { id });
      const hit = arr(r?.data?.issue?.team?.states?.nodes).find((x) => x?.type === st);
      if (!hit?.id) return false;
      await gql('mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}', { id, s: hit.id });
      return true;
    } catch { return false; }
  };
  const id = argv[1];
  switch (op) {
    case 'import': {
      if (n !== 3) usage(a, 'linear.sh import <TEAM-N> <out TASK.md>');
      keyOk(id); ready();
      let raw;
      try { raw = await gql('query($id:String!){issue(id:$id){title description url labels{nodes{name}}}}', { id }); } catch { die(a, `cannot read issue ${id}`); }
      const i = raw?.data?.issue ?? {};
      const work = `${bs(i.description)}\n\n\n## Labels\n\n${arr(i.labels?.nodes).map((l) => `- ${bs(l?.name)}\n`).join('')}`;
      const text = importEngine(a, 'linear', work, id, bs(i.title), `linear ${bs(i.url)}`);
      writeFileSync(path.resolve(a.cwd, argv[2]), text, 'latin1');
      return;
    }
    case 'publish': {
      if (n !== 3) usage(a, 'linear.sh publish <TEAM-N> <report-file>');
      keyOk(id);
      const rep = isFile(argv[2]) ? readText(argv[2]) : null;
      if (rep === null) die(a, `report file missing: ${argv[2]}`);
      ready();
      const hash = sha(rep);
      const text = `<!-- proofline:completion-report ${id} sha256:${hash} -->\n${rep.replace(/\n+$/, '')}`; // a command substitution drops the trailing newlines
      try { await gql('mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}', { i: id, b: utf8(text) }); } catch { die(a, `could not comment on ${id}`); }
      if (!(await setState(id, 'done'))) a.err(`${a.name}: report published, but the completed state could not be set on ${id}\n`);
      a.out(`${id}#${hash}\n`);
      return;
    }
    case 'verify': {
      if (n !== 3) usage(a, 'linear.sh verify <TEAM-N> <receipt>');
      keyOk(id);
      let receipt = argv[2];
      if (isFile(receipt)) receipt = `${id}#${sha(readText(receipt) ?? '')}`;
      const at = receipt.indexOf('#');
      const want = at < 0 ? receipt : receipt.slice(at + 1);
      if (!(receipt.slice(0, at < 0 ? receipt.length : at) === id && want !== '' && want !== receipt)) die(a, `malformed receipt: ${receipt}`);
      ready();
      let bodies = [];
      try { const r = await gql('query($id:String!){issue(id:$id){comments(first:250){nodes{body}}}}', { id }); bodies = arr(r?.data?.issue?.comments?.nodes).map((c) => String(c?.body ?? '')); } catch { bodies = []; }
      if (!bodies.some((b) => b.includes(`<!-- proofline:completion-report ${id} sha256:${want} -->`))) die(a, `no completion-report comment with that hash on ${id}`);
      return;
    }
    case 'followup': {
      if (n !== 3) usage(a, 'linear.sh followup <TEAM-N> <waiver-file>');
      keyOk(id);
      const wf = isFile(argv[2]) ? readText(argv[2]) : null;
      if (wf === null) die(a, `waiver file missing: ${argv[2]}`);
      ready();
      const h1 = wf.split('\n').find((l) => l.startsWith('# '));
      const title = h1 !== undefined ? h1.slice(2) : `Follow-up of ${id}`;
      let team = '';
      try { team = String((await gql('query($id:String!){issue(id:$id){team{id}}}', { id }))?.data?.issue?.team?.id ?? ''); } catch { die(a, `cannot read issue ${id}`); }
      if (team === '') die(a, `cannot resolve the team of ${id}`);
      let created = '';
      try { created = String((await gql('mutation($t:String!,$s:String!,$d:String!){issueCreate(input:{teamId:$t,title:$s,description:$d}){issue{identifier}}}', { t: team, s: utf8(title), d: utf8(wf) }))?.data?.issueCreate?.issue?.identifier ?? ''); } catch { die(a, 'could not create the follow-up issue'); }
      if (created === '') die(a, 'Linear returned no identifier');
      a.out(`${created}\n`);
      return;
    }
    case 'statusblock': {
      if (n !== 3) usage(a, 'linear.sh statusblock <TEAM-N> <block-file>');
      keyOk(id);
      const block = statusCheck(a, id, argv[2]);
      ready();
      const text = utf8(statusComment(id, block).replace(/\n+$/, ''));
      // the marker is the first line of our comment: the newest comment that starts with it is edited in place (commentUpdate); a new one only when there is none
      let cid = '';
      try {
        const r = await gql('query($id:String!){issue(id:$id){comments(first:250){nodes{id body}}}}', { id });
        const mine = arr(r?.data?.issue?.comments?.nodes).filter((c) => String(c?.body ?? '').startsWith(`<!-- proofline:status:${id} -->`));
        cid = mine.length > 0 ? String(mine[mine.length - 1].id ?? '') : '';
      } catch { cid = ''; }
      if (cid !== '') { try { await gql('mutation($i:String!,$b:String!){commentUpdate(id:$i,input:{body:$b}){success}}', { i: cid, b: text }); } catch { die(a, `could not update the status comment on ${id}`); } } else { try { await gql('mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}', { i: id, b: text }); } catch { die(a, `could not comment on ${id}`); } }
      return;
    }
    default: {
      if (n !== 3) usage(a, 'linear.sh status <TEAM-N> <backlog|todo|in-progress|done>');
      keyOk(id); ready();
      if (!(await setState(id, argv[2]))) die(a, `could not set ${argv[2]} on ${id}`);
      a.out(`${argv[2]}\n`);
    }
  }
}
