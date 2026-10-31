// @ts-check
// The validation program of `config_check` (agent.sh lines 294-411), line for line: it reads the output of configLines the way the awk
// program read it (`-F=`, field 1 is the key, the rest of the line is the value) and collects the same messages in the same order.
// Where awk iterates an array (`for (s in ...)`), the order of its messages is not defined by awk; when such a loop would print more
// than one message the order cannot be reproduced, and `ambiguous` is set so that the caller leaves the command to the shell code.

const TOP = /^(proofline_version|canonical_branch|default_topology|profile|runtime|failover|autonomy|review|git|approval|commands|tasks|design_docs|local_state|worktree|archive|verification|metrics|test_trust|writing|product|performance|budgets|capabilities|dispatch|default_mode|active_run_file|policy_source|knowledge_scope_root|safety|pipelines|execution_policy|database|hook|fingerprint|risk|security|contract|batch|validation|visual|rules|timeouts)$/;
const DIGITS = /^[0-9]+$/;
const HOOK_EVENT_TIMEOUT = /^hook\.(session|prompt|pretool|posttool|subagent_start|subagent_stop|stop)_timeout_seconds$/;
const REL_UP = /(^|\/)\.\.(\/|$)/;

/**
 * @param {string[]} lines the output of configLines
 * @returns {{ messages: string[], ambiguous: boolean }}
 */
export function checkConfigLines(lines) {
  /** @type {string[]} */ const messages = [];
  let ambiguous = false;
  /** @param {string} m */ const bad = (m) => { messages.push(m); };
  /** @param {string} k @param {string} v @param {string} set */
  const en = (k, v, set) => {
    if (v === '') return;
    if (set.split('|').includes(v)) return;
    bad(`invalid value for ${k}: ${v} (want ${set})`);
  };
  /** @param {string} k @param {string} v */
  const num = (k, v) => { if (v !== '' && !DIGITS.test(v)) bad(`invalid number for ${k}: ${v}`); };
  /** awk `v + 0` for a string that matched ^[0-9]+$ @param {string} v */
  const n0 = (v) => {
    if (v.length > 15) ambiguous = true; // beyond the exact integers of a double: awk would print another form
    return Number(v);
  };

  /** @type {Record<string, boolean>} */ const seen = {};
  /** @type {Record<string, string>} */ const gv = {};
  /** @type {Record<string, boolean>} */ const hasl = {};
  /** @type {Record<string, boolean>} */ const hasv = {};
  /** @type {Set<string>} */ const cmdseen = new Set();
  /** @type {Record<string, boolean>} */ const sig = {};
  /** @type {Record<string, boolean>} */ const wk = {};
  /** @type {Record<string, boolean>} */ const wrd = {};
  /** @type {Record<string, boolean>} */ const cnt = {};
  /** @type {Record<string, boolean>} */ const chk = {};
  /** @type {Record<string, boolean>} */ const sn = {};
  /** @type {Record<string, boolean>} */ const sd = {};
  /** @type {Record<string, boolean>} */ const sp = {};
  let hs = false;

  for (const line of lines) {
    const eq = line.indexOf('=');
    const k = eq < 0 ? line : line.slice(0, eq);
    const v = line.slice(k.length + 1);
    const p = k.split('.');
    /** @param {number} i */ const P = (i) => p[i - 1] ?? '';
    const top = P(1);
    if (!TOP.test(top)) { bad(`unknown top-level key: ${top}`); continue; }
    if (top === 'risk' && P(3) !== '') {
      if (!/^[a-z_]+$/.test(P(2))) bad(`invalid risk signal name: ${P(2)}`);
      else if (P(3) === 'check') en(k, v, 'contract|concurrency|performance|config|migration|visual|dependencies|logging');
      else if (P(3) === 'flag') en(k, v, 'contract_change|concurrency|performance_critical|data_change|destructive|ui');
      else if (P(3) === 'design_role') en(k, v, 'architect|data_architect|designer');
      else if (P(3) !== 'paths' && P(3) !== 'content' && P(3) !== 'words') bad(`unknown risk key: ${k}`);
      if ((P(3) === 'paths' || P(3) === 'content' || P(3) === 'words') && v !== '') sig[P(2)] = true;
      if (P(3) === 'words') wk[P(2)] = true;
      if (P(3) === 'words' && v !== '') wrd[P(2)] = true;
      if (P(3) === 'content' && v !== '') cnt[P(2)] = true;
      if (P(3) === 'check' && v !== '') chk[P(2)] = true;
    }
    if (k === 'risk.unsupported') en(k, v, 'block|report');
    if (top === 'validation' && k !== 'validation' && !/^validation\.(entry_words|entry_candidates|entry_input|entry_new|entry_output|entry_skip|code_patterns)$/.test(k)) bad(`unknown validation key: ${k} (want validation.entry_words, entry_candidates, entry_input, entry_new, entry_output, entry_skip or code_patterns)`);
    if (top === 'rules' && k !== 'rules') { if (!/^rules\.(budget_bytes|unused_after_reviews)$/.test(k)) bad(`unknown rules key: ${k} (want rules.budget_bytes or rules.unused_after_reviews)`); else num(k, v); }
    if (top === 'visual' && k !== 'visual') { if (!/^visual\.(ascii_turkish_words|ascii_turkish_allow)$/.test(k)) bad(`unknown visual key: ${k} (want visual.ascii_turkish_words or visual.ascii_turkish_allow)`); else if (!/^[A-Za-z]*([ ,]+[A-Za-z]+)*[ ,]*$/.test(v)) bad(`${k} must be ASCII words separated by spaces: ${v}`); }
    if (top === 'contract' && k !== 'contract' && !/^contract\.(paths|ignore)$/.test(k)) bad(`unknown contract key: ${k} (want contract.paths or contract.ignore)`);
    if (top === 'commands' && P(2) !== '') {
      if (P(3) !== '') {
        if (!/^(build|test|lint)$/.test(P(2))) bad(`commands.${P(2)} takes one command, not a list: ${k}`);
        else if (!DIGITS.test(P(3)) || P(4) !== '') bad(`commands.${P(2)} is a command or a list of commands (- command), not a map: ${k}`);
        else if (v === '') { if (P(3).length > 15) ambiguous = true; bad(`empty command in the commands.${P(2)} list (item ${Number(P(3)) + 1})`); }
        else if (cmdseen.has(`${P(2)}\u001c${v}`)) bad(`duplicate command in the commands.${P(2)} list: ${v}`);
        else { cmdseen.add(`${P(2)}\u001c${v}`); hasl[P(2)] = true; }
      } else if (/^(build|test|lint)$/.test(P(2)) && /^\[[^ ].*\]$/s.test(v)) bad(`${k} is an inline list; write a block list (one \`- command\` line per command): ${v}`);
      if (P(3) === '' && v !== '') hasv[P(2)] = true;
    }
    if (k === 'default_topology') en(k, v, 'standalone|orchestrated');
    else if (k === 'profile') en(k, v, 'max|balanced|economy');
    else if (/^runtime\.(lead|worker|reviewers)$/.test(k) || /^runtime\.roles\./.test(k)) en(k, v, 'claude|codex');
    else if (k === 'failover') en(k, v, 'auto|ask|off');
    else if (/^autonomy\./.test(k)) { if (!/^(TRIVIAL|STANDARD|COMPLEX|CRITICAL)$/.test(P(2))) bad(`unknown class under autonomy: ${P(2)}`); en(k, v, 'autonomous|supervised'); }
    else if (k === 'review.waiver_followup') en(k, v, 'none|task');
    else if (/^review\.(max_fix_rounds|small_max_files|small_max_lines)$/.test(k) || /^(test_trust|budgets|performance)\./.test(k)) num(k, v);
    else if (k === 'git.commit_format') en(k, v, 'conventional|plain');
    else if (k === 'git.push_requires_approval') en(k, v, 'true|false');
    else if (k === 'git.platform') en(k, v, 'github|gitlab|azure|bitbucket|other');
    else if (k === 'git.platform_host') { if (v !== '' && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(v)) bad(`git.platform_host is a bare host name such as gitlab.company.com (no scheme, port, path or spaces): ${v}`); }
    else if (k === 'tasks.adapter') en(k, v, 'markdown|github|jira|linear');
    else if (top === 'design_docs' && P(2) === 'design' && P(3) !== '') {
      if (P(3) === 'shared' && P(4) === '') { if (/^\//.test(v) || REL_UP.test(v)) bad(`${k} must be project-relative: ${v}`); }
      else if (P(3) === 'surfaces' && P(4) === '') hs = true;
      else if (P(3) === 'surfaces' && P(5) === '') { if (!/^[A-Za-z0-9_-]+$/.test(P(4))) bad(`invalid surface name: ${P(4)} (letters, digits, - and _)`); sn[P(4)] = true; }
      else if (P(3) === 'surfaces' && P(6) === '' && (P(5) === 'doc' || P(5) === 'paths' || P(5) === 'mode')) {
        sn[P(4)] = true;
        if (P(5) === 'doc') { if (/^\//.test(v) || REL_UP.test(v)) bad(`${k} must be project-relative: ${v}`); if (v !== '') sd[P(4)] = true; }
        else if (P(5) === 'paths') {
          // split(v, pe, " "): runs of blanks separate, leading and trailing blanks are ignored
          const pe = v.split(/[ \t\n]+/).filter((x) => x !== '');
          for (const e of pe) { const c = e.split('**/').length - 1; if (c > 1) bad(`${k} allows one **/ per glob: ${e}`); }
          if (/[\\|]/.test(v)) bad(`${k} may not contain \\ or |: ${v}`);
          if (/^\//.test(v) || /(^|[ /])\.\.(\/|[ ]|$)/.test(v)) bad(`${k} must be project-relative globs: ${v}`);
          if (v !== '') sp[P(4)] = true;
        } else if (v !== '' && !/^[a-z][a-z-]*$/.test(v)) bad(`${k} is a visitor mode in lower case, for example persuade or operate: ${v}`);
      } else bad(`unknown design_docs.design key: ${k} (want shared or surfaces.<name>.doc|paths|mode)`);
    }
    else if (k === 'local_state' || k === 'metrics') en(k, v, 'on|off');
    else if (k === 'writing.profile') en(k, v, 'auto|ste|plain');
    else if (k === 'writing.strictness') en(k, v, 'relaxed|strict');
    else if (top === 'writing' && k !== 'writing') bad(`unknown writing key: ${k} (want writing.profile or writing.strictness)`);
    else if (k === 'product.dir') { if (/^\//.test(v) || REL_UP.test(v)) bad(`product.dir must be project-relative: ${v}`); }
    else if (k === 'product.stale_days') { if (v !== '' && !/^[1-9][0-9]*$/.test(v)) bad(`product.stale_days must be a positive integer: ${v}`); }
    else if (top === 'product' && k !== 'product' && k !== 'product.vague_words') bad(`unknown product key: ${k} (want product.dir, product.vague_words or product.stale_days)`);
    else if (/^pipelines\.[A-Z]+\.(evidence|qa|architect)$/.test(k)) en(k, v, 'yes|no');
    else if (/^pipelines\.[A-Z]+\.review$/.test(k)) en(k, v, 'yes|no|optional');
    else if (/^pipelines\.[A-Z]+\.(max_explorers|max_scope_paths)$/.test(k)) num(k, v);
    else if (/^pipelines\.[A-Z]+\.dispatch_timeout_seconds$/.test(k)) { num(k, v); if (DIGITS.test(v) && (n0(v) < 30 || n0(v) > 28800)) bad(`${k} must be 30 to 28800`); }
    else if (/^capabilities\.[^.]+\.[^.]+$/.test(k)) en(k, v, '1|2|3');
    else if (k === 'execution_policy.max_context_bytes' || k === 'execution_policy.revision') num(k, v);
    else if (k === 'worktree.copy_files') { if (/(^| )\//.test(v) || /(^|[ /])\.\.([ /]|$)/.test(v) || /[|\\]/.test(v)) bad(`worktree.copy_files must be project-relative globs without a leading / or .. : ${v}`); }
    else if (top === 'worktree' && k !== 'worktree') bad(`unknown worktree key: ${k} (want worktree.copy_files)`);
    else if (k === 'archive.keep') num(k, v);
    else if (top === 'archive' && k !== 'archive') bad(`unknown archive key: ${k} (want archive.keep)`);
    else if (k === 'verification.env_files') { if (/(^| )\//.test(v) || /(^|[ /])\.\.([ /]|$)/.test(v) || /[*?|\\]/.test(v) || /\[|\]/.test(v)) bad(`verification.env_files must be project-relative file names (space-separated, no glob, no leading / or .. ): ${v}`); }
    else if (k === 'verification.doc_paths') { if (/(^| )\//.test(v) || /(^|[ /])\.\.([ /]|$)/.test(v) || /[?|\\]/.test(v) || /\[|\]/.test(v)) bad('verification.doc_paths must be project-relative entries: a directory prefix ending in /, an exact path or *.ext'); }
    else if (top === 'verification' && k !== 'verification' && k !== 'verification.command_timeout_seconds') bad(`unknown verification key: ${k} (want verification.env_files or verification.doc_paths)`);
    else if (k === 'batch.mutation_budget_cap') num(k, v);
    else if (k === 'batch.ci_wait_minutes') { num(k, v); if (DIGITS.test(v) && n0(v) < 1) bad(`${k} must be at least 1`); else if (DIGITS.test(v) && n0(v) > 720) bad(`${k} must be at most 720`); }
    else if (k === 'batch.ci_appear_minutes') { num(k, v); if (DIGITS.test(v) && n0(v) < 1) bad(`${k} must be at least 1`); else if (DIGITS.test(v) && n0(v) > 240) bad(`${k} must be at most 240`); }
    else if (k === 'batch.task_timeout' || k === 'batch.runtimes') { /* belonged to the removed headless driver (0.0.32): accepted, not validated */ }
    else if (top === 'batch' && k !== 'batch') bad(`unknown batch key: ${k}`);
    else if (k === 'dispatch.claude_permission_mode') en(k, v, 'bypassPermissions|acceptEdits|default');
    else if (k === 'dispatch.network_retries') { num(k, v); if (DIGITS.test(v) && n0(v) > 6) bad('dispatch.network_retries is at most 6'); }
    else if (k === 'hook.approve_budget_seconds') { num(k, v); if (DIGITS.test(v) && (n0(v) < 5 || n0(v) > 25)) bad(`${k} must be 5 to 25 (the runtime stops a hook at 30 s)`); }
    else if (k === 'hook.next_budget_seconds') { num(k, v); if (DIGITS.test(v) && (n0(v) < 2 || n0(v) > 20)) bad(`${k} must be 2 to 20`); }
    else if (k === 'hook.lock_wait_seconds') { num(k, v); if (DIGITS.test(v) && (n0(v) < 1 || n0(v) > 20)) bad(`${k} must be 1 to 20`); }
    else if (top === 'hook' && k !== 'hook' && !HOOK_EVENT_TIMEOUT.test(k)) bad(`unknown hook key: ${k} (want hook.approve_budget_seconds, hook.next_budget_seconds, hook.lock_wait_seconds or hook.<event>_timeout_seconds)`);
    else if (k === 'timeouts.scale') { if (v !== '' && (!/^[0-9]+(\.[0-9]+)?$/.test(v) || Number(v) < 0.5 || Number(v) > 10)) bad(`timeouts.scale must be a number from 0.5 to 10: ${v}`); }
    else if (k === 'timeouts.warn_percent') { num(k, v); if (DIGITS.test(v) && (n0(v) < 50 || n0(v) > 95)) bad(`${k} must be 50 to 95`); }
    else if (top === 'timeouts' && k !== 'timeouts') bad(`unknown timeouts key: ${k} (want timeouts.scale or timeouts.warn_percent)`);
    else if (HOOK_EVENT_TIMEOUT.test(k)) { num(k, v); if (DIGITS.test(v) && (n0(v) < 10 || n0(v) > 600)) bad(`${k} must be 10 to 600`); }
    else if (k === 'verification.command_timeout_seconds') { num(k, v); if (DIGITS.test(v) && (n0(v) < 60 || n0(v) > 28800)) bad(`${k} must be 60 to 28800`); }
    else if (k === 'tasks.status_block_seconds') { num(k, v); if (DIGITS.test(v) && (n0(v) < 1 || n0(v) > 300)) bad(`${k} must be 1 to 300`); }
    else if (k === 'fingerprint.cache_min_bytes') { num(k, v); if (DIGITS.test(v) && n0(v) < 65536) bad(`${k} must be at least 65536`); }
    else if (top === 'fingerprint' && k !== 'fingerprint') bad(`unknown fingerprint key: ${k}`);
    else if (k === 'dispatch.network_backoff_seconds') num(k, v);
    else if (k === 'dispatch.timeout_seconds') { num(k, v); if (DIGITS.test(v) && (n0(v) < 30 || n0(v) > 28800)) bad(`dispatch.timeout_seconds must be 30 to 28800`); }
    seen[k] = true;
    gv[k] = v;
  }

  // END block. Loops over awk arrays: their message order is undefined, so more than one message from one loop is ambiguous.
  /** @param {string[]} keys @param {(s: string) => string[]} each */
  const unordered = (keys, each) => {
    let emitting = 0;
    for (const s of keys) { const m = each(s); if (m.length) emitting++; for (const x of m) bad(x); }
    if (emitting > 1) ambiguous = true;
  };
  unordered(Object.keys(hasl), (s) => (hasv[s] ? [`commands.${s} has both a value and a list of commands; keep one`] : []));
  const gnum = (/** @type {string} */ key, /** @type {number} */ def) => (DIGITS.test(gv[key] ?? '') ? n0(/** @type {string} */ (gv[key])) : def);
  const ha = gnum('hook.approve_budget_seconds', 20);
  const hp = gnum('hook.prompt_timeout_seconds', 30);
  if (hp < ha + 5) bad(`hook.prompt_timeout_seconds (${hp}) must be at least hook.approve_budget_seconds + 5 (${ha + 5})`);
  if (!seen['canonical_branch']) bad('missing key: canonical_branch');
  if (!seen['git.branch_prefix']) bad('missing key: git.branch_prefix');
  if (seen['git.platform_host'] && gv['git.platform_host'] !== '' && (gv['git.platform'] ?? '') === '') bad('git.platform_host needs git.platform (the platform that host runs)');
  unordered(Object.keys(sn), (s) => {
    /** @type {string[]} */ const m = [];
    if (!sd[s]) m.push(`design surface ${s} has no doc (design_docs.design.surfaces.${s}.doc)`);
    if (!sp[s]) m.push(`design surface ${s} has no paths (design_docs.design.surfaces.${s}.paths)`);
    return m;
  });
  const nsn = Object.keys(sn).length;
  if (hs && !nsn) bad('design_docs.design.surfaces names no surface');
  if (seen['design_docs.design.shared'] && !hs) bad('design_docs.design.shared needs design_docs.design.surfaces');
  unordered(Object.keys(sig), (s) => (chk[s] ? [] : [`risk signal ${s} has patterns but no check`]));
  unordered(Object.keys(wrd), (s) => (cnt[s] ? [] : [`risk signal ${s} has words but no content (the pattern the line must match as well)`]));
  unordered(Object.keys(wk), (s) => (wrd[s] ? [] : [`risk.${s}.words is empty (a signal with words matches a line that names one of them; remove the content as well to switch the signal off)`]));
  if (cnt['log_sensitive'] && !wk['log_sensitive']) bad('risk.log_sensitive.words is missing (without words every file that has a log call would open the logging focus)');
  return { messages, ambiguous };
}
