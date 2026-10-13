# Config consistency (focus `config`)

The `config` risk focus (A78 signal `config_env`, A88) runs inside `REVIEW_RULES` (`REVIEW_SMALL` on tier
small). It is deterministic: [check-config.mjs](../scripts/check-config.mjs) reads git objects and the working
tree, [validate-config.mjs](../scripts/validate-config.mjs) recomputes the gate. Nothing is installed, no
project code runs, no network is used. Every item is `measured` (a reproducible scan); judgement is not part of
this focus.

Only lines the change **adds** are judged (flags: also the lines it removes). A pre-existing undocumented
variable or secret is never a finding of this change.

## 1. Run

```
node <skill-dir>/scripts/check-config.mjs --base <base_sha> --plan <run>/PLAN.md --out <dir>/config-check.json
node <skill-dir>/scripts/validate-config.mjs <dir>/config-check.json --table
```

`--repo` defaults to the current directory. Without `--plan` the feature-flag check cannot compare with the
plan and reports flag defaults as notes (confidence `medium`).

## 2. Checks

| Check | Class | What it finds |
|---|---|---|
| `env_undocumented` | blocking | an added read of a variable that no example/sample/template file and no Markdown, reStructuredText or AsciiDoc file mentions |
| `secret_plaintext` | blocking | an added line of a config, env or example file matching a secret rule |
| `flag_default_on` | blocking with a plan, else note | an added flag set to on that the plan does not name |
| `flag_removed_referenced` | blocking | a flag key removed from a config file whose name is still referenced in the repository |
| `env_documented_unused` | note | a variable added to an example env file that no code or config reads |
| `secret_allowlisted` | note | a secret-looking line carrying `proofline:allow-secret` |
| `flag_default_on_planned` | note | a flag set to on that the plan names |
| `flag_default_off` | note | a flag added with default off |

### Environment variables

Matched reads (literal names): `process.env.X`, `process.env["X"]`, `import.meta.env.X`, `Deno.env.get("X")`,
`os.environ["X"]`, `os.environ.get("X")`, `os.getenv("X")`, `os.Getenv("X")`, `os.LookupEnv("X")`,
`env::var("X")`, `env!("X")`, `ENV["X"]`, `ENV.fetch("X")`, `getenv('X')`, `$_ENV['X']`, `System.getenv("X")`,
`Environment.GetEnvironmentVariable("X")` in code files, and `${X}` / `${X:-default}` in config files. Ambient
variables (`PATH`, `HOME`, `NODE_ENV`, `CI`, `TMPDIR`, ...) are never reported. **Documented** means the name
appears as a word in an example/sample/template/dist file or a Markdown, reStructuredText or AsciiDoc file.

### Secrets

The rule names are those of the SECRETS gate's built-in scan (`aws_access_key_id`, `aws_secret_access_key`,
`github_token`, `gitlab_token`, `slack_token`, `private_key`, `jwt`, `generic_secret`, `env_file`). The generic
rule needs a key containing `api_key`, `secret`, `password`, `token`, `access_key` or `private_key` and a value of
at least 16 characters with letters, digits and entropy of 3.5 bits or more; a value starting with `$`, `<`,
`{` or `%` (a reference or placeholder) is never a secret. An `.env` file (not `.env.example`) with a value is an
`env_file` hit. Quoted and, in config files, unquoted values are matched.

The document never contains a value: only the rule name, the key name and the value length. The validator rejects a
document in which any text matches a secret pattern. A line containing `proofline:allow-secret` (the same
convention the SECRETS gate honors) is a note: use it for test fixtures with fake credentials.

The validator rejects a document in which any rule, `generic_secret` included, matches the subject or detail text.

A plain-text secret is also found by the SECRETS gate, which is never waivable; this focus adds the context
(which config file, which key) inside the review.

### Feature flags

A flag is a boolean key (`true|false|on|off|yes|no|enabled|disabled|1|0`) in a config, env or example file whose
name contains `feature`, `flag`, `toggle`, `experiment` or `rollout`, or that sits under a `features`, `flags`,
`toggles` or `experiments` block. In code, a flag-like environment variable read with a default of
`true`/`1`/`on` (`process.env.FEATURE_X || "true"`, `os.getenv("FEATURE_X", "true")`) counts too. The plan names a
flag when its text contains the flag name (also with `_`, `-` and `.` interchanged) as a whole word. A flag
whose added line is also a changed value of an existing flag is judged the same way (flipping to on is a new
default).

## 3. Result

`validate-config.mjs` prints `RESULT: FAIL` when any blocking item exists, otherwise `PASS`, and `CONFIDENCE:
high`, or `medium` when files were skipped (`not_reviewed`: larger than 1 MiB, more than 5000 files) or no plan
was available. Blocking rows are `blocking`, notes are `info`. A PASS says "no inconsistency found by these
checks", never that the configuration is correct.

## Limits

- Variable reads are matched by literal name in the idioms above, plus JavaScript destructuring of the
  environment (`const { A, B = "x", C: c } = process.env`, one or several lines, also `import.meta.env`), Python
  `from os import environ`, and Go `os.ExpandEnv`. Not matched: a computed name, an alias of the environment
  object (`const env = process.env; env.X`), a wrapper function (`getConfig("X")`), a framework binding
  (`@Value("${x}")`, `Config.get`, a config library reading `X`), a Rust or Go struct filled from the
  environment by a derive or tag, and shell scripts.
- A line that already exists elsewhere in the same file (moved or re-indented) counts as not new, so a duplicated
  line is not reported twice.
- Documentation is name based: a name in a README sentence counts as documented even when it says nothing useful.
- Secrets: the scan is regex and entropy based, so a low-entropy password, a value split over lines or an
  encoded blob is missed, and a random-looking non-secret can be reported (use `proofline:allow-secret` for a
  deliberate fake). The project's own secret scanner (`commands.secret_scan`) is not run here.
- Flags: the key naming and block conventions above are heuristics; a flag stored in a database or a remote
  service is outside the repository.
- Parent block detection for YAML and JSON uses indentation, so a minified or flow-style file is not seen.
- Binary files, vendored and build directories, lockfiles and files over 1 MiB are not read.
