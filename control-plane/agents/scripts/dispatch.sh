#!/bin/sh
# Platform-independent specialist runner (D6, D7, D8). The logic is Node code since A226 (core/dispatcher.mjs, `proofline-core.mjs dispatch`): it runs ONE
# specialist step headless on the runtime the execution policy resolves, under a watchdog (the runtime is a child in its own process group; TERM at the timeout,
# KILL after the grace), and reads the submission status the specialist's own `agent.sh submit` wrote.
#
#   dispatch.sh <TASK-ID> <role> [--focus F] [--prompt-file F] [--model M] [--effort E] [--runtime RT]
#
# Exit: 0 recorded | 1 task failure or record rejected | 2 usage/config | 5 NEEDS_INPUT | 6 BLOCKED | 124 timeout | 143 stopped from outside.
# This launcher stays until the front end moves (stage 9).
exec node "$(dirname "$0")/proofline-core.mjs" dispatch "$@"
