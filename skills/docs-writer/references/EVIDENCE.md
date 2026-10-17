# What the evidence script checks

`scripts/check-docs.mjs` reads documents and the project. It runs nothing. Output: `doc:line: <kind> not found: <claim>`; exit 1 when any line prints.

| Claim | Found in the document as | Counts as present when |
|---|---|---|
| link | `[text](target)` with a relative or root-relative target | the file exists; for `#anchor` on a Markdown file, a heading with that slug exists |
| path | a code span with a `/` or a known extension, or a path word of a command | the file or directory exists, relative to the project root or to the document |
| flag | `--name` in a code span, a command or a fenced shell line | the text occurs in a non-Markdown source file |
| subcommand | `proofline <word>` or `./bin/<tool> <word>` | the word occurs in a file under `bin/`, or in `skills/<tool>/SKILL.md` |
| config key | a dotted `a.b.c` code span whose first segment is a top-level key of a `config.yaml` | the full key path exists in that file |

Not checked: prose, examples with placeholders (`<name>`, `{id}`, `*`), absolute URLs, paths that start with `/` or `~`, and a path without extension or trailing slash unless its first segment is a top-level entry of the project.

A finding is real until you looked for the claim another way (a renamed file, a generated file, a flag parsed by a library). If it exists, say where in the report and leave the document unchanged. Otherwise fix the document, or the code when the code is wrong.
