// @ts-check
// T2 port of the moved-command assertions of the legacy suites (gates-test, risk-test, lifecycle-test, cifix-test, deliver-test, ...): every call of a
// moved read-only command that a legacy scenario made was recorded ONCE from the shell with the project as it was before the call
// (tests/fixtures/port-t2/trace/<suite>__<scenario>.json.gz). Here the Node core answers the same call on the same project and must give the recorded
// stdout, stderr and exit status. Nothing runs or compares with the shell at test time. The recorded text is the expected value.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { loadTrace, node, replayer, traceDir } from './port-t2-lib.mjs';

const only = process.env.PORT_T2_ONLY;
const names = readdirSync(traceDir).filter((f) => f.endsWith('.json.gz')).map((f) => f.slice(0, -8)).filter((n) => !only || n.includes(only)).sort();

/** The text with the volatile parts of the project spelled the same on both sides. @param {string} s @param {string} base */
const mask = (s, base) => s.split(base).join('<BASE>');

describe('legacy scenarios, moved commands', () => {
  for (const name of names) {
    test(name, () => {
      const tr = loadTrace(name);
      const rp = replayer(tr);
      /** @type {Map<string, string>} */ const roots = new Map();
      let i = 0;
      for (const c of tr.calls) {
        i++;
        const baseSha = tr.states[c.state].baseSha;
        let root = roots.get(c.state);
        const label = `${name} call ${i}: ${c.role ? `AGENT_ROLE=${c.role} ` : ''}${c.args.join(' ')}`;
        // each call sees the project as it was before it; a call that changed the project (freshness, next) must not leak into the next one
        root = rp.state(c.state); roots.set(c.state, root);
        const got = node(root, c.args, { env: c.role ? { AGENT_ROLE: c.role } : {} });
        assert.deepEqual({ out: mask(got.out, rp.sha), err: mask(got.err, rp.sha), code: got.code },
          { out: mask(c.out, baseSha), err: mask(c.err, baseSha), code: c.code }, label);
      }
    });
  }
});
