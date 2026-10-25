# Design surfaces

`design_docs.design` in `.agents/config.yaml` has two forms.

**One document** (the default, unchanged): a path.

```yaml
design_docs:
  design: docs/design/DESIGN.md
```

**One document per surface**: a mapping. A surface is a part of the product with its own visitor mode, for example a
marketing site that persuades and an admin app that operates.

```yaml
design_docs:
  design:
    shared: docs/design/BASE.md          # optional common base: brand, tokens every surface keeps
    surfaces:
      site:                              # name: letters, digits, - and _
        doc: docs/design/SITE.md
        paths: apps/web/** apps/landing/**   # space-separated globs
        mode: persuade                   # the visitor mode
      app:
        doc: docs/design/APP.md
        paths: apps/dashboard/**
        mode: operate
```

## Which document applies to a file

One function decides it. `sh .agents/scripts/agent.sh design-surface <PATH>` prints the answer as `key=value` lines
(`surface`, `visitor_mode`, `doc`, `shared`, `status`); the designer, QA, the verifier (design-sync) and the knowledge step
use it, and `design-sync.mjs --file <PATH>` applies the same rules.

- In a glob `*` and `**` match any characters including `/`, `**/` also matches zero directories (`apps/**/x.ts` matches
  `apps/x.ts`), `?` matches one character, and an entry ending in `/` is a directory prefix. `\` and `|` are refused in `paths`, and so is more than one `**/` in a glob.
- A file that matches **one** surface is held to that surface document plus the shared base. A contradiction with the shared
  base is a finding.
- A file that matches **two** surfaces is an error (`status=overlap`, exit 1): narrow the globs.
- A file that matches **none** is held to the shared document only; with no shared document `design-surface` warns that no
  design document applies.
- A surface whose document does not exist yet (`status=new-direction`) is **not** conformed to another surface. The designer
  designs it as a new direction that keeps the shared base, and the knowledge step writes its document.

## Writes

The shared document and every surface document are `design_docs` paths: the knowledge step may write them, and they are
not part of the content fingerprint, exactly like `DESIGN.md` in the single form. `agent.sh config-check` rejects a
surface without `doc` or `paths`, an absolute or `..` path, a bad name and a `shared` key without surfaces.

When the ui-design skill sees one surface with more than one visitor mode (for example a page that persuades and an area
that operates), it asks one question that proposes the two modes, so each can get its own surface.
