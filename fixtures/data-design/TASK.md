# Task: DATA-1 — Single full name for users

## Goal

Users have one `full_name` instead of separate first and last names, everywhere: database, API and code.

## Context

Support keeps editing names that do not fit the first/last split. The API should expose `fullName`.

## Acceptance criteria

AC-1: Every existing user has `full_name` equal to their first and last name joined by one space (or just the first name when there is no last name).
AC-2: `users.first_name` and `users.last_name` no longer exist in the database once the change is complete.
AC-3: The API object returns `fullName` and no longer returns `firstName` / `lastName`.
AC-4: Login lookups by email are case-insensitive and use an index (`lower(email)`).

## Out of scope

Nickname behaviour; sessions.

## Constraints

Login traffic never stops: no step may block reads or writes on `users` for more than a few seconds.

## Risks

`users` is large (about 2.4 million rows).

## Suggested class

COMPLEX (persistence change on a hot table)

## Verification commands

npm test
