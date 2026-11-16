// @ts-check
// The most lines and the longest line (bytes: the text is a latin1 string) one task file may declare under `## Test exceptions` in a batch (A285, B6). A leaf module: the parser
// (testreview.mjs) and the approval reader (exceptionsapproval.mjs) both need it and import each other through other modules. skills/task-author/scripts/validate-task.mjs keeps a copy
// (BATCH_LIMITS) that a test compares with these.
export const TASK_EXC_MAX_LINES = 50;
export const TASK_EXC_MAX_LINE = 1000;
