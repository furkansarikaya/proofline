# performance-proof ledger: <target>

Always English. Update after every step, before the next one; this is the resume point. Never delete rows;
never record what did not happen.

## Intake
- Change: <branch / range / working tree> | Base revision: <sha> (<how chosen>)
- Plan flag: performance_critical: <yes/no> | Stated budget: <text and source, or none>
- Thresholds: regression <n> % (<default|config|plan>), noise <n> %, min runs <n>

## Benchmark command
- Command: <command> | Defined in: <file:line> | Trial: <exit, excerpt> | Exercises the change: <how shown>
- Or UNSUPPORTED: <reason>

## Worktrees (paths written before creation)
- Temp dir: <path> | base: <path> @ <sha> | change: <path> @ <sha + copied changes>
- Build: base <exit> | change <exit>

## Measurements
| Attempt | Runs/side | Warmup | Timeout | Out dir | run-bench exit | Notes (concurrent load) |
|---|---|---|---|---|---|---|

## Results
| id | metric | unit | direction | status | regression % | interval % | noise % |
|---|---|---|---|---|---|---|---|

## Judged
| id | path | text | written criterion violated |
|---|---|---|---|

## Cleanup
- Worktrees removed: <yes/no> | Validator: <exit>

## Next step
<step or done>
