# Night mode

Night mode (`/proofline batch <ID...|all>`, A161) works through several tasks with one approval. This page holds the
detail; the README keeps the short form. The step-by-step mechanics of the driver are in [workflow](workflow.md#night-mode),
the hook rules around it in [enforcement layers](enforcement-layers.md), and every decision in [decisions](../decisions.md).

## The summary and the approval

`/proofline batch <ID...|all>` orders the listed tasks by `depends_on` and shows one summary: the order, what the approval
covers, what it does not, and the tasks left out (CRITICAL or unclassified tasks, and tasks that depend on them). Your one
reply "approve batch" is bound to that summary.

A project with no CI check on pull requests cannot run a batch (A163): `proofline merge` does not merge a pull request that
has no checks, so every task would stop at the merge step. The summary then carries a BLOCKER instead of a question, with
the ready `/proofline task Add a GitHub Actions workflow ...` line that adds the workflow. There is no setting that merges
without CI. `proofline doctor` and the delivery summary warn about the same thing early.

## Starting, stopping, status

After "approve batch" the session itself starts the driver (`agent.sh batch-start`; no separate terminal command). The driver
runs in the background, detached from the session: its own process group, SIGHUP ignored, stdin from `/dev/null`, output to
`.agents/local/batch/driver.log`, pid and group in `driver.pid`. Closing the session does not stop it. The reply is
`driver started, pid N, log <path>`, the sleep inhibitor in use and the reminder `plug in the computer; do not close the
laptop lid.` A second start is refused and names the running pid.

While the driver runs the computer does not idle-sleep: `caffeinate -i -w <driver pid>` on macOS, `systemd-inhibit` on
Linux. Where neither exists the start says so plainly; the machine may sleep and stop the batch. The lid is a different
matter: closing the laptop lid sleeps most machines whatever the inhibitor says, which is why the reminder stays.

`proofline batch stop` (or the session's `batch-stop`) stops only the driver it recorded: the verified process group from
`driver.pid`, never a process found by name or pattern. The task that was running is parked with the reason `stopped`.
`proofline batch status` starts with a `driver:` line (running with pid, start time and last log line; finished; not
running or stopped). A stopped or interrupted batch resumes with `proofline batch run` in a terminal or with the session's
batch start; merged tasks are not run again. `proofline batch run` in a terminal remains the same driver, in the foreground.

## Running the batch

The driver works through the tasks one at a time, each in a clean headless lead session. The summary's approval
stands in for the plan approval, the delivery approval (commit, push, pull request, merge only when CI is green and every
gate passed, cleanup) and a mutation budget raise up to `batch.mutation_budget_cap`.

A waiver, a scope expansion, a new dependency, a reopen, a destructive data change, a rule promotion, sending the friction
report and a new fix-round budget are never covered: the task is parked with its question, tasks that depend on it are
skipped, and the next independent task still runs.

The driver also stops when every runtime hit its usage limit, or when a runtime is not logged in.

## Sessions and timeouts

A session is always started as the leader of its own process group (job control, `setsid`, perl or python3, whichever is
verified on the machine); where none works the batch is refused.

A session that runs longer than `batch.task_timeout` (120 minutes) is closed together with every process it started (its
own process group, nothing else), the task is parked with the reason `timeout` and the batch goes on.

The headless Claude session runs with the permission mode of `dispatch.claude_permission_mode` (the PreToolUse hook
confines it).

## CI after every merge

After every merge the driver waits for the CI run of the merge commit itself, not the latest run, and stops when it is red,
still running after `batch.ci_wait_minutes`, or when no run appears within `batch.ci_appear_minutes`.

## Codex night sessions

A Codex night session runs in a sandbox profile that can commit and write the run records (`.git` and `.agents` writable
except hooks and `.git/config`, project folder writable, `$HOME` read-only, network on; the package-manager caches are
redirected into the temp dir, which is verified for npm, pnpm, yarn, pip and go only, so a package install with any other
tool is not promised to work).

`danger-full-access` only when you plan with `/proofline batch <ID...|all> --codex-danger-full-access` (the summary then
carries a warning and your approval covers it; config cannot enable it).

A Codex runtime must be codex-cli 0.163.0 or newer (the version the profile was verified on); the summary records the
version and the driver refuses an older or unreadable one.

## The morning table

`proofline batch status` is the morning table, generated from records only, followed by one line per headless session
(runtime, start, end, exit code, park reason, log path) so a first real run can be diagnosed in the morning.

## Limits that are decisions

Two limits are decisions, not gaps:

- Night mode runs markdown task files only: the unattended driver must not depend on network calls to resolve task ids.
  Import other tasks with `/proofline task`; `batch-plan` says so.
- A sandboxed Codex lead cannot start sandboxed Codex workers on macOS (sandboxes do not nest). `batch-plan` warns whenever
  a Codex session can run as the lead, including as the fallback runtime when one runtime hits its usage limit.
