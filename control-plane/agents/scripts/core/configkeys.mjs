// @ts-check
// The known keys of .agents/config.yaml (A376, issue 338 U5): the built-in list `config-check` warns against (an unknown key is most often a typo, so the warning names
// the closest known key; it never fails the check) and the classes of `proofline config` (core/configcmd.mjs). The list is built in because an installed project has no copy
// of the shipped config; tests/core/config-command.test.mjs keeps it equal to the keys of the shipped control-plane/agents/config.yaml.

/** Every key of the shipped config outside the open maps below, plus the keys config-check still accepts from older files (contract.*, batch.task_timeout, batch.runtimes). */
export const KNOWN_KEYS = Object.freeze(`proofline_version profile runtime runtime.lead runtime.worker runtime.reviewers runtime.roles output_cap_bytes failover codex codex.sandbox
codex.sandbox.network codex.sandbox.local_server codex.sandbox.failover commands commands.install commands.build commands.test commands.lint commands.secret_scan git
git.branch_prefix git.commit_format git.protected_branches git.push_requires_approval git.commit_trailer git.platform git.platform_host git.forbidden_identities review
review.max_fix_rounds review.small_max_files review.small_max_lines review.risky_paths review.code_like_markdown review.waiver_followup test_trust test_trust.repeat
test_trust.mutation_budget test_trust.slow_ratio test_trust.review_rounds test_trust.review_minutes security security.licenses security.licenses.allow security.licenses.deny
security.audit_command security.advisory_check canonical_branch default_topology autonomy approval approval.phrases tasks tasks.adapter tasks.dir tasks.status_block_seconds
design_docs design_docs.design design_docs.architecture design_docs.data_model design_docs.api design_docs.adr_dir worktree worktree.copy_files archive archive.keep
verification verification.env_files verification.command_timeout_seconds verification.doc_paths local_state metrics writing writing.profile writing.strictness product
product.dir product.vague_words product.stale_days test_budgets test_budgets.default_kind test_budgets.unit test_budgets.unit.test_ms test_budgets.unit.suite_ms
test_budgets.integration test_budgets.integration.test_ms test_budgets.integration.suite_ms test_budgets.e2e test_budgets.e2e.test_ms test_budgets.e2e.suite_ms test_stability
test_stability.ratio test_stability.floor_ms performance performance.regression_pct performance.noise_pct performance.min_runs budgets budgets.max_advisor_calls
budgets.max_escalations budgets.max_parallel_reviewers database database.paths database.clients database.migrate_commands validation validation.entry_words
validation.entry_candidates validation.entry_input validation.entry_new validation.entry_output validation.entry_skip validation.code_patterns visual visual.ascii_turkish_words
visual.ascii_turkish_allow risk default_mode active_run_file policy_source knowledge_scope_root safety safety.destructive_git_requires_explicit_authorization
safety.external_network_requires_task_authorization safety.dependency_changes_require_task_authorization pipelines profiles profiles.light profiles.light.types
profiles.light.classes profiles.light.content_globs profiles.light.never_paths execution_policy execution_policy.revision execution_policy.forbidden_efforts
execution_policy.repeat_model_cap execution_policy.max_context_bytes execution_policy.lead_base_model execution_policy.classes execution_policy.providers capabilities batch
batch.mutation_budget_cap batch.ci_wait_minutes batch.ci_appear_minutes timeouts timeouts.scale timeouts.warn_percent hook hook.approve_budget_seconds hook.next_budget_seconds
hook.lock_wait_seconds fingerprint fingerprint.cache_min_bytes dispatch dispatch.timeout_seconds dispatch.network_retries dispatch.network_backoff_seconds
dispatch.claude_permission_mode dispatch.command_template rules rules.budget_bytes rules.unused_after_reviews
contract contract.paths contract.ignore batch.task_timeout batch.runtimes`.split(/\s+/));

/** The open maps: keys whose names the project chooses (a role, a runtime, a model, a class, a risk signal, a design surface). */
const OPEN = Object.freeze([
  /^runtime\.roles\.[a-z_]+$/,
  /^capabilities\.[^.]+(\.[^.]+)?$/,
  /^autonomy\.[A-Z]+$/,
  /^pipelines\.[A-Z]+(\.(evidence|qa|architect|review|max_explorers|max_scope_paths|max_fix_rounds|mutation_budget|dispatch_timeout_seconds))?$/,
  /^risk\.[a-z_]+(\.(check|flag|design_role|paths|content|words))?$/,
  /^execution_policy\.(classes\.[A-Z]+|(repeat_model_cap|lead_base_model)\.[a-z][a-z0-9_-]*|providers\.[a-z][a-z0-9_-]*(\.(models|efforts))?)$/,
  /^hook\.[a-z_]+_timeout_seconds$/,
  /^design_docs\.design\.(shared|surfaces(\.[A-Za-z0-9_-]+(\.(doc|paths|mode))?)?)$/,
]);

/** The key without the item numbers of a block list (`commands.build.0` -> `commands.build`). @param {string} k */
export const baseKey = (k) => k.replace(/(\.[0-9]+)+$/, '');

/** Is K (a dotted key of configLines) a key proofline reads? @param {string} k */
export function knownKey(k) {
  const b = baseKey(k);
  return KNOWN_KEYS.includes(b) || OPEN.some((re) => re.test(b));
}

/** Edit distance of two short strings. @param {string} a @param {string} b */
function distance(a, b) {
  /** @type {number[]} */ let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** The known key closest to K (the smallest edit distance; the first in list order on a tie). @param {string} k @returns {string} */
export function closestKey(k) {
  let best = ''; let bd = Infinity;
  for (const c of KNOWN_KEYS) { const d = distance(k, c); if (d < bd) { bd = d; best = c; } }
  return best;
}

/**
 * The warnings of `config-check` for keys it does not know (A376): one line per unknown key, in file order, naming the closest known key. A key that config-check already
 * reports as an error (MESSAGES name it) gets no warning as well. A warning never fails the check: proofline ignores the key.
 * @param {string[]} lines the output of configLines @param {string[]} messages the error messages of checkConfigLines @returns {string[]}
 */
export function unknownKeyWarnings(lines, messages) {
  /** @type {string[]} */ const out = [];
  const seen = new Set();
  const top = (/** @type {string} */ k) => k.split('.')[0];
  for (const l of lines) {
    const k = baseKey(l.slice(0, l.indexOf('=')));
    if (seen.has(k) || knownKey(k)) continue;
    seen.add(k);
    // already an error: the message names the key, its top-level block, or one of its names (`invalid risk signal name: Bad Name` for risk.Bad Name.check)
    const segs = k.split('.').slice(1).filter((s) => s.length >= 3);
    if (messages.some((m) => m.includes(k) || m === `unknown top-level key: ${top(k)}` || segs.some((s) => m.endsWith(`: ${s}`) || m.includes(`: ${s} `)))) continue;
    out.push(`warning: unknown config key ${k} (closest known key: ${closestKey(k)}); proofline ignores it`);
  }
  return out;
}
