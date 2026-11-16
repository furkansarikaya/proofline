# Writing an adapter

For someone who wants proofline to run on another coding agent: what an adapter is, which support tiers exist and the steps to add one.

An adapter is a small package that (1) renders the role sources in `roles/` into an agent's native format and
(2) maps proofline's hooks onto that agent's hook mechanism. Enforcement never lives in an adapter: state,
gates and the commit/push lock are in the control plane (Node code under `control-plane/agents/scripts/`, started by the thin launcher `agent.sh`; [ADR 0001](../adr/0001-node-control-plane.md)) and the git hooks, which work with
any agent. The normative guide is [adapters/README.md](../../adapters/README.md); this page is the short path.

## Support tiers

| Tier | Needs | You get |
|---|---|---|
| Full | role rendering plus hooks | lead, hooks, agents, gates, routing, failover |
| Protocol | an agent that reads `AGENTS.md` and runs shell | the workflow in `standalone` topology, enforcement through the control plane (`agent.sh`) and git hooks |
| Worker | a headless CLI mode | worker or reviewer through a command template in config |

## Steps

1. Pick the target's agent format and where it loads agents from. Check its current documentation, and note the tested version in `adapters/<name>/README.md`.
2. Add a `render<Name>` function and a target name to `adapters/generate.mjs`, mirroring `renderCodex`.
3. Add tests to `tests/generator/generator.test.mjs`: structure, skill substitution, profile switch, escaping, `--check`.
4. Run `node adapters/generate.mjs --check` and `node --test tests/generator/*.test.mjs`.
5. Map the runtime's hooks (user-prompt capture for approvals, pre-tool-use for ownership, subagent-stop for results) using `adapters/claude/hooks/hooks.json` and `proofline-hook.mjs` as a model. The hooks are Node code and fail closed: with Node missing or older than 22.13 the PreToolUse hook blocks. A hook that is wrong on Windows is caught only by the `hook-windows` CI leg, which runs on pull requests that touch hook or path code ([CONTRIBUTING](../../CONTRIBUTING.md)).
6. Label the adapter "not tested" in your PR unless you ran it end to end. Only tested rows are claimed in `tests/e2e/README.md`.

Generated files are never edited by hand. Related: [roles](../concepts/roles.md), [enforcement layers](../concepts/enforcement-layers.md).
