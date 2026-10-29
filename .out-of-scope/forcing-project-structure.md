# Forcing a project structure

**Status:** Rejected.

proofline does not require a folder layout, a solution file at the root,
a single build command or a fixed depth.

## Instead

Root, nested, multi-project and monorepo layouts are equally supported.
Commands are read from the project's own truth (CI files, README, package
scripts, workspace files) and are written to config only after one proving
run and the user's approval. When discovery is ambiguous, proofline
proposes nothing rather than a broken command.
