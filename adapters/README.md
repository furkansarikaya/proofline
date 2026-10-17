# Adapter guide

An adapter is one small package that (1) renders the role sources in `roles/` into an agent's native
format and (2) maps proofline's hooks onto that agent's hook mechanism. Enforcement itself never lives in an
adapter: state, gates and the commit/push lock are in `control-plane/agents/scripts/agent.sh` and the git
hooks, which work with any agent (D6). Supported: Claude Code and Codex (full). Others: send a PR (D8).
Untested adapters must be labelled "not tested".

## Support status (0.0.3)

Rendering and hooks are covered by `tests/generator/generator-test.sh`, the enforcement tests and the self-tests.
End-to-end results are an evaluator's `E2E: PASS` on a dated run; the results, with the commit of every run, are in
[tests/e2e/README.md](../tests/e2e/README.md#current-results).

| Adapter | Rendering, hooks, enforcement | End-to-end team runs |
|---|---|---|
| Claude Code (`adapters/claude`) | tested (incl. one live headless hook test) | each of the five scenarios passed at some point (2026-10-13 to 2026-10-17; STANDARD.tr several times); none verified on the current `main` |
| Codex (`adapters/codex`) | tested (hooks, dispatch, agents rendered) | partially tested: cheapest-model integration checks (dispatch, submit, doctor probes, mixed TRIVIAL to the commit-approval stop, failover `resume`); the scored Codex-only TRIVIAL run failed; no scored scenario passed |
| Any `AGENTS.md` agent (protocol tier), any headless CLI worker | control plane, git hooks and a fake command tested | not tested |

## 1. Role sources

`roles/<id>.md` = frontmatter + body (format: `roles/README.md`). Fields an adapter uses:

| Field | Use |
|---|---|
| `id`, `name`, `purpose`, `conditional` | agent name `proofline-<id>` with `_` -> `-` (`proofline-security-reviewer`; the role id keeps its underscore); description = `<purpose>. Use when: <conditional>` |
| `tools` | space-separated Claude tool names; map to the target's tool or permission names |
| `owns` | paths the role writes; rendered into `owns.conf` (enforced by the PreToolUse hook and `dispatch.sh`, not by the agent file) |
| `sandbox` | `read-only` or `workspace-write`; map to the target's sandbox/permission mode |
| `model.<profile>`, `effort.<profile>` | per profile `max`, `balanced`, `economy`; `claude=<m> codex=<m>` pairs |
| `tier_floor` | capability floor 1..3, consumed by the execution policy, not by the agent file |
| body | the instructions; `{{skill:x}}` marks a skill reference |

The `lead` role is the main session, not a subagent: adapters render no agent file for it (it still gets a
role text and a docs entry).

## 2. Rendering with `adapters/generate.sh`

```
adapters/generate.sh [--check] [--target claude-plugin|claude-project|codex|control-plane|docs|all]
                     [--profile max|balanced|economy] [--out DIR] [--root DIR]
```

| Output | Source of truth for |
|---|---|
| `adapters/claude/agents/proofline-<agent>.md` | Claude Code plugin agents (`{{skill:x}}` -> `${CLAUDE_PLUGIN_ROOT}/skills/x/SKILL.md`) |
| `adapters/codex/agents/proofline-<agent>.toml` | Codex custom agents (`{{skill:x}}` -> `.agents/skills/x/SKILL.md`) |
| `control-plane/agents/roles/<id>.md` | stable prompt prefix used by `dispatch.sh`; `{{skill:x}}` -> `.agents/skills/x/SKILL.md` |
| `control-plane/agents/owns.conf` | `<role> <token>...` from `owns:` (`NNN...` file tokens cut to their directory prefix); read by the PreToolUse hook and `dispatch.sh` |
| `control-plane/agents/tools.conf` | `<role> <Tool,Tool,...>` from `tools:` |
| `control-plane/agents/roles.conf` | execution policy input: `role profile runtime model effort tier_floor` |
| `docs/reference/roles.md` | generated reference |

Output is deterministic (sorted roles, no timestamps). `--check` renders into a temp dir and fails on any
missing, stale or edited generated file; CI runs it. Generated files are never edited by hand.

`--out DIR` renders for an installed project (used by `proofline init` with the chosen profile):
`DIR/.claude/agents/`, `DIR/.codex/agents/`, `DIR/.agents/roles/`, `DIR/.agents/roles.conf`,
`DIR/.agents/owns.conf`, `DIR/.agents/tools.conf`. Skills are installed once in `DIR/.agents/skills/`
(`{{skill:x}}` -> `.agents/skills/x/SKILL.md` for every project target). Only `proofline-*` agent files are replaced; other files in those directories are kept.

TOML escaping (Codex): `developer_instructions` is a multi-line literal string (`'''`, no escaping); if the
body contains `'''` the generator falls back to a basic multi-line string with `\` and `"` escaped.

## 3. Adding an adapter

1. Pick the target's agent format and where it loads agents from. Verify against its current documentation,
   not memory; note the version you tested in `adapters/<name>/README.md`.
2. Add a `render_<name>` function to `generate.sh` (mirror `render_codex`: frontmatter fields from the role
   source, body through `body_for <id> <skill-path-prefix> /SKILL.md`), a target name, and tests in
   `tests/generator/generator-test.sh` (structure, skill substitution, profile switch, escaping, `--check`).
3. Map the hooks (section 4). The adapter writes only thin shims; every decision is made by `agent.sh`.
4. Run `sh tests/generator/generator-test.sh` and `adapters/generate.sh --check`.

## 4. Hook mapping

The shims call control-plane scripts; they must work from the project root and never decide anything:

| proofline need | Claude Code | Codex |
|---|---|---|
| deny out-of-role edits and git/gate violations | `PreToolUse` (deny JSON or exit 2) | `PreToolUse` (same shape; project hooks load once the project is trusted and reviewed with `/hooks`) |
| capture a subagent's final message into the ledger | `SubagentStop` (`agent_type`, `last_assistant_message`) -> `agent.sh record` with `AGENT_ROLE` | `SubagentStop` (same fields) |
| capture user approvals | `UserPromptSubmit` (`prompt`) -> `.agents/local/prompts/<session>.json` | `UserPromptSubmit` |
| resume context | `SessionStart` | `SessionStart` |

An agent without hooks still works at the protocol tier: it reads `AGENTS.md`, runs `agent.sh`, and the git
hooks enforce the commit/push lock. An agent with a headless CLI can be a worker or reviewer through a
command template in config.
