# Expected: system-design

Evaluator only; never shown to the runner. Outputs: the architecture text / `ARCHITECTURE.md` draft and
any ADRs (standalone: under `.agents/local/system-design/`, or ADR drafts for `docs/adr/`), and the final
message. `selfcheck.sh` proves the planted facts.

Planted facts: `src/customers/repository.js:createCustomerRepository` (`list`, `marketingOptIn` field),
`src/orders/repository.js:createOrderRepository` (`byCustomerSince`), `src/notify/email.js:createMailer`
(`sendEmail`) already provide every capability except the weekly run itself. `deploy/README.md`: the HTTP
service runs as 2 replicas; the platform runs scheduled jobs from `deploy/jobs.yaml`, at most one
instance at a time (example: `cleanup-sessions` -> `scripts/cleanup-sessions.js`).
`src/notify/legacy-sms.js` is dead code; `src/billing/` is unrelated.

## MUST

1. Exactly one new component (e.g. a digest module under `src/digest/` or a job script under
   `scripts/`, or both as one component: the job entry point plus its logic), with its path stated.
2. Every existing component in the design is mapped to its real path and symbol:
   `src/customers/repository.js` (`list` / `marketingOptIn`), `src/orders/repository.js`
   (`byCustomerSince`), `src/notify/email.js` (`sendEmail`), `deploy/jobs.yaml`. Each cited path exists.
3. The weekly trigger is a job in `deploy/jobs.yaml` (schedule `0 8 * * 1` or equivalent), following the
   `cleanup-sessions` pattern, and the design states why not an in-process timer in the HTTP service
   (2 replicas -> each customer would get two emails).
4. Exactly one ADR, and it records the real trade-off: how the weekly run is triggered and kept from
   sending twice (platform job vs in-process timer across 2 replicas, and/or re-run idempotency), with
   the alternatives considered.
5. The opt-in filter (`marketingOptIn`) and the "no orders -> no email" rule appear in the design.

## MUST NOT (over-design smells; any one fails the run)

6. A second ADR, or an ADR for a choice with no real alternative here (file layout, email wording,
   function names, test framework, date maths).
7. A message queue, event bus, outbox, pub/sub, or a new service/process other than the scheduled job.
8. A generic scheduler/job framework, plugin system, or "jobs registry" abstraction inside the app.
9. New interfaces/ports/adapters or repository abstractions wrapping the existing repositories or mailer
   (e.g. `IOrderRepository`, `EmailProvider` interface) with one implementation.
10. A new dependency (e.g. a cron or email library) or a new datastore/cache.
11. Speculative extension points: configurable frequencies, multiple channels (SMS/push), template
    engines, localisation, A/B variants — none is requested.

## MUST NOT (decoys)

12. No change proposed to `src/notify/legacy-sms.js` (no removal, refactor or reuse) and no component
    for SMS.
13. `src/billing/` does not appear as a component of the design.
14. No file outside the skill's own output is created or modified; no commit.
