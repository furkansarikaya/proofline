// @ts-check
// Weight by work type (A364, issue 338 C4): the LIGHT profile. A content or docs task of a low class whose plan and diff touch only documentation text and images (a positive list) is
// not asked for a mutation budget approval, and the reviewer and QA are told by instruction that mutation testing and the optional design group of the visual check are not required.
// The approval need is the only thing the control plane enforces (gate.mjs knows nothing of the profile). Nothing else is lighter: every required gate of the tier stays required (SECRETS,
// SECURITY, the reviews, QA, VERIFY), so Core invariants 1 and 2 are untouched. The decision is the control plane's: it reads the task type of the sealed TASK.md (the user's, set before the
// freeze), the class, the plan and the changed paths, at EVERY call, and stores nothing, so a later change (a code file in the diff) reclassifies upward at once and nothing frozen is rewritten.
// In doubt the profile is full: an unreadable type, an unloaded ecosystem definition, a path in none of the allowed sets.
import { fileText, planDestructive, planScope, planSectionPresent, scopePaths } from './records.mjs';
import { pathMatches } from './scope.mjs';
import { ecosystemSets, pipelineClass, riskFocusesOf, taskChangedPaths } from './signals.mjs';
import { taskType } from './taskfile.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The files a light run may change by default: documentation text and images. Everything else (json, xml, html, svg, css, scripts, tests, configuration) makes the run full. */
export const LIGHT_CONTENT_GLOBS = '*.md *.mdx *.txt *.rst *.adoc *.png *.jpg *.jpeg *.gif *.webp *.avif';

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
    const never = cfg.get('profiles.light.never_paths', '');
    const risky = `${cfg.get('review.risky_paths', '')} ${eco.risky} ${eco.dependency}`.trim();
    const codeLike = cfg.get('review.code_like_markdown', '.agents/** skills/** roles/** adapters/** .claude/** .codex/** AGENTS.md CLAUDE.md **/SKILL.md **/*.prompt.md');
    const content = cfg.get('profiles.light.content_globs', LIGHT_CONTENT_GLOBS);
    const paths = [...new Set([...scopePaths(planScope(ctx, dir).rows), ...taskChangedPaths(ctx, dir)])];
    for (const p of paths) {
      if (risky !== '' && pathMatches(p, risky)) return no(`${p} is a risky or dependency path`);
      if (never !== '' && pathMatches(p, never)) return no(`${p} is a configuration or CI path`);
      if (pathMatches(p, codeLike)) return no(`${p} is code-like text`);
      // a positive list: only documentation and media may change in a light run; data, markup, style, scripts, tests and configuration make it full
      if (!pathMatches(p, content)) return no(`${p} is not a content file (profiles.light.content_globs)`);
    }
    return { light: true, reason: '' };
  });
}

/** `mutation_testing` and `design_group` lines of `pipeline`. @param {Context} ctx @param {string} dir */
export function weightLines(ctx, dir) {
  const w = weightProfile(ctx, dir);
  return `profile=${w.light ? 'light' : 'full'}\n${w.light ? '' : `profile_reason=${w.reason}\n`}mutation_testing=${w.light ? 'off' : 'on'}\ndesign_group=${w.light ? 'off' : 'optional'}\n`;
}
