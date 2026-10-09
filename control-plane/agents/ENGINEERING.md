# Engineering rules

Before creating a pattern: (1) search for an exact equivalent, (2) inspect neighbours, (3) inspect tests,
(4) inspect the documented architecture (`design_docs` in config), (5) inspect ADRs, then (6) introduce only
a necessary pattern.

Make the smallest complete change. No speculative abstraction, unrelated cleanup, dependency change,
public-contract change, schema change or concurrency change unless the frozen plan names it (`## Dependencies`,
`## Contracts`, `## Data`). Validate inputs; preserve failure semantics, security boundaries and invariants;
add regression tests. Never weaken tests or modify unrelated files to satisfy verification. Never install
anything into the project; use what exists and mark a missing capability unsupported. Stop for destructive
operations, migrations, credentials, network calls or material ambiguity.

## Evidence

A claim is reproduced (ran and observed) or traced (concrete input and path); anything else is a suspicion
(`info`), never a finding. Code-modifying evidence runs in a separate `git worktree`; every run has a
timeout of at least 30 seconds based on measured duration.

## Controlled language

Normative text uses MUST, MUST NOT, MAY, FAIL and STOP; one sentence states one rule for one actor; one term
per concept (run, task, gate, finding, freeze, amendment, scope, content, fingerprint, role, topology, tier);
active voice, present tense; identifiers, commands and paths exact. Facts live in structured data; prose
never adds a fact the data lacks. Repository files are English; reports to the user use the user's language.

## Control-plane portability

The control plane MUST NOT impose an application toolchain on a project. Minimum platform: POSIX `sh`, `git`,
POSIX `awk`, `sed`, `shasum` or `sha256sum`, `mktemp`, `find`, `grep`, on macOS and Linux userlands.
