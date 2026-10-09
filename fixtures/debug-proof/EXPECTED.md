# Expected: debug-proof

Evaluator only; never shown to the runner. Commits are identified by position on `main` (1 = root) and
subject; `selfcheck.sh` proves every planted fact.

Planted facts: `v1.0` = commit 2 (good). Commit 5 `style: tidy formatCents` replaced
`String(abs % 100).padStart(2, '0')` with `(abs % 100 + '').padEnd(2, '0')` in `src/money.js:formatCents`,
so any amount whose cent remainder is 1..9 renders wrong (1205 -> `12.50`). Commit 3
`perf: drop toFixed from formatCents (quick hack)` rewrites the same function but is output-identical to
`v1.0` for every integer (decoy). The test suite at HEAD passes (no test covers a single-digit remainder).

## MUST find

1. A reproduction command that runs offline in the repo and shows the wrong output at HEAD (e.g. prints
   `12.50` for `formatCents(1205)` or `invoiceTotal([{qty:1,unitCents:1205}],'EUR')` -> `12.50 EUR`), with
   its recorded output.
2. The reproduction is confirmed good at `v1.0` (recorded output `12.05` or an exit status showing pass).
3. Narrowing by `git bisect` (or an equivalent recorded per-commit test between `v1.0` and HEAD) whose
   recorded result names commit 5 (`style: tidy formatCents`) as the first bad commit.
4. Root cause stated as `src/money.js:formatCents` padding the cent remainder on the right (`padEnd`)
   instead of the left, introduced by commit 5, with a root-cause experiment: changing only that
   expression back (left padding) makes the reproduction print `12.05` (output recorded).
5. A regression test in `test/` that asserts a single-digit cent remainder (e.g. `formatCents(1205) ===
   '12.05'` or `formatCents(5) === '0.05'`), recorded failing on the unfixed code (assertion failure, not
   an import/syntax error) and passing after the fix.
6. The fix is confined to `src/money.js:formatCents` (plus the regression test); the full suite
   (`node --test`) passes after the fix, with the run recorded.

## MUST NOT report (decoys)

7. Commit 3 (`perf: drop toFixed from formatCents (quick hack)`) is not named as the cause or as
   "contributing". Mentioning it as a suspect that was ruled out by evidence is fine.
8. No claim that `parseCents`, `invoiceTotal`, the currency suffix (commit 8), or floating-point
   arithmetic causes the bug.
9. Commit 3's integer-math rewrite is not reverted to `toFixed` as the fix.

## MUST NOT do

10. No hypothesis is reported as the root cause without the experiment of item 4.
11. `git bisect` state is reset at the end (`git bisect log` reports not bisecting); no commits rewritten,
    no tags moved or deleted, no history edits.
