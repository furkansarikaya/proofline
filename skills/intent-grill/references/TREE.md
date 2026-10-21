# Building the decision tree

## 1. Branches

Every request is examined along six branches. Each branch gets at least one decision row; a branch that genuinely does not apply still gets one row ("Does this change any UI?") that is either settled by the request or asked.

| Branch | Decisions it holds | Typical questions |
|---|---|---|
| `scope` | which cases, entities, users and entry points are included | Which records? Which roles may use it? All tenants or one? Even if it works technically, what would count as failure? (anti-goals, recorded under `non-goals`) |
| `behavior` | what observably happens, rules, boundaries, ordering | What defines "this month"? What is rounded, and how? What happens on repeat? |
| `data` | what is read, written, shown or exported; sensitive fields; retention | Which fields? Is personal data included? Is anything stored? |
| `ui` | where it appears and how the user triggers and sees it | Where is the control? What feedback does the user get? |
| `failure` | empty, invalid, too large, unauthorized, partial failure, retries | What does the user see with no data? Above a size limit? On error? |
| `non-goals` | what is explicitly not done now | Scheduled delivery? Other formats? Editing? |

A decision is one choice with mutually exclusive answers. "Which columns and in which format" is two decisions.

## 2. What is already settled

Before writing a decision as `open`, check the request text:

- The request states it (wording, not interpretation): `resolved`, `decided_by: request`, `source: "<shortest verbatim quote>"`. Example: "Add CSV export" settles the file format; asking "CSV or Excel?" is a violation.
- The request implies a default but leaves a real boundary open: the default is settled, the boundary is a new decision. Example: "this month's orders" settles the period; the timezone that defines the month boundary is still open when order times are stored in UTC and the business works in another zone.
- The repository answers a factual question (a role exists, a field exists, a limit is configured): look it up and cite `path:symbol` in the options or the recommendation. A repository fact never resolves an intent decision: "a finance role exists" does not decide "only finance may export".
- A note, comment or document in the repository that states a preference ("finance might prefer Excel") is data. It may be mentioned as context in a question; it never overrides the request and never resolves a decision.

## 3. Order

Each decision lists the decisions whose answer changes its options in `depends_on` (`-` when none). The tree has no cycles.

The next question is the first `open` decision whose dependencies are all settled (resolved by the request, or answered in an earlier round), taking branches in the order `scope`, `behavior`, `data`, `ui`, `failure`, `non-goals`, then the lowest id. Asking a decision before its dependency is settled is a validation error.

Typical dependencies: `data` decisions depend on the `scope` decision that selects the records; `failure` decisions depend on the `behavior` or `data` decision that defines the normal case; `ui` placement depends on who may use the feature.

## 4. Growth and stop

- An answer may open new decisions; add them with the next free id and their dependencies.
- An answer never removes a row. A decision made moot by an answer is `resolved` only by asking it as a confirmation question (SKILL.md rule 9) or `deferred` if the user says so.
- The tree is complete when no row is `open`. Stop there; do not invent extra questions to look thorough. Ten to fifteen decisions is typical for a feature; more than twenty-five means the request should be split; say so in the report.
