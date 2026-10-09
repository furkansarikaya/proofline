# Runner instructions: debug-proof

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/debug-proof/setup.sh /tmp/fx-debug-proof
```

- Skill: `debug-proof`
- Mode: standalone (no proofline run is active; nothing is installed)
- Prompt:

> Use the debug-proof skill on this repository. Bug report from a customer: "Since the latest update, some
> invoice totals are wrong. An invoice for twelve euros and five cents now shows 12.50 EUR. It was right
> in version 1.0." Find the cause, fix it, and leave a regression test.
