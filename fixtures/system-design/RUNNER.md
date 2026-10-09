# Runner instructions: system-design

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/system-design/setup.sh /tmp/fx-system-design
```

- Skill: `system-design`
- Mode: standalone (no proofline run is active; nothing is installed; no design documents exist yet)
- Prompt:

> Use the system-design skill to design this change: every Monday at 08:00 UTC, each customer who opted in
> to marketing email receives one email summarising their orders of the past 7 days (count and total).
> Customers without orders in that period get no email. Design only; do not implement.
