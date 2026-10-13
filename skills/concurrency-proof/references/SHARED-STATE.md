# Shared state and critical sections

Language-independent heuristics. `find-shared-state.mjs` gives the candidate lines; this checklist turns
them into questions. Answer each with code you read at the head state, never with a guess.

## 1. What runs at the same time (actors)

Name the actors before the state. Typical sources:

- Concurrent requests to one handler (every web server runs requests concurrently, even on one thread).
- Several workers, consumers or replicas reading the same queue, topic or table.
- A timer, cron job or scheduler running while requests are served.
- Retries: the first attempt and its retry are two actors when the first one is not cancelled.
- Threads, goroutines, tasks, `Promise.all`, process pools, parallel test runs.

Then the runtime's model, which decides **where** an actor can be interrupted:

| Model | Interleaving points |
|---|---|
| Single-threaded event loop (JavaScript, Python asyncio, Dart) | only at suspension points: `await`, `yield`, callbacks, `.then`. Code between two suspension points runs atomically with respect to other tasks of the same process |
| Threads, goroutines, OS processes sharing memory | between any two instructions; a non-atomic read-modify-write is never atomic |
| Several processes or replicas | in-process locks and caches do not coordinate them; only the shared store (database, cache server, queue) does |

## 2. Checklist per category

For each category: the pattern that makes it a candidate, then what proves or refutes it.

| Category | Candidate when | Refuted when |
|---|---|---|
| `lost_update` | a value is read, changed in application code and written back (`x = read(); write(x + n)`), with a suspension point or thread switch possible in between | the write is atomic in the store (`UPDATE ... SET n = n + ?`, `INCR`, compare-and-set with a version check that rejects the stale write), or a lock held across the read and the write by every writer |
| `double_processing` | check-then-act: a status or existence check followed by a side effect, then the status write (`if not done: do(); mark_done()`) | the check and the mark are one atomic step (conditional update that reports affected rows, unique constraint, claim with compare-and-set, lock across both) and the side effect runs only for the winner |
| `idempotency` | an operation that may be repeated (retry, redelivery, double submit, client resend) has an external effect (payment, email, stock, row insert) | a key that the effect's owner deduplicates on is passed and is the same for every repetition (check the owner's documented semantics, not the field name); or a unique constraint makes the repeat a no-op |
| `retry_side_effect` | a retry around a call whose earlier attempt may still complete (timeout without cancellation, ambiguous network error after the request was sent) | the call is idempotent by key or by nature (pure read), or the earlier attempt is cancelled before the retry and cancellation is honoured by the callee |
| `race` | two actors use shared mutable state (module-level variable, cache, singleton, global map, file) and the outcome depends on their order | the state is only touched between suspension points of a single-threaded runtime, is per-request, or every access holds the same lock |
| `deadlock` | two locks (mutexes, row locks, advisory locks, table locks) taken in different orders on different paths; a lock held while waiting for a resource that needs the same lock; a non-reentrant lock re-acquired | one global acquisition order on every path; a timeout that releases and reports; try-lock with back-off that cannot starve both |
| `ordering` | consumers assume messages or events arrive in send order across partitions, consumers or retries | ordering is guaranteed by the transport for this key (single partition per key, sequence check that rejects out-of-order) and the code relies only on that |
| `redelivery` | an at-least-once consumer acknowledges after the effect, or has an effect that is not idempotent | the effect is deduplicated by message id (stored atomically with the effect), or acknowledgement and effect commit together |
| `timeout` | a timeout that abandons work which continues (no cancellation), or returns failure for an operation that may have succeeded; missing timeout on a call that holds a lock | the abandoned work is cancelled and the callee stops, or the caller treats "unknown" outcomes as unknown and reconciles |
| `transaction_boundary` | related writes in separate transactions; a remote call or message publish inside a transaction that may roll back; reads outside the transaction used for writes inside it; isolation level too weak for a read-then-write | the writes share one transaction; the publish uses an outbox committed with the data; `SELECT ... FOR UPDATE` or a serializable isolation covers the read-then-write |
| `lock_lifecycle` | a lock released on the success path only (no `finally`/`defer`), a lock held across a suspension point that may never resume, a lease or TTL lock whose holder can outlive it, a lock object created per call (protects nothing) | release in `finally`/`defer`/`with`; a fencing token on lease locks; one lock instance shared by every contender |

## 3. Critical section

Write the critical section as: the shared state, the first line that reads or checks it, the last line that
writes it or acts on the check, and every interleaving point in between. No interleaving point, no race in
that section (in a single-threaded runtime). An interleaving point plus a second actor that can enter the
same section is a candidate for [INTERLEAVING.md](INTERLEAVING.md).

## 4. What is not a finding

- A pattern that looks dangerous but has no second actor (code run once at start-up, a per-request object).
- A synchronous check-and-set in a single-threaded runtime: nothing can run between the check and the set.
- A lock you would have written differently, when the schedule shows it holds.
- "Could be a problem if deployed across several processes" without evidence that it is: an unproven risk
  naming the deployment fact that is missing.
