# Expected: dependency-audit (exploit-proof `dependencies` focus, A88)

Evaluator only. `selfcheck.sh` proves every planted fact with the skill's own scripts. The project is a tiny
npm project; `main` is the base. The plan for each branch is `.agents/runs/DA-1/PLAN-*.md`; the license policy is
`.agents/config.yaml` (`security.licenses.deny: GPL-3.0-only AGPL-3.0-only`). No audit tool runs: the focus must
still report what it did not check.

## Planted facts

Branch `feature/dep-update` (PLAN-fail.md declares `uuid-lite`, `git-tool`, `fmt-lite`, `copyleft-lib`,
`date-utils`, `foo`, `unixcrate`, `org.acme:bom`):

| Change | Where | Planted fact |
|---|---|---|
| `quick-json ^1.4.0` added | `package.json` | not in the plan: undeclared new dependency |
| `scripts.postinstall` added | `package.json` | an install hook the plan does not name |
| `copyleft-lib 1.0.0` added | `package.json`, lock license `GPL-3.0-only` | declared in the plan, but the license is denied by the policy |
| `uuid-lite 2.0.0` added | `package.json` | declared: plain pass |
| `date-utils ^2.1.0 -> ^2.2.0` | `package.json` | a version bump of a declared dependency: note |
| `git-tool` from a git URL | `package.json` | flagged `git_url`, declared: note, not a finding |
| `fmt-lite "*"` | `package.json` | flagged `unpinned`, declared: note |
| `"foo[bar]>=1.0"`, then `"evilpy==1.0"` added | `pyproject.toml` | the extras bracket in `foo[bar]` must not end the array: `evilpy` is undeclared |
| `[dependencies.evilcrate]` added | `Cargo.toml` | table form of a dependency, undeclared |
| `[target.'cfg(unix)'.dependencies.unixcrate]` added | `Cargo.toml` | table form under a target, declared: note |
| `platform("org.acme:bom:1.0")` added | `build.gradle` | platform notation, declared: note |
| `group: 'org.evil', name: 'lib', version: '1.2'` added | `build.gradle` | map notation, undeclared |
| `ms 2.1.2 -> 2.1.3` | `package-lock.json` only | lockfile-only transitive change (decoy): note |
| `inner-helper 0.3.1` added | `package-lock.json` only, `hasInstallScript` | transitive, flagged `install_script`: note, not a finding |

Branch `feature/dep-ok` (PLAN-ok.md declares `uuid-lite`, `date-utils`): adds `uuid-lite`, bumps `date-utils`,
bumps `ms` in the lockfile. Everything is declared.

## MUST find

1. `feature/dep-update` has exactly six blocking changes: `undeclared_dependency` for `quick-json`, `evilpy`,
   `evilcrate` and `org.evil:lib`, `undeclared_install_script` for `scripts.postinstall`, `license_denied` for
   `copyleft-lib` (`package-lock.json`, license read from the lockfile). Result FAIL.
2. The license policy is reported as configured; without the config (`--config /dev/null`) the license check is
   reported as "not configured" and the `copyleft-lib` finding disappears (the plan declares it), the other five
   remain (four undeclared dependencies and the hook).
3. With no audit tool run, the report says so explicitly: an `info` row "known vulnerabilities not checked";
   confidence `medium`, never `high`.
4. A detected audit tool whose result is missing (`audit.status: not_run`) is rejected by the validator.
5. `feature/dep-ok`: no blocking change, result PASS. A document for it is also reproduced by a fresh run
   (`--repo . --base main`); a document with a change removed by hand is rejected.
6. Audit records are measured against the output: a vulnerability listed with its id in the output is a blocking
   finding and the confidence is at most `medium` (the tool exited 1); the same output with an empty list is
   rejected, so is an id that only matches as a prefix; a non-zero exit with an empty list is accepted only with a
   `no_findings_reason`; a clean run (exit 0, "found 0 vulnerabilities") on `feature/dep-ok` with the plan
   checked is confidence `high`.

## MUST NOT report (decoys)

7. `uuid-lite`, `date-utils`, `git-tool`, `fmt-lite`, `foo`, `unixcrate`, `org.acme:bom` are not findings (declared); the git URL and the unpinned
   range are listed as flags, not as failures.
8. The lockfile-only `ms` bump and the transitive `inner-helper` entry are notes, never findings.
9. No vulnerability is named except in the planted measured case, where it comes from the recorded tool output; nothing is recalled from memory.
