// @ts-check
// Verification commands for a project whose commands.build|test|lint are empty (A200, A230; the former bin/lib/commands.sh). An empty key is no reason to wait: the
// commands are discovered from the project, proven by running each once, and proposed with ONE question. The user's yes writes only the proven ones. A command that was
// not proven (a trial run that failed, or one with shell operators that a trial run would execute unchecked) is never written.
//   proofline doctor --commands          discover, prove, record the proposal (.agents/local/commands/PROPOSAL.tsv) and ask
//   proofline doctor --apply-commands    write the proposal after the user's yes (`commands-check` decides, from the user's own message or from a batch approval whose
//                                        summary names this proposal)
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { agentCall } from './batch.mjs';
import { cfgCmds, cfgSet } from './configset.mjs';
import { KINDS, discoverCommands, verifyCommands } from './discover.mjs';
import { ProoflineError } from './errors.mjs';
import { sha256File } from './hash.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The folder of the proposal. @param {Context} ctx */
const dirOf = (ctx) => `${ctx.root}/.agents/local/commands`;
/** @param {Context} ctx */
const configOf = (ctx) => `${ctx.root}/.agents/config.yaml`;
/** `proofline: MSG`, status 1 (the front end appends the user's next step). @param {string} msg */
const die = (msg) => new ProoflineError(`proofline: ${msg}`, 1);

/** `cm_empty`: the commands keys that are empty in the config, in order. @param {Context} ctx @returns {string[]} */
export function emptyKinds(ctx) { return KINDS.filter((k) => cfgCmds(configOf(ctx), `commands.${k}`).length === 0); }

/** Say a line now (a trial run takes long, so the report is not held back). @param {Context} ctx @param {string} line */
function say(ctx, line) { ctx.out(`${line}\n`); ctx.flush(); }

/** A command of this core in process, its output relayed. @param {Context} ctx @param {string[]} argv */
function call(ctx, argv) {
  const r = agentCall(ctx, argv);
  return r;
}

/** `cm_propose`. @param {Context} ctx @returns {number} */
export function proposeCommands(ctx) {
  const empty = emptyKinds(ctx);
  if (empty.length === 0) { say(ctx, 'commands: build, test and lint are configured'); return 0; }
  const found = discoverCommands(ctx.root);
  const dir = dirOf(ctx);
  mkdirSync(dir, { recursive: true });
  const proposal = `${dir}/PROPOSAL.tsv`;
  // only the empty keys are proposed; a configured key is never touched
  /** @type {Record<string, string[]>} */ const cmds = { build: [], test: [], lint: [] };
  for (const k of empty) cmds[k] = found[/** @type {'build' | 'test' | 'lint'} */ (k)].filter((c) => c !== '');
  if (empty.every((k) => cmds[k].length === 0)) {
    rmSync(proposal, { force: true });
    say(ctx, `commands: empty in .agents/config.yaml:${empty.map((k) => ` ${k}`).join('')}, and nothing could be discovered from this project; set them by hand (commands.build, commands.test, commands.lint)`);
    return 0;
  }
  say(ctx, 'proving the discovered commands, one run each...');
  const kept = verifyCommands(ctx.root, { build: cmds.build, test: cmds.test, lint: cmds.lint }, (l) => say(ctx, l), { env: ctx.env });
  // no time is written into the proposal: freshness is the approval request's own requested_at (A200 review)
  const rows = empty.flatMap((k) => kept[/** @type {'build' | 'test' | 'lint'} */ (k)].map((c) => `${k}\t${c}\n`));
  if (rows.length === 0) {
    rmSync(proposal, { force: true });
    say(ctx, "commands: none of the discovered commands could be proven (a failed trial run is not written): fix the project's build, or set commands.* by hand");
    return 0;
  }
  const tmp = `${proposal}.${process.pid}.tmp`;
  writeFileSync(tmp, rows.join(''));
  renameSync(tmp, proposal);
  say(ctx, '');
  say(ctx, `commands proposal ${sha256File(proposal).slice(0, 12)} (each command ran once and passed):`);
  for (const r of rows) { const [k, ...c] = r.slice(0, -1).split('\t'); say(ctx, `  commands.${k}: ${c.join('\t')}`); }
  say(ctx, 'QUESTION (one): write these into .agents/config.yaml? Reply "approve commands". Nothing is written without your reply.');
  // the question is also a normal approval request of the kind `commands`, bound to the sha256 of this file; the user's reply records it
  const r = call(ctx, ['request-approval', '-', 'commands']);
  ctx.out(r.out); ctx.err(r.err);
  if (r.status !== 0) say(ctx, '(the approval request could not be recorded: run agent.sh request-approval - commands)');
  say(ctx, '  in a night batch the summary names this proposal and your batch approval covers it (A200); then: proofline doctor --apply-commands');
  return 0;
}

/** `cm_apply`: write the proposal when `commands-check` says the user agreed. @param {Context} ctx @returns {number} */
export function applyCommands(ctx) {
  const proposal = `${dirOf(ctx)}/PROPOSAL.tsv`;
  let ok = false;
  try { ok = statSync(proposal).size > 0; } catch { ok = false; }
  if (!ok) throw die('doctor --apply-commands: no commands proposal (run: proofline doctor --commands)');
  const chk = call(ctx, ['commands-check']);
  ctx.err(chk.err);
  if (chk.status !== 0) throw die('doctor --apply-commands: the user has not agreed to this proposal yet; ask the one question and wait for the reply');
  // the approval is used up before anything is written: a replay of the same proposal needs a new request and a new reply. A user approval that cannot be consumed
  // refuses the apply; a batch-covered proposal has no commands approval to consume (it can be regenerated and re-applied; harmless, the batch approval covered that exact content).
  if (chk.out.includes('approved by the user')) {
    if (call(ctx, ['approval-consume', '-', 'commands']).status !== 0) throw die('doctor --apply-commands: the commands approval could not be consumed, so nothing was written');
  }
  const rows = readFileSync(proposal, 'latin1').split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split('\t'));
  for (const k of KINDS) {
    const v = rows.filter((r) => r[0] === k).map((r) => r[1] ?? '').join('\n');
    if (v === '') continue;
    if (cfgCmds(configOf(ctx), `commands.${k}`).length > 0) { say(ctx, `commands.${k} is configured now; left as it is`); continue; }
    if (!cfgSet(configOf(ctx), `commands.${k}`, v)) throw die(`config key not set: commands.${k}`);
    say(ctx, `wrote commands.${k}: ${v.replace(/\n/g, ';')}`);
  }
  renameSync(proposal, `${dirOf(ctx)}/applied-${Math.floor(Date.now() / 1000)}.tsv`);
  const cc = call(ctx, ['config-check']);
  ctx.out(cc.out); ctx.err(cc.err);
  if (cc.status !== 0) throw die('the written commands do not pass agent.sh config-check; fix .agents/config.yaml');
  return 0;
}
