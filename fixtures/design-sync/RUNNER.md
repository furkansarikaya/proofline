# Runner instructions: design-sync

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/design-sync/setup.sh /tmp/fx-design-sync
```

- Skill: `design-sync`
- Mode: standalone (no proofline run is active; no `.agents/config.yaml`, so the default design document
  locations apply)
- Prompt:

> Use the design-sync skill to check this repository's design documents against the code and give the
> verdict.
