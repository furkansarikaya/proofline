# Runner instructions: qa-plan

Build the fixture outside this repository, start the agent in it, and send the two prompts below exactly,
in order, in the same session.

```sh
sh fixtures/qa-plan/setup.sh /tmp/fx-qa-plan
```

- Skill: `qa-plan`
- Mode: standalone (no proofline run is active; nothing is installed)
- Prompt 1 (before-implementation step):

> Use the qa-plan skill to write the QA plan for the task in `TASK.md` (FX-QA): acceptance and
> adversarial scenarios. Base it on `TASK.md` only.

- Prompt 2 (after-implementation step):

> The implementation of FX-QA is now in `src/shipping.js` (last commit). Use the qa-plan skill to execute
> the QA plan against it and write the QA report with a verdict.
