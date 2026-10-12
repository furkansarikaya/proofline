# proofline: Design Decisions

This document records every decision made in the design (grilling) session for **proofline**. It is the single source of truth for the first build. Anyone changing a decision updates this file and states why. Decisions taken autonomously during the build go into the "Decisions made autonomously" section at the end.

## What proofline is

proofline is a complete, language-agnostic engineering team for coding agents. A **lead** (the main session) runs a **deterministic workflow**: it classifies each task, freezes what the class requires, dispatches **bounded specialist roles**, passes the change through **independent, evidence-based gates**, and stops before delivery. Every specialist works through a **skill** that produces runnable or traceable evidence; nothing passes on a model's say-so.

Three layers:

- **Workflow** (when): classification, freezes, gates, fix loop, cleanup. Derived from the author's [deterministic-agent-workflow-example](https://github.com/furkansarikaya/deterministic-agent-workflow-example).
- **Roles / agents** (who): Lead, Task Author, Explorer, Architect, Data Architect, Designer, QA, Implementer, Reviewer, Security Reviewer, Verifier.
- **Skills** (how): one method per job, each usable on its own. Includes the existing [test-trust](https://github.com/furkansarikaya/test-trust) and [proof-review](https://github.com/furkansarikaya/proof-review).

Guiding principle across everything: **no evidence, no claim.**

---

## 1. Identity

**D1. Name: `proofline`.** Used for the repository, plugin, CLI (`proofline`), slash commands (`/proofline …`) and folders. Before anything else, the build checks GitHub for an existing project with this name; on a clash it stops and reports.

**D30. Version: 0.0.1.** Full scope, but the number says "not yet proven on real projects". All skills carry the team's version. Until 1.0.0: 0.0.x for fixes, 0.x.0 for new features or behaviour changes. The standalone test-trust and proof-review repositories are archived (with a pointer to proofline) only after proofline has been used on a real project; their old install commands keep working with the frozen versions.

**D33. License and attribution.** MIT, copyright "2026 Furkan SARIKAYA". No code or text is copied from other repositories, so no attribution is required, and no third-party project name is used anywhere in the repository (README, documentation, decisions, changelog, skills, roles). Platform, tool and standard names that proofline runs on or integrates with (Claude Code, Codex, GitHub, GitLab, Jira, Linear, the Agent Skills standard, Conventional Commits) and the author's own repositories may be named. The author's private review flow contributes **architecture only**; no organisation-specific name, rule, skill name, path or branch may enter the repository. A pre-release scan checks every file and commit against the author's forbidden-pattern list (see D19), which itself is never committed.

---

## 2. Lead and orchestration

**D2. The lead is the main session.** It takes the workflow's Orchestrator role (`full_lifecycle`). It never writes product code: while a run is active, a hook blocks the lead from editing anything except run artifacts and task files. The lead's context stays small: it consumes only compact, structured specialist results (D12), never raw output. Lead mode starts with `/proofline` or automatically at session start when proofline is installed in the project. Its method is the **proofline-lead** skill (D22).

**D3. Autonomy and stop points.** Four stop points always apply:

1. a specialist's question (relayed verbatim, D13),
2. destructive or irreversible operations (data deletion, destructive migrations),
3. a need to change scope,
4. commit, push, PR.

Two autonomy levels: **supervised** (stop for plan approval before the plan freeze) and **autonomous** (run to CODE_DONE without stopping). Default by class: TRIVIAL and STANDARD autonomous, COMPLEX and CRITICAL supervised. Configurable in config and per task ("finish this without asking").

**D4. Concurrency.** One active run per worktree; one implementation worker per run; Explorers in parallel up to the class bound; reviewers in parallel at the gate. The lead manages a **task queue** (sequential, each task in its own run). Parallel tasks only in separate git worktrees, each with its own run; `max_parallel_runs` defaults to 1. The lead never starts a parallel run whose scope overlaps a running one.

**D5. Execution policy and model profiles.** One execution policy, resolved by one script, decides model, effort, context budget and escalation per role and runtime.

- Profiles: **`max`** (Opus-heavy, every focus a separate reviewer, test-trust full mode where useful), **`balanced`** (default), **`economy`** (Opus only for the security reviewer or not at all, small focuses merged into one reviewer, no advisor calls, test-trust diff mode only). Chosen at `init`; overridable per role and per run.
- `balanced` defaults: lead and Architect Opus; Data Architect Opus; Explorer, Implementer, Verifier, Designer and review focuses Sonnet; Security Reviewer always Opus.
- Escalation to a stronger model: low-confidence PASS, a recent FAIL on the same focus, large diff or plan, CRITICAL class, second fix round.
- Sonnet roles may consult an Opus **advisor** on borderline calls, capped per run.
- Budgets in config: max advisor calls, max escalations, max parallel reviewers per run.
- Duration and outcome history in `.agents/local/metrics/` (one small file, `metrics: off` disables it) informs routing.
- Every routing decision goes into the run ledger with its reason; the completion report shows which model and runtime did what.

**D6. Runtime per role.** Config sets `runtime.lead`, `runtime.worker`, `runtime.reviewers` (and per role if needed) to `claude` or `codex`, so "Claude only", "Codex only" and mixes (e.g. Claude lead, Codex worker) all use one structure. Two architectural rules make this possible:

- **Enforcement core is platform-independent.** State transitions, freezes, gate checks and the commit/push lock live in `agent.sh` and git hooks (pre-commit, pre-push), which work whatever agent is used. Claude Code hooks and Codex mechanisms are extra layers, never the foundation.
- **Roles come from one source.** Each role is defined once (D11); a generator renders Claude Code agents and Codex formats from it. CI checks generated files are in sync.

**D7. Failover.**

- **Lead failover is by design:** all state is in `RUN.yaml`, the ledger and run artifacts, written after every transition. If the Claude lead runs out of limit, the user opens Codex and runs `proofline resume`; Codex continues from the last completed transition. An interrupted step restarts from its beginning, never from the middle.
- **Specialist failover** is configured: `failover: auto | ask | off`, default `auto` when both runtimes are installed. Switching happens only at step boundaries, is written to the ledger with the reason, and shows in the completion report. This is not the "silent fallback" the workflow forbids, because it is explicitly allowed by config and recorded.
- **Capability floor:** if the other runtime cannot meet a role's required capability under the active profile (e.g. the security reviewer's required model), there is no switch; that gate is BLOCKED. Security is never silently downgraded.

**D8. Platform support tiers.**

| Tier | Platforms | What works |
|---|---|---|
| **Full** | Claude Code, Codex | Lead, all hooks, agents, commands, gates, routing, failover. Tested end to end. |
| **Protocol** | Any agent that reads `AGENTS.md` and runs shell commands | The workflow in `standalone` topology; enforcement through `agent.sh` and git hooks; skills via the Agent Skills standard. |
| **Worker** | Any agent with a headless CLI mode | Can be a worker or reviewer through a command template in config. |

Runtimes are added through **adapters**: one small package per agent that renders role definitions into its format and maps its hooks. Only agents actually installed on the build machine are tested; every untested row is labelled "not tested". README has a "community adapters" section and a one-file adapter guide; others add support by PR.

### Installation and updates

- **`proofline init`** (`/proofline init` in Claude Code, `proofline init` script elsewhere): asks for runtimes, model profile, task adapter, protected branches (D34), push approval and forbidden commit identities; discovers the project's language, build and test commands and fills config; installs the control plane (`.agents/`, scripts, `AGENTS.md`, `CLAUDE.md`, git hooks) and places agents and skills for the chosen runtimes. Never overwrites existing files: merges and shows what changed.
- **`proofline upgrade`**: updates the control plane, preserves user-modified files and config fields, reports conflicts.
- **`proofline doctor`**: verifies hooks, runtimes, config validity, which commit identity will be used, and that each enforced rule is really enforced.
- Claude Code plugin marketplace supported. Codex and terminal installation by cloning the repository and running the install script; no `curl | bash`. Skills alone remain installable with `npx skills add`.

---

## 3. Roles

**D9 + D24. Role list.** Based on the workflow's roles, with the Reviewer split per the review flow and a design family added:

| Role | Does | Skills | Conditional |
|---|---|---|---|
| **Lead** | Owns the lifecycle; only role that changes task state or declares DONE | proofline-lead, plan-contract, debug-proof | always |
| **Task Author** | Turns a one-sentence request into a standard task | task-author, intent-grill | when no task exists |
| **Explorer** | Bounded investigation, compact verified evidence | evidence-map | not TRIVIAL |
| **Architect** | System and API design; plan `## Architecture`; ADRs | system-design, api-design | COMPLEX, CRITICAL, or on request |
| **Data Architect** | Data model and migrations; plan `## Data` incl. migration plan | data-design | when persistence/schema changes, or on request |
| **Designer** | UI design; `DESIGN.md`; per-task UI spec | ui-design | when UI changes, or on request |
| **QA** | QA plan before; QA report after | qa-plan, test-trust | STANDARD and up |
| **Implementer** | The approved change with RED/GREEN evidence | tdd-proof, debug-proof | always |
| **Reviewer** | Focuses: plan, rules, tests, data | proof-review, test-trust | per tier (D14) |
| **Security Reviewer** | Attacker-minded, exploitable findings only | exploit-proof | full tier |
| **Verifier** | Mechanical proof the frozen plan is implemented | verify-proof, design-sync | always |

The workflow's "no swarm, no recursion" rule holds: specialists never spawn agents; only the lead dispatches. Communication is only lead → bounded assignment → specialist → owned artifact + structured result → lead. A destructive migration makes the task CRITICAL and requires user approval.

**D11. Role source format.** Each role is `roles/<role>.md`: frontmatter (purpose, artifacts read, artifact owned, skills, allowed tools, model per profile, timeout, stop condition) and body (extended Does / Must-not table, step-by-step method, output format). The generator renders Claude Code agents and Codex formats; CI checks sync and protocol conformance.

---

## 4. Protocols

**D12. Result protocol.** Every specialist returns a fixed header block, then a compact findings table, then `BLOCKED_REASON` if any:

```
ROLE: <role>
TASK: <TASK-ID>
RESULT: PASS | FAIL | BLOCKED          (gate roles)
RESULT: DONE | BLOCKED | NEEDS_INPUT   (other roles)
CONFIDENCE: high | medium | low
FINGERPRINT: <git tree id of the evaluated content>
ARTIFACT: <path> <sha256>
```

Gate results are computed by the skill's rule, not by the model's judgement. A SubagentStop hook (Claude) or `agent.sh record` (Codex and others) parses and records the result; the lead can never write a verdict. Only the header and table reach the lead's context.

**D13. Handoff protocol.** When a specialist needs the user, it writes its state to its artifacts and returns `RESULT: NEEDS_INPUT` with numbered questions (text, options, recommended answer, why it is asked). The lead relays them **verbatim**: it never answers, summarises, or applies the recommended answer by default. After the user answers, the lead restarts the specialist on the same run with an `ANSWERS` block; the specialist resumes. Answers are logged with `answered_by: user`, so a lead answering on the user's behalf is auditable. The lead's own questions (plan approval, scope change) use the same format.

---

## 5. Gates

**D14. Class and tier.** The **class** (TRIVIAL…CRITICAL) decides which gates are mandatory; the **tier** decides review depth. Tier is computed from the diff by script, never from the lead's claim.

| Tier | Condition | Review |
|---|---|---|
| **docs** | Only plain documentation | No reviewer; secret scan only |
| **small** | ≤ 2 files, ≤ 30 lines, no risky path | One reviewer doing rules + tests |
| **full** | Everything else | plan, rules, tests, data (if plan has `## Data`), security, in parallel |

- CRITICAL is always full.
- Risky paths come from config with language-agnostic defaults: migrations, auth, security, payment, crypto, CI and deploy files, dependency manifests, infrastructure.
- **Code-like Markdown is never docs:** `.agents/**`, `skills/**`, `roles/**`, agent definitions, `AGENTS.md`, `CLAUDE.md`, prompt files (configurable list).

Review rules carried over from the author's review flow, generalised:

- Verdicts are recorded by a hook from the reviewer's output, never by the lead.
- **Content fingerprint:** if a single byte changes anywhere, earlier PASSes go stale.
- A PASS with `CONFIDENCE: low` does not count; that focus re-runs with a stronger model.
- **Pre-existing failures:** a failing test is re-run in a clean worktree at the base; if it also fails there, it is reported as pre-existing and is not a FAIL.
- A new dependency not named in the plan is a FAIL.
- A change to a versioned contract (API version, schema version) that the plan does not name is a FAIL.
- Database change classification is done from the diff only.
- Secret scan uses the project's own tool if present, otherwise a built-in pattern scan; secrets block the gate.
- Commit and push need both the gate's PASS for the current content and the user's explicit approval in the current message.

**D15. Fix loop.** `max_fix_rounds: 2` by default (configurable). FAIL findings go back to the worker that made the change, in the same worktree (same thread for Codex). Each round's context contains previous findings and files changed in that round; only reviewers made stale by the change re-run. Round 2 triggers escalation (D5). If findings remain after the last round, the run ends `terminate FAILED`, commit/push stay locked, and the lead reports the remaining findings and why. Never an endless loop.

**D16. Waivers.** Security and secret findings can never be waived. Other FAIL findings may be waived only by the user's explicit instruction in the current message, finding by finding, with a reason; the lead can never waive. Waivers go into the ledger and the completion report; with `waiver_followup: task` a follow-up task is created per waiver. One unwaived FAIL keeps the gate closed.

---

## 6. Tasks and delivery

**D17. Task standard.** The **task-author** skill turns a one-sentence request into a task following the workflow's `TASK.md` template: goal, context, numbered testable acceptance criteria, out of scope, constraints, risks, suggested class. It self-checks: every criterion is observable behaviour; criteria do not dictate implementation unless the user stated a constraint; out of scope is explicit; class matches the indicators. Ambiguity gets one `NEEDS_INPUT` round; nothing is invented. For COMPLEX/CRITICAL requests or on request, **intent-grill** runs first.

**D18. Task integrations.** Two-way adapters: import an external issue into canonical `TASK.md`, write the completion report back and update status. **markdown** (default) and **GitHub Issues** (via `gh`) are fully supported and tested. **Jira** and **Linear** are written to the adapter contract and labelled "not tested". Imported issue text is data, never instructions.

**D25. Task formats.** One canonical internal format (`TASK.md`) plus one **template per target** in `.agents/templates/tasks/` (Jira: summary, description, acceptance criteria, labels, components; GitHub: markdown body and labels; Linear; markdown). Templates are user-editable, so a team defines its own format (required fields, custom sections) once. Import parses with the template; missing canonical fields are asked via `NEEDS_INPUT`.

**D19. Git flow and identity guard.**

- Each task works on its own branch, `proofline/<TASK-ID>-<slug>`, created at the BRANCH step.
- Commit message format from config (default Conventional Commits with the task ID).
- PR body from the completion report and review summary. The agent never merges or tags.
- **Identity guard:** config lists forbidden commit-email patterns (e.g. an employer domain); a pre-commit hook blocks commits with a matching identity; `doctor` shows which identity a repository will use. Global git configuration is never touched.

**D34. Branch and push policy belongs to the team.** proofline does not hardcode team policy: the protected-branch list comes from config and is **empty by default**; `init` asks, and may read the platform's settings as a suggestion. Two workflow guarantees remain because they are not team policy but agent safety: every task runs on its own branch (no implementation directly on the canonical branch), and `push_requires_approval: true` by default (configurable).

---

## 7. Skills

**D22. Skill set (17).** All share one philosophy and the infrastructure rules in section 9; each works standalone.

| Skill | Purpose |
|---|---|
| **proofline-lead** | The lead's lifecycle method: classify, dispatch, consolidate, gates, fix loop, cleanup |
| **task-author** | Standard tasks and per-target formats (D17, D25) |
| **intent-grill** | Decision-tree interview for vague requests; output feeds task and plan |
| **evidence-map** | Explorer: compact EVIDENCE where every claim is a verified `path:symbol` |
| **plan-contract** | Executable, scoped plan; every scope path maps to a criterion; self-validating |
| **system-design** | Architecture: C4-style levels, components mapped to repo paths, ADRs |
| **api-design** | API contracts; uses existing OpenAPI/GraphQL/proto if present, else `API.md` |
| **data-design** | Data model, ERD, invariants; migration plan (expand/contract, backfill, reversibility, lock risk, rollback) |
| **ui-design** | `DESIGN.md` design system; per-task UI spec (screens, flows, states, accessibility) |
| **qa-plan** | Acceptance and adversarial scenarios before implementation |
| **tdd-proof** | Recorded RED (for the right reason; a compile error is not RED), GREEN, refactor; checks the new test is not hollow |
| **debug-proof** | Reproduce, hypothesise, narrow (incl. bisect), prove root cause, regression test |
| **test-trust** | Flaky, hollow, slow tests (D20) |
| **proof-review** | Intent, rules, bugs with evidence (D21) |
| **exploit-proof** | Attacker-minded source-to-sink review; exploitable findings only; reproduced or traced |
| **verify-proof** | Each acceptance criterion has a passing test; scope respected; commands pass; evidence only |
| **design-sync** | Design documents checked against code (D26) |

Deliberately not included: language-specific reviewers, refactor-cleaner (the workflow forbids unrelated cleanup), doc-updater (the knowledge step covers it), build-error resolver (within debug-proof). "Planner" in the README refers to plan-contract.

**D20. test-trust in the team.** Two modes. **full** (today's audit; standalone or as its own task). **diff** (the review gate's tests focus): runs changed tests and tests covering changed units in isolation a few times; mutates only changed units. Gate rule for diff mode: confirmed flaky in changed/covering tests, or hollow on a changed unit → FAIL; slow tests informational. Both modes follow D10, D12, D13. Thresholds (repeat counts, mutation budget, slowness ratios) in config. All existing decisions (evidence rules, worktree safety, fixtures) are kept; standalone use via `npx skills` continues.

**D21. proof-review in the team.** Inside a run, the intent source is the frozen `PLAN.md`: each acceptance criterion is a claim; any changed path outside `scope:` is unrequested. A `focus` parameter (`plan`, `rules`, `bugs`, or all) lets the gate run separate or combined reviewers. Gate rule: a missing or partial claim, a reproduced or traced bug, or a rule violation → FAIL; suspicions only → PASS. Outside a run it works as today (working tree, branch, PR). D10, D12, D13 apply.

**D26. Durable design documents and drift.** Locations from config; defaults: `DESIGN.md` at the repo root, `docs/design/ARCHITECTURE.md`, `docs/design/DATA_MODEL.md`, `docs/design/API.md`, ADRs in `docs/adr/`. The workflow's knowledge step updates them when a task changes a durable contract. **design-sync** checks claims against code (every table in `DATA_MODEL.md` exists in the schema; every component path in `ARCHITECTURE.md` exists; every endpoint in `API.md` exists) in the verify gate; drift is a FAIL. `/proofline design system|data|api|ui` reverse-engineers these documents from existing code, suggested as a first step when installing into an existing project.

**D23. Commands.** `/proofline` (status and next step), `init`, `upgrade`, `doctor`, `task` (`--grill` starts with intent-grill), `design system|data|api|ui` (`--check` runs design-sync), `run <TASK>`, `resume`, `queue`, `review` (standalone proof-review), `audit` (test-trust full), `debug`, `deliver <TASK>` (commit and PR with approval), `clean`. In Codex and terminals: `proofline <command>` plus the `AGENTS.md` protocol.

---

## 8. Artifacts and local state

**D10. Where things live.**

- **Inside a run:** everything under `.agents/runs/<TASK-ID>/` as registered artifacts (`agent.sh` knows them; unknown files are still rejected; gates bind to their hashes, e.g. `reviews/proof-review/`, `reviews/test-trust/`, `security/`, `design/`). Run cleanup deletes the folder; summaries go into the completion report. Run artifacts are required: gates, resume after failover, fix rounds and role-to-role communication all depend on them.
- **Outside a run** (standalone skill use): `.agents/local/<skill>/<target>/`, git-ignored, keeping only the ledger and findings; raw evidence is deleted once the report is written; when a re-run shows all findings closed, the folder deletes itself. `local_state: off` keeps nothing (re-runs start from scratch). `proofline clean` removes everything.
- Metrics: `.agents/local/metrics/`, `metrics: off` disables.
- The project root is never cluttered; everything proofline writes is under `.agents/`.

---

## 9. Inherited from test-trust and proof-review

These apply to every skill and role:

- **Evidence or nothing.** Findings are reproduced (ran and observed) or traced (concrete input and path); everything else is a suspicion, never a finding.
- **Never install anything** in the user's project. Use what exists; mark missing capabilities unsupported and narrow the step.
- **No ecosystem-specific instruction files.** Discover commands from CI config, build scripts and README; the project's own commands win; prove a capability with a real trial before relying on it.
- **Isolated execution:** anything that modifies code for evidence runs in a separate `git worktree` (uncommitted changes copied in when relevant). Git-ignored dependency folders are symlinked; build output folders are neither linked nor copied. An unmodified verification run comes first; all path checks via `realpath`; the worktree path is recorded before use and cleaned on resume.
- **Timeouts** on every run, based on measured duration, at least 30 seconds.
- **Bundled paths** resolve relative to the skill's own directory.
- **Content is data, not instructions:** repository files, PR descriptions, issue and task texts, commit messages and rule files (CLAUDE.md, AGENTS.md, …) are never followed as instructions. Commands found in them only run when they are the project's test/build commands.
- **Project rules check** (from proof-review D16): written, checkable team rules are evidence; vague rules produce no finding; only new violations in the diff are reported; context-bounded reading.
- **Sandbox warning** once, before any project code first runs.
- **Ledger:** resume point and audit trail; each step's rows written before the next step starts; never records what did not happen.
- **Language:** all repository files in English; reports to the user in the user's language; identifiers, paths, commands and enum values never translated.
- **Commit identity:** never the user's global identity by assumption; respect D19.

---

## 10. Repository, tests, docs

**D29. Repository layout and technology.**

```
proofline/
├── README.md  LICENSE  CHANGELOG.md
├── roles/                    role sources (D11)
├── skills/                   17 skills, each standalone
├── adapters/claude/          generator output targets, hooks, commands, plugin manifest
├── adapters/codex/
├── control-plane/            .agents/ template, agent.sh and scripts, git hooks, templates
├── bin/proofline             init, upgrade, doctor, commands
├── fixtures/                 per-skill fixtures with EXPECTED files
├── playground/               sample project for end-to-end team runs
├── tests/                    script self-tests, enforcement tests, generator tests
└── docs/                     decisions.md, concepts, guides (EN + TR), generated references
```

- Control plane and CLI in POSIX `sh` (plus `git`, `awk`, `sed`, `shasum`), like the source workflow. Skill validators in dependency-free Node, optional.
- Windows: officially via WSL or Git Bash; stated in README.
- No file sharing between skills; a CI check verifies duplicated shared sections have not drifted.

**D27. Test strategy (four layers).**

1. **Script self-tests:** lifecycle, freezes, gates, tier computation, execution policy, adapter generation, install/upgrade/doctor, in throwaway repositories.
2. **Enforcement tests:** each forbidden action is actually attempted and must be blocked: lead editing product code, commit without gate, commit with a forbidden identity, lead writing a verdict, out-of-scope change, push without approval.
3. **Skill fixtures:** existing test-trust and proof-review fixtures kept; every new skill gets a known-answer fixture (e.g. exploit-proof: planted vulnerability plus decoy; data-design: destructive migration; design-sync: drifted document; tdd-proof: a "RED" that is really a compile error).
4. **End-to-end team runs** in `playground/`: one task per class (TRIVIAL typo; STANDARD bug fix; COMPLEX feature with UI and data change; CRITICAL change with a destructive migration that must stop for approval), each under three runtime configurations (Claude only, Codex only, Claude lead + Codex worker), plus a failover scenario (Claude lead stopped mid-run, Codex `resume` completes). An independent evaluator compares each run with its EXPECTED file; runners never read EXPECTED files.

**D28. Codex during the build.** Codex is not used for development work (writing or reviewing). It runs only as a runtime under test in end-to-end scenarios. If Codex is not installed, those scenarios are skipped and reported as "not tested", and the support table says so.

**D31. Documentation.** README as a hub: one-sentence promise, install per runtime, support tiers table, 5-minute quick start, real output from an end-to-end run (never invented). `docs/`: concepts (workflow, roles, gates, enforcement, failover), guides (daily use, adding to an existing project, defining task templates, writing an adapter), and role and skill references generated from sources. English primary; the daily-use guide and prompt catalogue also in Turkish.

**D32. Build process.** Phases, each ending with a commit on a local `initial` branch; nothing is pushed and no GitHub repository is created during the build. Progress in a git-ignored progress file; an interrupted build resumes from it. If a local hook blocks a commit, the phase is saved with `git bundle` and the build continues; the report says so.

Phases: 0 name check and repository; 1 contracts and control plane; 2 role sources, generator, adapters; 3 lead, hooks, enforcement tests; 4 port test-trust and proof-review; 5 new skills and fixtures; 6 install, upgrade, doctor; 7 end-to-end team runs; 8 documentation; 9 release preparation and final scans.

---

## Open technical points to verify during the build

- How each runtime lets a role agent use a skill that is marked user-invoked only for top-level sessions. Preferred: role definitions point agents to the skill's `SKILL.md` path explicitly. If a platform prevents this, choose the closest working mechanism and record it below.
- Exact Claude Code plugin and marketplace format, hook events and Codex agent/config formats: verify against current documentation, not memory.

## Decisions made autonomously

Each entry: decision — reason — alternatives considered.

- **A1. Reviewer results carry a `FOCUS:` line** (D12 header extension). — `record` must map a reviewer result to one gate (REVIEW_PLAN/RULES/TESTS/DATA/SMALL). — Separate role ids per focus (more agents to generate and keep in sync).
- **A2. Gate set and tiers.** Gates: SECRETS, REVIEW_SMALL, REVIEW_PLAN, REVIEW_RULES, REVIEW_TESTS, REVIEW_DATA, SECURITY, QA, VERIFY. Review gates come from the computed tier for every class (a TRIVIAL code change still gets the small review); the tier never decreases within a run; docs tier only for plain-documentation extensions after risky/code-like paths are excluded. — D14 says the tier is computed from the diff, never claimed. — Class-only review requirements (would let a TRIVIAL label skip review of code).
- **A3. REVIEW_RULES covers project rules and the proven-bug hunt** (proof-review focus `rules+bugs`, reported as `FOCUS: rules`); REVIEW_SMALL = proof-review `rules+tests`. — D14 lists plan, rules, tests, data, security; the bug hunt needs a home. — A separate bugs gate (one more reviewer per full review).
- **A4. Findings-table severity is `blocking | info`** (gate effect only); finding ids `<GATE>-<n>` for gate results, `<role>-<n>` for task results; skill-internal ids stay in artifacts. — proof-review's no-severity rule; mechanical gate rules. — A CRITICAL..LOW scale (judgement leaks into the gate).
- **A5. Gate roles never return NEEDS_INPUT**; a decision they cannot make is `BLOCKED` with the reason. — D12 gives gate roles PASS/FAIL/BLOCKED only. — Allowing NEEDS_INPUT from gates (ambiguous gate state).
- **A6. Per-focus artifact directories** (`reviews/proof-review/{plan,rules,small}/`, `reviews/test-trust/{tests,qa}/`, `reviews/data-design/`, `security/`) and `record` refuses an artifact outside the role/focus set. — Parallel reviewers overwrote each other's report and voided each other's gate. — One shared report file.
- **A7. Verdict and approval provenance.** Gate records, waivers and approvals count only when the creating command bound their sha256 into the ledger; prompt captures and approval files must be regular, single-link, symlink-free files. — Review found hand-written files and symlinked captures could forge a PASS, a waiver or an approval. — Trusting files in the run folder. Residual (documented): a same-user process that writes a well-formed capture.
- **A8. Approvals come only from a TTY or a runtime hook's capture of the user's prompt**, single-use, bound to the content fingerprint / plan hash / exact gate record + finding; the lead may run `approve`, `answer`, `waive`, `ask` because they are gated by those captures. — D3, D13, D16 need "the user's explicit instruction in the current message" to be checkable by a script. — Blocking those commands for the lead (would make approvals impossible in a Claude session).
- **A9. Fix budget.** After `review.max_fix_rounds` only `terminate FAILED`, or a refreeze with an explicit user `budget` approval. — D15 "never an endless loop"; review showed a self-made amendment could reset the budget. — Free refreeze.
- **A10. Any byte change makes every earlier PASS stale** (whole-tree fingerprint); "only stale reviewers re-run" is satisfied by re-running the gates whose status is not `pass`. — D14 content fingerprint wins over a per-gate relevance model nobody can prove complete. — Path-relevance per gate.
- **A11. Open runs, not ACTIVE_RUN, drive the git hooks.** Every non-terminated, not-cleaned run under `.agents/runs/` restricts commits and pushes to its task branch; a delivered run is closed by `cleanup` (base is an ancestor of HEAD and the committed task paths equal the CODE_DONE content). — Emptying ACTIVE_RUN opened the door. — ACTIVE_RUN only.
- **A12. Specialist runtime dispatch.** Under a Codex (or terminal) lead every specialist runs as a separate headless process through `dispatch.sh`, which records the result itself; under a Claude lead with a Claude role the native subagent is used and a SubagentStop hook records. — Codex documents no spawn API for custom agents and results must be recorded deterministically. — Native Codex subagents (unrecordable).
- **A13. Writing roles and sandboxes.** Every role that writes an artifact has Write/Edit and Codex `workspace-write`; what it may write is enforced by `.agents/owns.conf` in the PreToolUse hook and by a product-tree fingerprint check in `dispatch.sh` (`writes_code: no` roles that change product files are BLOCKED). — Read-only sandboxes made the artifacts impossible. — Read-only roles returning artifacts inside the final message (large context for the lead).
- **A14. Agent names are hyphenated** (`proofline-security-reviewer`); role ids keep underscores. — Claude's documented agent-name characters. — Underscore names.
- **A15. Skills are installed once in the project at `.agents/skills/`** (Codex discovers it; Claude role agents read SKILL.md by path; only the `/proofline` entry skill is copied to `.claude/skills/`). The plugin uses `${CLAUDE_PLUGIN_ROOT}/skills/`. — Closes the open point on user-invoked skills: role definitions point to the SKILL.md path explicitly; `disable-model-invocation: true` stays for standalone use. — Two copies per runtime.
- **A16. `skills/proofline` is the D23 command entry skill** (`/proofline <command>`), not one of the 17 method skills. — Claude plugin commands are namespaced; a skill named like the plugin gives `/proofline`. — Separate command files.
- **A17. Implementer/designer windows** are opened by SubagentStart/SubagentStop hooks on the Claude Agent path and by `dispatch.sh` headless; the lead never brackets windows. — One owner per mechanism; the lead could forget. — Lead-managed windows.
- **A18. D13 language (superseded by A33).** Specialists receive `user_language` in the assignment and write their questions in it; the lead relays them verbatim. — D13 (verbatim) and the language rule (user's language) otherwise conflict. — Lead translation (breaks verbatim).
- **A19. Hook coverage is a strict heuristic.** Shell writes are detected by a dequoting tokenizer; non-literal command words, `eval`, shells reading stdin and any `git config` on `core.*` are denied during a run (deliberate false positives). Interpreter writes (`python -c`, `node -e`) remain detection-only through fingerprints at the gates. — Fail closed where cheap, detect the rest. — Allow-listing commands (unusable).
- **A20. Codex hooks for dispatched workers** run with `--dangerously-bypass-hook-trust` so the project's proofline hooks load in headless runs; the fingerprint and git-state checks remain. — Headless runs cannot review hooks interactively. — Workers without hooks.
- **A21. E2E isolation.** Claude runs use `--setting-sources project,local` (no user CLAUDE.md, skills or hooks — verified); Codex runs use a temporary `HOME`/`CODEX_HOME` with a symlink to the existing `auth.json` (never copied), because `--ignore-user-config` still loads `~/.codex/AGENTS.md` and user skills (verified). — Runs must not be influenced by the operator's personal setup. — Running in the user's environment.
- **A22. Codex during the build (D28 changed by the user mid-build).** The user allowed Codex for development work after phase 6 to save limits; earlier phases were written with Claude only. — Explicit user instruction. — Keeping D28.
- **A23. Plugin manifest lists agent files explicitly** (`claude plugin validate` requires `.md` paths); a test keeps the list equal to `adapters/claude/agents/`. — Validator behaviour. — Directory path (rejected by the validator).

- **A24. `agent.sh start` creates a run** (task file, run folder from templates, ACTIVE_RUN) in one command. — The first end-to-end run showed a lead creating RUN.yaml by hand and getting stuck. — Hand-copied templates.
- **A25. Run-level lock in `agent.sh`** for every read-modify-write of run state. — Parallel reviewers (D4) broke the ledger hash chain in an end-to-end run. — Serialising specialists (loses D4 parallelism).
- **A26. Codex lead sandbox.** A Codex lead needs `.git` write access and network for nested workers (`danger-full-access` headless or approving git commands interactively; `proofline init` enables network for the workspace sandbox). — Observed in end-to-end runs. — Read-only `.git` (no task branch possible).
- **A27. Verification of text-only criteria.** An acceptance criterion whose mapped paths all carry a `tdd_exemption` may be proven by a recorded verification command and its output instead of a test. — A typo fix was failed for lack of a test asserting a string. — Tests for every text change.
- **A28. QA scenarios declare `execution: auto | manual`;** manual scenarios never block the gate and are carried into the completion report. — A browser-only UI check blocked the QA gate. — Headless browser dependency (would violate "never install").
- **A29. End-to-end runs used `--profile economy` and a Sonnet lead** to fit usage limits; results are reported as such.

- **A30. Results are submitted, not announced (replaces the free-text header of D12 as the way a result enters a run; the header itself, incl. A1's `FOCUS:`, is unchanged).** A specialist reports with `agent.sh submit <ID> --confidence C [--focus F] [--result R] [--artifact P] [--findings FILE] [--reason T] [--questions FILE] [--agent TOKEN]`. The script, not the model, produces the header (`ROLE` from `AGENT_ROLE`, `TASK`, `FINGERPRINT` from the current content, the artifact's normalised run-relative path and sha256), assigns finding ids, derives a gate result from the findings (a contradicting `--result` is rejected) and defaults the report path from role and focus; it then hands the assembled message to the existing `record` validator, so every rule stays in one place. A rejection is returned to the specialist at once (exit 1, reason on stderr) and written, with the outcome, to `.agents/local/submissions/<token>.status`. The SubagentStop hook and `dispatch.sh` read that status and never parse a final message; a specialist that stops without a recorded submission is sent back once with the last rejection (Claude: SubagentStop `decision: block`, guarded by `stop_hook_active`; `dispatch.sh`: one rerun with the rejection in the prompt); a second miss is reported to the lead as "no result" and nothing is recorded. The Claude hook gives each subagent its token in the SubagentStart context and denies a `submit` that omits it or carries another agent's. — The end-to-end runs failed on "no record" again and again for format reasons (the `ARTIFACT` path form, header order, a hash typed by hand, a header in prose); each fix removed one spelling, so the cause was asking a model to hand-write a machine format. — Per-spelling parser fixes (treats symptoms: the next model finds the next spelling); letting the hook repair the header (would make the hook a second authority on role and fingerprint).
- **A31. The class is verified against the diff.** Before IMPLEMENTED and again before CODE_DONE, a TRIVIAL run whose task-owned diff changes an executable code file (config `review.executable_code`, default a language-extension list; markup, docs, data and config files are not code) is refused with the way out named: write the evidence and QA plan of the new class, `classify` it STANDARD or higher, amend and refreeze. — D14's tier is computed from the diff but the class was only the lead's claim; an e2e bug fix ran as TRIVIAL and skipped QA. — Forcing the class by diff size (a one-line fix to logic would stay TRIVIAL); a new gate (the refusal is cheaper and earlier).
- **A32. A destructive plan needs expand/contract steps, or the user's single-step approval.** In PLAN `## Data` with `destructive: yes`, the data-design step table needs a non-destructive step in phase expand|backfill|switch and every destructive step in phase contract|deferred (a later, separate migration); plan-contract's validator and `freeze` both check it (`plan_migration_shape`). The only exception is the line `single_step: yes` together with a new approval kind `single_step` (bound to the PLAN.md hash, granted by a user prompt containing an approval phrase and "single step"/"tek adım", consumed at freeze). — D22's data-design promises expand/contract but nothing enforced it; an e2e run planned the drop in the release that stops reading the column. — A free-text justification in the plan (a model can write it).
- **A33. Run artifacts are English, enforced by the scripts (supersedes A18).** Every file written inside a run, reports and stored questions included, is English whatever the user's language; the user's own words appear only as a `>` blockquote. Specialist assignments no longer carry `USER_LANGUAGE`; a question is written in English, relayed verbatim, and the lead may add a framing line and a marked translation beside it (never instead, never stored). `agent.sh submit` rejects a report, findings or questions with three or more non-English letters outside blockquotes and fenced code (a name such as "José" passes); `freeze` checks TASK/PLAN/EVIDENCE/QA_PLAN and the move to DONE checks every run artifact except raw runtime logs. Every role source carries the rule in its Does/Must-not table. — The rule "reports to the user are in the user's language" read as covering a role's `REPORT.md`; an e2e run wrote a Turkish result file, and the questions of A18 were Turkish files by construction. — A check on Turkish letters only (misses every other language); a blanket non-ASCII ban (rejects names, symbols, "×").
- **A34. Fixes from the second end-to-end round (Claude configuration).** (1) The content fingerprint excludes the task-source directory (`tasks.dir`): the control plane edits that file after the gates (completion report, status), which made every gate `stale` on a finished run; its contract is hashed separately. (2) `submit --report FILE|-` writes the artifact from the specialist's text (and `--findings -`, `--questions -` read stdin): a subagent runtime refused the `Write` of `security/REPORT.md`, which left the SECURITY gate unrecordable, and scratch files went to `/tmp`. (3) The Claude hook denies `git stash|reset|clean|restore|checkout --|switch|...` from a specialist unless it targets a worktree. (4) A fix round may also change test paths of the frozen scope (the regression test is part of the fix); the deadlock was a fix that needed a test outside the finding's `fix_scope`. (5) A destructive step counts as separated only in phase `deferred`; `contract` in the same change is one step (supersedes the `contract|deferred` wording of A32). (6) The destructive approval request lists each destructive step with its rollback. (7) design-sync is skipped for TRIVIAL runs and when no changed path is named by a design document. (8) The implementer runs debug-proof for any task describing a defect. — Findings of the evaluator on `TRIVIAL`, `STANDARD`, `STANDARD.tr`, `COMPLEX`, `CRITICAL` (claude), see `tests/e2e/README.md`. — Per-scenario patches in the fixtures (forbidden).
- **A35. Fixes from the second end-to-end round.** (1) Specialist report payloads live in `reports/NNN-<role>.md`; `results/` holds only recorded results (`NNN-<role>.result.md`, built by `submit`, header first) and dispatch logs, so every file there is a result. (2) A task author running before a run exists does not `submit` (no run, no token): it ends with a plain message, the lead relays its questions verbatim and ends with `Please answer the questions above.`; the second round had stopped at a task-author question that could not be stored. (3) The Claude hook denies `/tmp` scratch and worktrees for specialists when `$TMPDIR` is elsewhere. (4) IMPLEMENTED is refused for a STANDARD-or-higher task whose title or Goal names a defect (`review.defect_words`) until `reports/NNN-debug.md` exists. (5) The lead never re-asks a decision TASK.md, INTENT.md or earlier answers already record; an adjacent defect the task does not require is reported, not asked about. (6) The completion report states that commit and push each need approval. — Round-two evaluator findings (claude: TRIVIAL 32/33, STANDARD 29/36, STANDARD.tr 46/49, COMPLEX and CRITICAL stopped at a question before the run). — Narrowing the C-9 expectation (the expected files are not edited to fit the code).
- **A36. Third-round fixes.** (1) The `/tmp` scratch rule of A35 denied only paths outside the project root: the first version also matched a project that itself lives under `/tmp` (every end-to-end project) and stalled a STANDARD run by denying legitimate specialist commands. (2) A TRIVIAL copy change in a UI file needs no `## UI` section and no designer (validator and lifecycle table are class-aware). (3) `reports/qa-evidence/` is owned by the QA role; the completion report states the delivery approvals inside Implementation Summary. — Round-three evaluator findings (claude: TRIVIAL 33/36, STANDARD 30/39, STANDARD.tr, COMPLEX and CRITICAL were first stopped by the account's session limit and re-run). — Leaving the rule as it was (the round-three STANDARD stall).
- **A37. The content fingerprint works with a read-only object database.** The Codex `workspace-write` sandbox leaves `.git` read-only; `git add -A` failed there and the old code ignored the failure, so `agent.sh fingerprint` (and `submit`) could not record. The value is now retried with a private object directory and the repository's objects as an alternate (same content-addressed tree id). — First Codex-only end-to-end run. — Making `.git` writable for specialists (widens the sandbox).
- **A38. A Codex specialist's sandbox is granted the run folder and `.agents/local`.** `submit` records inside the specialist's own process (A30); Codex keeps `.agents` read-only, so `dispatch.sh` adds the run folder and `.agents/local` as writable roots for every role (probed against the real sandbox: `mkdir .agents/other` stays denied, the granted subpaths are writable). What a role may write remains decided by `owns.conf` and the fingerprint check. A lock in a non-writable directory fails at once with its reason instead of waiting 120 s. — Second Codex-only end-to-end run. — Recording outside the sandbox again (reintroduces the free-text final message A30 removed).
- **A39. Codex evidence worktrees.** `dispatch.sh` also grants `<git-common-dir>/worktrees` to a Codex specialist so `git worktree add` (mutation and base-run evidence, D10) works in the `workspace-write` sandbox (probed against the real sandbox). — Codex-only STANDARD run: every review gate BLOCKED on `.git/worktrees: Operation not permitted`. — Making `.git` writable.
- **A40. Database guard: no agent touches a database, no destructive step runs before approval, in any environment.** While a run is open the runtime hook denies (all roles, the lead and subagents alike) any command word, argument, assignment or redirection target that names a database file (config `database.paths`, a language-independent default list), any database client (`database.clients`; sqlite-family clients only against `:memory:` or a scratch file under `$TMPDIR` outside the project), any migration, seed or schema command (`database.migrate_commands`, comma-separated regular expressions covering npm scripts, prisma, drizzle, knex, sequelize, typeorm, alembic, flask, django, rails, artisan, flyway, liquibase, goose, dbmate, atlas, diesel, sqlx, dotnet ef, ecto, golang-migrate), and the Read, Grep, Glob, Edit, Write, NotebookEdit and apply_patch tools on a database file. The only database an agent may meet is a test suite's own throwaway database. `agent.sh start` records size and mtime of every database file in `.agents/local/db/<ID>.snapshot`; `freeze`, IMPLEMENTED, CODE_DONE and DONE refuse when a file changed, appeared or vanished (`agent.sh db-check`, `db-config`). Defaults live once in agent.sh and once, identically, in `config.yaml` (a test compares them). — The third end-to-end CRITICAL round showed a copy of the live database altered before the destructive approval; the EXPECTED files (K-9, K-13) were right and only enforcement was missing. — A hook-only rule (a script that opens the database by itself passes), a baseline hash of file contents (reads the database), allowing read-only queries (the user ruled them out). Residual: scripts opening a database by themselves are caught after the fact only. **User decision reported:** `tests/e2e/expected/CRITICAL.md` K-2 still offers "the count read from the local DB with a read-only query" as one way to evidence the row count; under this rule only the seed files and the test suite can evidence it (the other alternative in K-2).
- **A41. The lead never approves; the runtime records the user's approval (D3, D13; EXPECTED C-7 kept).** `agent.sh approve` and `approve-pending` are denied by the PreToolUse hook for every model; the prompt hook (Claude `UserPromptSubmit`, Codex `UserPromptSubmit`) stores the capture and then runs `agent.sh approve-pending <ID>`, which attempts `approve` for each open request of the run and of the no-run scope (commit, push) in its own process; `approve` still verifies the capture (newer than the request, sha256, approval phrase and kind word, single-use) or a TTY line. The lead skill and references now say "relay, stop, `agent.sh next` after the reply". — The third COMPLEX round: the lead ran `agent.sh approve` itself; C-7 forbids the call and D3/D13 make the approval the user's, while A8 had allowed the lead to run it behind the capture check. A8 is superseded for `approve` (`answer`, `waive`, `ask` unchanged). — Keeping A8 and rewording C-7 (the user ruled the EXPECTED file right), a hook that approves without the script's capture check.
- **A42. The QA plan is derived from the final plan and verified against it before freeze.** `QA_PLAN.md` carries a `Plan sha256:` line (the sha256 of the final PLAN.md); `freeze`, `refreeze` and the new read-only `agent.sh verify-qa-plan` refuse a QA plan derived from another plan, a plan criterion (scope `criteria:` or `## Behavior`) without an acceptance scenario, a scenario for a criterion the plan lacks, and a scenario whose `expected:` names a term the plan's `## Contracts` removes or renames without saying it is absent. `validate-qa.mjs plan --plan PLAN.md` applies the same rules for the qa role. A plan or contract change after the QA plan means dispatching `qa` again. — The third COMPLEX round: the QA plan contradicted the approved plan after a contract change, and nothing compared the two. — A hash only (does not catch a QA plan that was always wrong), the QA role validating alone (a model, not the script, would be the gate).
- **A43. A result cites an immutable copy of its artifact (C-9).** `submit` copies the artifact to `reports/snapshots/<sha12>-<role>-<flattened path>` after checking the original path against the role's paths, and the result header and gate record cite the copy. Two rounds that write the same report path (REPORT.md, VERIFY.md, QA_REPORT.md) can no longer leave the earlier result with a stale sha256, and a gate stays valid when the live report is rewritten for a later round. — The first and third rounds: "stale ARTIFACT hash after a re-run / a fix round" (C-9 requires every cited artifact to exist with the stated sha256). — Versioned report names chosen by the specialist (model cooperation), rewriting old results (they are hash-chained).
- **A44. Identifiers in the final report are checked by the runtime (TR-2) and the file tools reach the database guard.** (1) `agent.sh report-tokens <ID>` prints the state, the class and every required gate name while a run is at a reporting state; the new `Stop` hook (Claude settings fragment and plugin hooks, Codex hooks) compares the lead's last message with it, sends the lead back once with the missing identifiers, and records the state as reported when a message carries them (a second stop is always accepted). The lead skill already said "never translate" (D-language rule); a model translated `SECRETS` and `REVIEW_SMALL` anyway in the Turkish STANDARD.tr rounds. (2) The PreToolUse matcher of the Claude settings fragment and plugin hooks now includes `Read|Grep|Glob`; A40's file-tool checks never fired for those tools with the old matcher. — Presence of the identifiers is checkable by a script, the quality of the prose is not. — A longer skill rule (already failed), a post-hoc evaluator only, translating tables ourselves (the lead's prose is the user's language by D-language rule).
- **A45. tdd-proof: one cycle per behaviour (criterion), and the verify-proof fixture plan is valid.** `validate-tdd.mjs` rejected a second cycle on the same path although the skill asks one behaviour per cycle; a path may now carry several cycles, one per acceptance criterion (a duplicate `(path, criterion)` is rejected), and `--scope path:AC-1+AC-2` requires a cycle for each listed criterion. The control plane's RED/GREEN evidence stays per path (unchanged). The verify-proof fixture's `PLAN.md` carried a `task:` key and lacked `## Dependencies` and `## Contracts`, so the fixture failed `validate-plan.mjs`; fixed in the fixture, with a selfcheck line that validates it. — Skill-run results of 2026-10-12. — Keeping the validator's one-per-path rule (contradicts the skill), changing the skill to one cycle per path (merges behaviours).
- **A46. A Claude specialist started from an isolated-HOME Codex lead gets the operator's HOME.** The end-to-end harness runs a Codex lead with `HOME=<run>/codexhome` (A21); every child inherited it, so a Claude reviewer dispatched during failover or a mixed run was "not logged in". The harness exports `PROOFLINE_REAL_HOME`; `dispatch.sh` starts non-Codex specialists with that HOME. — The failover end-to-end attempt. — Copying the Claude credentials into the isolated HOME (copies a secret).
- **A47. Findings of the first end-to-end round after A40–A46 (Claude).** TRIVIAL passed 40/40. (1) STANDARD 34/36: the implementer tried `git stash push` (denied by the hook, but C-3 forbids the invocation): the implementer role now names `git show <base>:<path>` or a separate worktree as the way to look at the base, and lists the commands the hook denies. The defect check (A35) read only the title and Goal, so "Pagination hides books" with "behavioural bug fix" in Suggested class needed no `reports/NNN-debug.md`; it now reads title, Goal, Context and Suggested class, and the default defect words include hides, hidden, disappear(s/ed), missing, unreachable, skips, omits, ignores, duplicate. (2) CRITICAL 28/35: the task author wrote criteria that required the irreversible drop inside this change, so the data architect planned a single step (`single_step: yes`) and asked the user to approve a destructive step in a free-form question before any plan existed; the scripted harness replies were used up. The task author now writes criteria for the non-destructive step and names the drop as a follow-up; the data architect plans expand/contract by default, never picks `single_step: yes` itself, and never asks for a destructive approval in a question (the script requests it after the plan); explorer and data architect take evidence of stored data from seed files, fixtures and migrations and say the live database was not inspected. (3) COMPLEX stopped after 0 harness replies: the task author's question list before a run exists matched none of the harness's reply patterns (`recommended:` and `answers before` are now patterns; a commit or push approval is never answered). **User decision reported:** EXPECTED STANDARD.md S-6 names `results/NNN-debug.md`, while A35 and EXPECTED C-9 keep `results/` for recorded results only (every file there starts with the D12 header), so the debug-proof payload lives in `reports/NNN-debug.md`; the literal path cannot be met without breaking C-9. — Evaluator findings of round 1. — Allowing `git stash` for the implementer (C-3 forbids it), loosening C-3 or S-6.

### Open technical points — how they were closed

- **User-invoked-only skills in role agents:** verified against the Claude Code docs: a skill with `disable-model-invocation: true` cannot be preloaded or invoked by a subagent, so role definitions point to the skill's SKILL.md path explicitly (A15). Codex reads `.agents/skills/` natively.
- **Platform formats:** verified on 2026-10-09 against code.claude.com docs (plugin, marketplace, subagents, skills, hooks, headless) and Codex 0.162 help output + docs (custom agents in `.codex/agents/*.toml`, skills in `.agents/skills`, hooks in `.codex/hooks.json`, `codex exec` flags). Verified live: PreToolUse input carries `agent_id`/`agent_type` for subagent calls and none for the main session; a PreToolUse deny blocks in `-p` with `bypassPermissions`; SubagentStop context goes to the subagent, so record outcomes are relayed to the lead by its next PostToolUse; Codex project hooks fire and deny. Details: `docs/concepts/enforcement-layers.md`.
