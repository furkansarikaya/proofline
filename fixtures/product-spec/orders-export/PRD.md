# PRD: Monthly orders export

## Problem

Finance copies the monthly orders by hand from the orders page into a spreadsheet. [fact: interview INT-1 "I copy around 400 rows every month"]
The copy takes most of the first working day of the month. [assumption: value]
Who: the finance team that closes the month. [fact: interview INT-1 "we close the books in the first days of the month"]

## Goals

- G-1: Finance gets the month's orders as a file without copying rows.

## Non-goals

- Scheduled or emailed exports.
- File formats other than CSV.

## User stories

### US-1: As a finance clerk, I want to download the month's orders as CSV, so that I can close the month without copying rows

- AC-1: Clicking "Export CSV" on the orders page downloads a file with one row per order of the selected month.
- AC-2: A month without orders downloads a file that holds only the header row.

## Functional requirements

- FR-1: The orders page has an "Export CSV" control that exports the orders of the selected month.
- FR-2: The file has the columns id, date, total, currency, status.

## Non-functional requirements

- NFR-1: An export of 10000 orders completes within 5 seconds on the production server.

## Success metrics

- M-1: Exports per month; event: orders_export_completed; source: product analytics; baseline: 0 (no export exists) [decision: by product owner because the control does not exist yet]

## Assumptions

- A-1: Finance accepts CSV instead of a spreadsheet file. [assumption: usability]

## Open questions

### Blocking

- none

### Non-blocking

- Q-1: Should refunded orders carry a negative total?
