#!/bin/sh
# Builds the task-planning fixture in $1: a repo as it looks after a grill (A: tasks written to tasks.dir as <ID>.md,
# B: project-level ADR linked from a task, D: team.yaml under a self-ignoring .agents/local). Offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
mkdir -p "$1"; cd "$1"
git init -q
mkdir -p .agents/tasks docs/adr .agents/local
cat > docs/adr/0001-use-postgres.md <<'E2'
# ADR 0001: Use Postgres
Status: accepted
E2
for n in 1 2; do
  dep=''; [ "$n" = 2 ] && dep='depends_on: T-1
'
  cat > .agents/tasks/T-$n.md <<E2
# Task: T-$n - Sample

---
size: S
sprint: 1
assignee: dev-$n
${dep}---

## Goal
Do thing $n.

## Context
See [ADR 0001](/docs/adr/0001-use-postgres.md).

## Acceptance criteria
- AC-1: The thing $n works and returns HTTP 200.

## Out of scope
Nothing else.

## Constraints
None stated by the user.

## Risks
None known.

## Suggested class
STANDARD - small change

## Verification commands
npm test
E2
done
printf '*\n' > .agents/local/.gitignore
printf 'people: 2\n' > .agents/local/team.yaml
