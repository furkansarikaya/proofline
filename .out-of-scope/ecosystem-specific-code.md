# Ecosystem-specific code in shared scripts

**Status:** Rejected.

Shared scripts (discovery, agent.sh, hooks, validators) never branch on an
ecosystem name (go, cargo, dotnet, npm and so on). A static test fails the
build when they do.

## Instead

Everything ecosystem-specific is data in `control-plane/agents/ecosystems.json`:
markers, manifests, lockfiles, risky paths, version files, workspace
definitions, test output patterns, dependency folders. Supporting a new
ecosystem is a change to that one file. Platform adapters (GitHub, GitLab,
Azure DevOps) are the only other place where provider-specific commands
live.
