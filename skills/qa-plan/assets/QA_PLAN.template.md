# QA plan: <TASK-ID>

Plan sha256: <plan hash>

## Acceptance scenarios

- QA-1 (AC-1): <behaviour from the criterion>
  input: <concrete input or starting state>
  expected: <concrete observable outcome>
  execution: <auto | manual>
  run: <command, test selector, or script; for manual, the steps a human follows>

## Adversarial scenarios

- QA-2 (AC-1) [boundaries]: <what could break it>
  input: <concrete input>
  expected: <expected outcome>
  execution: <auto | manual>
  run: <how>

## Regression surface

<existing behaviour that must not change, with the test or command that shows it>
