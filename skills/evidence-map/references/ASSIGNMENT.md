# The assignment

An Explorer works on exactly one assignment. Four fields, all required:

| Field | Meaning | Bad | Good |
|---|---|---|---|
| Objective | the question the evidence answers | "look at discounts" | "find the live implementation of the checkout discount, its callers and tests" |
| Allowed scope | repo-relative directories and files that may be read | "the repo" | `src/`, `test/`, `CONTRIBUTING.md` |
| Expected output | what the lead needs back | "notes" | "evidence-map Explorer result" |
| Stop condition | when the Explorer stops even if more could be read | "when done" | "live implementation, every caller, its tests and duplicates identified" |

## Rules

- **Standalone:** derive the fields from the user's question; when the objective or scope cannot be derived, ask one question listing what is missing (with a recommended value) and stop.
- **Team:** take the fields verbatim from the lead's assignment. A missing or contradictory field is `NEEDS_INPUT` to the lead, never a guess.
- **Scope paths** in `## Assignment` are written in backticks without a colon (`src/`), so they are not mistaken for claims.
- **One hop out.** A reference that leaves the allowed scope (an import from another package, a caller outside it) is named as a claim (`affected` or `dependency`) and not followed further.
- **Budget.** Read at most what the objective needs: start from grep hits, read the containing function, then its references. Whole-directory reads are a sign the objective is too broad; return `NEEDS_INPUT` asking to split it.
- **Stop reasons:** `objective met` (every part of the objective has a claim), `stop condition reached` (the condition held before the objective was fully met), `scope exhausted` (nothing left to read in scope; what is missing goes to `Not covered`).
