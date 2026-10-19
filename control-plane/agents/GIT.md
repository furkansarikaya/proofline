# Git and safety rules

Inspect `git status --short` before work. User changes are user-owned: never reset, overwrite, stage,
discard or claim them; `agent.sh baseline <ID>` fingerprints them before DISCOVER. No force push, rebase,
destructive git command, credential access, arbitrary network request, destructive migration or
irreversible external action without the user's explicit approval. Global git configuration is never
touched; the repository's own identity is used (`doctor` shows it).

## Task branch

`canonical_branch` in `.agents/config.yaml` is the single source for the integration branch. Before
`baseline`, `agent.sh branch <ID>`:

- resolves the canonical branch's exact tip (never "whatever HEAD is");
- derives `<git.branch_prefix><ID>-<slug>` (default prefix `proofline/`): the slug is the task file's
  basename without the `<ID>-` prefix and `.md` (`local_markdown`), the TASK.md title (other sources) or
  `run` (`none`); lowercase, `[a-z0-9-]`, at most 48 characters;
- creates the branch at that tip, or re-attaches to the branch already recorded in RUN.yaml;
- refuses to reuse a same-named branch whose tip differs, and never deletes, resets or force-updates a branch.

`baseline`, `freeze`/`refreeze`, `handoff`, every gate, `verify-scope` and `delivery-check` FAIL unless the
working tree is on that exact branch. The implementer never runs `branch`.

## Commit, push, PR

The agent never tags, and merges only inside `deliver` through `proofline merge` (every check green; a FAILED or BLOCKED run is not delivered, it is reopened first, A152; `agent.sh deliver-plan` / `deliver-step`, GATES.md "Approvals"). Commit and push run through the git hooks installed with
`core.hooksPath=.agents/githooks`:

- pre-commit: identity guard (`git.forbidden_identities`), protected branches (`git.protected_branches`,
  empty by default, D34), while any run is open (`agent.sh open-runs`: not terminated, not cleaned up;
  ACTIVE_RUN plays no part) only on that run's task branch, the staged content must be exactly the gated
  content (`delivery-check`), and a `commit` approval bound to that content fingerprint
  (`agent.sh approval-consume <ID> commit <FINGERPRINT>`).
- pre-push: protected branches; while a run is open only its task branch; with
  `git.push_requires_approval: true` (default) a `push` approval
  (`approval-consume <ID|-> push`).

Commit messages follow `git.commit_format` (default Conventional Commits with the task id). The PR body is
derived from the completion report and the review summary. `.agents/runs/` and `.agents/local/` are
git-ignored and never committed.

## Implementer invocation

`dispatch.sh <ID> implementer` is the only sanctioned implementer invocation under `orchestrated`. It
brackets the run with `window-open`/`window-close`, records attested history even for a failed run, and
never falls back to the lead implementing. A failed implementer's partial edits stay for inspection;
undoing them is a destructive action that needs the user's approval.
