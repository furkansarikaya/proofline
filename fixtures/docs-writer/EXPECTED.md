# Expected: docs-writer

Evaluator only; never shown to the runner. Mode: audit. Output: the audit report and the corrected documents.
`selfcheck.sh` proves the planted facts with the skill's own scripts.

Planted facts: `docs/guide.md` quotes five things the project does not have; `docs/style.md` holds three
length findings. The project is a small shell tool (`bin/acme` with `build` and `serve [--port N]`,
`src/server.js`, `.agents/config.yaml` with `server.port`, `server.host` and a `writing:` block).

## MUST find

1. `docs/guide.md:9`: flag `--verbose` exists nowhere in the code.
2. `docs/guide.md:9`: config key `server.timeout` is not in `.agents/config.yaml`.
3. `docs/guide.md:9`: path `docs/old-guide.md` does not exist.
4. `docs/guide.md:10`: subcommand `./bin/acme deploy` does not exist.
5. `docs/guide.md:10`: link `setup.md` does not resolve.
6. `docs/style.md:3`: an instruction sentence over 20 words.
7. `docs/style.md:5`: an explanatory sentence over 25 words.
8. `docs/style.md:7`: a paragraph over 6 sentences.
9. Findings 6 to 8 are warnings under the default strictness `relaxed`.

## MUST NOT report (decoys)

10. `./bin/acme serve --port 8080`, `./bin/acme build`, `--port`, `src/server.js`, `server.port` and the links
    `../.agents/config.yaml` and `#usage` exist.
11. The long sentence in the `docs/style.md` table and in the fenced `sh` block (tables and code are not measured).
12. "Back up the file first. The migration drops the column." and the two list items are within limits.
