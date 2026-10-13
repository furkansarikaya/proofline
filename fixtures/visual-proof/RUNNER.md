# Runner instructions: visual-proof

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly. A
Chromium-family browser on `PATH` (or in the standard application folder) is needed for a measured result;
without one the expected result is `UNSUPPORTED`.

```sh
sh fixtures/visual-proof/setup.sh /tmp/fx-visual-proof
```

- Skill: `visual-proof`
- Mode: standalone (no proofline run is active; nothing is installed)
- Prompt:

> Use the visual-proof skill to check the orders screen in `app/` against `spec.md` (class COMPLEX) and tell me
> whether it meets the acceptance criteria.
