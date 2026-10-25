# Design surfaces

`design_docs.design` is a path (one document, the default) or a mapping:

```yaml
design_docs:
  design:
    shared: docs/design/BASE.md
    surfaces:
      site:
        doc: docs/design/SITE.md
        paths: apps/web/** apps/landing/**
        mode: persuade
```

Each surface has `doc`, `paths` (space-separated globs) and `mode` (the visitor mode); `shared` is the optional common base (brand, tokens every surface keeps).

## Resolve a file

`sh .agents/scripts/agent.sh design-surface <PATH>` (read-only) prints `key=value` lines: `status`, `surface`, `visitor_mode`,
`doc`, `doc_exists`, `shared`, `shared_exists`. Do not match globs by hand; this is the one decision.

| status | Meaning | What you do |
|---|---|---|
| `ok` | one surface matched and its document exists | Read the surface document and the shared base. A contradiction with the shared base is a finding. |
| `new-direction` | one surface matched, its document does not exist yet | Do not conform to another surface. Design it as a new direction that keeps the shared base; list its tokens and components under `new` so the knowledge step writes the surface document. |
| `no-surface` | no surface matched | Only the shared document applies (a warning when there is none). |
| `overlap` | two surfaces matched (exit 1) | Report the error; the project narrows the globs. Never pick one. |

In the single-document form the answer is `mode=single` and `doc` is that document.

## Two visitor modes on one surface

When a surface in the evidence serves more than one visitor mode (for example a landing page that persuades and a signed-in
area that operates), do not decide it. Ask one question (NEEDS_INPUT in a run, a normal question standalone) that proposes
the two modes: split it into two surfaces, each with its own `mode`, `paths` and document, with the recommended split and the
paths each would own. The answer is applied by the user in `design_docs.design.surfaces`; until then both modes are specified
in the task's `ui.json` per screen.
