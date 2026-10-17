# Runner instructions: docs-writer

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/docs-writer/setup.sh /tmp/fx-docs-writer
```

- Skill: `docs-writer`
- Mode: audit (no proofline run is active)
- Prompt:

> Use the docs-writer skill to audit this project's documents against the code and the writing profile, and
> fix what you can.
