# New roles and agents

**Status:** Rejected.

proofline has a fixed set of roles (Lead, Task Author, Explorer, Architect,
Data Architect, Designer, QA, Implementer, Reviewer, Security Reviewer,
Verifier). New capabilities have repeatedly been requested as new agents:
an SEO agent, an analytics agent, a product manager agent, a visual quality
agent, a logging agent.

## Why rejected

Every new role adds orchestration, prompts, gates and failure modes. Each
of those requests fitted an existing role better: product work runs in the
main session with a new reviewer focus; visual quality is a QA focus;
logging and validation are part of the Security Reviewer's sinks.

## Instead

Extend an existing role with a skill or a focus. A new role is considered
only when no existing role can hold the responsibility without breaking
the rule that the author of a change never reviews it.
