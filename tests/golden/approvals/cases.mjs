// @ts-check
// The inputs of the approval grammar golden (tests/golden/approvals/grammar.json): the kinds, the runs and the replies. The answers in grammar.json were recorded from the shell functions of agent.sh
// (approval_phrases, approval_fillers, approval_sentences, approval_norm, kind_words) by a recorder that A244 retired with the shell.
export const KINDS = ['plan', 'destructive', 'single_step', 'scope', 'budget', 'mutation_budget', 'tree', 'commit', 'push', 'pr', 'merge', 'cleanup', 'report', 'batch', 'commands', 'rename', 'known-issue', 'scale', 'delivery',
  'waive:REVIEW_SMALL-1', 'rule:R-7', 'reopen:LC', 'rationale:Card-Flip', 'bogus'];
export const RUNS = ['', '-', 'LC'];
export const REPLIES = ["Approve the plan!", "I'm approving it", 'it’s ok', '  A,B;;C  ', 'plan\tapproved\r\n', 'Onaylıyorum: planı', 'ÇALIŞMA ağacını onaylıyorum', 'go-ahead single_step', 'a `b` {c} [d] ~e | f ^g \\h', '', ' ', 'x\ny'];
