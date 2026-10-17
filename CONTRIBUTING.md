# Contributing to proofline

Thank you for helping. proofline is small on purpose: scripts decide, models propose. A contribution is judged
on whether it keeps that property.

## Set up

Requirements: a POSIX `sh`, Git, and Node.js 22.13 or newer for the skill tests. Nothing is installed into
the project; there is no build step.

```sh
git clone https://github.com/furkansarikaya/proofline
cd proofline
sh tests/selftest.sh                         # control-plane, enforcement, generator, CLI, task and e2e-harness suites (16 suites, over 145 units; a few minutes)
node --test tests/skills/                    # skill validators and fixtures' known answers (about 740 tests)
sh tests/fixtures/check-fixtures.sh          # builds every fixtures/*/setup.sh and runs its selfcheck (42 passed, 1 skipped without vitest)
node --test tests/benchmark/benchmark.test.mjs            # benchmark report known-answer test (seconds)
sh adapters/generate.sh --check              # generated agent files match roles/
sh docs/reference/generate-skills.sh --check # docs/reference/skills.md matches the skills
sh tests/shared/check-shared.sh              # shared skill sections have not drifted
node --test tests/skills/frontmatter.test.mjs # front matter, YAML/TOML and Markdown links (also run alone by CI)
```

`SELFTEST_ONLY=<suite>` runs one self-test suite; `LC_ONLY=<substring>` runs matching scenarios inside a suite.
The self-tests split every suite into scenario units and run them on all cores; `SELFTEST_JOBS=<n>` sets the
core count and `SELFTEST_SHARD=<i>/<n>` runs one slice (CI uses four).
CI additionally runs `shellcheck -s sh` over every shell script. A pull request that changes only plain
documentation (the root README, CHANGELOG, CONTRIBUTING, SECURITY; `.md`, `.png` and `.svg` files under `docs/` except `docs/reference/`) skips the
test jobs but still runs shellcheck and the sync checks; Markdown under `skills/`, `roles/`, `control-plane/`
and `adapters/` counts as code. Pull requests run Linux only (about 8 minutes of wall time, A109); macOS runs on pushes to `main` and nightly.
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
- **EXPECTED files are never loosened to fit a result.** If an expectation contradicts the design, say so in the
  pull request and let the maintainer decide; fix the product, not the answer key.
- **No file sharing between skills.** A skill is installable alone; shared rules are copied into each skill
  and checked by `tests/shared/check-shared.sh`.
- **No organisation-specific names, rules or paths** anywhere in the repository, and no third-party project
  names (see D33).
- **Everything in the repository is English**, including comments, fixtures and test names; the only
  exception is the Turkish translation of the user guides under `docs/guides/tr/`.
- The repository's own `.gitignore` ignores `.claude/` entirely (local agent state, progress notes, evaluations,
  worktrees). `proofline init` never adds `.claude/` to the `.gitignore` of an installed project; a CLI test checks it.
- Enforcement lives in `agent.sh` and the git hooks; runtime hooks only block earlier. A new rule starts in the
  script, with a test that really attempts the forbidden action (`tests/enforcement/`).

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

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, with the decision
  number in the subject or body, for example `fix(hooks): deny agent.sh approve to every model (A41)`.
- Optional trailers (`Constraint`, `Rejected`, `Confidence`, `Scope-risk`, `Not-tested`) record the reasoning
  when it is not obvious from the diff.
- One concern per pull request, on its own branch.

Pull request checklist:

- [ ] `sh tests/selftest.sh`, `node --test tests/skills/` and `sh tests/fixtures/check-fixtures.sh` pass
- [ ] generated files are in sync (`--check` commands above)
- [ ] a decision entry in `docs/decisions.md` for every behaviour change
- [ ] a test that fails without the change
- [ ] documentation updated, in English; any test count, CI time or end-to-end result you quote is current, and an end-to-end result carries its date and `main` commit
- [ ] `tests/e2e/README.md` holds every end-to-end result, and the README "Status" section claims no more than those tests show
- [ ] no EXPECTED file loosened; no organisation-specific or third-party project name added

## Versions

Every fix round that reaches users raises the patch version (0.0.2 to 0.0.3, and so on) in the same pull request; 0.x.0 is for new features or behaviour changes, and 1.0.0 is not planned yet. A release pull request:

- changes the version everywhere it appears, and nothing else: `bin/proofline` (`PROOFLINE_VERSION`), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `control-plane/agents/config.yaml`, `playground/package.json`, every `skills/*/SKILL.md` (`metadata.version`), the `SKILL_VERSION` constants in `skills/exploit-proof/scripts/diff-manifests.mjs` and `skills/proof-review/scripts/check-config.mjs`, the README status lines, the heading in `adapters/README.md`, and the version checks in `tests/cli/cli-test.sh`;
- moves the `Unreleased` entries of `CHANGELOG.md` under a new `## <version> — <date>` heading.

Check with `git grep -n "<old version>"`: only history (`CHANGELOG.md`, `docs/decisions.md`, `docs/skills/`, dated results in `tests/e2e/README.md`) may still name it.

To report a vulnerability, see [SECURITY.md](SECURITY.md).
