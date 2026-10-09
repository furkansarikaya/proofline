# Writing an adapter

An adapter is a small package that (1) renders the role sources in `roles/` into an agent's native format and
(2) maps proofline's hooks onto that agent's hook mechanism. Enforcement never lives in an adapter: state,
gates and the commit/push lock are in `control-plane/agents/scripts/agent.sh` and the git hooks, which work with
any agent. The normative guide is [adapters/README.md](../../adapters/README.md); this page is the short path.

## Support tiers

| Tier | Needs | You get |
|---|---|---|
| Full | role rendering plus hooks | lead, hooks, agents, gates, routing, failover |
| Protocol | an agent that reads `AGENTS.md` and runs shell | the workflow in `standalone` topology, enforcement through `agent.sh` and git hooks |
| Worker | a headless CLI mode | worker or reviewer through a command template in config |

## Steps

1. Pick the target's agent format and where it loads agents from. Check its current documentation, and note the tested version in `adapters/<name>/README.md`.
2. Add a `render_<name>` function and a target name to `adapters/generate.sh`, mirroring `render_codex`.
3. Add tests to `tests/generator/generator-test.sh`: structure, skill substitution, profile switch, escaping, `--check`.
4. Run `sh adapters/generate.sh --check` and `sh tests/generator/generator-test.sh`.
5. Map the runtime's hooks (user-prompt capture for approvals, pre-tool-use for ownership, subagent-stop for results) using `adapters/claude/hooks/hooks.json` and `proofline-hook.sh` as a model.
6. Label the adapter "not tested" in your PR unless you ran it end to end. Only tested rows are claimed in the README support table.

Generated files are never edited by hand. Related: [roles](../concepts/roles.md), [enforcement layers](../concepts/enforcement-layers.md).
