# debug-proof ledger: <target>

Always English. Update after every experiment, before the next one; this is the resume point and the audit trail. Never delete rows; never record what did not happen.

## Symptom
- Reported: <text and source>
- Expected: <behaviour>
- Kind: <bug|build_error>
- Known-good commit: <sha or none>
- Worktree (path written before creation): <absolute path>

## Reproduction
| Command | Runs | Failures | Exit | Excerpt file |
|---|---|---|---|---|

## Hypotheses
| Id | Rank | Statement (path:symbol) | Falsifier | Status |
|---|---|---|---|---|

## Experiments
| Id | Hypothesis | Change (one thing) | Command | Exit | Observed | Result (confirms/refutes/inconclusive) | Flips failure | Isolates cause |
|---|---|---|---|---|---|---|---|---|

## Bisect
- Used: <yes/no, why not> | good: | bad: | script: | first bad commit:

## Root cause
- Statement: <one sentence, path:symbol> | Hypothesis: <H id> | Proof experiment: <E id>

## Fix and regression test
- Fix paths: | Regression test: | Before (exit, class): | After (exit): | Suite (exit):

## Unresolved suspicions
- <listed separately; never part of the cause>

## Next step
<step or done>
