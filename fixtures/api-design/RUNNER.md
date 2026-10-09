# Runner instructions: api-design

Build the fixture outside this repository, start the agent in it, and send the prompt below exactly.

```sh
sh fixtures/api-design/setup.sh /tmp/fx-api-design
```

- Skill: `api-design`
- Mode: standalone (no proofline run is active; nothing is installed)
- Prompt:

> Use the api-design skill to design this API change: projects get an optional free-text description
> (up to 2000 characters), and the project field `name` is renamed to `title`. Design the contract only;
> do not change the handlers or the client.
