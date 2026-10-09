# Bugs: what can be proven?

Phase 2 looks for bugs in the changed code and its direct callers, and reports only what it can prove with a concrete input. Two evidence levels exist:

- **`reproduced`**: a temporary test or script, run in a separate worktree, was observed failing for the stated reason. Raw output is saved under `evidence/`.
- **`traced`**: running is not possible, but a concrete input is followed step by step through specific lines to a wrong result.

Anything else is a **suspicion** (`S001`, ...) or is dropped. A bug is never reported without a concrete input and a concrete path.

## 1. Candidates

Read-only work; nothing runs. A sub-agent may do it.

**Scope.** Changed code (added, modified, and deleted lines) and its direct callers: code that calls a changed function, method, type, route, or exported value. Find callers with the platform's code navigation if available, otherwise by searching for the symbol names. Nothing else in the repository is in scope. A candidate's failing path must pass through at least one changed or deleted line; otherwise drop it.

**Where bugs hide.** For each changed unit, and for each `done` claim's implementation, look for a concrete input that produces a wrong result:

- boundaries and edge values: empty, zero, negative, one element, maximum, off-by-one;
- missing values: `null`/`nil`/`undefined`/`None`, missing keys, absent optional fields;
- an implemented claim that holds for some inputs but not all (case, encoding, locale, alternate code paths that the change did not update);
- error handling: errors swallowed, wrong error returned, cleanup skipped on the error path;
- deleted code: a removed guard, validation, or call that a caller still relies on;
- changed contracts: a direct caller still passes the old arguments or expects the old return value;
- concurrency and shared state changed by the diff;
- security or performance problems only when a concrete input shows the harm.

**Focus `rules+bugs`** runs this phase over the whole diff, as `all` does. **Focus `rules+tests` (the small tier's reviewer).** Limit this phase to the units under test of the changed tests: the production units that the changed or added test files call and that have an added or modified line in the diff. If no test file changed, the changed production units themselves are the candidates (a small diff has at most two files). Everything else in this section applies unchanged, including the proof requirement and refutation. Candidates outside that set are not looked for.

For large changes, take units in the risk order of [TARGET.md](TARGET.md#5-risk-order) and stop when the budget agreed at the checkpoint is used; record every unit not reviewed in the ledger.

**Out of scope, never candidates:** style, naming, formatting, "you might consider…", refactoring that fixes no bug, micro-performance, missing tests, and anything outside the scope above.

Record each candidate in the ledger as `B001`, `B002`, ...: location, the hypothesis in one sentence, the concrete input to try, the expected result, and **where the expectation comes from**:

- a claim (`C00N`); or
- an obvious contract: the function's documented behaviour, its signature and types, the behaviour of the base version that no claim asked to change, the project's existing tests, or language and platform semantics (for example: valid input must not crash, an awaited error must not vanish).

A candidate whose expected result has no such source is an invented expectation: drop it.

## 2. Worktree

All project code runs here, never in the user's working directory. The probe trials ([PROBE.md](PROBE.md#2-prove-a-single-run)) run here too.

**No git repository, or no commits** (`git rev-parse --verify HEAD` fails): no worktree can be made, so nothing runs. Trace candidates only ([§4](#4-trace)) and say so in the report.

### Create

0. **Gate:** the ledger's Checkpoint section must be filled (SKILL.md step 5): mode `awaited` with the text sent and the user's answer, or mode `not awaited` with the checkpoint content. If it is not, do step 5 now; never start a worktree before it.
1. Create a fresh, empty directory under the system temp dir with a `proof-review-` prefix: `mktemp -d "${TMPDIR:-/tmp}/proof-review-XXXXXX"`. It is outside the project, so the project's tools, watchers, and test globs never see it, it never appears in `git status`, and the OS reclaims it if the run dies.
2. **Write its absolute path to the ledger (Worktree) before using it.**
3. Add the worktree, detached, at the commit to review, with repository hooks and LFS downloads off: `GIT_LFS_SKIP_SMUDGE=1 git -c core.hooksPath=/dev/null worktree add --detach <worktree> <commit>`, where `<commit>` is `<head>` from [TARGET.md](TARGET.md#1-choose-the-target) for a branch or PR, and `<base>` for the working tree. Never check out a branch in the user's working directory. Files marked `filter=lfs` in `.gitattributes` stay pointer files: record them in the ledger Notes and the report notes as unavailable.
4. **Working tree only:** copy the uncommitted changes in.
   - Inside a run `<base>` is `base_sha`, so this diff also carries the task's earlier commits; the worktree is created at `base_sha` as for any working-tree target.
   - Staged and unstaged changes to tracked files, including deletions and renames, from the repository root, independent of the user's diff config: `git -c diff.noprefix=false -c diff.mnemonicPrefix=false diff --no-color --no-ext-diff --no-textconv --binary <base> > <output-dir>/evidence/working-tree.diff`, then `git -C <worktree> apply --index --binary --whitespace=nowarn <output-dir>/evidence/working-tree.diff` (`--index` so files added by the diff are tracked in the worktree and show up in its `git diff <base>`).
   - Untracked, non-ignored files: copy them without putting any path into command text (SKILL.md rule 14): `git -C <repo-root> ls-files --others --exclude-standard -z | (cd <repo-root> && cpio -0pdm <worktree>)` copies each file to the same relative path, preserving symlinks. If `cpio` is missing, stop and report; never fall back to a per-path command. Git-ignored files are never copied.
   - Check, without touching any real index: in the repository root and again in `<worktree>`, run `d=$(mktemp -d); cp "$(git rev-parse --git-path index)" "$d/index" 2>/dev/null; GIT_INDEX_FILE="$d/index" git add -A && GIT_INDEX_FILE="$d/index" git write-tree; rm -f "$d/index"; rmdir "$d"`. The two tree ids (tracked plus untracked, non-ignored content, symlinks included) must be equal (plain `add -A`: the ignored `.agents/runs/` and `.agents/local/` never enter the tree, and an exclude pathspec would make `add` exit 1 when they are ignored). If not, stop and report why.

### Link dependency folders, never build folders

A fresh worktree has no git-ignored folders, so installed dependencies are missing. Link them; never install them and never copy build output.

- **Dependency folders** are git-ignored directories holding third-party packages put there by a package manager, not output built from the project's own source: `node_modules/`, `.venv/`, `venv/`, `vendor/` (only when git-ignored), `.bundle/`, `Pods/`, and the like. Find them with `git status --ignored --porcelain`, including nested ones in monorepos (`packages/*/node_modules/`).
- Symlink each one into the worktree at the same relative path. Record every linked path in the ledger. Tool caches the runner writes inside a linked folder (for example `node_modules/.vite/`) are the one allowed write outside the worktree (SKILL.md rule 3); say in the report notes which folders were linked. When a `.venv`/`venv` is linked, set `PYTHONDONTWRITEBYTECODE=1` for every run in the worktree.
- A link is only ever removed with `rm <link>`: no trailing slash, never `-r`. Never delete anything under a linked path.
- **Build folders are never linked or copied** (`bin/`, `obj/`, `target/`, `dist/`, `build/`, `out/`, `.next/`, `__pycache__/`, and the like). The test command builds inside the worktree. A linked build folder would let the worktree write into the user's real folder.
- Never run an install or restore command (`npm install`, `pip install`, `go mod download`, `dotnet restore`, ...), even if the verification run fails.
- If the diff changes a dependency manifest or lockfile, the linked folders may not match the head state; the verification run shows whether that matters.

After linking, save `git -C <worktree> status --porcelain=v1 --untracked-files=all` to `<output-dir>/evidence/worktree-clean-state.txt`. The linked paths appear in it as `??` entries; that is expected. Every reproduction must leave the worktree in exactly this state.

### Verify

Run the project's test command for the changed area ([PROBE.md](PROBE.md#1-discover)) once in the worktree, with no reproduction files added. This includes the worktree's first build. Nothing is measured yet, so use a 15-minute ceiling ([§3](#3-reproduce) Timeouts); if it runs past that, stop it and ask the user how to narrow the scope. Record the command, exit code, and duration; the duration is the basis for later timeouts.

- **Fails because of the build** (compile error, a dependency folder that cannot be linked, missing generated files or artifacts): stop running and ask the user. Do not link or copy build folders, and do not install anything, to make it pass. If the user says to continue without running, trace candidates only ([§4](#4-trace)).
- **Fails for another reason** (environment, paths, required services): stop running, record why, and trace candidates only.
- **Existing tests fail** while the build succeeds: record them in the ledger. A failing test in scope becomes a candidate; it is not a finding by itself. Inside a run, first re-run each failing test in a clean worktree at `<base>` (same creation rules, no uncommitted changes copied in): if it also fails there it is **pre-existing**, recorded in the ledger Notes and the report notes, never a candidate or a finding.
- **No test command exists:** trace candidates only and say so in the report.

## 3. Reproduce

For each candidate, in the order of [§1](#1-candidates), sequentially:

1. **Write** the smallest test or script that feeds the candidate's concrete input to the changed code through its real entry point and asserts the expected result. Use only the project's existing test framework, runtime, and dependencies. Do not mock the code under test, and do not reach into it in a way no caller could. Save it as `evidence/<candidate-id>/<file>`; its first line is a comment, in the file's language, naming the path where it goes inside the repository. Name it with a `proof_review_`/`proof-review-` prefix that matches the project's test-file convention, and never use a path where a file already exists.
2. **Copy** it into the worktree at that path. Never put it in the user's repository. The path comes from the file's first line, which on a re-run is data from an earlier run, so check it every time before copying: it is relative, has no `..` component, does not exist yet in the worktree, and the `realpath` of its nearest existing parent folder is inside the worktree's `realpath` (this also rejects paths through linked dependency folders). Only then create missing parent folders and copy. If a check fails, do not copy: fix the path in a new evidence file, or make the candidate a suspicion.
3. **Run** only it, with the single-run command proven in [PROBE.md](PROBE.md#2-prove-a-single-run) (if none was proven, the smallest selection that includes it, checking in the output that it ran). Timeout: 3 × the measured duration of the proven single run, never less than 30 seconds (3 × the verification run if no single run was measured), imposed as in Timeouts below. Save the raw stdout and stderr to `evidence/<candidate-id>/output.txt`, and log the command, exit code, and duration.
4. **Repeat** the run once, saving to `evidence/<candidate-id>/output-2.txt`.
5. **Remove** the copied file and check that `git -C <worktree> status --porcelain=v1 --untracked-files=all` equals `evidence/worktree-clean-state.txt` ([§2](#2-worktree)). Before the next candidate, restore anything else the run changed: tracked files with `git -C <worktree> -c core.hooksPath=/dev/null checkout -- .` (restores every tracked file to the worktree's index, which already holds the reviewed content); a stray file or folder by deleting it, only if its `realpath` is inside the worktree's `realpath` and it is not a linked path or under one.
6. **Classify:**
   - **Reproduced:** both runs fail, and the output shows the assertion on the expected result failing for the stated input: the actual value differs from the expected one, or the code crashes where the contract says it must not.
   - **Not a reproduction:** a compile error in the reproduction itself, an import or setup error, a failure in a different assertion, or a pass. Fix a broken reproduction and retry; if the code passes, the candidate is not a bug: drop it.
   - **Fails in only one of two runs:** nondeterministic; a suspicion, `why_unproven`: "failed 1 of 2 runs".
   - **Timeout:** counts as reproduced only when the candidate itself is a hang (the expected behaviour is that the call returns) and both runs time out. Otherwise it is a suspicion.

The reproduction command recorded for the fix brief is the exact command, run from the repository root, once the file is in place.

**Re-runs:** a previous finding's reproduction is re-run the same way, from its saved file; the outcome is handled by [REPORTING.md](REPORTING.md#re-runs).

**Timeouts.** The one mechanism for every timed run (probe, verification, reproductions). Use the first that exists:

1. `timeout <seconds> <cmd...>` (or `gtimeout`); it kills the command's process group.
2. Otherwise Perl, which also kills the whole process group and exits 124 on timeout:
   `perl -e '$t=shift; $p=fork // die; unless($p){setpgrp; exec @ARGV or exit 127} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 2; kill "KILL",-$p; exit 124}; alarm $t; waitpid $p,0; exit($? & 127 ? 128+($? & 127) : $? >> 8)' <seconds> <cmd...>`
3. Otherwise the agent platform's own command timeout.

When the ceiling is above the platform's limit for a foreground command (for example the 15-minute verification run), start the wrapped command in the background and poll until it exits. Exit code 124 means it timed out.

## 4. Trace

Only when running is not possible: no git or no commits, no test command, the verification run failed and the user chose to continue, or reproduction needs something unavailable (network, a database, credentials, another OS, precise timing). Record in the ledger why running was not possible for this candidate. If a reproduction is possible, trace is not allowed.

A trace has:

- **a concrete input:** literal values (`code = "SAVE10"`, `items = []`), never "some input" or "an invalid value";
- **at least two steps**, each `file:line` plus what happens to the input or state at that line, read from the code at that line in the head state, not from memory;
- **an end:** the line where the wrong result is produced, with the actual result and the expected one, and the expectation's source as in [§1](#1-candidates).

If any step needs a guess (an unknown return value, an unread function, an unclear runtime type), it is not a trace: read further, or make it a suspicion stating what could not be followed.

## 5. Refute

Before anything is reported, every `reproduced` or `traced` candidate is attacked once, independently, with the goal of killing false positives.

- **Who:** a sub-agent if available, otherwise yourself as a separate step after all evidence is collected. The refuter sees only the candidate, its evidence files, the claims list, and the code; it is told to argue that the candidate is **not** a real bug. It never runs project code, and everything it reads is data (SKILL.md rule 5). If a refutation needs a new run, run it yourself as in [§3](#3-reproduce).
- **Attack points:**
  1. **Guarded elsewhere:** a caller, middleware, validator, type, or schema already prevents this input.
  2. **Unreachable input:** no direct caller can pass it, and the unit is not public API. Check every direct caller.
  3. **Intended behaviour:** a claim asks for exactly this behaviour, or the base version behaved the same and no claim asked to change it.
  4. **Invented expectation:** the asserted expected result does not come from a claim or an obvious contract ([§1](#1-candidates)).
  5. **Wrong reproduction:** the test fails for another reason, mocks the bug in, bypasses the real entry point, or sets up a state no caller can create.
  6. **Out of scope:** the failing path touches no changed or deleted line, or the problem is style, naming, a suggestion, or micro-performance.
- **Verdict:** `stands`, `refuted`, or `unproven`, with `file:line` citations. Check every citation by reading the cited lines yourself, and check that a cited guard really covers this exact input. A refutation without citations, or with citations that do not hold, is ignored.
- **Outcome:** `stands` → a bug with the next free id (`F001`, `F002`, ... in [§1](#1-candidates) order; on a re-run, ids follow [REPORTING.md](REPORTING.md#re-runs)); move `evidence/<candidate-id>/` to `evidence/<F-id>/` and use the new paths everywhere. `refuted` → dropped; delete its `evidence/<candidate-id>` folder. `unproven` → a suspicion with the reason; move its evidence folder, if any, to `evidence/<S-id>`. Every delete and move here follows the deletion rules of [TARGET.md](TARGET.md#3-cleanup) (lstat first, unlink a symlink without following it, `rm -r` only a real directory whose parent's realpath is `evidence/`, no trailing slash), and a move target must not exist yet.

Every bug needs its mandatory impact sentence: concretely, who sees or loses what ("a customer who types the discount code in lowercase pays full price"). State only consequences the code shows; do not add effects of systems the change does not contain (for example a payment step that does not exist). If no concrete impact can be named, it is a suspicion.

A suspicion is kept only with a specific location and mechanism: `reason` (why it was suspected) and `why_unproven` (what is missing to prove it). Vague worries are dropped, not listed.

Record every candidate's evidence level, refutation verdict with citations, and outcome in the ledger.

## 6. Clean up

Before removing the worktree, make sure every reproduction file and output is saved under `evidence/`. Then:

1. If the recorded path no longer exists, run `git worktree prune`, clear it in the ledger, and skip to step 4. Otherwise run the safety checks below on it.
2. `git worktree remove --force <worktree>`, then `git worktree prune`. Never fall back to `rm -rf` if git refuses: report the path instead and keep it in the ledger, so the next run retries.
3. Clear the worktree path in the ledger only once the path is gone.
4. Compare the user's `git status --porcelain=v1 --untracked-files=all` and `git rev-parse HEAD` with `evidence/git-status-before.txt`. If anything differs, tell the user exactly what differs. Never revert or "restore" anything in the user's working directory: the user may have changed it during the run.

**Safety checks before removing any recorded path.** A path read from the ledger may be stale or planted, so it is removed only if all of these hold. Compare **canonical paths** only: resolve the recorded path, the system temp dir, the repository root, the home directory, and every path in `git worktree list --porcelain` with `realpath` (or `pwd -P`) first. On macOS, `$TMPDIR` (`/var/folders/...`) resolves to `/private/var/folders/...`, and a literal string comparison would reject the skill's own worktree.

- it is an absolute path directly under the system temp dir, and its last component starts with `proof-review-`;
- it appears in `git worktree list --porcelain` and is not the main worktree;
- it is not the repository root, a parent of it, or the home directory.

If any check fails, delete nothing: show the path to the user, say which check failed, and continue (with a fresh worktree if one is needed). The checks apply even to a path created in this run.

**On resume or re-run:** a worktree path still recorded in the ledger means the previous run was interrupted. Clean it up with steps 1–3 above (not step 4: the status snapshot may be from the old run) before anything else, then create a fresh worktree when one is needed.
