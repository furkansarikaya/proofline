# Time limits

Every wait in the control plane has a limit, and a limit is a last resort: a step that hits it **fails** (it is never a pass),
the work it did is kept, and the next run of the step resumes from it. Bigger limits and the scale below only wait longer; they
skip no gate and weaken no check.

## One multiplier

`timeouts.scale` in `.agents/config.yaml` (default `1.0`, bounds `0.5` to `10`) multiplies every duration below, rounded up. A value
outside the bounds, or one that is not a number, is read as `1.0`; `agent.sh config-check` refuses it. `agent.sh timeouts` prints
every limit as it is used now.

The approval fast path is the one exception: `hook.approve_budget_seconds` (5 to 25, default 20) is never scaled. The approval is
recorded first, as one small file write, and the hook's own limit (`hook.prompt_timeout_seconds`, kept at least that budget + 5)
may grow without the approval step getting slower.

`proofline doctor --scale` times the approval path and `agent.sh config-check` on this machine, compares them with a reference
(500 ms and 250 ms), and proposes a scale: the ratio rounded up to a half step, from `1.5` to `10`, nothing when the machine is
not slow. It writes the proposal to `.agents/local/scale/PROPOSAL.tsv` and asks one question; `proofline doctor --apply-scale`
writes `timeouts.scale` only after your own reply **`approve scale`** (an approval kind bound to the proposal, used up on apply)
and then refreshes the hook limits in the settings files.

## Where every limit lives

| Limit | Value now (before scale) | Key | Read by |
|---|---|---|---|
| Dispatched step (default, when the run has no class) | 5400 s (was 1800) | `dispatch.timeout_seconds`, 30 to 28800 | `dispatch.sh`, `agent.sh` (stale marker), `check-result.mjs` |
| Dispatched step per class | TRIVIAL 1800 (was 900), STANDARD 5400 (1800), COMPLEX 7200 (3600), CRITICAL 7200 (3600) | `pipelines.<CLASS>.dispatch_timeout_seconds`, 30 to 28800 | `dispatch.sh` |
| Per-role step duration | none of its own: explorer, architect, qa, implementer, every reviewer focus, security reviewer, verifier and designer (including the full design audit) share the class limit | | |
| Stale dispatch marker | the step limit + 60 s | | `agent.sh` (`inflight_pid_alive`) |
| Warning to the lead | 80 % of a step's limit | `timeouts.warn_percent`, 50 to 95 | `agent.sh next`, `agent.sh wait-line` |
| Network retry wait | 15 s, doubling, 3 tries (not scaled: a pause, not a limit) | `dispatch.network_backoff_seconds`, `dispatch.network_retries` | `dispatch.sh` |
| Kill after a timeout | 5 s grace after TERM (not scaled) | | `dispatch.sh` |
| Build, test, install command of the build record; one re-run of reproduced evidence | 1800 s (was 900) | `verification.command_timeout_seconds`, 60 to 28800 | `build-record.sh`, `agent.sh` |
| Wait for another build of the same commit | 1800 s | `BUILD_RECORD_WAIT` (environment) | `build-record.sh` |
| Lock wait of `agent.sh` | 120 s | `PROOFLINE_LOCK_TIMEOUT` (environment) | `agent.sh` |
| Status block update | 20 s | `tasks.status_block_seconds`, 1 to 300 | `agent.sh` |
| CI of a merge commit: wait for a run to finish, wait for it to appear | 30 min, 10 min (told to the lead; the lead asks again) | `batch.ci_wait_minutes` 1 to 720, `batch.ci_appear_minutes` 1 to 240 | `batch.sh` |
| CI-fix and delivery steps | no timer: each reads the CI once, the lead asks again | | |
| Approval budget of the prompt hook | 20 s, never scaled | `hook.approve_budget_seconds`, 5 to 25 | the hook |
| `agent.sh next` in the session hook | 10 s | `hook.next_budget_seconds`, 2 to 20 | the hook |
| Busy lock in a hook | 8 s | `hook.lock_wait_seconds`, 1 to 20 | the hook |
| Runtime limit per hook event | session 30, prompt 30, pretool 30, posttool 30, subagent start 60, subagent stop 120, stop 30 | `hook.<event>_timeout_seconds`, 10 to 600 | `proofline init`/`upgrade` write them into `.claude/settings.json` and `.codex/hooks.json` |
| Kill guard of the hook | 20 s | `PROOFLINE_KG_BUDGET` (environment) | the hook |
| Visual audit | per page and browser start 30 s (`--timeout MS`, the caller passes it), native tools 120 s; the whole audit is a dispatched step under the class limit | | `measure.mjs`, `native.mjs` |
| Trial run of a discovered command | 600 s | | `proofline doctor --commands` |
| `claude plugin list` in doctor | 20 s | | `proofline doctor` |

The hook limits in the settings files come from the config: edit `hook.<event>_timeout_seconds` or `timeouts.scale`, then run
`proofline upgrade`. Only the `timeout` of the hooks whose command names `proofline-hook.sh` is written; every other setting and hook
is kept, and a second run changes nothing. The hooks of the plugin install (`adapters/claude/hooks/hooks.json`) carry the shipped
values.

## How the defaults were derived

Source: 47 step, dispatch and run records of two real tasks in a project that used the earlier defaults (read only; nothing of
it is stored here). Rules:

1. For each step type, take the longest observed duration of a step that ended by itself. A dispatch cut by the limit is censored:
   its true duration is above the limit, so the limit is counted twice.
2. The limit of a step type is the largest of: 3 times the longest finished duration, 2 times the longest censored one, 1.5 times
   the longest incident reported by users (explorer 48 min, full design audit 54 to 60 min, dispatch cut at 1800 s twice).
3. The records carry no class. The two cuts at 1807 s and 1824 s show the 1800 s limit of STANDARD was in force, so the data
   describes STANDARD. TRIVIAL, COMPLEX and CRITICAL have no data: they get a documented multiple (2 times) of their earlier default.

| Step type | Records | Longest finished | Rule 1 to 3 gives |
|---|---|---|---|
| explorer | 4 | 193 s | 4320 s (incident 48 min) |
| architect | 1 | 385 s | 1155 s |
| qa | 8 | 1764 s | 5292 s |
| qa, visual | 1 | 345 s | 5400 s (incident, design audit 60 min) |
| designer | 2 | 102 s | 5400 s (incident, design audit 60 min) |
| implementer (dispatch) | 10 | 1290 s; 2 cut at 1800 | 3870 s |
| reviewer, plan | 4 | 244 s | 732 s |
| reviewer, rules | 4 | 414 s | 1242 s |
| reviewer, tests | 5 | 1786 s | 5358 s |
| security reviewer | 4 | 60 s | 180 s |
| verifier | 1 | 310 s | 930 s |

All dispatched roles share one limit per class, so the class value is the largest row, rounded to 5400 s for STANDARD (3 times the
earlier 1800 s). The other classes: TRIVIAL 1800 s, COMPLEX 7200 s, CRITICAL 7200 s (2 times the earlier 900, 3600, 3600). The
build and test limit is 2 times its earlier 900 s: there is no measurement of build time in the records. An upgrade moves a limit
that still holds the earlier shipped value to the new one (from a project older than 0.0.39) and never touches a value you changed.

## When a step takes long

- At 80 % of a step's limit, `agent.sh next` (and `agent.sh wait-line`) add one `TIME` line for the lead, which tells you in one
  line; nothing is stopped or blocked.
- At the limit the step fails with exit 124. `dispatch.sh` writes `dispatch/RESUME-<role>[-focus].md` (log tail, changed paths,
  artifacts); the next dispatch of the same role and focus carries it in its prompt, and the note is removed when the step
  submits. Explorers also keep a note per assignment, so two explorers that both time out do not overwrite each other.
- A build or test command stopped by its limit (exit 124) is a failure and leaves **no** sealed build record, so the next run
  starts again instead of reusing a verdict that only says the machine was slow. A re-run of reproduced evidence that hits its limit
  is reported as not reproduced, with the limit named.
- CI waits and delivery steps have no timer of their own; a batch that gives up on a CI run stops and resumes from its state
  (merged tasks are not run again).
