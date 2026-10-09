# Runner instructions: verify-proof

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/verify-proof/setup.sh /tmp/fx-verify-proof
```

- Skill: `verify-proof`
- Mode: standalone (no proofline control plane is installed; the run artifacts are provided as files)
- Prompt:

> Use the verify-proof skill to verify task FX-VP on the current branch. The task, the frozen plan and the
> run state (including `base_sha`) are in `.agents/runs/FX-VP/` (`TASK.md`, `PLAN.md`, `RUN.yaml`).
> Give the verdict.
