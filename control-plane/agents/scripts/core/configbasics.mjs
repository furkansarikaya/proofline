// @ts-check
// `proofline doctor --config` (A374, issue 338 U5): a READ-ONLY listing of the few settings a user is expected to change, each with its value in this project, the shipped default and a
// one-line meaning. The list is built in (BASIC_KEYS), never read from the banners of a config file: a project config keeps its own text (the upgrade adds missing keys, never comments),
// so an older file without the BASICS banner works the same. The shipped config.yaml groups the same keys under its BASICS banner; tests/core/config-basics.test.mjs keeps the two in step.
import { readFileSync } from 'node:fs';
import { configGetFrom, configLines } from './config.mjs';
import { isFile } from './paths.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The basic keys: [dotted key, meaning]. No key is renamed or moved by this list; it only names them. @type {ReadonlyArray<readonly [string, string]>} */
export const BASIC_KEYS = Object.freeze([
  ['profile', 'model profile of the team: max, balanced or economy (cost against strength)'],
  ['runtime.lead', 'runtime of the lead: claude or codex'],
  ['runtime.worker', 'runtime of the implementer and the other workers: claude or codex'],
  ['runtime.reviewers', 'runtime of the reviewers: claude or codex (the implementer never reviews its own change)'],
  ['commands.build', 'how to build the project (one command, or a block list); empty means the verify gate has nothing to run'],
  ['commands.test', 'how to run the tests (one command, or a block list); empty means the verify gate has nothing to run'],
  ['commands.lint', 'how to lint the project; `none` says on purpose that there is no lint'],
  ['git.protected_branches', 'branches nobody pushes to directly (space-separated, empty: your team decides)'],
  ['git.push_requires_approval', 'true: a push needs your approval first'],
  ['codex.sandbox.network', 'on lets Codex workers reach the network; off by default, set only by you in this file'],
  ['codex.sandbox.local_server', 'on lets a Codex worker run a loopback test server; needs network: on, set only by you'],
  ['codex.sandbox.failover', 'claude hands a Codex implementer that the sandbox stopped to the Claude implementer'],
  ['security.advisory_check', 'on is your consent to send the package names and versions of your npm lock file to the public npm registry for an advisory check; off by default'],
  ['output_cap_bytes', 'most bytes the lead sees from a status command before the rest is cut (0 = no cap)'],
  ['review.max_fix_rounds', 'how many failing review rounds a task may have before it stops and asks you (default 2)'],
  ['test_trust.mutation_budget', 'how many mutants the tests review may try per task (default 20)'],
  ['test_trust.review_rounds', 'how many rounds the test review loop may take before you decide (default 4)'],
]);

/** @param {string} v */
const show = (v) => (v === '' ? 'empty' : v);

/** A key's value for display: the scalar, or the items of a block list joined by `; `. @param {string[]} lines @param {string} key @returns {string | null} null when the key is absent */
function valueOf(lines, key) {
  const v = configGetFrom(lines, key);
  return v === null ? null : v.split('\n').join('; ');
}

/**
 * One line per basic key. @param {string[]} user configLines of the project's config @param {string[] | null} def configLines of the shipped config, or null when it was not found
 * @returns {string[]}
 */
export function basicsLines(user, def) {
  /** @type {string[]} */ const out = [];
  for (const [key, meaning] of BASIC_KEYS) {
    const now = valueOf(user, key);
    const dflt = def === null ? null : valueOf(def, key);
    if (def === null) { out.push(`${key}: ${now === null ? 'not in your file' : show(now)} (shipped default not found) ${meaning}`); continue; }
    const d = dflt === null ? 'none' : show(dflt);
    if (now === null) out.push(`${key}: not in your file, the default applies (default ${d}) ${meaning}`);
    else out.push(`${key}: ${show(now)} (default ${d}${now === (dflt ?? '') ? '' : ', changed'}) ${meaning}`);
  }
  return out;
}

/** `proofline doctor --config`: prints the basics, changes nothing. @param {Context} ctx */
export function configBasics(ctx) {
  const text = readFileSync(ctx.configFile, 'latin1');
  const home = ctx.env.PL_HOME ?? '';
  const shipped = home === '' ? '' : `${home}/control-plane/agents/config.yaml`;
  const def = shipped !== '' && isFile(shipped) ? configLines(readFileSync(shipped, 'latin1')) : null;
  ctx.out('the settings you are expected to change, with the value in this project (.agents/config.yaml), the shipped default and what each means:\n');
  for (const l of basicsLines(configLines(text), def)) ctx.out(`${l}\n`);
  ctx.out('Change a value with proofline config <key> <value> in your terminal, or by editing .agents/config.yaml yourself; codex.sandbox.*, the commands and every key but three are your decision, an agent does not set them.\n');
  ctx.out('Everything else is advanced: defaults for the control plane, kept under the ADVANCED banner of the shipped config; change one only with a decision (an A-record in docs/decisions.md).\n');
  ctx.out('This list is built in, not from the banners of your file, so a config written before the BASICS banner existed is listed the same way. Guide: docs/concepts/configuration.md\n');
  return 0;
}
