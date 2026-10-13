# Contributing to proofline

Thank you for helping. proofline is small on purpose: scripts decide, models propose. A contribution is judged
on whether it keeps that property.

## Set up

Requirements: a POSIX `sh`, Git, and Node.js 22.13 or newer for the skill tests. Nothing is installed into
the project; there is no build step.

```sh
git clone https://github.com/furkansarikaya/proofline
cd proofline
sh tests/selftest.sh                         # control-plane, enforcement, generator, CLI and task suites (a few minutes)
node --test tests/skills/                    # skill validators and fixtures' known answers
sh tests/fixtures/check-fixtures.sh          # builds every fixtures/*/setup.sh and runs its selfcheck
sh adapters/generate.sh --check              # generated agent files match roles/
sh docs/reference/generate-skills.sh --check # docs/reference/skills.md matches the skills
sh tests/shared/check-shared.sh              # shared skill sections have not drifted
```

`SELFTEST_ONLY=<suite>` runs one self-test suite; `LC_ONLY=<substring>` runs matching scenarios inside a suite.
The self-tests split every suite into scenario units and run them on all cores; `SELFTEST_JOBS=<n>` sets the
core count and `SELFTEST_SHARD=<i>/<n>` runs one slice (CI uses four).
CI additionally runs `shellcheck -s sh` over every shell script. A pull request that changes only plain
documentation (the root README, CHANGELOG, CONTRIBUTING, SECURITY; `.md`, `.png` and `.svg` files under `docs/` except `docs/reference/`) skips the
test jobs but still runs shellcheck and the sync checks; Markdown under `skills/`, `roles/`, `control-plane/`
and `adapters/` counts as code. Pull requests run Linux only; macOS runs on pushes to `main` and nightly.
End-to-end team runs are described in
[tests/e2e/README.md](tests/e2e/README.md); they use real agents and are not required for a pull request.

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
- Enforcement lives in `agent.sh` and the git hooks; runtime hooks only block earlier. A new rule starts in the
  script, with a test that really attempts the forbidden action (`tests/enforcement/`).

## New runtime support

Follow [writing an adapter](docs/guides/writing-an-adapter.md) and [adapters/README.md](adapters/README.md).
Support that you did not run end to end is labelled **not tested** in the README's support table; do not
claim more than the tests show.

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
- [ ] documentation updated, in English
- [ ] no EXPECTED file loosened; no organisation-specific or third-party project name added

To report a vulnerability, see [SECURITY.md](SECURITY.md).
