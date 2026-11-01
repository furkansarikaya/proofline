// @ts-check
// Stage 2, package C1: next, summary, plan-section, digest, report-facts, report-execution, report-tokens. Each keeps its arguments,
// stdout, stderr, exit code and files exactly as in agent.sh 0.0.41. An argument shape whose shell error text the core does not copy
// (`${2:?usage}`) throws BridgeToShell before any output; the entry then runs the shell code.
import { bytes } from '../config.mjs';
import { BridgeToShell } from '../errors.mjs';
import { isDir, isFile } from '../paths.mjs';
import { digestRun, nextCommand, planSection, reportExecution, reportFacts, reportTokens, summaryRun } from '../reports.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** The id argument of a command that needs one (`${2:?usage}`). @param {string[]} args */
function needId(args) {
  const id = args[0];
  if (id === undefined || id === '') throw new BridgeToShell('usage');
  return bytes(id);
}

/** A..: read-only commands that use the fingerprint cache (agent.sh `fp_fast=yes`). */
const FAST = 'yes';

/** @param {Context} ctx @param {string[]} args */
function next(ctx, args) {
  ctx.fpMode = FAST;
  const id = bytes(args[0] ?? '');
  if (noRunYaml(ctx, id)) return 2;
  nextCommand(ctx, id);
  return 0;
}

/** A run folder without RUN.yaml: the shell's awk reads it, fails silently and `set -e` ends `next` and `digest` with status 2, no output. @param {Context} ctx @param {string} id */
function noRunYaml(ctx, id) {
  return /^[A-Za-z0-9_-]+$/.test(id) && isDir(`${ctx.root}/.agents/runs/${id}`) && !isFile(`${ctx.root}/.agents/runs/${id}/RUN.yaml`);
}

/** @param {Context} ctx @param {string[]} args */
function summary(ctx, args) { ctx.fpMode = FAST; summaryRun(ctx, bytes(args[0] ?? ''), bytes(args[1] ?? '')); return 0; }

/** @param {Context} ctx @param {string[]} args */
function planSectionCommand(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = needId(args);
  const name = args[1];
  if (name === undefined || name === '') throw new BridgeToShell('usage');
  planSection(ctx, id, bytes(name));
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function digest(ctx, args) {
  ctx.fpMode = FAST;
  const id = needId(args);
  if (noRunYaml(ctx, id)) return 2;
  digestRun(ctx, id);
  return 0;
}

/** @param {Context} ctx @param {string[]} args */
function reportFactsCommand(ctx, args) { ctx.fpMode = 'refresh'; reportFacts(ctx, needId(args)); return 0; }

/** @param {Context} ctx @param {string[]} args */
function reportExecutionCommand(ctx, args) { ctx.fpMode = 'refresh'; reportExecution(ctx, needId(args)); return 0; }

/** @param {Context} ctx @param {string[]} args */
function reportTokensCommand(ctx, args) { ctx.fpMode = 'refresh'; reportTokens(ctx, needId(args)); return 0; }

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const C1_HANDLERS = {
  next,
  summary,
  'plan-section': planSectionCommand,
  digest,
  'report-facts': reportFactsCommand,
  'report-execution': reportExecutionCommand,
  'report-tokens': reportTokensCommand,
};
