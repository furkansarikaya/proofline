# Security policy

proofline is a control plane that decides whether a coding agent's work counts: gates, approvals, waivers and
the lead's ban on writing product code are enforced by scripts and hooks. A way around that enforcement is a
security issue in this project.

## Supported versions

Only the latest 0.0.x release receives fixes. Until 1.0.0, 0.0.x is fixes and 0.x.0 is new features or
behaviour changes; older releases are not patched.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** (Security Advisories) for this repository: open the
repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull
request for a vulnerability, and do not post exploit details publicly before a fix is available.

A useful report names the version (or commit), the platform and runtime (Claude Code, Codex, terminal), the
steps to reproduce on a throwaway project, what you expected to be blocked, and what happened instead.

## In scope

- Bypassing the control plane or hook enforcement: forging or replaying a gate record, an approval, a waiver or a
  verdict; making a gate pass on content it did not judge.
- Getting the lead to write product code, against the ban in the orchestrated topology.
- Writing outside the sandbox, the run folder or an evidence worktree.
- Bypassing the forbidden-identity protection of commits and pushes.
- Leaking a secret: into a run artifact, a report, a commit or a log.
- Policy bypass through hidden instructions in repository, pull request, issue or task content.
- Reading, copying, changing or migrating a database, or running a destructive step, without the user's
  approval.

## Out of scope

- Limitations that are documented as policy-only in
  [control-plane/agents/ENFORCEMENT.md](control-plane/agents/ENFORCEMENT.md) and in the residuals listed there.
- Auditing or running an untrusted repository outside a sandbox: proofline executes the project's own test and
  build commands, so run untrusted code in an isolated environment.
- Vulnerabilities in the agent runtimes, platforms or third-party tools proofline runs on; report those to their
  maintainers.

## What to expect

proofline is a volunteer project, maintained on a best-effort basis. There is no response or fix deadline.
Reports are read, reproduced where possible, and fixed in the next 0.0.x release; reporters are credited in
the advisory unless they ask not to be.
