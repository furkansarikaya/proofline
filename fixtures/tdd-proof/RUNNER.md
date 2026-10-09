# Runner instructions: tdd-proof

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/tdd-proof/setup.sh /tmp/fx-tdd-proof
```

- Skill: `tdd-proof`
- Mode: standalone (no proofline run is active; nothing is installed)
- Prompt:

> Use the tdd-proof skill to implement the task in `TASK.md` (FX-TDD), criterion by criterion, with
> recorded RED, GREEN and refactor evidence. A colleague already wrote the test for AC-3 in
> `test/format-zero.test.js`; use it for AC-3. Do not commit.
