# Enforcement layers

proofline enforces its rules in three layers (D6). The foundation works with any agent; runtime hooks only
block earlier and feed the foundation. Rules that nothing technical stands behind are listed as policy-only.

Codex leads dispatch nested Codex runtimes. `proofline init` merges
`[sandbox_workspace_write] network_access = true` into the project's `.codex/config.toml` when Codex is
selected, preserving other project keys. The lead sandbox needs network access so workers can contact
their runtime API; product code changes still pass the control plane's scope, lifecycle and gate checks.
A Codex lead must also be able to write `.git` to create the task branch. In an interactive session,
approve the required git commands; the night-mode batch runs in your own session under the same hooks, see [night mode](night-mode.md). Product-code ownership remains
enforced by proofline hooks and gates. Dispatched workers retain `workspace-write` and the run-directory grant.

| Layer | Where | Works with |
|---|---|---|
| Control plane | `.agents/scripts/agent.sh`, `dispatch.sh`, git hooks in `.agents/githooks/` (`core.hooksPath`) | every runtime, humans |
| Runtime hook | `adapters/claude/hooks/proofline-hook.sh` (installed as `.agents/hooks/proofline-hook.sh`), wired by `adapters/claude/hooks/hooks.json` (plugin), `adapters/claude/settings.fragment.json` (project `.claude/settings.json`), `adapters/codex/hooks.json` (project `.codex/hooks.json`) | Claude Code, Codex |
| Policy | role instructions, `AGENTS.md`, the proofline-lead skill | — |

The HTTP-client check (curl, wget, http, xh) is method-blind by design: it matches the merge and completion path shapes (`/pulls/<n>/merge`, `/merge_requests/<n>/merge`, `/pullrequests/<n>`, `state_event`) on any host, so even a GET on them is denied.

## Which rule is enforced where

| Rule | Control plane (all runtimes) | Claude Code hook | Codex hook | Policy-only part |
|---|---|---|---|---|
| Lead never writes product code (D2) | detection: `window-open`/`window-close` attest the implementer's tree; any other change FAILS IMPLEMENTED, every gate and CODE_DONE | PreToolUse denies main-session Edit/Write/MultiEdit/NotebookEdit outside `TASK.md PLAN.md EVIDENCE.md COMPLETION_REPORT.md amendments/`, `tasks.dir` and `.agents/local/assignments/` (dispatch assignments; nothing else under `.agents/local/`, `ACTIVE_RUN` is set by `agent.sh`); with no run active the same ban holds (A169): the denial says to propose a light run with `/proofline run <text>`, and task files, `.agents/`, the knowledge scope and git-ignored files stay writable; Bash write heuristic; a symlink or multiply hard-linked target is never written; `ln` touching `.agents/` is denied | PreToolUse: Bash heuristic and `apply_patch` file headers | writes through interpreters (`python -c`, `node -e`), `cd` before a relative write, `find -exec` |
| Specialists write only what they own | `dispatch.sh` refuses the result of a non-code role that changed the product tree; `verify-scope` | PreToolUse for subagents: paths from `.agents/owns.conf` (token ending in `/` = subtree, other tokens one exact file, `NNN` = three digits, `/` prefix = project-relative, `PRODUCT_SCOPE` = frozen PLAN scope); implementer and designer writes outside the run dir need an open window | same, for dispatched `codex exec` workers (role from `AGENT_ROLE` in the hook environment) | — |
| Only gate roles record verdicts; the lead never does (D12) | `record` requires `ROLE` = `AGENT_ROLE`, refuses PASS/FAIL for `lead`, stale fingerprints, foreign tasks | PreToolUse denies `agent.sh record|gate|window-open|window-close` for everyone and any `AGENT_ROLE=<other role>`, matched on dequoted words (`agen""t.sh`, `"record"`, `env AGENT_ROL""E=`), inside `sh|bash -c '...'` and `"$(...)"` (one nesting level); during a run also non-literal command words, script paths or subcommands (`$a record`), `eval`, `env -S`, a shell reading stdin, indirect `AGENT_ROLE` (`read AGENT_ROLE`), copies of `agent.sh`; writes to `gates/ approvals/ waivers/ questions/ results/*.result.md RUN.yaml LEDGER.log .agents/local/ .agents/hooks/`; SubagentStop records `proofline-<role>` results itself | PreToolUse same; SubagentStop same if native subagents are used | `AGENT_ROLE=reviewer agent.sh record` typed in a plain shell is accepted (agent.sh cannot know who sets the variable); interpreters and `find -exec` |
| Subagent acts only as its own role | role command boundary in `agent.sh` | PreToolUse: specialists (subagents and `AGENT_ROLE` processes) run only literal `agent.sh` commands of their allowlist: implementer `worker-evidence` (with `AGENT_ROLE=implementer`) `status pipeline fingerprint verify-*`; every other role `status pipeline fingerprint next verify-*`; `approve`/`waive`/`answer` never | same | — |
| No hand-started nested runtime during a run | — | PreToolUse denies `claude -p|--print` / `codex exec|e` from Bash, quoted or not (use `dispatch.sh`) | same | invocations through interpreters |
| User approvals, waivers, `answered_by: user` (D13, D16) | `approve` needs a TTY or a capture newer than the request with sha256, phrase and kind word; `waive` refuses SECRETS/SECURITY and needs a `waive:<ID>` approval; `answer` writes `answered_by: user` only when the answer is inside the latest capture | UserPromptSubmit writes `.agents/local/prompts/<session>.json`; never for a dispatched specialist (`AGENT_ROLE` set) | UserPromptSubmit same | negation ("do not approve") is not detected |
| A pull request is merged only when every check is green (A136, A180: GitHub through gh, GitLab through glab, Azure DevOps through az; a pull request with no checks is merged only after the build and test pass in a clean copy, "verified locally, no CI"; Bitbucket, other hosts and a missing tool: proofline merges nothing, the user does) | `proofline merge <PR>` (`bin/lib/merge.sh`): a fresh `gh pr view` shows the PR open, not a draft, every check run COMPLETED/SUCCESS and every status SUCCESS (a skipped check passes only if it is not required), the head read twice and equal, then `gh pr merge --match-head-commit <sha>`; it refuses on anything unseen or unparsable | PreToolUse, for every caller, with or without a run, installed or not (the plugin hook): denies `gh pr merge` in any spelling (`--admin`, `--auto`, `-R`, `env`/`sudo`/`xargs`/`ssh` wrappers, `sh -c`, a variable as command word), `gh api` calls to a merge endpoint, merge mutation or `refs/heads/<main>` update, `gh alias`, and on the other platforms (A180) `glab mr merge`, `glab api` merge endpoints, `glab alias`, `az repos pr update` that completes or auto-completes, `az rest` on pull requests and HTTP clients aimed at a GitLab merge request or an Azure DevOps pull request, `git push` of a protected branch or a bare push while one is checked out, `git merge` on one; the denial names `proofline merge` | same script, so the same denials where the Codex hook is installed and trusted; a Codex session without that hook is not blocked | denied for the common spellings only, not proof against every one: a script written and then run, a payload assembled at run time, an HTTP client with the URL in a variable, the web UI or a tool other than Bash are not seen (A136). GitHub branch protection with required checks is the fail-closed backstop |
| An agent stops only a process it started itself (A156, A161) | — (the rule is in the role instructions) | PreToolUse, for every caller, with or without a run, installed or not: denies `pkill`, `killall`, `skill`, `slay`, `fuser -k`, `kill -1` and a PID `0` in any spelling (`00`, `+0`, `$((0))`), `kill $(pgrep ...)` and the same with `pidof`, `ps`, `lsof`, `fuser`, `pgrep ... \| xargs kill`, `xargs pkill` (the patterns arrive on stdin), a variable, array or loop variable filled from such a search in the same command (`PID=$(pgrep x); kill $PID`, `for p in $(pgrep x); do kill $p; done`, `pgrep x \| while read p; do kill $p; done`, `pids=($(pgrep x)); kill ${pids[@]}`, `while read p; do kill $p; done < <(pgrep x)`), also when the search is `ps -o pid= -C node` or `ps -eo pid=,args=` (a `NAME=` shaped argument is not an assignment), `find ... -exec kill` and `find ... \| xargs kill`, `eval` and a variable command word whose value the same command assigns, `$(...)` and backticks in an unquoted here-document body, the same forms inside interpreter one-liners and here-documents (`python -c`, `perl -e`, `node -e`, `ruby -e`, `php -r`, `osascript -e`, and `awk` only where it can run a command (`system(`, a pipe to or from a command): `pkill`/`killall` text, `os.kill(0|-1)`, `process.kill(0|-1)`, `Process.kill(.., 0)`, a psutil loop over `process_iter` that kills, a kill in code that runs `pgrep`, `pidof` or `lsof`, `os.system("kill 0")`; a kill of a PID the code spawned itself (`child.pid`) passes, also when the code reads `/proc` or runs `ps -o rss= -p <pid>`; the denial for code text says that such text cannot be told from a command and that you can run it yourself with `!`), and the content of a script file the command runs (`sh x.sh`, `bash x`, `./x`, `source x`, `python x.py`, `node x.js`, `perl x.pl`, `ruby x.rb`, also after `cd dir &&`, and `cat x.sh \| sh`; read when it is a text file of at most 256 KB under the project (not `node_modules`) or a temp folder, and only when its text holds `kill`, `slay` or `fuser`; the guard stops after 20 s and then denies text that holds such a word) or writes with a here-document, `echo` or `printf` in the same command; under `sudo`/`env`/`xargs`/`setsid`/`busybox` wrappers, a path, quotes and `sh -c`; `kill <pid>`, `kill $!`, `kill $PID` (a PID the agent holds), `kill -0` and `kill $(cat pidfile)` pass | same script, so the same denials where the Codex hook is installed and trusted | a tripwire against an honest mistake, not a security boundary against a hostile agent (A161): only the model's own tool calls are seen, never what you type yourself; not seen are a payload assembled at run time from data the hook cannot see, a script another tool call writes and a later call runs from outside the project and temp folders, a file larger than 256 KB or a binary, `node_modules` code, a PID taken from a search in an earlier command, commands inside another tool's text (`npm run`, `make`, package.json scripts), `ssh host pkill x` and `docker exec c pkill x` (they signal processes on another machine or in a container, not yours), and the part of a here-document body beyond 200000 characters; the boundary against a hostile agent is the runtime's permission mode and sandbox |
| Commit/push need gates, identity and approval (D19, D34) | pre-commit, pre-push | PreToolUse (always, with or without a run) denies, case-insensitively: `--no-v*` on any git command, `git commit -n` (in any short-option cluster), `git -c|--config-env` with `hookspath`/`include*`/`alias.*`, `--git-dir`, `--exec-path`, `git config` on the `core`/`include`/`alias` sections or `hookspath` (set, `--unset`, `--remove-section`, `--replace-all`, `--file`, `--edit`), `GIT_CONFIG*`/`GIT_DIR`/`GIT_COMMON_DIR`/`GIT_EXEC_PATH` assignments, any write (incl. `chmod rm mv`) to `.agents/githooks/` or `.git/config` | same | a human who unsets `core.hooksPath` |
| Implementer and designer window bracketing | `dispatch.sh` for headless workers | SubagentStart `window-open <ID> <role>`, SubagentStop `window-close ... <role>` for `proofline-implementer` and `proofline-designer` (`.agents/local/windows/<agent_id>`) | same when native subagents are used | — |
| Lead sees record outcomes | — | SubagentStop writes `.agents/local/records/<agent_id>.txt`; the main session's next PostToolUse relays it as context ("rejected: ...") and deletes it | same | — |
| Lead mode at session start (D2) | `agent.sh next` | SessionStart: skill path (`.agents/skills/proofline-lead/SKILL.md`; plugin: `${CLAUDE_PLUGIN_ROOT}/skills/proofline-lead/SKILL.md`), active run, next step | same (skill `.agents/skills/proofline-lead/SKILL.md`) | following the skill |

Hook behaviour: JSON is read with `jq`, else `node`. Unparsable input while a run is active denies the tool
call (fail closed); with no active run every check except the git-bypass rules passes (fail open). Without
`.agents/config.yaml` the hook does nothing. The wiring (`settings.fragment.json`, `.codex/hooks.json`)
denies PreToolUse with exit 2 when `.agents/config.yaml` exists but `.agents/hooks/proofline-hook.sh` is
missing. The Bash scan is a tokenizer heuristic (quotes removed, heredoc bodies skipped; writes:
redirections, `tee`, `sed -i`, `perl -i`, `cp`/`mv`/`install`/`rsync`/`ln` targets and `-t`, `mv` sources,
`touch`/`rm`/`truncate`/`unlink`/`rmdir`/`shred`, `chmod`/`chown`/`chgrp`, `dd of=`); the authoritative check
stays the window/fingerprint verification at every gate.
Two hook layers (plugin + project install) record a subagent result once (`records/<agent_id>.lock`).

Codex: project hooks load only when the project is trusted (`[projects."<abs>"] trust_level = "trusted"`)
and the hooks were reviewed with `/hooks`; headless runs need `--dangerously-bypass-hook-trust`. Hook
commands run in the session cwd, so `.codex/hooks.json` resolves the project root (`git rev-parse
--show-toplevel`, else `$PWD`) before calling `.agents/hooks/proofline-hook.sh`; a session started in a
subdirectory is enforced the same way. Claude-only input: `agent_id`/`agent_type` on PreToolUse
(how a subagent is told apart from the lead). Under a Codex lead, specialists run as `codex exec`
processes started by `dispatch.sh`, which sets `AGENT_ROLE` in their environment; that, not `agent_id`, is
what the hook uses there.

## Process rules

An agent stops only a process it started itself, by its own PID. `pkill`, `killall`, `kill` by pattern (`kill $(pgrep ...)`, `pgrep ... | xargs kill`, a variable or loop variable filled from `pgrep`/`ps`, `find -exec kill`) and mass kills (`kill -1`, `kill 0` in any spelling) are denied by the runtime hook for the agents' tool calls, also when they sit in an interpreter one-liner (`python -c`, `perl -e`, `node -e`), a here-document, `eval` or a script file the command runs from the project or a temp folder.

The guard is a tripwire against an honest mistake, not a sandbox against a hostile agent: a command assembled at run time, a script outside those folders, and what another tool runs for you (`npm run`, `make`, `ssh host pkill x`, `docker exec c pkill x`) are not seen (A161). Code that only prints or matches a kill word is denied too, because it cannot be told from a command; the denial says so and you can run the command yourself with the `!` prefix. The runtime's permission mode and sandbox are the boundary. Commands you type yourself are not affected.

## Verified platform behaviour (Claude Code 2.1.295)

Probed in a throwaway project with a logging hook (`claude -p --setting-sources project,local
--permission-mode bypassPermissions`), 2026-10-09:

- PreToolUse from the main session: keys `cwd effort hook_event_name permission_mode prompt_id session_id
  tool_input tool_name tool_use_id transcript_path`, no `agent_id`/`agent_type`.
- PreToolUse from a subagent: the same plus `agent_id` (e.g. `a8ac707a1899a62e7`) and
  `agent_type: "proofline-explorer"` (project agent, no prefix).
- SubagentStart: `agent_id agent_type cwd hook_event_name prompt_id session_id transcript_path`;
  `agent_type` = the agent's `name`.
- SubagentStop: `agent_id agent_transcript_path agent_type background_tasks cwd effort hook_event_name
  last_assistant_message permission_mode prompt_id session_crons session_id stop_hook_active transcript_path`.
- The Agent tool call: `tool_name: "Agent"`, `tool_input.subagent_type`; its PostToolUse `tool_response`
  carries `agentId` and `agentType`.
- A PreToolUse `permissionDecision: "deny"` blocks in `-p` with `bypassPermissions`; the file was not written
  and the model reported the reason.
- SubagentStop `additionalContext` reaches the subagent, not the lead; PostToolUse `additionalContext` in the
  main session reaches the lead (observed: the lead quoted `proofline: record of proofline-explorer rejected:
  malformed header: missing FINGERPRINT`). SessionStart `additionalContext` reaches the lead.
- Not verified: the `agent_type` string of a plugin agent (the hook accepts `proofline:proofline-<role>`).

## Verified platform behaviour (Codex CLI 0.162.0)

`HOME`/`CODEX_HOME` in a temp dir (auth symlinked), project trusted, `codex exec
--dangerously-bypass-hook-trust -s workspace-write`:

- Project `.codex/hooks.json` hooks fired: SessionStart (`cwd hook_event_name model permission_mode
  session_id source transcript_path`), UserPromptSubmit (`+ prompt turn_id`), PreToolUse (`cwd
  hook_event_name model permission_mode session_id tool_input tool_name tool_use_id transcript_path
  turn_id`; shell calls have `tool_name: "Bash"`, `tool_input.command` a string).
- A PreToolUse deny JSON blocked `printf x > blocked.txt` ("Command blocked by PreToolUse hook").
- Not verified: SubagentStart/SubagentStop payloads (no native subagent in the probe), the tool name and
  input of file edits (`apply_patch`; the hook reads `*** Add|Update|Delete File:` headers from any tool
  whose name contains `patch`), and whether SessionStart/PostToolUse `additionalContext` reaches the model.
