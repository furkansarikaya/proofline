// @ts-check
// The legacy shell snippets that build the T2 states (used ONLY by tests/fixtures/port-t2/record.mjs, once, while the shell exists).
// Each name is a snapshot restored by port-t2-lib.mjs. The helpers (scaffold, to_code_done, reopen_failed_run, ...) are those of the legacy suites.
const REOPEN = `reopen_failed_run() {
  export SC_TEST_CRIT=AC-2 SC_TASK_EXTRA='- AC-2: second behavior'; scaffold orchestrated; unset SC_TEST_CRIT SC_TASK_EXTRA
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null; gfail REVIEW_SMALL impl_test.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl_test.txt 'test: default for an empty key'; A handoff LC IMPLEMENTED >/dev/null; gfail QA impl.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl.txt 'impl: second attempt'; A handoff LC IMPLEMENTED >/dev/null; gpass REVIEW_SMALL; gpass QA; gfail VERIFY impl.txt
  printf 'reason: the empty-key contract cannot be met within the frozen plan scope\\nevidence: gates/*-VERIFY.yaml fail on the third content\\n' | A terminate LC FAILED >/dev/null
}`;
export const STATES = /** @type {Record<string, string>} */ ({
  'failed-run': `${REOPEN}\nreopen_failed_run`,
  'failed-run-md': `${REOPEN}\nSC_AGENTS_MD=1 reopen_failed_run`,
  'failed-run-md2': `${REOPEN}\nSC_AGENTS_MD=2 reopen_failed_run`,
  'codedone': 'scaffold orchestrated; to_code_done orchestrated',
  'codedone-agents': 'SC_SCOPE_AGENTS=1 scaffold orchestrated; unset SC_SCOPE_AGENTS; to_code_done orchestrated',
  'codedone-named-skill': 'SC_SCOPE_NAMED=.claude/skills/proofline/named.md scaffold orchestrated; unset SC_SCOPE_NAMED; to_code_done orchestrated',
  'codedone-named-agent': 'SC_SCOPE_NAMED=.claude/agents/proofline-named.md scaffold orchestrated; unset SC_SCOPE_NAMED; to_code_done orchestrated',
  'codedone-md': 'SC_AGENTS_MD=1 scaffold orchestrated; to_code_done orchestrated',
  'tier-standard': 'scaffold standalone no STANDARD manual; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null',
  'tier-critical-data': "scaffold standalone no CRITICAL manual; printf '\\n## Data\\n\\ndestructive: no\\n\\nno schema change in practice\\n' >> .agents/runs/LC/PLAN.md; approve_as_user plan 'approve the plan'; A freeze LC >/dev/null",
  'planned-md': 'SC_AGENTS_MD=1 scaffold orchestrated',
});
