# Configuration

`.agents/config.yaml` of your project holds every setting of the control plane. Most of it is defaults you never touch. The shipped file is split into two parts so you can see which settings are yours.

- **BASICS**: the few settings a user is expected to change. They come first in the file.
- **ADVANCED**: defaults of the control plane (limits, budgets, risk signals, timeouts, execution policy). Change one only with a decision (an A-record in `docs/decisions.md`); each block has a one-line comment saying what it is.

The split changes no key and no default. A key keeps its name and place in the dotted path (`review.max_fix_rounds` stays `review.max_fix_rounds`), so a project config written for an older version keeps working.

## The basics

`proofline doctor --config` lists them with the value in your project, the shipped default and what each means. It is read-only.

| Key | What it is |
|---|---|
| `profile` | model profile of the team: `max`, `balanced` or `economy` |
| `runtime.lead`, `runtime.worker`, `runtime.reviewers` | which runtime (`claude` or `codex`) runs each part of the team |
| `commands.build`, `commands.test`, `commands.lint` | how the project is built, tested and linted; `proofline doctor --commands` finds empty ones; `lint: none` says there is no lint |
| `git.protected_branches`, `git.push_requires_approval` | branches nobody pushes to directly; whether a push needs your approval |
| `codex.sandbox.network`, `codex.sandbox.local_server`, `codex.sandbox.failover` | what a Codex worker may do beyond the default profile (off by default) |
| `security.advisory_check` | your consent (`on`) to send the package names and versions of your npm lock file to the public npm registry for an advisory check; off by default |
| `output_cap_bytes` | most bytes the lead sees from a status command before the rest is cut |
| `review.max_fix_rounds` | failing review rounds a task may have before it asks you |
| `test_trust.mutation_budget`, `test_trust.review_rounds` | mutants and rounds of the test review |

## Change a value

Edit `.agents/config.yaml` yourself and run `agent.sh config-check` (or `proofline doctor`). Two kinds of settings need your own edit, an agent does not write them:

- `security.advisory_check` sends package names and versions to a public service; it stays off until you set it by hand.
- `codex.sandbox.*` is a permission for Codex workers (network, a loopback test server, hand-over to the Claude implementer). The hook denies agent writes to the file as a tripwire; your review of config changes is the boundary. `init` and `upgrade` never change a value.
- Raising a budget (`review.max_fix_rounds`, `test_trust.mutation_budget`) is allowed, a lower value is always allowed. A plan or a batch approval can only raise them through the approvals that exist.

## Older project files

`proofline upgrade` adds keys your file lacks and never touches your values, comments or order. A project config therefore keeps its own text and may have no BASICS banner. `proofline doctor --config` does not read banners: it works from a built-in list of basic keys, so every project is listed the same way. A key your file lacks is shown with the shipped default.

## The advanced part

The ADVANCED banner of the shipped file starts the defaults: topology and autonomy per class, tasks and design documents, worktrees and the evidence archive, verification, test budgets, the database guard, the security extension, input validation words, the risk-adaptive pipeline, per-class pipelines, the light profile, the execution policy, night mode, timeouts and hooks, dispatch and project rules. Their meaning is in the comments of the file and in [timeouts](timeouts.md), [gates](gates.md), [testing](testing.md) and [limits](../limits.md).
