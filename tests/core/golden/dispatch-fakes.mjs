// @ts-check
// The fake runtimes of the golden dispatcher cases (tests/core/golden/dispatch-record.mjs records the shell dispatcher with them, tests/core/dispatch-golden.test.mjs
// runs the Node dispatcher with the very same files): each writes its argument list, its stdin and its variables to $FAKE_LOC, and submits by writing its status file.

/** @param {'codex' | 'claude' | 'cli'} n the text of the fake runtime */
export function fakeRuntime(n) {
  return `#!/bin/sh
loc=$FAKE_LOC; n=${n}
printf '%s\\n' "$@" > "$loc/$n.argv"
if [ "$n" = cli ]; then cp "$1" "$loc/cli.stdin"; else cat > "$loc/$n.stdin"; fi
echo "$AGENT_ROLE|$PROOFLINE_AGENT|$PROOFLINE_FOCUS|$PROOFLINE_DISPATCH_RUNTIME|$HOME|\${CODEX_HOME:-}" > "$loc/$n.env"
o=''; if [ "$n" = cli ]; then o=$2; else while [ $# -gt 0 ]; do [ "$1" = -o ] && o=$2; shift; done; fi
[ -z "$o" ] || echo "x" > "$o"
mkdir -p "$FAKE_ROOT/.agents/local/submissions"
if [ "\${FAKE_LATE:-}" = 1 ] && [ ! -f "$loc/late" ]; then : > "$loc/late"; [ "$n" = claude ] && echo '{"result":"x"}'; exit 0; fi
printf 'status=ok\\ntask=LC\\nrole=%s\\nresult=DONE\\ngate=\\nraw=results/001-%s.result.md\\n' "$AGENT_ROLE" "$AGENT_ROLE" > "$FAKE_ROOT/.agents/local/submissions/$PROOFLINE_AGENT.status"
[ "$n" = claude ] && echo '{"type":"result","is_error":false,"result":"ok"}'
exit 0
`;
}

/** The roles table of the old dispatch-test.sh: role balanced max economy (model:effort) floor, claude rows by model name, codex rows by tier token. */
export function fixtureRoles() {
  const rows = [['architect', 'opus:high', 'opus:xhigh', 'sonnet:high', 2], ['explorer', 'sonnet:medium', 'opus:medium', 'haiku:low', 1], ['implementer', 'sonnet:high', 'opus:high', 'sonnet:medium', 2],
    ['reviewer', 'sonnet:high', 'opus:max', 'sonnet:medium', 2], ['security_reviewer', 'opus:high', 'opus:xhigh', 'opus:high', 3], ['verifier', 'sonnet:medium', 'opus:high', 'haiku:medium', 1],
    ['designer', 'sonnet:medium', 'opus:high', 'sonnet:low', 1]];
  let out = '';
  for (const [role, balanced, max, economy, floor] of rows) {
    for (const [profile, pm] of [['balanced', balanced], ['max', max], ['economy', economy]]) {
      const [mo, ef] = String(pm).split(':');
      const tier = mo === 'haiku' ? 'tier1' : mo === 'sonnet' ? 'tier2' : 'tier3';
      const ce = ef === 'max' ? 'xhigh' : ef;
      out += `${role} ${profile} claude ${mo} ${ef} ${floor}\n${role} ${profile} codex ${tier} ${ce} ${floor}\n`;
    }
  }
  return out;
}

