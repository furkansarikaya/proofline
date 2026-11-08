// Builds the performance-proof fixture in <target-dir>: the synthetic base/change sample files (no benchmark runs) and a
// project config whose `performance:` block sets regression_pct 20, and three plans whose `## Risk` flag line
// states budget_pct=20, budget_pct=12 and an unparseable budget_pct. Deterministic and offline.
import path from 'node:path';
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.mkdir('.agents');
  f.cp(path.join(import.meta.dirname, 'samples'), 'samples');
  f.w('.agents/config.yaml', `performance:
  regression_pct: 20
  noise_pct: 5
  min_runs: 10
`);
  for (const b of ['20', '12', 'abc']) f.w(`PLAN-${b}.md`, `# Plan\n\n## Risk\n\nperformance_critical: yes budget_pct=${b}\n`);

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

