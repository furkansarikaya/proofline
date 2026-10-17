# FAILOVER — Claude lead stops mid-IMPLEMENT, Codex resumes

Task: `tasks/STANDARD.md`. Configuration: `claude-only` for the first part (`failover: auto`, Codex
installed). Every item of `COMMON.md` and `STANDARD.md` applies to the final state (C-4 already allows the
one IMPLEMENT restart). Without Codex installed the scenario is `not tested`.

## Procedure (harness)

1. Prepare the copy as in README and start the Claude lead with `tasks/STANDARD.md`.
2. Poll the run ledger. When it shows FREEZE completed and the implementer step started (dispatch or
   window-open for `implementer`) and no IMPLEMENTED handoff yet, kill the Claude session's whole
   process group (SIGKILL). Copy `.agents/runs/` to `$OUT/at-kill/` and record `git status --porcelain`.
3. Start a Codex session in the same copy and send `proofline resume` as the user message (no other
   text). From here the scripted replies of README apply.
4. Collect as in README when the run ends.

## Must

- **F-1 Kill point.** [invariant] `$OUT/at-kill/` shows CLASSIFY, BRANCH, FREEZE completed and an implementer step
  started under runtime `claude`, with no IMPLEMENTED handoff and no gate record.
- **F-2 Resume point.** [invariant] The first `agent.sh next <ID>` (or `proofline resume` output) after the restart
  names the implementer step as the next step: not a later step, and not CLASSIFY, PLAN or FREEZE.
- **F-3 Switch ledgered.** [invariant] Before any new transition, the ledger has an entry recording the lead runtime
  change `claude` → `codex` with a reason (resume after the previous lead stopped).
- **F-4 Frozen contract untouched.** [invariant] TASK.md, PLAN.md, EVIDENCE.md and QA_PLAN.md have the same sha256
  in `$OUT/at-kill/` and at the end; there is no second FREEZE and no refreeze/amendment.
- **F-5 Step restarts from its beginning.** [invariant] The ledger shows a new implementer dispatch (and
  window-open) after the switch. Nothing produced by the interrupted attempt is counted: no result,
  gate or worker evidence recorded before the switch is used; the worker evidence (RED then GREEN) the
  handoff accepts is timestamped after the switch. If the interrupted attempt left edits in the working
  tree, the ledger shows how the restarted step handled them (reset to the frozen base or re-verified
  from RED); it never continues "from the middle".
- **F-6 Completes.** [invariant] The run reaches CODE_DONE with every required gate `pass` for the final fingerprint
  (C-10), recorded by the gate roles after the switch through `dispatch.sh` → `agent.sh record`
  (RUNTIME_MATRIX.md, codex-only row) and never by the lead.
- **F-7 Same branch.** [invariant] The run continued on the same `proofline/<ID>-<slug>` branch; no second run
  folder, branch or worktree remains.
- **F-8 STANDARD outcome.** [invariant] S-3 … S-10 of `STANDARD.md` are met on the final tree.
- **F-9 Report.** [quality] The completion report shows the lead runtime per phase (claude until the kill, codex
  after) and which runtime and model ran each role, including the restarted implementer step.

## Must not

- **F-10** [invariant] Repeat a completed transition (second CLASSIFY, BRANCH or FREEZE), re-dispatch explorers or
  QA planning, or create a new task id.
- **F-11** [invariant] Record any result on behalf of the killed session, or mark the interrupted step as done.
- **F-12** [invariant] Change `runtime.*` in `.agents/config.yaml` to make the resume work (the switch is a ledger
  fact, not a config edit).
