# Runner instructions: ui-design

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/ui-design/setup.sh /tmp/fx-ui-design
```

- Skill: `ui-design`
- Mode: standalone (no proofline run is active; nothing is installed)
- Prompt:

> Use the ui-design skill to write the UI spec for this change to the project list page
> (`src/ui/pages/ProjectList.js`): users can filter the list by status (all, active, archived) and by a
> text search on the project name. Spec only; do not implement.
