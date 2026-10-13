# Task: UI-9

## Goal

Users can filter the project list (`src/ui/pages/ProjectList.js`) by status (all, active, archived) and by a
text search on the project name.

## Acceptance criteria

- AC-1: A status select and a search field filter the list; both are operable with the keyboard.
- AC-2: When no project matches the filters, a distinct empty state offers to clear the filters.
- AC-3: The result count change is announced politely to screen readers.

## Suggested class

COMPLEX (the filter state interacts with loading, error and empty states)
