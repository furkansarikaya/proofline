# Writing profile

How a proofline skill writes prose for people: documentation, reports, questions. The config block `writing:` picks the profile.

| Key | Values | Meaning |
|---|---|---|
| `writing.profile` | `auto` (default), `ste`, `plain` | `auto`: English text follows `ste`, Turkish text follows `plain`. `ste` or `plain` forces one profile for every language. |
| `writing.strictness` | `relaxed` (default), `strict` | `relaxed`: a measured rule that fails is a warning. `strict`: it is a finding and the check exits 1. |

`ste` is a simplified technical English: short, literal sentences with one meaning. `plain` is plain language: the reader finds, understands and uses the text at the first read. Both profiles use the rules below. They differ only in word choice, which a reader or reviewer judges.

## Rules

| # | Rule | Check |
|---|---|---|
| 1 | An instruction sentence has at most 20 words. | machine |
| 2 | An explanatory sentence has at most 25 words. | machine |
| 3 | A paragraph has at most 6 sentences. | machine |
| 4 | A noun phrase has at most 3 words. | judged |
| 5 | One instruction per sentence. | judged |
| 6 | An instruction is in the active voice and the imperative mood. | judged |
| 7 | One word names one thing, everywhere in the text. | judged |
| 8 | A warning gives the instruction first, then the risk. | judged |

## What the machine check measures

The length script, where a skill carries it, measures rules 1 to 3 and nothing else.

- It skips front matter, code fences, tables, headings, HTML comments, and link and image targets (the link text counts).
- A list item is an instruction. A sentence is an instruction when its first word looks like a base-form verb and is not a determiner, pronoun, preposition or conjunction. Every other sentence is explanatory.
- A word is a run of letters or digits. An inline code span counts as one word.
- Exit 0 when nothing fails or the strictness is `relaxed`. Exit 1 when the strictness is `strict` and a rule fails. Exit 2 on a usage error.

The check reads the strictness from `--strictness`, then from `writing.strictness` in `.agents/config.yaml`, then uses `relaxed`. Its last output line lists rules 4 to 8 as judged: it does not check them, the writer and the reviewer do.

## Applying the rules

- Put the action first. State the condition before the action only when the action is wrong without it.
- Name the reader's goal in the first sentence of a section.
- Pick one term for each thing and keep it. Do not vary a word for style.
- Write a warning as: instruction, then the risk of ignoring it ("Back up the file first. The migration drops the column.").
- Break a long noun phrase into a short clause.
