// Builds the docs-writer fixture project in <target-dir>: a small tool with two documents. docs/guide.md quotes five
// things the project does not have (one path, one flag, one config key, one link, one subcommand) next to
// several that exist; docs/style.md plants three writing-length findings next to text that must pass.
// Deterministic and offline. usage: node setup.mjs <target-dir>
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.w(`bin/acme`, `#!/bin/sh
# acme build | serve [--port N]
case "\${1:-}" in
  build) echo "building" ;;
  serve) shift; [ "\${1:-}" = "--port" ] && echo "port $2"; echo "serving" ;;
  *) echo "usage: acme build | serve [--port N]" >&2; exit 2 ;;
esac
`);
  f.w(`src/server.js`, `export const start = (port = 8080) => port;
`);
  f.w(`.agents/config.yaml`, `server:
  port: 8080
  host: localhost
writing:
  profile: auto
  strictness: relaxed
`);
  f.w(`docs/guide.md`, `# Guide

Start the server with \`./bin/acme serve --port 8080\`. The code is in \`src/server.js\`.

## Usage

Build first with \`./bin/acme build\`. Set \`server.port\` in [the config](../.agents/config.yaml) to change the default.

Print more detail with \`--verbose\`. Set \`server.timeout\` to stop slow requests. Read \`docs/old-guide.md\` for the history.
Run \`./bin/acme deploy\` to publish. See the [setup page](setup.md) and the [usage section](#usage).

| Item | Detail |
|---|---|
| \`src/server.js\` | the entry point |
`);
  f.w(`docs/style.md`, `# Style sample

Run the installer, answer every question it asks on the screen, wait for the progress bar to reach the very end, and then restart the machine to finish.

The installer keeps a log of every step it takes, and a reader who wants to trace a failure later can open that log and follow the steps one by one until the failing step appears.

First sentence of the long paragraph. Second sentence of the paragraph. Third sentence of the paragraph. Fourth sentence of the paragraph. Fifth sentence of the paragraph. Sixth sentence of the paragraph. Seventh sentence of the paragraph.

Back up the file first. The migration drops the column.

- Stop the service.
- Copy the data directory to a safe place.

| Step | Detail |
|---|---|
| 1 | This table cell holds a very long sentence that has more than twenty-five words but is a table and so the check must ignore it completely. |

\`\`\`sh
echo "a fenced line is never measured even when it has more than twenty words in it, so this long line must pass the check without a finding"
\`\`\`
`);
}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });
