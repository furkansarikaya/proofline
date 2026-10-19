# Prompt catalogue

Prompts you can paste into your agent session. In Claude Code use `/proofline <subcommand>`; elsewhere run
`proofline <subcommand>` in a terminal (it prints the exact instruction for your runtime) or say the same in
plain words. Turkish: [tr/prompt-katalogu.md](tr/prompt-katalogu.md).

## Setup

| Goal | Prompt |
|---|---|
| Install in this project | `/proofline init` |
| Preview first | `proofline init --dry-run` |
| Check everything is enforced | `/proofline doctor` |
| Update the control plane | `/proofline upgrade` |
| Where am I? | `/proofline status` |

## Tasks

| Goal | Prompt |
|---|---|
| Write a task from one sentence | `/proofline task Add a CSV export button to the invoices page` |
| Interview me first (vague or large) | `/proofline task --grill Rework how we handle retries` |
| Run a task | `/proofline run TASK-001` |
| Run without stopping for plan approval | `/proofline run TASK-001 and finish this without asking` |
| What is queued? | `/proofline queue` |
| Import an issue (github adapter) | `/proofline task import issue 42` |

## Design documents

| Goal | Prompt |
|---|---|
| Architecture from the code | `/proofline design system` |
| Data model from the schema | `/proofline design data` |
| API contract | `/proofline design api` |
| Design system from the UI | `/proofline design ui` |
| Drift check | `/proofline design system --check` |

## Review, audit, debug (standalone)

| Goal | Prompt |
|---|---|
| Review my uncommitted work | `/proofline review` |
| Review a branch against its intent | `/proofline review this branch; the intent is in the PR description` |
| How far can I trust the tests? | `/proofline audit` |
| Debug with proof | `/proofline debug the checkout total is wrong when a coupon and gift card are combined` |
| Prove a UI change in a browser (measured; UNSUPPORTED without one) | `Use the visual-proof skill to check the orders screen against design/UI.md` |
| Check an API or schema change for breaking changes (UNSUPPORTED for a format it cannot parse) | `Use the contract-proof skill on the changes to openapi.yaml` |
| Look for races and double processing in changed code (proven problems only; PASS never means safe) | `Use the concurrency-proof skill on the payment retry change` |
| Measure a performance regression against the base (UNSUPPORTED without a benchmark command) | `Use the performance-proof skill on the search change` |

## During a run

| Situation | Prompt |
|---|---|
| Approve the plan | `I approve the plan` |
| Answer a relayed question | answer the numbered questions directly, in your own words |
| A gate failed, let it fix | `continue` (the fix loop runs up to 2 rounds) |
| Waive one non-security finding | `I approve waiving RULES-3 because the legacy module is replaced next sprint` (finding id and a specific reason; security and secret findings cannot be waived) |
| Allow more fix rounds after exhaustion | `I approve another round` |
| Answer a high-risk assumption the plan could not verify | start the message with `accept AS-1` (the id from the question; several: `accept AS-1 and AS-2`), with no "not", "if", "unless" or "but" after it; or say what is true instead. Nothing else accepts it |
| A check came back UNSUPPORTED | nothing by default: it is reported as unproven in the completion report (`## Unsupported Checks`, `not proven: ...`); to prove it, install the missing tool yourself and re-run |
| A check is blocked as INCONCLUSIVE (or the project sets `risk.unsupported: block`) | re-run it, or waive it explicitly: `I approve waiving the visual check because there is no browser on this machine` |
| Pick up after the runtime hit its limit | `/proofline resume` in the other runtime |
| Why is it blocked? | `/proofline status` and `proofline doctor` |

## Delivery

| Goal | Prompt |
|---|---|
| Deliver it: commit, push, PR, merge when green, cleanup (one summary) | `/proofline deliver TASK-001` |
| Approve that whole summary | `approve delivery` (or `I approve the delivery`) |
| Commit | `I approve the commit for TASK-001` |
| Push | `I approve the push for TASK-001` |
| Clean finished runs | `proofline clean --yes` |

A reply must be one full sentence of the kind (`I approve the plan`, `I approve the commit`, `I approve the scope`, ...) or a short phrase such as `approve plan`; any extra clause makes it ambiguous and the question is asked again.

Approvals only count from your own message (or a typed terminal answer), after the request, and are single-use.
The accepted approval phrases are set in `approval.phrases` in `.agents/config.yaml`.

Related: [daily use](daily-use.md).
