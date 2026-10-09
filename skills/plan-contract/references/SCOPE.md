# Scope

## 1. Format

The canonical front matter, exactly this shape (two-space list items, four-space keys; `agent.sh` reads the same subset):

```
---
scope:
  - path: src/shipping.js
    new: true
    criteria: [AC-1, AC-2, AC-3]
  - path: test/shipping.test.js
    new: true
    criteria: [AC-1, AC-2, AC-3]
  - path: config/shop.json
    criteria: [AC-3]
    tdd_exemption: "data file read by src/config.js; AC-3 is proven by test/shipping.test.js"
---
```

| Key | Required | Value |
|---|---|---|
| `path` | yes | repo-relative file path; no `./`, `..`, glob characters (`* ? [ ] { }`), or directory |
| `criteria` | yes | flow list of `AC-<n>` ids from TASK.md, at least one |
| `new` | no | `true` when the plan creates the file; omitted or `false` otherwise |
| `tdd_exemption` | no | quoted reason why RED/GREEN evidence does not apply to this path |

No other keys, no other top-level keys, no comments inside entries.

## 2. Deriving scope

1. Per criterion, the behavior that must change and where it lives: the `code` claims of EVIDENCE.md, or `git grep` on the criterion's nouns when the class has no EVIDENCE.
2. Add the test file that proves the criterion (existing test file next to the code first; a new one only when none covers the module).
3. Add callers only when their code must change, not because they call changed code; a caller whose output changes but whose code does not is a regression risk for `## Tests`, not scope.
4. Prefer modifying an existing file to creating one; a new file needs a criterion no existing file can serve without mixing responsibilities.
5. Exclude: dead or duplicate implementations (EVIDENCE `conflict`), formatting-only changes, unrelated cleanups, generated files (list the generator's input instead), lockfiles unless `## Dependencies` adds a package.

## 3. TDD exemptions

Allowed only where a failing-then-passing test cannot exist for that file: data or config files read by tested code, documentation, generated metadata. The reason names what proves the behavior instead. "not needed", "config change", "trivial", "n/a" and similar are rejected: the validator strips stock phrases and requires at least 15 meaningful characters to remain, and at least 20 characters overall. A behavior-changing source file never gets an exemption.

## 4. Validation rules

`validate-plan.mjs <PLAN.md> <TASK.md> [--class C] [--repo DIR]` exits 1 on any of:

- front matter missing, not closed, not canonical, an unknown key, a key twice;
- empty scope; more than 2 paths for TRIVIAL;
- a glob, absolute, `./` or `..` path; a path under `.agents/runs/` or `.agents/local/`; a duplicate; a directory; a path resolving outside the repository;
- a path that does not exist and is not `new: true`; a path that exists and is `new: true`;
- a path with no criterion, or with a criterion TASK.md does not define;
- a TASK criterion served by no scope path and no `## Tests` line naming an existing or in-scope test file in backticks;
- a `## Tests` line for an unknown criterion;
- an invalid `tdd_exemption`;
- a missing title `# Plan: <TASK-ID>` or one naming another task; no criteria in TASK.md; an invalid class;
- a required section missing ([SECTIONS.md](SECTIONS.md)), a section twice, an empty or placeholder section (`TBD`, `TODO`, `...`, `<...>`);
- `## Data` whose first line is not `destructive: yes|no`, or `destructive: yes` with a class other than CRITICAL;
- `## Dependencies` or `## Contracts` that is neither `none` nor a `- ` list;
- `## Verification commands` without a command in backticks or a code block.
