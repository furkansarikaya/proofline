# Quality bar

The rubric every product document is held to. The author runs it on a draft before showing the draft to the user. The spec reviewer and the red team run the same rubric on a finished document and report a failed item as a finding. This page is the same in `product-discovery`, `product-assess` and `product-spec`.

## The five questions

| # | Question | Fails when |
|---|---|---|
| 1 | **Concrete.** Swap the product name for a competitor's: is the sentence still true? | It is still true. The sentence is generic ("users want a simple, fast tool"). Name the user, the situation, the number or the behaviour that only this product or market has. |
| 2 | **Sourced.** Is every fact a fact with a source you can open? | A number, quote, competitor feature or regulation has no source, or sits in a sentence as if it were known. A proposal wearing a fact's clothes fails here. |
| 3 | **New.** Does it tell the user something they did not already say? | It repeats the user's words in better grammar. A document with no proposal, no risk and no question of the agent's own fails. |
| 4 | **Unknowns.** Does it say what is not known, and what would settle it? | Every line is certain. Gaps are hidden, not listed as assumptions, open questions or "searched, not found". |
| 5 | **So what?** Does each finding change a decision, and is the decision named? | A finding ends with "interesting". No insight names the decision of the frame it affects. |

## Self-critique before showing

Before the user sees a document:

1. Read it once as a sceptic. Write one line per question above in the conversation: `pass`, or `fail: <the line> -> <the fix>`.
2. Fix every fail. Run the checker. Show the document only when both are clean.
3. Show the user the rubric result in one line ("5 of 5; weakest: #3, 4 of the 6 risks are mine, all proposals"). Never claim a pass the text does not earn.

## Reviewers

The spec reviewer (`SPEC-REVIEW.md`) and the red team (`STRATEGY-REVIEW.md`) check the finished document against these five questions in a `## Quality bar` section, one line each, and name the line that fails. A failed item is a finding, never a verdict by itself: the verdict follows the gate rule of the review.

## Proposals and the bar

The agent's proposals are held to the bar too. A proposal that fails #1 (generic) is dropped before the user sees it; a proposal that fails #2 (it states an unsourced fact) is rewritten as a question or an assumption with an estimate and a basis.
