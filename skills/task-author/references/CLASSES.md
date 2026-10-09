# Classification

The class decides which artifacts and gates the run needs. The highest class any indicator reaches wins. When unsure between two classes, take the higher. A destructive or irreversible migration makes the task CRITICAL.

| Class | Indicators (any one places the task here) | Examples |
|---|---|---|
| TRIVIAL | All of: at most 2 files; no behaviour change to executable code; no design choice; no public contract, persistence, security or concurrency involvement | typo, comment, small deterministic doc or config change |
| STANDARD | Bounded behaviour change or fix confined to one component; no new integration; no persistence or messaging change; no security boundary | ordinary feature, bounded bug fix, localized API behaviour |
| COMPLEX | Two or more modules or layers; new integration or dependency; public API or contract change; persistence, schema or messaging change; meaningful concurrency; significant refactor; a design choice with real tradeoffs | new integration, cross-module change |
| CRITICAL | Authentication, authorization, cryptography, secrets or credentials, any security boundary; destructive or irreversible migration; financial or data-integrity-critical behaviour; major concurrency or idempotency; high-impact infrastructure, CI or deploy | login, permissions, data migration |

## How to apply

1. List the indicators the request touches, using only facts from the request and the repository (`path:symbol`).
2. The class is that of the highest indicator. Write it as `<CLASS> - <indicator>` (for example `COMPLEX - public API contract change`); with several, name the one that decided plus the others in parentheses.
3. A request that is vague about which side of a boundary it falls on (does it touch persistence? auth?) is classified one level up and the uncertainty goes to `## Risks`, or becomes a question.
4. The suggestion is advisory: the lead classifies by script and may differ; the validator checks only that a valid class and an indicator are present.
