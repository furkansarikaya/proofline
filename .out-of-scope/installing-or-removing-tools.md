# Installing or removing tools

**Status:** Rejected.

proofline never installs, upgrades or uninstalls tools on the user's
machine or in the project: no package managers, SDKs, linters, test
runners, browsers or CLIs, and nothing global.

## Allowed

- Detecting a tool, using it when present, and saying clearly when it is
  missing (`tool_unavailable`, never a silent pass).
- Optional tools that make work cheaper (structural search, output
  compression) are used only when the user installed them. Evidence
  commands always run with full, uncompressed output.
- Temporary, self-contained installs inside proofline's own development
  (for example an SDK in a temporary folder to verify a fixture), removed
  afterwards, never in a user project.
