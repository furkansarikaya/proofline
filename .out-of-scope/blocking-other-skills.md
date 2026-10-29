# Blocking other skills and plugins

**Status:** Rejected.

proofline does not block, disable or uninstall skills and plugins the user
installed, including ecosystem-specific ones.

## Instead

During an active run, proofline's method skills take precedence over
overlapping skills (other TDD, review, debug or UI audit skills).
Language and ecosystem skills are used freely. Files other skills produce
go to the run's scratch folder. doctor lists hooks that inject
instructions into the context and warns; it never fails on them.
