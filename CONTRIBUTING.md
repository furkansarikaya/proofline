# Contributing to proofline

Thank you for helping. proofline is small on purpose: scripts decide, models propose. A contribution is judged
on whether it keeps that property.

## Set up

Requirements: a POSIX `sh`, Git, and Node.js 22.13 or newer (a runtime requirement of proofline itself, not only of the skill tests). Nothing is installed into
the project; there is no build step.

Run locally (the `CI` variable unset), `tests/selftest.sh` and `tests/affected.sh` use half of the cores (at least one) and run under `nice`, so the machine stays usable; `SELFTEST_JOBS=N` sets the job count. With `CI` set (GitHub Actions does) they use every core at normal priority.

```sh
git clone https://github.com/furkansarikaya/proofline
cd proofline
sh tests/affected.sh                         # runs only the self-test units your changes can affect (--list prints them, --all selects everything)
sh tests/selftest.sh                         # control-plane, enforcement, generator, CLI, task and e2e-harness suites (16 suites, over 145 units; a few minutes)
node --test tests/skills/                    # skill validators and fixtures' known answers (about 740 tests)
sh tests/fixtures/check-fixtures.sh          # builds every fixtures/*/setup.sh and runs its selfcheck (42 passed, 1 skipped without vitest)
node --test tests/benchmark/benchmark.test.mjs            # benchmark report known-answer test (seconds)
sh adapters/generate.sh --check              # generated agent files match roles/
sh docs/reference/generate-skills.sh --check # docs/reference/skills.md matches the skills
sh tests/shared/check-shared.sh              # shared skill sections have not drifted
sh tests/shared/check-static.sh              # shortcut labels in code comments, README size bound, third-party names
sh tests/ci/sync-design-library.sh --check   # design library copies are byte-identical to their pins (network; DESIGN_LIBRARY_MIRROR=<dir> uses a local mirror)
node --test tests/skills/frontmatter.test.mjs # front matter, YAML/TOML and Markdown links (also run alone by CI)
```

`SELFTEST_ONLY=<suite>` runs one self-test suite; `LC_ONLY=<substring>` runs matching scenarios inside a suite.
The self-tests split every suite into scenario units and run them on all cores; `SELFTEST_JOBS=<n>` sets the
core count and `SELFTEST_SHARD=<i>/<n>` runs one slice (CI uses sixteen).
CI additionally runs `shellcheck -s sh` over every shell script. A pull request that changes only plain
documentation (the root README, CHANGELOG, CONTRIBUTING, SECURITY; `.md`, `.png` and `.svg` files under `docs/` except `docs/reference/`) skips the
test jobs but still runs shellcheck, the sync checks and the core-invariant tests (`sh tests/invariants/invariants-test.sh`, see Core invariants); Markdown under `skills/`, `roles/`, `control-plane/`
and `adapters/` counts as code. Pushes to `main` and pull requests run Linux only (about 8 minutes of wall time, A109); macOS runs nightly and on manual runs (A164).
A pull request that changes hooks, skills, roles or the control plane also runs the real-session smoke test (A195) and pastes its table:
`sh tests/real-session/smoke.sh` drives a real Claude Code session with a cheap model through `/proofline run`, `deliver` and a two-task
`batch` in a throwaway repository and prints a PASS/FAIL table (a few minutes of model time; it is not part of CI). Do not merge on a table
that is not all PASS. The table counts for the LAST commit that will be merged: if a commit that changes product code (hooks, skills, roles, control plane, adapters) arrives after the smoke, re-run the affected smoke steps and write the result in the pull request description. A change to the Codex sandbox profile also runs `sh tests/real-session/codex-sandbox.sh` (no model; needs the Codex CLI) and `SMOKE_ONLY=codex sh tests/real-session/smoke.sh`.
End-to-end team runs are described in
[tests/e2e/README.md](tests/e2e/README.md); they use real agents and are not required for a pull request.
The benchmark report (`node tests/benchmark/benchmark.mjs`, see [tests/benchmark/README.md](tests/benchmark/README.md))
scores recorded fixture and e2e results per skill; pull requests run only its own test.

## Rules

- **Every behaviour change is a decision.** Add an entry to [docs/decisions.md](docs/decisions.md) (next free
  `A<n>`): what changed, why, and the alternatives rejected.
- **Markdown under `skills/**`, `roles/**`, `control-plane/**` and `adapters/**` is reviewed like code.** It is
  what the agents execute. Regenerate derived files (`sh adapters/generate.sh`,
  `sh docs/reference/generate-skills.sh`) and commit them.
- **Every new user-visible command, option or rule updates the documentation before merge** (A153): `proofline help` (`bin/proofline`), the entry skill (`skills/proofline/SKILL.md`: argument-hint and routing), the lead Commands table (`skills/proofline-lead/SKILL.md`), the README (command list, and a short explanation of a new rule) and the relevant `docs/concepts` page. The README says what proofline is and how to use it; detail goes to `docs/concepts` (`tests/shared/check-static.sh` bounds the README size). The CLI test compares `proofline help` with the entry skill, the lead table and the README command list.
- **EXPECTED files are never loosened to fit a result.** If an expectation contradicts the design, say so in the
  pull request and let the maintainer decide; fix the product, not the answer key.
- **Read `.out-of-scope/README.md` before proposing or implementing a feature.** A request that matches a Rejected entry is not implemented and the user is told which entry it matches; a Deferred entry is not built as a side effect of other work. Changing an entry needs a user decision recorded in [docs/decisions.md](docs/decisions.md).
- **No file sharing between skills.** A skill is installable alone; shared rules are copied into each skill
  and checked by `tests/shared/check-shared.sh`.
- **No organisation-specific names, rules or paths** anywhere in the repository, and no third-party project
  names (see D33). The single exception is a notice file that a licence requires
  (`skills/ui-design/library/THIRD_PARTY_NOTICES.md`) and the byte-identical data copies it lists, which carry the
  sources' own strings. `tests/shared/check-static.sh` reads the names from the notices file and fails when one
  (in any case or hyphenation) appears in any other file; it skips exactly the files listed there. Everywhere else refer to "source 1" and "source 2".
- **Everything in the repository is English**, including comments, fixtures and test names; the only
  exception is the Turkish translation of the user guides under `docs/guides/tr/`.
- The repository's own `.gitignore` ignores `.claude/` entirely (local agent state, progress notes, evaluations,
  worktrees). `proofline init` never adds `.claude/` to the `.gitignore` of an installed project; a CLI test checks it.
- Enforcement lives in `agent.sh` and the git hooks; runtime hooks only block earlier. A new rule starts in the
  script, with a test that really attempts the forbidden action (`tests/enforcement/`).

## Core invariants

These six rules are the boundary of every patch. No speed-up, convenience or refactoring may loosen them. A patch that seems to need an
exception does not make it: it stops and asks the maintainer.

1. A run is never CODE_DONE until every required gate has passed for the current content, or the user has explicitly waived it.
2. SECRETS and SECURITY are never waived, and they run on every round that changes product code, dependencies or configuration.
3. Approvals and waivers are recorded only from the user's message. No agent can produce an approval, a waiver, or a rationale that overrides a finding.
4. Evidence is reproduced independently. An agent's claim is not evidence.
5. The agent that wrote a change never reviews it.
6. In doubt, the safe side wins: the gate runs, the question is asked, the finding stays blocking.

Each rule has at least one test in [tests/invariants/](tests/invariants/) that really attempts the forbidden action against the real
`agent.sh`. CI runs the suite on every pull request, documentation-only ones included. A rule that cannot yet be tested mechanically is
named in the header of `tests/invariants/invariants-test.sh` (its "Not yet mechanical" list) instead of being faked.
A patch that changes anything under `tests/invariants/` must say why in the pull request description, on a line that starts with
`Invariant-test-change:`, and the review approves that change separately from the rest of the patch. `tests/invariants/check-changed.sh`
fails the pull request otherwise. Locally: `sh tests/invariants/invariants-test.sh`, and `PR_BODY="..." sh tests/invariants/check-changed.sh < changed-paths.txt`.

The text proofline loads into every session (the AGENTS.md and CLAUDE.md blocks, the SessionStart text, the entry skill, each role's agent
file and first skill) has a size budget (A202): `sh bin/lib/context-size.sh repo .` measures it, `tests/context/budget.tsv` holds the limits and
`tests/context/context-budget-test.sh` fails a patch that grows an item above its limit. A patch that changes the budget file says why on a line
that starts with `Context-budget-change:` (`tests/context/check-budget-changed.sh`). A rule that leaves the AGENTS.md block gets a row in
`tests/context/rule-map.tsv` with its new place.

## New runtime support

Follow [writing an adapter](docs/guides/writing-an-adapter.md) and [adapters/README.md](adapters/README.md).
Support that you did not run end to end is labelled **not tested** in `tests/e2e/README.md`; do not
claim more than the tests show.

## Development process

How work is split between agents in this repository.

- The lead plans, dispatches, merges results and decides. The lead does not write code, docs or tests.
- Every change goes to a separate implementer sub-agent. A separate test sub-agent writes self-tests, skill
  tests and fixtures. A separate review sub-agent checks the diff against `docs/decisions.md` and the task.
  The author never reviews its own work; the reviewer never fixes.
- An e2e evaluator is always a different agent from the one that ran the scenario and from the one that
  wrote the fix.
- Models: lead Opus; implementer, test and review Sonnet; Opus advises on hard design decisions.
  Sub-agents return a compact result only: findings and file paths.
- Agents work in their own worktrees, never in the main checkout.
- Leads and sub-agents never read `docs/decisions.md` end to end (it is over 500 KB): `grep -n "^## A<n>\|<keyword>" docs/decisions.md` for the relevant `A` entries and read only those.
- A review FAIL returns its findings to the same implementer, at most 2 rounds. Then that job stops, is
  reported, and other jobs continue.
- One branch and one pull request per job. Merge when CI is green; no direct push to `main`. Green is checked by
  script, not only asked for (A136): the merge path is `bin/proofline merge <PR>`, which merges only when every check of the
  pull request is SUCCESS on its current head. The runtime hook denies `gh pr merge` (always `--admin` and `--auto`), merge
  endpoints of `gh api`, and `git merge` on or `git push` to `main`, for the common spellings (A136 lists what it cannot
  see). GitHub branch protection with required status checks is the fail-closed backstop and stays on. The hook must be
  wired in the lead's session (the plugin hook does it).
- Progress is kept in `.claude/progress.md`, so an interrupted session resumes from it.
- Codex integration checks never run full scenarios and never run in parallel. A Codex lead uses the base model
  (`gpt-6-sol`, A135); the cheapest model applies to workers only. They use the lowest reasoning effort (A100),
  a hard call cap, and stop on the first quota error.

## Working agreement

How the lead works with sub-agents. Later releases cite this section.

- The lead plans, hands work to sub-agents and merges their results. Code is written by implementers, and the
  agent that wrote a change never reviews it.
- Review: a FAIL goes back to the same implementer for at most 2 rounds. The 3rd round is done by a new
  implementer. After that, only findings that break default usage stop a merge. A re-review looks only at the
  lines changed since the last review.
- Agent hygiene: close a finished sub-agent at once; run at most 3 sub-agents at the same time; start no new
  agents while waiting for CI; close only processes you started yourself.
- Commits use the identity `furkansarikaya@users.noreply.github.com`.
- A cheap model does mechanical work; a strong model does design and review.
- A sub-agent reply is at most 15 lines.

## Test policy

- Agents run only `sh tests/affected.sh` locally. The full self-test is CI's job, and a pull request is merged
  when CI is green.
- The Core invariants suite, the equivalence rig, the Node tests and the static checks are never skipped, not even by the CI fast mode below.
- Tests run quiet: they print failures and one summary line.
- A new validator gets one valid example and one or two invalid examples.
- No test calls a model and there is no end-to-end test in CI.
- The number of tests is not a goal.

### Temporary CI fast mode (Node migration)

What: while `tests/ci/fast-mode.txt` exists and is not expired, a pull request skips the legacy self-test shards, the fixtures job and the skill tests step. Why: a user decision of 2026-10-31, so that the Node migration stage 1 pull requests are not held by the hour-long legacy self-test. Safeguards: the invariants (context budget included), equivalence, Node tests, type check and static checks always run; pushes to main, the nightly run and manual runs run everything; `tests/ci/fast-mode.mjs` validates the file and the `changes` job fails after the expiry. It expires 2026-11-07 or when stage 12 lands, whichever is first. Removal: delete `tests/ci/fast-mode.txt`.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, with the decision
  number in the subject or body, for example `fix(hooks): deny agent.sh approve to every model (A41)`.
- Optional trailers (`Constraint`, `Rejected`, `Confidence`, `Scope-risk`, `Not-tested`) record the reasoning
  when it is not obvious from the diff.
- One concern per pull request, on its own branch.

Pull request checklist:

- [ ] CI is green (the full self-test, skill tests and fixtures are CI's job; locally run `sh tests/affected.sh`)
- [ ] generated files are in sync (`--check` commands above)
- [ ] a decision entry in `docs/decisions.md` for every behaviour change
- [ ] a test that fails without the change
- [ ] the smoke table ran on the last commit that will be merged; a later commit that changes product code had the affected smoke steps re-run, and the result is in the description
- [ ] help, entry skill, lead Commands table, README and `docs/concepts` updated for every new user-visible command, option or rule
- [ ] documentation updated, in English; any test count, CI time or end-to-end result you quote is current, and an end-to-end result carries its date and `main` commit
- [ ] `tests/e2e/README.md` holds every end-to-end result, and the README "Status" section claims no more than those tests show
- [ ] no core invariant loosened; a change under `tests/invariants/` carries an `Invariant-test-change:` line in the description and was approved separately in review
- [ ] no EXPECTED file loosened; no organisation-specific or third-party project name added

## Versions

Every fix round that reaches users raises the patch version (0.0.3 to 0.0.4, and so on) in the same pull request; 0.x.0 is for new features or behaviour changes, and 1.0.0 is not planned yet. A release pull request runs `sh tests/ci/bump-version.sh <new-version>` (A168), never a global search-and-replace: that rewrote history comments in 0.0.25. `sh tests/ci/bump-version.sh --check` fails when a site disagrees with `.claude-plugin/plugin.json`. The script:

- changes the version everywhere it appears, and nothing else: `bin/proofline` (`PROOFLINE_VERSION`), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `control-plane/agents/config.yaml`, `playground/package.json`, every `skills/*/SKILL.md` (`metadata.version`), the `SKILL_VERSION` constants in `skills/exploit-proof/scripts/diff-manifests.mjs` and `skills/proof-review/scripts/check-config.mjs`, the README status lines, the heading in `adapters/README.md`, `docs/reference/skills.md` (regenerate: `sh docs/reference/generate-skills.sh`), the version example in `skills/proof-review/references/REPORTING.md`, the fixtures `fixtures/concurrency-proof/selfcheck.sh` and `fixtures/insights/setup.sh`, and the pinned versions in `tests/cli/cli-test.sh` and `tests/skills` (concurrency-proof, proof-review, data-design, proofline-lead). It never touches comments, prose or code that say when something was introduced;
- moves the `Unreleased` entries of `CHANGELOG.md` under a new `## <version> — <date>` heading.

Check with `git grep -n "<old version>"`: only history (`CHANGELOG.md`, `docs/decisions.md`, `docs/skills/`, dated results in `tests/e2e/README.md`) may still name it.

To report a vulnerability, see [SECURITY.md](SECURITY.md).
