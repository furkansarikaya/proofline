// @ts-check
// Weight by work type (A364, issue 338 C4): the LIGHT profile. A content or docs task of a low class, whose plan and diff touch no code, dependency, configuration, CI or data, needs no
// mutation testing in its tests review and has the optional design group of the visual check off by default. Nothing else is lighter: every gate of the tier stays (SECRETS, SECURITY, the
// reviews, QA, VERIFY), so Core invariants 1 and 2 are untouched. The decision is the control plane's: it reads the task type of the sealed TASK.md (the user's, set before the freeze),
// the class, the plan and the changed paths, at EVERY call, and stores nothing, so a later change (a code file in the diff) reclassifies upward at once and nothing frozen is rewritten.
// In doubt the profile is full: an unreadable type, an unloaded ecosystem definition, a path in none of the allowed sets.
import { fileText, planDestructive, planScope, planSectionPresent, scopePaths } from './records.mjs';
import { pathMatches } from './scope.mjs';
import { EXECUTABLE_CODE_DEFAULT, PathKinds } from './pathkind.mjs';
import { ecosystemSets, pipelineClass, riskFocusesOf, taskChangedPaths } from './signals.mjs';
import { taskType } from './taskfile.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/**
 * `{ light, reason }` for a run: reason is '' when light, else the first thing that keeps it full.
 * @param {Context} ctx @param {string} dir the run folder @returns {{ light: boolean, reason: string }}
 */
export function weightProfile(ctx, dir) {
  return ctx.once(`weight:${dir}`, () => {
    const cfg = ctx.config();
    const no = (/** @type {string} */ reason) => ({ light: false, reason });
    const cls = pipelineClass(ctx, dir);
    if (!((cls === 'TRIVIAL' || cls === 'STANDARD') && cfg.get('profiles.light.classes', 'TRIVIAL STANDARD').split(/\s+/).includes(cls))) return no(`class ${cls === '' ? 'not set' : cls} is not light`);
    const type = taskType(fileText(ctx, `${dir}/TASK.md`) ?? '');
    if (!cfg.get('profiles.light.types', 'content docs').split(/\s+/).includes(type)) return no(`task type ${type} is not light`);
    const eco = ecosystemSets(ctx);
    if (!eco.loaded) return no('the ecosystem definition is not loaded (risky and dependency paths are unknown)');
    const plan = fileText(ctx, `${dir}/PLAN.md`) ?? '';
    if (planSectionPresent(plan, 'Data')) return no('the plan has a ## Data section');
    if (planDestructive(plan) === 'yes') return no('the plan is destructive');
    const focus = riskFocusesOf(ctx, dir).filter((f) => f !== 'visual');
    if (focus.length > 0) return no(`risk focus ${focus.join(',')}`);
    const pk = new PathKinds(ctx);
    const never = cfg.get('profiles.light.never_paths', '');
    const risky = `${cfg.get('review.risky_paths', '')} ${eco.risky} ${eco.dependency}`.trim();
    const codeLike = cfg.get('review.code_like_markdown', '.agents/** skills/** roles/** adapters/** .claude/** .codex/** AGENTS.md CLAUDE.md **/SKILL.md **/*.prompt.md');
    const exec = cfg.get('review.executable_code', EXECUTABLE_CODE_DEFAULT);
    const paths = [...new Set([...scopePaths(planScope(ctx, dir).rows), ...taskChangedPaths(ctx, dir)])];
    for (const p of paths) {
      if (risky !== '' && pathMatches(p, risky)) return no(`${p} is a risky or dependency path`);
      if (never !== '' && pathMatches(p, never)) return no(`${p} is a configuration or CI path`);
      if (pathMatches(p, codeLike)) return no(`${p} is code-like text`);
      if (pk.testOrFixture(p)) continue;
      if (pathMatches(p, exec)) return no(`${p} is code`);
    }
    return { light: true, reason: '' };
  });
}

/** `mutation_testing` and `design_group` lines of `pipeline`. @param {Context} ctx @param {string} dir */
export function weightLines(ctx, dir) {
  const w = weightProfile(ctx, dir);
  return `profile=${w.light ? 'light' : 'full'}\n${w.light ? '' : `profile_reason=${w.reason}\n`}mutation_testing=${w.light ? 'off' : 'on'}\ndesign_group=${w.light ? 'off' : 'optional'}\n`;
}
