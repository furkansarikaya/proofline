# Handoff: questions and answers (D13)

`A` = `.agents/scripts/agent.sh`.

## 1. A specialist asks

A `RESULT: NEEDS_INPUT` result is recorded by the hook or dispatch.sh: `questions/NNN.md` (verbatim) and
`execution.awaiting_input: true`. dispatch.sh's failover question (`failover: ask`, exit 5) and the lead's
own questions (section 3) are stored the same way by `A ask`. `A next <ID>` then prints
`agent.sh questions <ID>`.

1. Run `A questions <ID>`.
2. Print its output to the user unchanged, inside the lead status block's `QUESTIONS:` (or as is). The
   questions are English, as every run artifact is. When the user's language is not English, add one line in
   the user's language before the block and, after it, a translation of the block marked as a translation;
   the translation is never stored and never replaces the verbatim block.
3. A question from a specialist that ran before the run existed (task author, intent-grill) is not stored: relay
   its `QUESTIONS:` block verbatim, end with the single line `Please answer the questions above.`, and STOP;
   restart the same specialist with an `ANSWERS` block. STOP. Nothing else runs while a question is pending (`CODE_DONE` fails and `next` keeps pointing here).

Never: answer it; choose the `recommended` option because the user is silent or "it is obvious"; summarise,
shorten, merge, reorder, translate or reformat the questions; add the lead's own opinion in the same
message; continue other steps of the run.

## 2. The user answers

1. For each answered question `N`, pipe the user's own answer text (copied from their message, unchanged)
   to `A answer <ID> <N>`. `answered_by: user` is recorded only when that text is contained in the latest
   captured user prompt; anything else is recorded as `answered_by: lead` and shows in the report.
2. A partial answer: answer the answered ones, re-print the rest (`A questions <ID>`), STOP.
3. "Use the recommended one" / "you decide" from the user: that sentence is the answer text; the
   specialist applies the recommended option.
4. Restart the same role on the same run with an `ANSWERS:` block (the user's text per question number, pasted
   as the user wrote it: no paraphrase, no line of your own, no option letter you chose; a blanket reply stays
   that reply; the freeze compares recorded answers with the captured prompts)
   and the original assignment's other keys ([DISPATCH.md](DISPATCH.md#2-the-assignment)). The specialist
   resumes from its artifacts. It never asks again in the run: `submit` rejects a second NEEDS_INPUT from the
   same role (one round only; the limit is per role per run, so a later instance of the role has none either);
   it decides with the recommended option it offered and says so, or returns BLOCKED. The rule is enforced by
   the script for results submitted inside a run (after `agent.sh start`); the pre-run intake (task author,
   intent-grill's own interview rounds) is bound only by its own protocol. Inside a run intent-grill's interview
   (the task author's NEEDS_INPUT with `--artifact design/INTENT.md`; no other role) is exempt from the one-round rule and may ask one question per round for as many
   rounds as the tree needs (A75).

## 3. The lead's own questions

Plan approval, destructive approval, scope change, waiver and commit/push use `A request-approval <ID>
<kind>` (kinds `plan`, `destructive`, `scope`, `commit`, `push`, `waive:<FINDING-ID>`); its output is the
question; relay it verbatim and STOP. A question the lead must ask without a `request-approval` kind
(choosing between two plans, a scope change with options, opening a PR) is the same block, written in
English (it is stored in the run), stored with `A ask <ID>` (block on stdin, or `--file .agents/local/assignments/<ID>/<file>`).
Gather every open question of one decision point first and ask them together, numbered, in one `A ask`; the
user's replies are limited, so never split one decision point over several asks:

```
QUESTIONS:
1. <question>
   options: <a> | <b>
   recommended: <one option>
   why: <what depends on the answer>
```

Then `A questions <ID>`, relay verbatim, STOP; the user's reply is recorded with `A answer <ID> <N>` as in
section 2.

After the reply the runtime's prompt hook records the approval (only a captured prompt newer than the request
with an approval phrase and a kind word counts); the lead never runs `approve` (the hook denies it). Run
`A next <ID>`: an approval still requested means the user did not approve: do not retry with other wording;
ask what to change.
