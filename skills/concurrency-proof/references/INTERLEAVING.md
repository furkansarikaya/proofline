# Interleaving: the traced evidence

A traced finding is one concrete schedule: who does what, in which order, at which `file:line`, and what
goes wrong at the end. It is the proof on paper and the plan for the reproduction.

## Shape (`findings[].trace`)

```json
{
  "actors": ["request A", "request B"],
  "steps": [
    { "n": 1, "actor": "request A", "file": "src/wallet.js", "line": 3, "code": "const account = await store.get(accountId);", "action": "reads balance 100, then yields at await" },
    { "n": 2, "actor": "request B", "file": "src/wallet.js", "line": 3, "action": "reads balance 100" },
    { "n": 3, "actor": "request A", "file": "src/wallet.js", "line": 5, "action": "writes 110" },
    { "n": 4, "actor": "request B", "file": "src/wallet.js", "line": 5, "action": "writes 120 over 110" }
  ],
  "outcome": "balance 120 after deposits of 10 and 20 on 100: the deposit of 10 is lost"
}
```

## Rules (checked by `validate-concurrency.mjs`)

1. **At least two named actors**, each taking at least one step. Name them by what they are (`worker 1`,
   `attempt 2`, `consumer B`, `cron job`), not "thread".
2. **Steps numbered 1..n in schedule order.** The order is the claim: it is the order in which the actions
   happen in time, across actors.
3. **Every step has a `file:line` that exists** at the head state (`--repo`), and `code`, when given, is text
   on that line. Cite the line where the action happens, not the function header.
4. **The finding's `location` is one of the steps**: the line where the bad outcome is produced (usually the
   second write, the second side effect, the retry call).
5. **The schedule touches the change**: with `--base`, at least one step is on a line the diff adds or
   changes. Otherwise the problem is `pre_existing`.
6. **`outcome` is observable**: a wrong value, a duplicate effect, a stuck lock, a message processed twice,
   with the concrete numbers of the schedule.

## Rules (yours, not machine-checkable)

- Every step must be allowed by the code and the runtime: an actor only switches at an interleaving point
  of the model ([SHARED-STATE.md](SHARED-STATE.md#1-what-runs-at-the-same-time-actors)); a lock blocks the
  second actor; a constraint rejects the second insert. If the schedule needs something the code forbids,
  the candidate is refuted.
- Cite the guard that fails: if there is a check, lock or key on the path, a step shows why it does not stop
  this schedule (the key is not passed, the lock is per call, the check reads a stale copy).
- External behaviour (a gateway's deduplication, a queue's delivery guarantee, a database's isolation level)
  is cited from the code or documentation in the repository; an assumption about it makes the candidate an
  unproven risk naming the missing fact.
- One schedule per finding. Two different ways to fail are two findings.
