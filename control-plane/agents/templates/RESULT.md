ROLE: <role-id>
TASK: <TASK-ID>
FOCUS: <plan|rules|tests|data|rules+tests>
RESULT: <PASS|FAIL|BLOCKED or DONE|BLOCKED|NEEDS_INPUT>
CONFIDENCE: <high|medium|low>
FINGERPRINT: <output of agent.sh fingerprint <TASK-ID>>
ARTIFACT: <run-relative path> <sha256>

| id | severity | path:line | finding | evidence |
|---|---|---|---|---|
| <GATE>-1 | blocking | path/to/file:12 | <one line> | <reproduced or traced> |

BLOCKED_REASON: <one line, only with RESULT: BLOCKED>
QUESTIONS:
1. <question, only with RESULT: NEEDS_INPUT>
   options: <a> | <b>
   recommended: <one option>
   why: <what depends on the answer>
