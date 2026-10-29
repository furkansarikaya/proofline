# Agents that deploy

**Status:** Rejected.

proofline does not deploy to any environment: no production releases, no
infrastructure changes applied by an agent, no database migrations run
against a live system.

## Why rejected

Deployment is irreversible in ways a pull request is not. proofline's
guarantees end at a reviewed, verified and merged change.

## Instead

proofline prepares everything a person needs to deploy: configuration,
infrastructure as code, a step-by-step release guide, a rollback plan,
release readiness checks. The person runs the deployment.
