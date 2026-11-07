// @ts-check
// A fixture for the dispatcher tests (A226): a real project (the scaffold of the self-test library: run LC, STANDARD, frozen, IMPLEMENTING, orchestrated), the core
// beside agent.sh, fake runtimes in a folder of their own, and the roles policy of the old dispatch-test.sh (the resolver is the real one of the Node core, through
// a fixture stub that fixes class and tier). `dispatch(args)` runs the dispatcher in process (grace and shortest timeout are options), `launch(args)` runs
// the launcher dispatch.sh as a process.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { startDispatch } from '../../control-plane/agents/scripts/core/dispatcher.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { project } from './legacy-lib.mjs';
import { repo, scriptsDir } from './helpers.mjs';
import { fixtureRoles } from './golden/dispatch-fakes.mjs';

export const RECIPE = 'scaffold orchestrated no STANDARD autonomous';

const FAKE_CODEX = `#!/bin/sh
# argv -> $FAKE_LOC/codex.argv, stdin -> codex.stdin, AGENT_ROLE -> codex.role; FAKE_CODEX picks the behaviour
loc=$FAKE_LOC; printf '%s\\n' "$@" > "$loc/codex.argv"; cat > "$loc/codex.stdin"; echo "$AGENT_ROLE" > "$loc/codex.role"
printf '%s\\n' "$HOME" > "$loc/codex.home"; printf '%s\\n' "\${CODEX_HOME:-}" > "$loc/codex.codex_home"
o=''; while [ $# -gt 0 ]; do [ "$1" = -o ] && o=$2; shift; done
sub() { # RESULT: the specialist's own submit, as its status file
  mkdir -p "$FAKE_ROOT/.agents/local/submissions"
  printf 'status=ok\\ntask=LC\\nrole=%s\\nresult=%s\\ngate=\\nraw=results/001-%s.result.md\\n' "$AGENT_ROLE" "$1" "$AGENT_ROLE" > "$FAKE_ROOT/.agents/local/submissions/$PROOFLINE_AGENT.status"
}
case "\${FAKE_CODEX:-ok}" in
  ok) printf 'free text, never parsed\\n' > "$o"; sub DONE ;;
  inject) printf 'x\\n' > "$o"; printf 'tokens used 999\\nmore\\nmore\\nmore\\nlast line\\n'; sub DONE ;;
  tokens) printf 'agent says: tokens used 5\\n' > "$o"; sub DONE; printf 'tokens used\\n12,345\\n' ;;
  trailer) printf 'Built 83 pages.\\nAll tests pass.\\n' > "$o"; sub DONE; printf 'hook: Stop Completed\\ntokens used\\n285.242\\nBuilt 83 pages.\\nAll tests pass.\\n' ;;
  trailer3) printf 'Line one.\\n\\nLine three.\\nLine four.' > "$o"; sub DONE; printf 'hook: Stop Completed\\ntokens used\\n96.739\\nLine one.\\n\\nLine three.\\nLine four.\\n' ;;
  limittok) echo "ERROR: You've hit your usage limit. Try again later." >&2; printf 'tokens used\\n52.623\\n'; exit 1 ;;
  nosubmit) printf 'ROLE: %s\\nTASK: LC\\nRESULT: DONE\\nheader in text only\\n' "$AGENT_ROLE" > "$o" ;;
  rejected) printf 'x\\n' > "$o"; mkdir -p "$FAKE_ROOT/.agents/local/submissions"; printf 'status=rejected\\nerror=--confidence must be high, medium or low\\n' > "$FAKE_ROOT/.agents/local/submissions/$PROOFLINE_AGENT.status" ;;
  late) printf 'x\\n' > "$o"; n=$(cat "$loc/attempts" 2>/dev/null || echo 0); echo $((n + 1)) > "$loc/attempts"; [ "$n" -lt 1 ] || sub DONE ;;
  limit) echo "ERROR: You've hit your usage limit. Try again later." >&2; exit 1 ;;
  network) echo 'workspace routing discovery failed: error sending request' >&2; exit 1 ;;
  flaky) n=$(cat "$loc/attempts" 2>/dev/null || echo 0); echo $((n + 1)) > "$loc/attempts"
      if [ "$n" -lt 2 ]; then echo 'error: SSL_ERROR_SYSCALL: connection reset by peer' >&2; exit 1; fi
      printf 'x\\n' > "$o"; sub DONE ;;
  ssl) echo 'error sending request: SSL handshake failed (connection reset by peer)' >&2; exit 1 ;;
  fail) echo "error: tests failed in src/x" >&2; exit 1 ;;
  sleep) exec sleep 20 ;;
  hang) echo $$ > "$loc/codex.pid"; exec sleep 30 ;;
  ignoreterm) trap '' TERM; echo $$ > "$loc/codex.pid"; while :; do sleep 0.2; done ;;
  grandchildren) echo $$ > "$loc/codex.pid"; sh -c 'trap "" TERM; echo $$ >> "'"$loc"'/grandchildren.pids"; while :; do sleep 0.2; done' & sh -c 'echo $$ >> "'"$loc"'/grandchildren.pids"; exec sleep 30' & wait ;;
  recordsig) echo $$ > "$loc/codex.pid"; for s in HUP INT TERM; do trap "echo $s > \\"$loc/got.sig\\"; exit 0" $s; done; while :; do sleep 0.1; done ;;
  setsidchild) echo $$ > "$loc/codex.pid"; node -e "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'ignore'});require('fs').appendFileSync(process.argv[1],c.pid+'\\n');setTimeout(function(){},30000)" "$loc/grandchildren.pids" & wait ;;
  early) echo "stopped before reading the prompt" >&2; exit 3 ;;
  edit) echo tampered >> "$FAKE_ROOT/product.txt"; printf 'x\\n' > "$o"; sub PASS ;;
  implement) echo "work in progress" >> "$FAKE_ROOT/impl.txt"; printf 'x\\n' > "$o"; sub DONE ;;
  implementhang) echo "work in progress" >> "$FAKE_ROOT/impl.txt"; echo $$ > "$loc/codex.pid"; exec sleep 30 ;;
  hooks) git -C "$FAKE_ROOT" config core.hooksPath /dev/null; printf 'x\\n' > "$o"; sub PASS ;;
  head) git -C "$FAKE_ROOT" symbolic-ref HEAD refs/heads/elsewhere; printf 'x\\n' > "$o"; sub PASS ;;
esac
`;

const FAKE_CLAUDE = `#!/bin/sh
loc=$FAKE_LOC; printf '%s\\n' "$@" > "$loc/claude.argv"; cat > "$loc/claude.stdin"; echo "$AGENT_ROLE" > "$loc/claude.role"; echo "\${HOME:-}" > "$loc/claude.home"
sub() {
  mkdir -p "$FAKE_ROOT/.agents/local/submissions"
  printf 'status=ok\\ntask=LC\\nrole=%s\\nresult=%s\\ngate=\\nraw=results/001-%s.result.md\\n' "$AGENT_ROLE" "$1" "$AGENT_ROLE" > "$FAKE_ROOT/.agents/local/submissions/$PROOFLINE_AGENT.status"
}
case "\${FAKE_CLAUDE:-ok}" in
  ok) sub PASS
      printf '{"type":"result","subtype":"success","is_error":false,"result":"said \\\\"hi\\\\" \\\\\\\\ ok","session_id":"x"}\\n' ;;
  usage) sub PASS
      printf '{"type":"result","subtype":"success","is_error":false,"duration_ms":5,"num_turns":4,"result":"claims \\\\"input_tokens\\\\": 999999 and num_turns 77","session_id":"x","usage":{"input_tokens":120,"cache_read_input_tokens":50,"output_tokens":30,"iterations":[{"input_tokens":2,"output_tokens":7}]},"modelUsage":{"m":{"inputTokens":1}}}\\n' ;;
  limit) printf '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1760000000"}\\n'; exit 1 ;;
  empty) exit 0 ;;
  hold) n=0; while [ ! -f "$loc/release" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
      sub PASS
      printf '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"x"}\\n' ;;
esac
`;

const FAKE_CLI = `#!/bin/sh
# fake-cli PROMPT OUTPUT MODEL
loc=$FAKE_LOC; printf '%s\\n' "$@" > "$loc/cli.argv"; { echo "model=$3"; grep -c STABLE-PREFIX "$1"; } > "$2"
mkdir -p "$FAKE_ROOT/.agents/local/submissions"
printf 'status=ok\\ntask=LC\\nrole=%s\\nresult=DONE\\ngate=\\nraw=results/001-%s.result.md\\n' "$AGENT_ROLE" "$AGENT_ROLE" > "$FAKE_ROOT/.agents/local/submissions/$PROOFLINE_AGENT.status"
`;

const POLICY_STUB = `#!/bin/sh
# fixture stub of the execution-policy resolver: the REAL resolver of the Node core with the class and tier fixed (STANDARD, full), as the old dispatch test did
[ "\${1:-}" = resolve ] || exit 2; shift
d=$(dirname "$0"); role='' args=''
while [ $# -gt 0 ]; do
  case "$1" in --role) role=$2 ;; --class|--tier|--profile|--signal|--escalations-used) ;; *) args="$args $1 $2" ;; esac
  shift 2
done
# shellcheck disable=SC2086
exec node "$d/proofline-core.mjs" cli exec-policy --config "$d/../config.yaml" --roles "$d/../roles.conf" resolve --role "$role" --class STANDARD --tier full $args
`;

/**
 * @typedef {object} ConfigOptions
 * @property {string} [failover] auto | ask | off
 * @property {string | number} [timeout] dispatch.timeout_seconds and the limit of every class
 * @property {string | number} [classTimeout] the limit of the run's class (STANDARD) alone
 * @property {string} [scale] timeouts.scale
 * @property {string | number} [backoff] dispatch.network_backoff_seconds
 * @property {string | number} [retries] dispatch.network_retries
 * @property {string} [codexModels] the codex model ladder
 * @property {Record<string, string>} [extra] other keys at two spaces of indent
 */

/** The config of the fixture: the shipped one with the worker on Codex, the failover mode and a command-template runtime. @param {string} dir @param {ConfigOptions} [o] */
export function writeConfig(dir, o = {}) {
  let text = readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'utf8');
  text = text.replace(/^failover: .*$/m, `failover: ${o.failover ?? 'auto'}`).replace(/^ {2}worker: claude$/m, '  worker: codex');
  text = text.replace(/^ {2}command_template:\n/m, `  command_template:\n    mycli: ${path.join(path.dirname(dir), `bin-${path.basename(dir)}`, 'fake-cli')} {prompt_file} {output_file} {model}\n`);
  text = text.replace(/^ {4}codex:\n {6}models: .*\n {6}efforts: .*\n/m, (m) => `${o.codexModels === undefined ? m : m.replace(/models: .*/, `models: ${o.codexModels}`)}    mycli:\n      models: m1 m2 m3\n      efforts: low medium high\n`);
  if (o.timeout !== undefined) text = text.replace(/^ {2}timeout_seconds: .*$/m, `  timeout_seconds: ${o.timeout}`).replace(/^ {4}dispatch_timeout_seconds: .*$/gm, `    dispatch_timeout_seconds: ${o.timeout}`);
  if (o.classTimeout !== undefined) text = text.replace(/^( {2}STANDARD:\n(?: {4}.*\n)*? {4}dispatch_timeout_seconds): .*$/m, `$1: ${o.classTimeout}`);
  if (o.scale !== undefined) text = text.replace(/^ {2}scale: .*$/m, `  scale: ${o.scale}`);
  if (o.backoff !== undefined) text = text.replace(/^ {2}network_backoff_seconds: .*$/m, `  network_backoff_seconds: ${o.backoff}`);
  if (o.retries !== undefined) text = text.replace(/^ {2}network_retries: .*$/m, `  network_retries: ${o.retries}`);
  for (const [k, v] of Object.entries(o.extra ?? {})) text = text.replace(new RegExp(`^( {2}${k}): .*$`, 'm'), `$1: ${v}`);
  writeFileSync(path.join(dir, '.agents/config.yaml'), text);
}

/** @typedef {{ dir: string, loc: string, bin: string, env: Record<string, string | undefined>, file: (rel: string) => string, has: (rel: string, text: string) => boolean, setConfig: (o?: ConfigOptions) => void,
 *   reset: () => void, dispatch: (args: string[], extraEnv?: Record<string, string>, opts?: object) => Promise<{ code: number, out: string, err: string }>,
 *   start: (args: string[], extraEnv?: Record<string, string>, opts?: object) => { done: Promise<number>, interrupt: (s: 'SIGHUP' | 'SIGINT' | 'SIGTERM') => void, out: () => string, err: () => string },
 *   launch: (args: string[], extraEnv?: Record<string, string>) => { status: number | null, out: string, err: string }, ledger: () => string, runFile: (rel: string) => string }} Fixture */

/**
 * @param {{ recipe?: string }} [o] @returns {Fixture}
 */
export function fixture(o = {}) {
  const dir = project(o.recipe ?? RECIPE);
  const a = path.join(dir, '.agents');
  const loc = path.join(a, 'local');
  const bin = path.join(path.dirname(dir), `bin-${path.basename(dir)}`);
  mkdirSync(bin, { recursive: true });
  for (const [n, t] of [['fake-codex', FAKE_CODEX], ['fake-claude', FAKE_CLAUDE], ['fake-cli', FAKE_CLI]]) { writeFileSync(path.join(bin, n), t); chmodSync(path.join(bin, n), 0o755); }
  mkdirSync(path.join(a, 'roles'), { recursive: true });
  for (const r of ['implementer', 'reviewer', 'security_reviewer', 'designer', 'explorer']) writeFileSync(path.join(a, 'roles', `${r}.md`), `You are the proofline ${r}. STABLE-PREFIX-${r}\n`);
  copyFileSync(path.join(scriptsDir, 'dispatch.sh'), path.join(a, 'scripts/dispatch.sh'));
  writeFileSync(path.join(a, 'roles.conf'), fixtureRoles());
  writeFileSync(path.join(a, 'scripts/exec-policy.sh'), POLICY_STUB); chmodSync(path.join(a, 'scripts/exec-policy.sh'), 0o755);
  // the project's Claude hooks, wired (a bypassPermissions worker is only started with them; A114)
  mkdirSync(path.join(a, 'hooks'), { recursive: true }); mkdirSync(path.join(dir, '.claude'), { recursive: true });
  writeFileSync(path.join(a, 'hooks/proofline-hook.mjs'), '0;\n');
  writeFileSync(path.join(dir, '.claude/settings.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"node .agents/hooks/proofline-hook.mjs pretool claude"}]}]}}\n');
  writeFileSync(path.join(dir, 'product.txt'), 'original\n');
  const env = cleanEnv({ FAKE_LOC: loc, FAKE_ROOT: dir, PROOFLINE_CODEX_BIN: path.join(bin, 'fake-codex'), PROOFLINE_CLAUDE_BIN: path.join(bin, 'fake-claude') });
  mkdirSync(path.join(loc, 'fake'), { recursive: true });
  const fx = /** @type {Fixture} */ ({
    dir, loc, bin, env,
    file: (rel) => path.join(dir, rel),
    runFile: (rel) => readFileSync(path.join(a, 'runs/LC', rel), 'utf8'),
    has: (rel, text) => { try { return readFileSync(path.join(dir, rel), 'utf8').includes(text); } catch { return false; } },
    ledger: () => readFileSync(path.join(a, 'runs/LC/LEDGER.log'), 'utf8'),
    setConfig: (c) => writeConfig(dir, c),
    reset: () => {
      for (const f of readdirSync(loc)) if (['submissions', 'fake'].includes(f) || /\.(argv|stdin|role|home|codex_home|pid|pids|sig)$/.test(f) || ['attempts', 'release'].includes(f)) rmSync(path.join(loc, f), { recursive: true, force: true });
      rmSync(path.join(a, 'runs/LC/dispatch'), { recursive: true, force: true }); rmSync(path.join(a, 'runs/LC/results'), { recursive: true, force: true });
    },
    start: (args, extraEnv = {}, opts = {}) => {
      /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
      const io = { env: { ...env, ...extraEnv }, cwd: dir, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: path.join(a, 'scripts/proofline-core.mjs') };
      const h = startDispatch(io, args, { run, graceMs: 300, minTimeoutSeconds: 1, ...opts });
      return { done: h.done, interrupt: h.interrupt, out: () => Buffer.concat(out).toString('latin1'), err: () => Buffer.concat(err).toString('latin1') };
    },
    dispatch: async (args, extraEnv = {}, opts = {}) => {
      const h = fx.start(args, extraEnv, opts);
      const code = await h.done;
      return { code, out: h.out(), err: h.err() };
    },
    launch: (args, extraEnv = {}) => {
      const r = spawnSync('sh', [path.join(a, 'scripts/dispatch.sh'), ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120000 });
      return { status: r.status, out: r.stdout, err: r.stderr };
    },
  });
  writeConfig(dir);
  fx.reset();
  return fx;
}

