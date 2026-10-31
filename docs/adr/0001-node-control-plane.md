# ADR 0001: move the control plane, hooks, CLI and tests from shell and awk to Node

- **Status:** accepted as a plan (A204). No code moves with this record; each stage below is its own pull request and patch release.
- **Date:** 2026-10-31, proofline 0.0.40 (`main` at 7acdba5).
- **Companions:** [0001-inventory.md](0001-inventory.md) (what exists today, condensed), [0001-stages.md](0001-stages.md)
  (one section per stage, the source for the GitHub issues).

Numbers in this record come from four inventories made before the decision ("inventory"); "measured" means counted with a
PATH shim that logs every external program a command starts (macOS, BSD userland). Estimates are labelled as estimates.

## 1. Context

proofline's decisions are made by scripts, not by models. Those scripts are POSIX `sh` and awk: 172 `.sh` files and three
extensionless shell files, about 44,900 lines, of which 78 files contain awk. The centre is
`control-plane/agents/scripts/agent.sh`: 9,170 lines, 132 commands, 611 functions, 13 sibling scripts it calls as child
processes. The runtime hook (`adapters/claude/hooks/proofline-hook.sh`, 2,609 lines) runs on every tool call of Claude Code and
Codex. Tests are shell too: 49 suites split into 459 units in 16 CI shards, 21,006 s of single-core work by the weights file.

Shell made proofline easy to install (nothing to build, nothing to install) and easy to read in small pieces. It now costs more
than it saves:

1. **Process cost is structural.** Every hash, `stat`, field read and glob test is a process. Measured:

   | path | processes | wall |
   |---|---|---|
   | prompt that records an approval (hook + `agent.sh approve-pending`) | 544 | 3.4 s |
   | PreToolUse for one Bash call | 39-45 | 0.7 s |
   | SessionStart with an open run | 130 | 3.3 s |
   | `agent.sh next`, 0 / 60 extra changed files (2-file fixture) | 68-193 / 1,930 | 2.3-4.6 s / 18.3 s |
   | `agent.sh publish-completion-report` | 1,754 | 34 s |
   | `agent.sh record` (one gate result) | 449-459 | 8 s |
   | one run of 101 `agent.sh` calls | 9,384 | 189 s |

   `verify-seal` starts one `shasum` per ledger line (67 processes at 63 lines). Changed-path loops are quadratic (paths times
   baseline entries). The approval path grew from 206 processes (A188) to 544: each correct addition adds processes.
2. **Duplication.** The config parser exists four times (agent.sh, `bin/lib/config.sh`, the hook, the git hooks), the JSON string
   codec three times, SHA-256 helpers three times, the ecosystem definition in three forms (JSON, TSV for awk, five `.mjs` copies)
   plus three `ecosystems.sh` copies. Tests compare awk programs textually to keep two parsers equal.
3. **Correctness hazards that shell makes cheap to create:** `set -e` is off inside `if`/`&&`/`||`, so five places work around it
   with background subshells and nested `sh agent.sh` re-invocations; awk dialect differences (interval expressions, byte classes
   that hold only under `LC_ALL=C`); GNU/BSD `stat`, `date`, `ps` differences; seven places in the tests extract code or values
   from `agent.sh` text with `sed`/`awk` (at least four of them `eval` a function body).
4. **Windows has no path.** No file handles Windows paths; a `C:\...` path from the runtime is not treated as absolute (inferred:
   every Edit or Write during a run would be denied). The README says "use WSL or Git Bash". A nightly job only measures hook
   timing in Git Bash; at the inventory's 20-50 ms per process, one approval costs 11-27 s against a 20 s budget (estimate).
5. **Node is already there.** 149 Node files (32,364 lines) already ship, with no npm package; 79 of them are skill scripts. `freeze`,
   `record` and `knowledge-done` already run Node validators, and the hook already uses `jq` or `node` for JSON.

## 2. Decision

Each line is one decision; A204 records, per line, which Core invariant it does not loosen.

- **D1. One Node entry point, `proofline-core`.** `control-plane/agents/scripts/proofline-core.mjs`, installed as
  `.agents/scripts/proofline-core.mjs`. The 132 `agent.sh` commands become its subcommands one to one: same names, arguments,
  stdin, stdout, stderr, exit codes and files written. The sibling scripts become further subcommands (for example `dispatch`).
  The module exports `run(argv, io)` so the hook and the CLI call it in process, without a child process.
- **D2. Take over command by command behind the existing entry files.** `agent.sh` and every sibling script stay at their paths
  as wrappers: a command that has moved is delegated to `proofline-core`; a command that has not moved runs the old shell code.
  The old code of a moved command stays untouched as the fallback until stage 10 removes it.
- **D3. Nothing on disk changes.** Same ledger, approval, answer, waiver, gate, evidence and decision records, run folder, config,
  task files, hash chain, locks and every other format (inventory, section 3 of the `agent.sh` inventory). A run started under
  0.0.40 continues under any stage, and a rollback to an earlier stage or to 0.0.40 continues a run started under a later one.
- **D4. Node 22.13 or newer, Node's own libraries only, no npm package at runtime.** `proofline doctor` checks the version;
  proofline never installs Node.
- **D5. An equivalence rig decides every takeover.** Old and new code run side by side on the same fixtures and recorded command
  traces; stdout, stderr, exit code and every written file are compared exactly, after a closed normalisation list; in CI.
- **D6. The Core invariant suite passes unchanged at every stage, on both engines.** It is ported to Node only in stage 13, under the
  `Invariant-test-change:` rule, and the shell copy keeps running beside the Node copy until stage 15.
- **D7. Hooks run as one Node process per event.** The approval capture writer (hook) and its readers (`approve`, `answer`, the
  Stop hook) move in the same stage and keep the exact bytes, pinned by committed golden files. While the shell hook still runs
  (stages 1-3), a moved command that fails (exit 127 because Node is missing, or any non-zero exit) makes the guard that needed it deny
  instead of silently switching off.
- **D8. Code form:** ESM, `// @ts-check` with JSDoc types, a type checker that runs in CI only, `node:test`, structured errors with
  the existing message text, platform-independent paths.
- **D9. Speed:** one process per command; external programs only where truly needed; each file read and parsed once per command
  invocation; one spawn wrapper module through which every child process goes, so tests count and budget spawns.
- **D10. Only launchers remain.** At the end no shell or awk with logic remains anywhere in the repository; the files listed under
  [Launchers](#9-launchers-and-the-no-shell-logic-rule) only start Node. A CI check enforces it, as a shrinking allowlist from
  stage 1 and as a strict rule from stage 15.
- **D11. Windows runs without Git Bash for proofline's own logic** at the end (Git for Windows still provides git and runs git
  hooks); each stage states what a Windows user needs.
- **D12. One ecosystem reader.** Node reads `ecosystems.json` through `ecosystems.mjs`; `ecosystems.tsv` and the three
  `ecosystems.sh` copies are removed when their last reader is gone.
- **D13. Each stage is its own pull request and patch version, ends with the real-session smoke, and can be rolled back**: by an
  engine switch (a file in `.agents/local`, or an environment variable) until stage 10, by installing the previous release, and by a
  plain revert always (section 5.4).
- **D14. No new test seam reaches the product's decisions.** Test stubs stay files inside the fixture, as `test-lib.sh` writes them
  today; no `PROOFLINE_TEST*` variable may swap the secret scan, the execution policy, the task adapter or the clock.

## 3. What does not change

- Every file format and folder under `.agents/` (the list in D3), byte for byte, including `key: "value"` quoting, line order,
  the ledger line layout `seq= prev= event= role= from= to= digest= ts= epoch= detail=`, the `<subdir>/<name>@<sha256>` binding
  tokens, the RUN.yaml two-level layout and the fingerprint cache line.
- Command names, arguments, environment seams (`PROOFLINE_NO_TTY`, `PROOFLINE_LOCK_TIMEOUT`, `PROOFLINE_DISPATCH`,
  `PROOFLINE_PLATFORM`, `PROOFLINE_TEST`, `PROOFLINE_GH`, `PROOFLINE_UNAME`, `PROOFLINE_SESSION_PID` and the rest), output text
  (it is an API: `next` prints `key=value` lines other tools parse; `summary` line 1 is matched by `next-user` and the hook) and
  exit codes. The `usage` text keeps omitting the 16 commands it omits today.
- The spellings users and models type: `sh .agents/scripts/agent.sh <command>`, `sh .agents/scripts/dispatch.sh <ID> <role>`,
  `proofline <command>`.
- `config.yaml` keys and defaults, task files, the task adapter contract (shipped adapters become `.mjs`; a user-written
  `<name>.sh` adapter is still run).
- The lock protocol: `mkdir` locks with a `pid` file, the same paths, stale detection by liveness and the `lock-break` ledger event,
  so an old and a new process in the same project exclude each other.
- Behaviour that is not pretty but is relied on: read-only commands that remove stale dispatch markers or append to the fingerprint
  cache, `tier` writing for the lead, the worktree re-exec rule (A169), byte length under `LC_ALL=C`, byte-order sorting.

## 4. Node version

**Floor: Node 22.13.0.** Reasons:

1. It is the lowest release line the Node project still supports on the decision date: Node 18 reached end of life on 2025-04-30
   and Node 20 on 2026-04-30. A floor on an unsupported line would ask users to run a runtime without security fixes.
2. 22.13 is already the documented and CI-tested floor (CONTRIBUTING, `playground/package.json`, the e2e probe). One number
   for the whole repository; no second, lower floor that nobody tests.
3. The core needs nothing newer: `fs`, `path`, `crypto`, `child_process`, `node:test`, `util.parseArgs` and
   `module.enableCompileCache` all exist in 22.13. The 22.0-22.12 range would work by API evidence but would not be tested, and the
   gain is small.

CI tests the floor exactly (22.13.0) and the current active LTS line. Node 22 leaves support in April 2027; raising the floor then is a
new decision. `proofline doctor` reports the version and fails below the floor with a message that names it; `proofline init` refuses
below the floor. proofline never installs or upgrades Node (`.out-of-scope/installing-or-removing-tools.md`): it detects, uses and
says clearly what is missing.

Today CONTRIBUTING says Node is needed for the skill tests only. After stage 1 Node is a runtime requirement (the first moved
commands run on every hook event). Stage 1, not this record, changes CONTRIBUTING and the README.

## 5. Architecture

### 5.1 Layout

```text
control-plane/agents/scripts/
  agent.sh                 wrapper, then (stage 10) launcher
  proofline-core.mjs       entry: argv, role gate, locks, the command table, run(argv, io)
  core/
    proc.mjs               the only module that imports node:child_process (see 8.1)
    errors.mjs             ProoflineError: code, message (the existing text), exit code
    paths.mjs              root and worktree resolution, POSIX form for stored paths, Windows input paths
    clock.mjs              now(), with the test clock seam
    hash.mjs               SHA-256 over bytes and files (node:crypto)
    lock.mjs               the mkdir lock protocol of agent.sh
    config.mjs             the one config reader (replaces four)
    records.mjs            key: value records, RUN.yaml, ledger, manifests, TSV proposals
    context.mjs            per-invocation read-once cache
    git.mjs                the git queries, through proc.mjs
    commands/<area>.mjs    handlers, one module per inventory area
adapters/claude/hooks/proofline-hook.mjs   the hook; imports the project's core in process
bin/proofline, bin/lib/*.mjs               the CLI; imports the project's core in process
```

The hook and the CLI import the core of the project they act on (`<root>/.agents/scripts/proofline-core.mjs`), as they call that
project's `agent.sh` today, so a plugin and a project of different versions behave as they do now (A194).

### 5.2 One command invocation

`run(argv, io)` does what `agent.sh` does, in the same order: resolve the root (and the worktree re-exec rule, A169), check the
role (`valid_role`, `cmd_allowed`), take the locks for non-read-only commands, run the handler, release the locks. A handler never
calls `process.exit`; it returns an exit code or throws a `ProoflineError`. The `io` object carries env, cwd, stdin and the two
output streams, so the hook can run several commands in one process with separate outputs.

The cache in `context.mjs` lives for one invocation and is dropped at its end, even inside one hook process: A203 rejected caching
across commands (stale answers). A writer updates or drops the cached value it changed.

### 5.3 Delegation and the engine switch (stages 1-9)

`agent.sh` gains a short preamble before any parsing: when the command is in the moved list and the engine is not forced to
shell, it runs `exec node "$(dirname "$0")/proofline-core.mjs" "$@"`. Sibling scripts get the same preamble.

- **The engine switch** is read by the `agent.sh` preamble, the sibling scripts, the hook and the git hooks from two places; either one
  forcing the old code wins:
  - the file `.agents/local/engine` (one line: `sh` for every command, or `sh:<command>,<command>` for single commands; in a worktree
    the main tree's file). A file is the switch for users because a hook process is started by the runtime, not by the user's shell,
    and may not see an `export` made after the session started; `.agents/local` is already protected from model writes by the hook.
    `proofline doctor` prints the active switch.
  - `PROOFLINE_ENGINE=sh` and `PROOFLINE_ENGINE_SH=<command>,<command>` in the environment, for CI and tests.
- The hook denies a model's command that assigns `PROOFLINE_ENGINE*` or `PROOFLINE_TEST*` (a tripwire; see section 7).
- The core runs a command it does not own yet by calling the old code through `proc.mjs` (`sh agent.sh` with the engine forced to
  shell), so nothing loops. These bridge calls are counted and shrink to zero by stage 10.
- **The shell hook fails closed on a moved command.** Today the shell hook drops failures of `hook-config`, `db-config` and
  `config-get` (`proofline-hook.sh` lines 959, 977, 1331: `|| return 1`, `|| : >`, `|| mg_cb=''`), so the database guard and the
  merge guard fall back to empty settings. Once those commands run in Node, a missing `node` would switch the guards off silently.
  From stage 1 until the hook itself moves (stage 3): while a run exists, a tool call whose guard needs a moved command is denied when
  that command exits 127 or any other non-zero code, with a message that names the command and says to check `node` (22.13 or newer)
  on PATH; the merge guard, which protects the canonical branch also without a run (A136), denies the same way in an installed project.

### 5.4 Rollback, concretely

1. **Switch** (stages 1-9): write `sh` into `.agents/local/engine` (or set `PROOFLINE_ENGINE=sh` for a CI job). Every later command,
   hook event and git hook runs the old code; run state is untouched because no format changed.
2. **Install the previous release.** Verified by reading `bin/lib/install.sh`: `proofline upgrade` installs the tree of the checkout it
   runs from, whatever its version. It stages that checkout, keeps files the user modified, and removes unmodified files that the
   project's manifest lists and the staged tree does not ship; `config.yaml` keeps its keys (`cfg_merge_new` only adds missing ones) and
   `proofline_version` is set to the checkout's version. There is no version guard and no test of a downgrade today. Stage 1 adds a
   downgrade test: a project installed from the stage's checkout, with a run in flight, is upgraded from the previous release's checkout
   and the run continues to DONE. Hook wiring after a downgrade: the old installer merges by string equality and adds its old string
   beside the new one; the Node hook then yields (section 9).
3. **Revert** the stage's pull request.
4. **Sessions that run across stage 10.** A session keeps the hook strings it read at its start. A session started on a release before
   stage 3 holds strings that run `.agents/hooks/proofline-hook.sh` (project form) or the plugin's `proofline-hook.sh` (plugin form). If
   that file were deleted, the project form would block every tool call (its PreToolUse guard exits 2) and the plugin form would fail
   open (`sh` cannot open the file). So `proofline-hook.sh` stays after stage 10 as a launcher (`exec node .../proofline-hook.mjs "$@"`)
   until stage 15, and the plugin form gets the fail-closed guard of the project form (section 9).

## 6. The equivalence rig

A command moves to Node only when the rig shows it behaves the same.

**Inputs.**

1. *Scenario cases* in `tests/equivalence/cases/`: a fixture built with the existing scaffolds (`scaffold orchestrated COMPLEX`
   and the rest), the `perf-test.sh` fixture (frozen COMPLEX run, 120 extra ledger lines, 30 result files), the scaling fixture of the
   inventory (0, 20, 60 changed files), then a list of commands.
2. *Trace replay*: with `PROOFLINE_TRACE=<dir>` the `agent.sh` wrapper records argv, cwd, the environment seams, stdin bytes and a
   content-addressed snapshot of the project before each call. Every call that one CI run of the self-tests executes becomes a case
   (the suites hold about 2,587 helper calls to `agent.sh` by a static count; the executed number is measured in stage 1).
3. *Alternating engines*: one run lifecycle where calls alternate between engines (old, new, old, ...), compared with the same
   lifecycle on the old engine only. This is the test of D3: a run continues across an upgrade and across a rollback.
4. *Node absent*: the same hook events and git-hook calls with `node` removed from PATH. The expected result is not equality but the
   safe side: during a run every guard that needs a moved command denies (stages 1-3), `agent.sh` exits non-zero, a commit is blocked.

**Comparison.** Each case runs twice from identical copies of the snapshot, once per engine. Compared: stdout bytes, stderr bytes,
exit code; every file under the project root including `.agents/` (content and the executable bit); git state as tree ids, ref
names and porcelain status. Directory order is byte order on both sides.

**No clock seam.** A test clock in the product would also move the time that approval checks compare (a capture must be newer than
its request), so there is none (D14). Times are masked instead, in the named fields only, and the hash chain is checked rather than
masked: each side's ledger must verify on its own (every `prev=` equals the SHA-256 of that side's previous line), and the lines are
then compared with only `ts=`, `epoch=` and the `prev=` values that depend on them masked. `digest=` is compared exactly: it covers
RUN.yaml lifecycle fields that hold no time (`lifecycle_digest`, agent.sh 3252-3260).

**The closed normalisation list** (`tests/equivalence/normalise.mjs`). Only values that differ between two correct runs are masked,
each only in the field named:

| value | where |
|---|---|
| times | ledger `ts=`, `epoch=` and the dependent `prev=` (after the chain check above); `timestamp:`, `requested_at:`, `approved_at:`, `asked_at:`, `answered_epoch:`, `decided_at=`, `consumed_at:` in records; each value must lie inside the case's wall-clock window |
| process ids | lock `pid` files, `pid=` in dispatch markers, line 1 of nonce files, `$$`-based temp names, intake file names `<ms>-<pid>.json` |
| temporary directories | `$TMPDIR/...XXXXXX` paths in messages |
| random nonces | the hex part of `nonce:` in delivery summaries and of `local/dispatch/nonce-<hex>` names |
| measured durations | `total_ms=`, `max_ms=` in HOOKS.log, `duration_s` in metrics, the ms column of the hook timing spool |
| file metadata | `mtime_ns`, `ctime_ns`, `inode` in fingerprint-cache keys |
| archives | `<ID>-<UTC>.tar.gz` names; archives are compared by member list and member bytes, not by gzip bytes |

Each rule has a test that plants a real difference next to the masked value (one byte of a ledger `detail=`, an exit code, a missing
file, a mode bit, a changed hash in the same line) and requires the rig to report it. A pull request that adds a rule needs the
maintainer's approval; `.out-of-scope/weakening-core-invariants.md` forbids normalising broadly enough to hide a real difference.

**In CI.** A new `equivalence` job on Linux runs the scenario cases and the trace cases of every command the pull request touches or
has moved; the full trace replay runs nightly on Linux and macOS. **Takeover rule:** a command's default engine becomes Node only
when (1) every scenario and trace case of it is equal on Linux and macOS, (2) the full self-test passes with Node as default, (3) the
Core invariant suite passes on both engines, and (4) no normalisation rule was added without approval.

## 7. Core invariants

The six rules of CONTRIBUTING bound every stage. How the migration keeps each:

1. **CODE_DONE needs every required gate for the current content.** Required gates, gate status, fingerprints and waivers are
   computed by the same rules and proven equal by the rig on every gate state of the fixtures; `handoff` moves only after the gate
   readers it uses.
2. **SECRETS and SECURITY never waived.** The waiver and batch-accept refusals move with their commands, with their message text;
   the invariant suite tries the waiver on both engines.
3. **Approvals only from the user's message.** The capture writer and every reader move together (stage 3), against a corpus of
   prompts (Unicode, quotes, backslashes, CR, tabs, control bytes, Turkish letters, long text) whose capture files must be
   byte-identical between the old and the new hook; the old `approve` must accept new captures and refuse what it refused, and the
   reverse, because a rollback mixes them. The corpus and its expected capture, intake and history bytes are committed as golden
   files in stage 3, so they outlive the rig. From stage 1 the hook denies any model command that starts Node and loads the core, in
   every spelling it can see: a path to `proofline-core.mjs` or to `.agents/scripts/core/`, `node -e`/`--eval`/`-p`/`--print`,
   `--input-type=module` with code on stdin, `--import`/`--require`/`-r`/`--loader`, `env node`, `npx node`, or a variable holding
   `process.execPath`, whenever the command text names `.agents/scripts` or `proofline-core`. This is a tripwire, not the boundary:
   hooks read command text and cannot see everything (`.out-of-scope/small-rejected-ideas.md`). The boundary is unchanged: `approve`
   records an approval only from a captured user message (SHA-256 of the exact text, captured after the request, single use), the
   capture is written by the hook from the runtime's prompt event, and writes to `.agents/local/` are refused to models by the hook and,
   against a hostile agent, by the runtime's permission mode and sandbox.
4. **Evidence is reproduced independently.** Evidence commands keep running with full output through `proc.mjs`; the
   normalisation list is closed and tested (section 6).
5. **The author never reviews.** The role gate (`valid_role`, `cmd_allowed`, the read-only list) moves in stage 1, first, with a test
   of every role against every command on both engines.
6. **In doubt, the safe side.** An internal error in the core exits non-zero, never 0; a PreToolUse internal error during a run is a
   deny; an unknown command prints the usage and exits 2. A missing `node`: `agent.sh` and the git hooks fail (exit 127 blocks a
   commit); while the shell hook still runs (stages 1-3) a guard whose moved command fails denies instead of falling back to empty
   settings (section 5.3); from stage 3 every hook form turns a failed start of PreToolUse into the blocking exit code 2 (section 9).
   The "Node absent" rig case and the enforcement suite prove each of these; until they pass in a stage, that stage does not claim it.
   Test stubs never reach a decision outside the harness (D14): stage 1 adds a test that, with no fixture stub present, sets every
   `PROOFLINE_TEST*` and `PROOFLINE_ENGINE*` value and shows that SECRETS results, execution-policy decisions and approval results
   do not change.

## 8. Code form and speed

### 8.1 One spawn wrapper

`core/proc.mjs` is the only module of the core, the hook and the CLI that imports `node:child_process` (a static check fails
otherwise). It offers `run(program, args, options)` (sync and async), `runUserCommand(text, options)` and `killTree(child)`.

- Every call is counted per program. `PROOFLINE_SPAWN_LOG=<file>` appends one line per child (program, duration); tests assert
  budgets from `tests/bench/spawn-budgets.tsv`.
- Programs truly needed: `git`; `gh`, `glab`, `az`; the runtimes (`claude`, `codex`, `dispatch.command_template`); `node` for the
  skill validators (skills are installable alone, so they stay separate scripts); `tar` for run archives; `ps` on macOS for the
  dispatch nonce's ancestor walk (Linux reads `/proc`); `taskkill` on Windows for process-tree kills; `caffeinate` or
  `systemd-inhibit` for the night sleep inhibitor; the user's own command strings. `jq`, `curl`, `timeout`, `shasum`, `stat`,
  `date`, `awk`, `sed`, `grep` and the rest are no longer started.
- Platform CLIs keep the A180 refusal of a tool that resolves into the project or a temporary folder. Windows `.cmd` shims (for
  example `az.cmd`) run through `cmd.exe /d /s /c` with strict argument quoting, the one documented exception to `shell: false`.
- `runUserCommand` is the one place that hands a string to a shell: user commands in `config.yaml` and a user-written `.sh` task
  adapter. It uses `/bin/sh -c` on POSIX; on Windows `sh -c` when an `sh` is on PATH, otherwise `cmd.exe`, and `doctor` says which.

### 8.2 Read once, compute once

- Config, RUN.yaml, ledger, gate records, baseline map, task and plan parse, and the changed-path set are read once per invocation
  (`context.mjs`).
- The baseline is a map built once, which removes the paths-times-entries loop. Path fingerprints use `fs` and `node:crypto`, not
  `stat` and `shasum` per path. `verify-seal` hashes the ledger in one pass in process. Risk signals are computed once.
- Git queries stay semantically identical; a combined or cheaper git call is allowed only with a rig case for its edge cases
  (renames, deletions, untracked files in ignored folders, worktrees).
- The hook loads modules lazily and may use `module.enableCompileCache()`; stage 3 measures both.

### 8.3 Form

- Modern JavaScript, ESM (`.mjs`), `// @ts-check` at the top of every core, hook, CLI and test-harness module, types in JSDoc.
- Type checking is a development tool that never enters the runtime: a CI job runs the checker with exact pinned versions of the
  checker and of the Node type definitions, fetched in that job only (`npm exec --package=<checker>@<exact> ...`), against a
  `jsconfig.json` with `checkJs`, `strict` and `noEmit`. Nothing is added to the shipped tree: no root `package.json`, no lockfile, no
  `node_modules`. Honest limit: the checker itself is a third-party npm package that only CI downloads; if the registry is down, that
  job fails, the product does not change. Contributors may run it locally the same way; it is not required.
- Tests use `node:test` and `node:assert/strict`.
- Errors are `ProoflineError` values with a stable code, the existing message text and the existing exit code; the top level prints
  the message exactly as the shell did. Messages are compared by the rig, so they cannot drift.
- Paths: `node:path` for every join; paths stored in files stay in POSIX form (`/`), as today, so run folders are portable; input
  paths from the runtime (`C:\...`, `/c/...`) are normalised in `paths.mjs`, tested with `path.win32` on every platform.
- Byte semantics of the shell are kept where formats depend on them: lengths with `Buffer.byteLength`, sorting by bytes, no locale.

## 9. Launchers and the no-shell-logic rule

At the end these files remain; each only starts Node. The inventory gives the reasons per file.

| file | form |
|---|---|
| `control-plane/agents/scripts/agent.sh` | `#!/bin/sh` and one line `exec node "$(dirname "$0")/proofline-core.mjs" "$@"` |
| `control-plane/agents/scripts/dispatch.sh` | same, with the core subcommand `dispatch` |
| `control-plane/agents/githooks/pre-commit`, `pre-push` | same, with the core subcommands for the two git hooks |
| `bin/proofline` | `#!/usr/bin/env node` and one dynamic `import` of `bin/lib/proofline.mjs` |
| `bin/proofline.cmd` | `@node "%~dp0proofline" %*` |
| hook command strings in `adapters/claude/hooks/hooks.json`, `adapters/claude/settings.fragment.json`, `adapters/codex/hooks.json` | one pinned string per event that runs `node` on the hook file |
| `adapters/claude/hooks/proofline-hook.sh` (transitional, stages 10-14) | same form as `agent.sh`, starting `proofline-hook.mjs`; removed in stage 15 (section 5.4, item 4) |

Hook strings. The plugin form calls the plugin's own `proofline-hook.mjs`, which does the duplicate check against the project settings
that `grep` does today. All three forms (plugin, project, Codex) keep one guard, written once in a template: a failed start of
PreToolUse (Node missing, hook file missing) exits with the runtime's blocking code 2, as the project form's shell guard does today
(Core invariant 6). For the plugin form this is stricter than today: with the plugin enabled and Node missing, PreToolUse blocks even in
a project without proofline; the plugin's install text names Node 22.13 as a requirement. Node can be absent where `sh` never is, which
is why the guard cannot be dropped. The exact
string per runtime (how the runtime expands variables and which shell it uses on Windows) is fixed and tested in stage 3. Upgrades:
the install merge learns the old `sh -c` strings so it replaces them instead of adding a second hook; after a rollback to an older
version that re-adds the old string, the Node hook sees the old wiring for the same event in the same settings file and yields.

**The rule** (`tests/ci/no-shell-logic.mjs`, strict from stage 15):

- A *shell file* is any tracked file with a `.sh` or `.bash` extension, a shell shebang (`sh`, `bash`, `dash`, `ash`, `zsh`), or a file
  under a `githooks` folder. Any shell file not in the launcher list fails.
- A launcher's text must equal its template exactly: a shebang, at most one `exec node <path> "$@"` line where `<path>` is built only
  from `$(dirname "$0")`; no other command, variable, operator (`if`, `case`, loops, `&&`, `||`, `|`, `;`) or redirection.
- No `.awk` file, and no `awk`, `sed`, `sh` or `bash` program started from Node outside `runUserCommand`.
- Every `command` value in the three hook wiring files equals the pinned template of its event.
- Every `run:` step of `.github/workflows/*.yml` is a single command line (no `if`, loops, `&&`, `||`, pipes, `;` or `$(...)`);
  GitHub `${{ }}` expressions and `env:` keys are not shell.
- Not code: fenced snippets in Markdown, and command strings in `config.yaml` (the user's data).

From stage 1 the same script runs as a **ratchet** over two snapshots of 0.0.40: `tests/ci/shell-allowlist.txt` (every shell file) and
`tests/ci/inline-shell-snapshot.txt` (the SHA-256 and location of every `run:` step of `ci.yml` and of every hook command string in the
three wiring files). A pull request may remove entries, never add one; a step or hook string that is new or changed must already pass
the strict rule (one command line for a `run:` step, the pinned template for a hook string); an entry whose file or step no longer
exists must be removed. So no inline shell can grow before stage 15.

## 10. How the black-box tests keep working

About 2,587 test calls run `sh ./.agents/scripts/agent.sh` and assert exit codes and message text (574 `expect_msg`, 774 `grep -q`).
They keep working unchanged because the entry file stays at its path, the message text is compared by the rig, and file formats do
not change. Places that need care, in the stage where their target moves:

- **`test-lib.sh` stays untouched until stage 15.** The shell invariant suite sources it (`invariants-test.sh` line 20), so it is
  treated as part of the suite; a change to it would need the `Invariant-test-change:` rule, and the plan needs none.
- **Stubs stay files inside the fixture (D14).** `test-lib.sh` writes shell stubs of `secret-scan.sh`, `exec-policy.sh` and
  `markdown.sh` into the fixture's `.agents/`. When those move (stages 5, 6, 7) the core keeps today's rule: if that sibling file exists
  in the project, it is run, exactly as `agent.sh` runs it today. The installer stops shipping those files, so only a fixture that writes
  one gets it; the exposure equals today's (an installed file under `.agents/`, covered by the hook's path policy and the manifest). No
  environment seam is added. The rule goes in stage 15 with `test-lib.sh`; the Node harness (stage 11) writes stub modules into its
  fixtures the same way.
- **Text extractions get golden tests before their code goes.** The seven extractions (`sb_scrub`, `sb_strip`, `SB_KEYS=`,
  `risk_words_match` twice, `blocking_rule_version=`, `approval_phrases`), the awk-parser comparison in `check-shared.sh` and the three
  `.test.mjs` files that read `agent.sh` text keep testing the old code while it exists. In the stage where the related command moves,
  a golden test is added whose expected outputs are recorded from the old engine: `risk_words_match` and the `next` order
  (`proofline-lead.test.mjs`) in stage 2; `approval_phrases` in stage 3; `sb_scrub`, `sb_strip`, `SB_KEYS` and the freeze messages
  (`plan-contract.test.mjs`) in stage 4; `blocking_rule_version` in stage 5; `frontmatter.test.mjs` reads the core's command table
  (all 132 entries, moved or bridged) from stage 1. Stage 10 only deletes the extraction tests together with the code they read; no test
  is rewritten in the stage that deletes its code. The config-parser comparison goes in stage 9 with `bin/lib/config.sh`.
- **The ecosystem-branching rule keeps its teeth.** `tests/shared/check-static.sh` rule 5 (lines 122-125) reads the ecosystem ids from
  `ecosystems.tsv`, passes when the file is missing, and scans shell only. Stage 2 adds a Node check over the core, hook and CLI `.mjs`
  that reads `ecosystems.json` and fails when it is missing, and makes rule 5 fail, not pass, when its data file is missing; stage 10
  moves rule 5's remaining scan to the Node check in the same pull request that deletes the TSV.
- A test and the code it tests never move in the same stage: product stages 1-10 run the unchanged shell suites as their proof;
  suites move in stages 11-14, after the product.
- Timing-sensitive suites (`kill-guard-test`, `gates-test`, `batch-test`, `dispatch-test`) get their timing seams honoured by the core
  before the related command moves.

## 11. Windows

| after stage | what a Windows user needs | what still needs an `sh` |
|---|---|---|
| today (0.0.40) | Git Bash or WSL (`sh`, awk, coreutils, `ps`), git | everything; Windows paths are not handled (inferred: writes during a run are denied) |
| 1-2 | the same plus Node 22.13 | everything not yet moved |
| 3 (hooks) | Node, git; the hook is one Node process per event and handles `C:\` paths | no hook event; the lead's `sh .agents/scripts/agent.sh` calls and commands not yet moved |
| 4-8 | Node, git, an `sh` to type the launcher spelling | commands not yet moved; `dispatch` until 7 |
| 9 (CLI) | `proofline` through `bin/proofline.cmd`; install without `sh` | the `sh` spellings of the two launchers |
| 10-15 | Git for Windows (git; its bundled `sh` runs the git hook launchers), Node 22.13, the runtime | nothing of proofline's logic. `node .agents/scripts/proofline-core.mjs <command>` works from PowerShell or `cmd`; the `sh` spelling still works where an `sh` exists. User command strings written in POSIX shell syntax still need an `sh` (they are the user's data) |

Process cost on Windows (estimate, using the inventory's 20-50 ms per process): one Bash tool call drops from 39-45 processes (0.8-2.3 s)
to one Node start plus at most a few git calls. Honest limit: none of this has run on Windows. Stage 3 adds a `windows-latest` CI job for
the hook tests and the hook benchmark, and stage 15 extends it to the core tests; until those pass, Windows stays "use WSL or Git Bash" in
the README.

## 12. Stage plan

Each stage: its own branch, pull request and patch version (numbers taken when it ships: 0.0.x), the equivalence job green, the Core
invariant suite green on both engines, the before/after measurement in the description, the real-session smoke table on its last
commit. Details in [0001-stages.md](0001-stages.md).

| # | stage | depends on | estimate (agent-days) |
|---|---|---|---|
| 1 | equivalence rig, core skeleton, spawn wrapper, ratchet, config commands | - | 6-9 |
| 2 | read-only commands (`status`, `next`, `digest`, `summary`, `pipeline`, `verify-*`, `fingerprint`, insights, debt list, queue) | 1 | 7-10 |
| 3 | hooks and the approval/answer fast path, git hooks | 2 | 8-12 |
| 4 | run lifecycle (`start`, `classify`, `freeze`, `handoff`, `terminate`, `cleanup`, ...) | 2, 3 | 5-8 |
| 5 | gates, results and reports (`record`, `submit`, `gate`, `secret-scan`, `waive`, `publish-completion-report`, ...) | 4 | 6-9 |
| 6 | delivery (`deliver-*`, merge, platform and task adapters, CI watching) | 5 | 5-7 |
| 7 | dispatch, batch, worktrees, execution policy | 5, 6 | 6-9 |
| 8 | discovery, build records, friction, lessons, rules, context size | 7 | 3-5 |
| 9 | CLI (`bin/`), generators, skill shell scripts | 8 | 5-7 |
| 10 | remove the shell paths: launchers, engine switch, fallbacks (extraction tests deleted with their code) | 9 | 3-4 |
| 11 | test harness, runner, CI scripts and `ci.yml` inline logic | 10 | 4-6 |
| 12 | control-plane test suites | 11 | 8-12 |
| 13 | enforcement, invariants (Node copy), CLI, task, e2e and real-session tests | 11 | 4-6 |
| 14 | fixtures | 11 | 3-5 |
| 15 | strict no-shell-logic check, last shell removed, documentation | 12, 13, 14 | 1-2 |

**Total: 74-111 agent-days (estimate), about 15-23 weeks (estimate)** at the observed pace of one patch per working day, five working
days a week. Basis: lines to port per stage (inventory), the test volume, recent patch sizes (0.0.33: 4,047 inserted lines; 0.0.39: 5,655;
0.0.40: 1,068; one patch a day in late October 2026), and in stage 1 an allowance of 2-3 agent-days for building the rig and recording the
traces. Maintainer review and smoke runs come on top. **Re-plan point after stage 2:** stages 1 and 2 build the rig and most of the shared
library; their measured effort, CI time and trace volume are compared with these estimates, and stages 3-15 are re-estimated (and
re-ordered if needed) in a decision entry before stage 3 starts.

**Departures from the suggested order.** (a) The read-only stage moves `insights` and the debt list but not `queue`'s and `insights`'
CLI front ends, which move with the CLI in stage 9. (b) The lifecycle stage is split into two (4 lifecycle, 5 gates and reports): they
are each as large as the hook stage, and `handoff` can only be proven after the gate readers it uses. (c) The no-shell-logic check
starts in stage 1 as a ratchet instead of appearing only at the end, so no stage can add shell. (d) Tests move after the product
(stages 11-14), never with the code they test. (e) The suites are split four ways (harness and CI, control-plane suites, the rest,
fixtures) because they hold about 25,800 lines of shell, more than `agent.sh` and its siblings together. (f) The shell
invariant suite and `test-lib.sh`, which it sources, are the last shell files removed (stage 15), so the suite runs unchanged at every
earlier stage.

## 13. Alternatives rejected

- **Keep shell and fix only the awk hot spots.** A188 and A203 did this. It works locally and does not last: the approval path went
  from 206 to 544 processes after A188, each fix makes the code harder to read (parameter-expansion tricks to avoid a process), the
  quadratic loops are in shared helpers that every gate command runs, the duplication stays, and Windows paths stay unhandled.
- **Rewrite in another language** (a compiled binary or a different scripting runtime). A binary needs a build and per-platform
  downloads, while proofline installs from a git checkout with nothing to build; another scripting runtime would be a second runtime
  next to the Node that the 79 skill scripts already need, with less predictable presence and versions on user machines. Node is
  already a dependency, so one language serves skills, core, hooks and tests.
- **A daemon** that keeps state in memory to avoid start-up cost. It needs a lifecycle (who starts it, stale daemons, several sessions,
  worktrees, a Codex sandbox that cannot reach a socket), it caches across commands (rejected in A203), and a socket that can record an
  approval is a new attack surface for Core invariant 3. A Node start measured about 28 ms on this machine (mean of 10 `node -e 0`,
  macOS, Node 24.14.1); not measured on Node 22.13 or Windows (stage 1 does).
- **Bundling with npm dependencies** (a YAML library, argument parsers, process helpers, a bundler). Supply-chain risk in the component
  that records approvals and gates; an install step that proofline does not have ("nothing is installed into the project"); and no need:
  the formats are proofline's own line formats and the config is a restricted scalar YAML subset.
- **A big-bang rewrite.** Equivalence of 132 commands cannot be shown at once, no command can be rolled back alone, feature work would
  stop for months, and the invariant suite would test a moving target.
- **Porting the tests first, or with the code.** A test and its code changed together can agree on the same mistake; the unchanged shell
  suites are the strongest proof the product stages have.

## 14. Consequences

- Node 22.13 becomes a runtime requirement from stage 1 (today: skill tests only). Stage 1 updates CONTRIBUTING, the README and
  `doctor`.
- A dual-maintenance window: until stage 10 a behaviour change to a moved command must be made in both engines in the same pull
  request (the rig fails otherwise). Feature work in an area should wait while its stage is open.
- Output text is frozen as an API during the migration; message improvements wait or are made in both engines.
- CI time rises while the rig and the shell fallback run (estimate: up to half again, mitigated by replaying only touched commands per
  pull request), then falls: the self-tests spend most of their 21,006 s starting processes.
- Contributors write JavaScript with JSDoc types; `shellcheck` leaves CI in stage 15.
- The ecosystem definition goes from three forms to two (JSON and the `.mjs` reader). The `.mjs` copies grow from five to seven
  (performance-proof and verify-proof get one each), because skills share no files; the three `ecosystems.sh` copies and the TSV go.
- `jq` and `curl` stop being optional dependencies (Node parses JSON and has `fetch`).

## 15. Risks

| risk | mitigation |
|---|---|
| the approval capture changes by one byte and approvals are refused, or accepted wrongly | writer and readers in one stage; prompt corpus; old/new cross-acceptance tests; rollback mixes are tested |
| dispatch watchdog semantics (TERM, KILL after 5 s, traps, process groups) differ | port with fake runtimes that ignore TERM, hang or exit early; POSIX process groups (`detached`, negative pid), `taskkill /T` on Windows; on Windows a CLI `decide` with a nonce fails closed unless called in process by the dispatcher |
| a normalisation rule hides a real difference | closed list, planted-difference test per rule, maintainer approval for a new rule |
| shell quirks the formats rely on (`set -e` paths, `LC_ALL=C` byte semantics, byte lengths, glob order) | rig on every command; byte-order sorting and `Buffer.byteLength` are rules in the code form |
| concurrent feature work drifts between engines | the rig fails the pull request; per-area freeze while a stage is open |
| CI time and flakiness of the timing-sensitive suites | touched-commands replay per pull request, full replay nightly; seams before ports |
| Windows behaviour unknown (hook string forms, `.cmd` shims, CRLF) | stage 3 decides the strings on `windows-latest`; Windows stays documented as WSL or Git Bash until the Windows jobs pass; CRLF tolerance is a separate decision after stage 15 (the old code keeps a `\r`, and equivalence requires the same) |
| Node missing on a machine where `sh` was always present: guards switch off silently | stages 1-3: the shell hook denies when a moved command fails (section 5.3); from stage 3 every hook form blocks a failed PreToolUse start; `doctor` and `init` refuse below Node 22.13; the "Node absent" rig case |
| a test seam lets an agent change a decision (secret scan, policy, clock) | no environment seam (D14); stubs are fixture files as today; a test that every `PROOFLINE_TEST*` value changes nothing outside the harness; the hook denies such assignments (tripwire) |
| Node start-up and module loading cost in the hook | lazy imports, compile cache, a budget in the hook benchmark |
| Node 22 leaves support in April 2027 | a new decision then; CI already tests the next LTS line |
| the in-process hook runs several commands and leaks state between them | the per-invocation context; a test runs two commands in one process and compares with two processes |

## 16. Open questions (recommended defaults, maintainer to confirm)

1. **Hook guard.** Recommended: the pinned fail-closed guard in all three hook forms (section 9). Failing open is not offered: it
   contradicts Core invariant 6, and Node can be absent where `sh` never is. *Maintainer to confirm.*
2. **Documented spelling.** Recommended: keep `agent.sh` and `dispatch.sh` as permanent launchers: 278 lines in skills and roles name
   `agent.sh`, and tests, git hooks and the hook's deny rules use both spellings; a rename would be its own later decision.
   *Maintainer to confirm.*
3. **Invariant-suite overlap.** Recommended: the shell and Node invariant suites run side by side until the Node copy has been green on
   `main` through at least one full release after the one that added it; stage 15 deletes the shell copy only then, otherwise the deletion
   waits for a later release. *Maintainer to confirm.*
