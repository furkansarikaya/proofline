# Merging without verification

**Status:** Rejected.

## Not acceptable

- Merging a pull request whose checks are red or pending.
- A setting that allows merge without either CI or local verification.
- Delivering a FAILED or BLOCKED run as a pull request. This existed once
  as a draft pull request path and was removed: the only delivery path is
  CODE_DONE.
- Bypassing hooks (`--no-verify`) or asking the user to do so.

## Allowed, and why it is not a relaxation

When a platform shows no CI checks, the configured verification commands
must pass on a clean copy of the exact commit, and the pull request says
"verified locally, no CI". A failed or blocked run is brought back through
`reopen` and the normal gates, never around them.
