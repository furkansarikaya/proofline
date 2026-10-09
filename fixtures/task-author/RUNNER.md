# Runner instructions: task-author

Four independent runs. Build a fresh copy of the fixture for each run, outside this repository, start the
agent in it, and send that run's prompt exactly. When a run stops with questions (`NEEDS_INPUT`), record
the questions and end the run there: do not answer.

```sh
sh fixtures/task-author/setup.sh /tmp/fx-task-author-a    # likewise -b, -c, -d
```

- Skill: `task-author`
- Mode: standalone (no proofline run is active; nothing is installed; task format: markdown)

## Run a

> Use the task-author skill to write a task for this request: slugify('Hello, world!') returns
> 'hello-world-' with a trailing hyphen; slugs must never end with a hyphen.

## Run b

> Use the task-author skill to write a task for this request: add login with Google.

## Run c

> Use the task-author skill to write a task for this request: clean up the archived projects when
> exporting.

## Run d

> Use the task-author skill to import the Jira issue exported in `incoming/PROJ-142.json` into a task.
