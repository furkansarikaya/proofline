# Verification: <TASK-ID>

Owner: verifier (verify-proof, design-sync). Did we implement the frozen plan, and can the repository prove
it? Runs the commands; never edits the implementation. The ARTIFACT of the verifier result (VERIFY gate).

Verdict: PASS | FAIL

## Commands

- `<exact command>` | exit=<n>
  output: <the relevant line>

## Acceptance criteria

- AC-1: <the passing test that proves it>

## Plan conformance

`agent.sh verify-scope`, `verify-freeze`, `verify-worker-evidence` results; design-sync result
(`design/SYNC.md`) when design documents exist.
