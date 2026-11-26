# Upgrading with runs in flight

`proofline upgrade` replaces the control plane of a project (`.agents/scripts`, skills, roles, hooks, git hooks) and merges new config keys. A project often has runs, a batch or unmerged worktrees open when the owner upgrades it. This page says when that is safe, what the upgrade refuses, what it saves and how to undo it (A371, issue 338 item U6). Nothing here installs a tool, reads the network or keeps hidden state: the upgrade source is the plugin or checkout the `proofline` command runs from, and the backups and ledger rows are plain files in the project.

## The commands

| Command | What it does |
|---|---|
| `proofline upgrade --check` | Writes nothing. Prints installed and new version, the state format verdict, the open runs, the batch and worktrees, the runs that hold gate results, the config keys it would add (and those it does not merge), the files it would change, and whether the upgrade would be refused. Exit 1 when it would be refused. |
| `proofline upgrade --dry-run` | The file plan only (as before). |
| `proofline upgrade` | Refuses (below) or: takes the project lock, backs up every file it replaces, replaces them, writes an `upgrade` ledger row per run, prints the runs whose gate results came from the older core and the next steps, and ends with the cheap self-checks (engine files, manifest, `config-check`, hook wiring). A FAIL there does not undo the upgrade; its line says what to fix. |
| `proofline upgrade --rollback` | Restores the newest backup. |

## What it refuses

It refuses, names each reason and writes nothing, while:

- a **specialist is running** (`.agents/local/submissions/<token>.started` in the main tree or any batch worktree): wait for its result;
- a **write window is open** (`.agents/local/windows/<token>`): it closes when the specialist stops; wait for it;
- a **control-plane command holds the lock** (`.agents/local/locks/shared.lock`, a worktree's `tree.lock`, a run's `.lock`, with a live pid; a lock whose holder is gone is stale and does not block): wait for it to finish. The upgrade itself holds `shared.lock` while it writes, so a command started meanwhile waits for it;
- the installed **state format is newer** than this version reads (a downgrade), whatever is open;
- the installed version is **newer than the one being installed** or **before the state format table starts (0.0.173)**, while a run or batch is open;
- a frozen open run **binds something the upgrade would change**: the freeze hashes the `risk.`, `performance.`, `security.` and `contract.` config lines, `.agents/modes/*.yaml` and the ecosystem files. (The shipped changes since 0.0.173 touch none of them.)

A **parked run, an open question and an active batch do not block**: their state is on disk and the new core reads it. A specialist whose `SubagentStop` never fired (the session was killed) leaves its `.started` marker and blocks the upgrade; the way out is the existing one (A351: `tree-inspect`, then the user's `tree-accept`).

## State format

`STATE_FORMAT` (a small integer in `core/upgradesafe.mjs`) names the shape of everything proofline keeps in a project. The installed one is the `# state_format:` line of `.agents/.proofline-manifest` (absent: 1 for an install from 0.0.173 on). The table: format 1 starts at 0.0.173 and every change after it is additive. A newer installed format is refused; an older one is read unchanged when each step to this one is additive; a step that is not would need a migration, and none exists yet, so the upgrade refuses it while state is open. The RUN.yaml and batch files are not stamped: the manifest stands for the project.

## What an upgrade saves

Before it writes, the upgrade copies every file it may replace (the files of the plan, the config, the manifest, the runtime settings, the AGENTS.md and CLAUDE.md blocks, `.gitignore`, the hook tree) to `.agents/local/upgrade-backup/<old>-to-<new>/files/` and lists what changed in `UPGRADE.tsv` (`replaced`, `removed`, `new` with the sha256 of the file the upgrade wrote). The last 2 backups are kept. `.agents/local` is git-ignored.

`--rollback` puts back every replaced and removed file and deletes every new one, but only a file that still holds what the upgrade wrote: a file you changed since is kept and listed. It refuses when the installed version is not the one the backup upgraded to, when the backup was already restored, and when a run exists that was not there at the upgrade (it was started with the new version). The `core.hooksPath` setting is not restored. The backup folder is not trusted: before anything is written every row of `UPGRADE.tsv` must name a plain relative path of the install set (never under `.agents/runs`, `.agents/local` or `.git`), neither the destination nor the backup copy may sit on a symbolic link, and the backup copy must still have the sha256 recorded when it was made; one bad row refuses the whole rollback. With `local_state: off` there is no backup, so `--rollback` says so. `proofline upgrade` (also `--check` and `--rollback`) is refused for every specialist by the PreToolUse hook: it is the user's command.

Each run with a lifecycle ledger gets one row, `event=upgrade ... detail=old=<v> new=<v> state_format=<n>` (a rollback writes `old=<new> new=<old> rollback=yes`). `proofline status` shows that the active run crossed an upgrade, and `proofline resume` shows the row in the ledger tail. The gates of an active run stay valid: they are bound to the plan hash, the tree and the read-sets, not to the core version. No gate is re-run; the output lists the runs whose gate results came from the older core so you can decide.

## State added since 0.0.173 (PRs 339 to 355)

Every item is additive. "New core, absent" is what the new core does with a project that lacks it (tested: `tests/core/upgrade-old-state.test.mjs` drives a run to CODE_DONE on the config shape of 0.0.173 and checks the key list). "Old core, present" is what a downgrade meets.

| Added | New core, absent | Old core (0.0.173), present |
|---|---|---|
| Config `output_cap_bytes`, `profiles.light.*` (new top-level keys) | built-in defaults (cap 6000; light profile: the shipped lists); `upgrade` adds them | `config-check` fails with `unknown top-level key` (checked in its source); the readers never look the keys up |
| Config `test_trust.review_rounds`, `review_minutes`, `execution_policy.repeat_model_cap.*` | built-in defaults (4 rounds, 120 minutes, no model cap); `upgrade` adds them | ignored (not tested) |
| Config `pipelines.COMPLEX.max_fix_rounds`, `mutation_budget` (and CRITICAL) | `upgrade` adds them at any depth under their existing block (the config merge is a deep additive merge: it never changes, removes or reorders what the project has); a project that sets its own lower global `max_fix_rounds` keeps it (C4) | ignored (not tested) |
| `.agents/local/standing/STANDING.tsv` (standing approvals) | no file means no standing approval | never written, never read |
| `.agents/local/batch/scopes.tsv` | a batch plan without it is not taken as the bound plan (it is made again) | not read |
| `<gate record>.readset` next to a gate record | a record without `readset_sha256` is derived at the comparison (the gate stays valid while its read-set is unchanged) | ignored |
| ledger rows `green-control`, `mutant-result`, `upgrade` | rows absent: the control plane has not run the commands itself, no mutants recorded: the gate asks for them | the seal checks the chain and the lifecycle digest only; an unknown event is carried |
| `ctx_*` and `denials` keys of the `tools.jsonl` records | the report prints no `Lead context` line without them | extra keys in a JSON line |
| `class` key of the run records in `.agents/local/metrics/records.jsonl` | the forecast does not count a record without it (`no history` until runs of the new version finish) | ignored |
| `.agents/local/submissions/<token>.run` | absent: the specialist is unknown, the old `.started` and window files still count | not read |
| `# state_format:` in the manifest | absent: 1 | an unknown `# key:` header line is skipped |

The `.started` and window files, the run folders, RUN.yaml, `LEDGER.log` and the gate records are the same shape as at 0.0.173.

## Not done yet

There is no migration framework (no non-additive change exists to migrate), the state files are not stamped with their format, and `--rollback` does not undo the `core.hooksPath` setting or a commit you made of the upgraded files.
