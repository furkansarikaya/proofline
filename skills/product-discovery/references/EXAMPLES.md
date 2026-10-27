# Examples

One shallow and one good example for each document of the discovery. They show the difference in quality, not the format; the format is in [DISCOVERY-FORMAT.md](DISCOVERY-FORMAT.md). Names are invented. The examples sit inside code fences on purpose: a checker never reads them, and you never copy them into a real document. Write your own text from your own sources.

## FRAME

Shallow:

```markdown
- C-1 Users want a better way to manage orders. [assumption: value]
```

Good:

```markdown
- C-1 A finance clerk of a small shop copies the month's orders by hand into a spreadsheet before closing the books. [fact: interview INT-1 "I copy around 400 rows every month"]
- Decision this discovery supports: build a CSV export first, or fix the orders page filter that causes the copying (the user decides).
```

Difference: the good frame names who, what they do today and the decision it feeds; the shallow one fits any product.

## RESEARCH

Shallow:

```markdown
- C-10 The market for order tools is large and growing fast. [fact: web https://market.example/report accessed 2026-10-01 "growing"]
```

Good:

```markdown
## Search plan
- SQ-1 What do small-shop order tools charge per seat?; queries: "order management pricing small business" | "per seat order tool"; sources: pricing, reviews

## Claims
- C-10 (SQ-1) (critical; second source: C-11) Tool A charges 12 USD per seat and month. [fact: web https://a.example/pricing accessed 2026-10-01 "12 USD per seat per month"]
- C-11 (SQ-1) Tool A's price was 12 USD per seat in a review. [fact: web https://reviews.example/tool-a accessed 2026-10-02 "we pay 12 USD per seat"]

## Searched, not found
- SQ-2 No public figure for the number of small shops that export orders by hand.
```

Difference: the good research states the question it searched, gives two independent sources for the number that matters, and says what it did not find.

## COMPETITORS

Shallow:

```markdown
| Competitor | Attribute | Value | Source | Observed | Quote |
| Tool A | Features | many | | | |
```

Good:

```markdown
### Tool A
- sells to: shops with up to ten staff | https://a.example/customers | 2026-10-01 | "built for teams of up to ten"
- positioning: "orders without a spreadsheet" | https://a.example | 2026-10-01 | "orders without a spreadsheet"
- pricing model: per seat, no free tier | https://a.example/pricing | 2026-10-01 | "per seat, billed monthly"
- praised: fast setup | https://reviews.example/tool-a | 2026-10-02 | "set up in an afternoon"
- complained: export is manual | https://reviews.example/tool-a | 2026-10-02 | "I still export to CSV by hand"
- switching cost: one afternoon of data import [assumption: usability estimate "one reviewer says an afternoon; larger shops may need longer"]

## Implications for us
- Tool A's reviewers complain about the same manual export, so export is a gap we can name, and a per-seat price is the number we compare with.
```

Difference: the good analysis says who the competitor sells to, what users praise and complain about in their own words, and what that means for us; the shallow one is a feature list that could describe anyone.

## OPPORTUNITIES

Shallow:

```markdown
- OP-1 Improve the export. [assumption: value]
```

Good:

```markdown
- OP-1 Finance cannot export one month in one step. C-1, INT-1
- R-1 OP-1 evidence: strong; users: C-1; fit: removes the copying that the frame names; effort: small; reason: two sources agree and the change touches one page
```

Difference: the good opportunity rests on ids and is ranked with reasons for evidence, users, fit and effort; the shallow one is a wish with no order.

## So what

Shallow:

```markdown
- IN-1 Competitors exist. evidence: C-10; so what: good to know
```

Good:

```markdown
- IN-1 Both the price page and a review put Tool A at 12 USD per seat, and the review says export is still manual. evidence: C-10, C-11; so what: we can compete on export, so the first release is the export and the price comparison waits.
```

Difference: the good insight names the observation, the ids it rests on and the change in the decision; the shallow one changes nothing.
