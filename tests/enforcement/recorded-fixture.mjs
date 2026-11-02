// @ts-check
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// The project fixtures of the recorded enforcement corpora: the scaffold of the legacy enforcement suite (an orchestrated COMPLEX run with the git hooks
// installed), in the run states the scenarios need. Built by the self-test library's verbs once per process (see tests/core/legacy-lib.mjs).
const BASE = 'scaffold orchestrated no COMPLEX "${AUTO}"; node "$tl_agents/../../tests/legacy-githooks/install.mjs" .agents/githooks; mkdir -p .agents/hooks src; '
  + "printf '.agents/githooks/\\n.agents/hooks/\\n' >> .git/info/exclude; git config core.hooksPath .agents/githooks; git config commit.gpgsign false";

/**
 * The recipe of a fixture. @param {'implementing' | 'planning' | 'code_done'} [state] implementing is the default
 */
export function fixtureRecipe(state = 'implementing') {
  const auto = state === 'planning' ? 'manual' : '';
  const base = BASE.replace('${AUTO}', auto);
  switch (state) {
    case 'code_done': return `${base}; to_code_done orchestrated`;
    default: return base;
  }
}

/**
 * Set the state line of a section of RUN.yaml (execution: or handoff:). The hook reads only the STATUS line of `summary` (execution.state and handoff.state),
 * so the DONE and BLOCKED fixtures are the CODE_DONE and base fixtures with that field set: building them through the whole flow takes minutes and adds nothing.
 * @param {string} dir @param {'execution' | 'handoff'} section @param {string} value
 */
export function setState(dir, section, value) {
  const file = join(dir, '.agents/runs/LC/RUN.yaml');
  let sec = '';
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').map((l) => {
    const m = /^([a-z_]+):/.exec(l);
    if (m) sec = m[1] ?? '';
    return sec === section && /^  state:/.test(l) ? `  state: ${value}` : l;
  }).join('\n'));
}
