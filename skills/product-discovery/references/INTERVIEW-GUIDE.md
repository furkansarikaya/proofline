# Interview guide

Use it to prepare questions and to write the synthesis. The user runs the interview; this skill never contacts people.

## Questions

- **Open.** Ask for a story, not a verdict: "Tell me about the last time you exported the monthly orders."
- **Non-leading.** Never name your solution or the answer you hope for. "Would you like a one-click export?" leads; "What happens after you have the numbers?" does not.
- **Past behaviour first.** What people did, with what, how often, and what it cost. Opinions about the future are assumptions.
- **Follow the surprise.** Ask "Why?" or "What happened next?" once, then stop.
- **One topic at a time**, five to eight questions in all, ordered from the person's day to the problem.
- **Do not ask** for names, contact data or anything you do not need.

## After the interview

1. The user pastes the notes or transcript. Write it unchanged to `.agents/local/product-discovery/<slug>/interviews/INT-<n>.txt`. Create `.agents/local/.gitignore` with `*` first when it is missing.
2. In `INTERVIEWS.md` add `- INT-<n> <role>, <YYYY-MM-DD>` and the claims drawn from it: `- C-<n> <paraphrase> [fact: interview INT-<n> "<exact quote>"]`. Copy quotes exactly; shorten with `...` only.
3. Run `check-quotes.mjs <slug>` and `check-quotes.mjs <slug> --privacy`. Fix a quote, never the raw text.
4. A theme heard once is one claim, not a pattern. Say how many interviews support it.
