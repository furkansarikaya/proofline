// @ts-check
// The alternating-engine case (ADR 0001 section 6, input 3; D3: a run continues across an upgrade and across a rollback). One full run lifecycle
// of the self-tests (scaffold, RED/GREEN under windows, every gate, handoffs to CODE_DONE, knowledge, completion report, DONE) is executed twice:
// every `sh ./.agents/scripts/agent.sh` call on the old engine only, and with the calls alternating old, new, old, ... (the new engine is the
// default engine; between the lifecycle steps the script also calls role, hook-config, config-get and timeouts, the commands that move in stage 1).
// The two finished project trees must be equal under the rig's normalisation. Until proofline-core.mjs exists, "new" is the shell as well.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { baseEnv, copyTree, coreAbsent, run, scaffoldFixture, scriptsSrc, snapshot } from './fixture.mjs';
import { compareSides, formatDiffs, isShellFlake } from './rig.mjs';

// The shell function `sh` shadows the program for the agent.sh calls only; the counter lives in a file because $(...) runs in a subshell.
const SCRIPT = `
. "$EQ_LIB"
sh() {
  case "\${1:-}" in
    ./.agents/scripts/agent.sh)
      eq_n=$(cat "$EQ_CNT" 2>/dev/null || echo 0); eq_n=$((eq_n + 1)); echo "$eq_n" > "$EQ_CNT"
      eq_t0=$(date +%s)
      if [ -n "\${EQ_ALT:-}" ] && [ $((eq_n % 2)) = 0 ]; then command sh "$@"; else PROOFLINE_ENGINE=sh command sh "$@"; fi
      eq_rc=$?; printf '%s\\t%s\\t%s\\t%s\\n' "$eq_n" "$(( $(date +%s) - eq_t0 ))" "$eq_rc" "\${EQ_ALT:+alt:}$2 $3" >> "$EQ_CNT.times"; return "$eq_rc" ;;
    *) command sh "$@" ;;
  esac
}
mx() { A role >/dev/null; A config-get profile >/dev/null; A hook-config >/dev/null; A timeouts >/dev/null; A tm-scaled 30 >/dev/null; }
RID=LC; cd "$EQ_FX" || exit 1; mx
worker RED fail impl_test.txt 'test: lookup returns the stored value'; mx
worker GREEN pass impl.txt 'impl: lookup returns the stored value'; mx
A handoff LC IMPLEMENTED >/dev/null; mx
pass_all; mx
A handoff LC CODE_DONE >/dev/null; mx
finish_done; mx
A status >/dev/null; A verify-seal LC >/dev/null
echo "calls=$(cat "$EQ_CNT")"
cp -R "$PWD/." "$EQ_OUT/res/"
`;

/** The shell runs async so that the two lifecycles run in parallel: one takes about 6 minutes here (publish-completion-report 95 s, handoff 57 s, record 30 s each: unmoved shell commands) and 2.5 times that on a CI runner. */
const LIFECYCLE_TIMEOUT_MS = 2400000;
function sh(/** @type {Record<string,string>} */ env) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', SCRIPT, join(scriptsSrc, 'x.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), LIFECYCLE_TIMEOUT_MS);
    p.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
async function lifecycle(/** @type {boolean} */ alternate) {
  // both runs start from identical copies of one frozen scaffold (a second scaffold would have another baseline commit id)
  const out = mkdtempSync(join(tmpdir(), 'eq-life.')); mkdirSync(join(out, 'res')); const fx = join(out, 'fx'); const scaf = scaffoldFixture('orchestrated', 'COMPLEX'); copyTree(scaf.dir, fx); const cnt = join(out, '..', `eq-cnt.${process.pid}.${alternate ? 'alt' : 'old'}`);
  const t0 = Math.floor(Date.now() / 1000);
  const r = await sh({ ...baseEnv(out), EQ_OUT: out, EQ_FX: fx, EQ_LIB: join(scriptsSrc, 'test-lib.sh'), EQ_CNT: cnt, ...(alternate ? { EQ_ALT: '1' } : {}) });
  const t1 = Math.floor(Date.now() / 1000);
  // per-call durations written by the shell function above: the table that tells a slow call from a hung one
  let table = ''; try { table = readFileSync(`${cnt}.times`, 'utf8'); } catch { /* none written */ }
  rmSync(cnt, { force: true }); rmSync(`${cnt}.times`, { force: true });
  const slow = table.split('\n').filter(Boolean).map((l) => l.split('\t')).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 12).map((x) => `#${x[0]} ${x[1]}s rc=${x[2]} ${x[3]}`).join('\n');
  if (process.env.EQ_TIMES) process.stderr.write(`${alternate ? 'alternating' : 'old only'} slowest calls:\n${slow}\n`);
  assert.equal(r.code, 0, `${r.signal ? `killed by ${r.signal} after the spawn timeout; ` : ''}slowest calls (#n seconds rc args):\n${slow}\nlast call: ${table.trim().split('\n').pop()}\n${r.stderr}${r.stdout}`);
  const files = snapshot(join(out, 'res')); rmSync(out, { recursive: true, force: true });
  return { calls: Number(/calls=(\d+)/.exec(r.stdout)?.[1]), side: { outputs: [{ code: r.code, stdout: r.stdout.replace(/calls=\d+\n/, ''), stderr: '' }], files, window: /** @type {[number, number]} */ ([Math.min(t0 - 1, scaf.builtAt), t1]) } };
}

test(`one run lifecycle with alternating engines equals the same lifecycle on the old engine${coreAbsent() ? ' (the new engine is the shell until proofline-core.mjs exists)' : ''}`, { timeout: 5400000 }, async () => {
  // The shell reads `date` twice per ledger line (ts= and epoch=), so a line written across a second boundary names two seconds. That is a flake of
  // the old engine, not a rig finding, and the check is not loosened: a scenario is run once more when the ONLY violations are ts/epoch seconds
  // mismatches. Any other difference fails at once; a second mismatch fails too.
  const flakeOnly = (/** @type {import('./rig.mjs').Diff[]} */ d) => isShellFlake(d, [old.side, alt.side]);
  let d = []; let old; let alt;
  for (let attempt = 0; attempt < 2; attempt++) {
    [old, alt] = await Promise.all([lifecycle(false), lifecycle(true)]);
    assert.ok(old.calls > 40, `a lifecycle makes many calls (${old.calls})`); assert.equal(old.calls, alt.calls);
    assert.ok([...old.side.files.keys()].some((p) => p.endsWith('/LEDGER.log')) && [...old.side.files.keys()].some((p) => p.endsWith('COMPLETION_REPORT.md')));
    // the full lifecycle writes time fields the closed list does not name yet (PENDING_APPROVAL in normalise.mjs): masked here, flagged for the maintainer
    d = compareSides(old.side, alt.side, ['old only', 'alternating'], { pendingApproval: true });
    if (!flakeOnly(d)) break;
  }
  assert.equal(d.length, 0, formatDiffs(d));
});
