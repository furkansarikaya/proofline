# Research method

How `RESEARCH.md` and `COMPETITORS.md` are produced. The checks are in [DISCOVERY-FORMAT.md](DISCOVERY-FORMAT.md#3a-research-method-researchmd).

1. **Plan before searching.** Write the questions the frame leaves open as `SQ-n` lines, each with the queries you will run and the source types you will read. A plan written after the search proves nothing. Ask the user to add or strike questions.
2. **Use the right source type.** `official-docs` for what a product does; `pricing` pages for what it costs; `changelog` for how fast it moves and what it dropped; `regulation` for what is required; `reviews` and `forums` for what users praise and complain about; `jobs` (job postings) for what a company is building; `interviews` and `data` for the user's own evidence. A claim about price from a blog post is weaker than the pricing page.
3. **Two sources for what the decision rests on.** Tag a claim `(critical; second source: C-m)` when the decision in the frame depends on it (a price, a market figure, a legal rule, a competitor's key feature). The second source is independent: another site, another interview, another data set. Two pages that copy each other are one source.
4. **Freshness.** Record the access date of every web fact. Prefer a page that shows its own publication or update date and quote it. A fact older than `product.stale_days` is reported `stale`; fetch it again or say why it still holds. A changelog or a price changes faster than a regulation.
5. **Read, then quote.** Open the page. Copy the sentence that holds the number or the feature. Never fill a fact from memory.
6. **Competitors beyond features.** For each competitor find who it sells to, its positioning in its own words, its pricing model, what users praise and complain about (reviews, forums), and the cost of switching away. A missing item is `unknown`, never a guess. End with what follows for us.
7. **End with the gaps.** List under `## Searched, not found` what you searched and could not find. A document that found everything is suspect; say so if it did.
8. **Propose, do not invent.** Suggest competitors, adjacent markets and questions the user did not name. They are proposals the user accepts or rejects ([EVIDENCE.md](EVIDENCE.md#1a-proposals)). The facts you bring for them still need a source.
