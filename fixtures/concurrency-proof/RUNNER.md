# Runner instructions: concurrency-proof

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/concurrency-proof/setup.sh /tmp/fx-concurrency-proof
```

- Skill: `concurrency-proof`
- Mode: standalone (no proofline run is active; nothing is installed)
- Prompt:

> Use the concurrency-proof skill to review the changes on main since the tag `base`. These functions run
> in a web service with many concurrent requests, and order workers receive "paid" messages at least once.
