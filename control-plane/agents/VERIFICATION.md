# Verification

The verifier proves, in `VERIFY.md`, that the frozen plan is implemented and the repository shows it:

- every acceptance criterion maps to a passing test or command (`AC-n: <evidence>`);
- every command from PLAN `## Verification commands` and `commands.build|test|lint` ran:
  ``- `<exact command>` | exit=<n>`` with one `output:` line;
- `agent.sh verify-freeze`, `verify-scope`, `verify-worker-evidence` pass;
- design-sync (`design/SYNC.md`) when design documents exist: drift is a FAIL.

A failing test that also fails at `repository.base_sha` in a clean worktree is pre-existing: an `info` row,
not a FAIL. The verifier never edits the implementation; failure follows the fix loop (GATES.md).

## Control-plane checks

```sh
.agents/scripts/agent.sh status | effective | config-check
.agents/scripts/agent.sh pipeline <ID> | next <ID> | summary <ID>
.agents/scripts/agent.sh verify-freeze|freshness|verify-scope|verify-knowledge-scope|verify-worker-evidence|verify-handoff|verify-gates|verify-seal|validate <ID>
.agents/scripts/agent.sh delivery-check <ID>
.agents/scripts/agent.sh test        # every .agents/scripts/*-test.sh in throwaway repositories
```

## Implementation evidence

Recorded by the topology's owner (`implementer` under `orchestrated`, `lead` under `standalone`):

```sh
printf 'command: <exact test command>\ntarget: <comma-separated scope paths>\nexpected_failure: <RED only: the specific behavioural reason>\n' \
  | AGENT_ROLE=implementer .agents/scripts/agent.sh worker-evidence <ID> <RED|GREEN|REFACTOR|FIX> <pass|fail>
```

RED records `fail` for the right reason (a compile error is not RED); GREEN and FIX record `pass`.
