// @ts-check
// The rig's own tests (issue #166): it passes on identical runs and on runs that differ only in valid times and the hashes derived from
// them, and it reports every planted difference. Pure in-memory sides: no engine is run here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSides, formatDiffs } from './rig.mjs';
import { PENDING_APPROVAL, RULE_IDS, isoToEpoch, rankConflicts, sha256, tarMembers } from './normalise.mjs';
import { synthSide, toSide } from './lib-synth.mjs';

const T0 = 1_800_000_000; const WIN = /** @type {[number, number]} */ ([T0 - 5, T0 + 60]);
const good = (/** @type {number} */ t = T0, tweak = {}) => toSide(synthSide(t, tweak), [t - 5, t + 60]);
const kinds = (/** @type {import('./rig.mjs').Diff[]} */ d) => d.map((x) => x.kind);
const expectReported = (/** @type {any} */ a, /** @type {any} */ b, /** @type {RegExp} */ re, /** @type {string[]|undefined} */ kindList) => {
  const d = compareSides(a, b); assert.ok(d.length > 0, 'the rig reported nothing for a planted difference');
  assert.match(formatDiffs(d), re, formatDiffs(d)); if (kindList) for (const k of kindList) assert.ok(kinds(d).includes(k), `${k} not in ${kinds(d)}`);
};

test('the closed list has exactly the eight rules of ADR 6 (a new rule needs the maintainer)', () => {
  assert.deepEqual([...RULE_IDS], ['times', 'derived-hashes', 'process-ids', 'temp-dirs', 'nonces', 'durations', 'file-metadata', 'archives']);
});

test('identical runs pass', () => {
  assert.equal(compareSides(good(), good()).length, 0);
});

test('two correct runs that differ only in times and the hashes derived from them pass', () => {
  const d = compareSides(good(T0), toSide(synthSide(T0 + 7), [T0 + 2, T0 + 80]));
  assert.equal(d.length, 0, formatDiffs(d));
});

test('planted: one byte of a ledger detail=', () => {
  const b = good(T0, { ledger: (/** @type {any[]} */ l) => { l[3].detail = '001-qa.decision runtime=claudf'; } });
  expectReported(good(), b, /content .*LEDGER\.log/, ['content']);
});

test('planted: an exit code', () => {
  const b = good(); b.outputs[0].code = 1; expectReported(good(), b, /exit-code step 0: 0 against 1/);
});

test('planted: stdout and stderr bytes', () => {
  const b = good(); b.outputs[0].stdout = 'ok \n'; expectReported(good(), b, /stdout step 0/);
  const c = good(); c.outputs[0].stderr = 'x'; expectReported(good(), c, /stderr step 0/);
});

test('planted: a missing file (either side)', () => {
  const b = good(); b.files.delete('.agents/runs/LC/questions/001.md');
  expectReported(good(), b, /missing-file .*questions\/001\.md/, ['missing-file']);
  expectReported(b, good(), /missing-file .*questions\/001\.md/, ['missing-file']);
});

test('planted: a mode bit', () => {
  const b = good(); const e = /** @type {any} */ (b.files.get('.agents/runs/LC/gates/001-QA.yaml')); e.mode = 0o755;
  expectReported(good(), b, /mode .*001-QA\.yaml: 644 against 755/, ['mode']);
});

test('planted: a changed hash next to a masked value (digest=, an unverified prev=, a binding)', () => {
  expectReported(good(), good(T0, { ledger: (/** @type {any[]} */ l) => { l[1].digest = 'd2'; } }), /content .*LEDGER\.log/);
  const b = good(T0, { ledger: (/** @type {any[]} */ l) => { l[2].prev = 'f'.repeat(64); } });
  expectReported(good(), b, /prev=f+ is not the SHA-256 of the previous line/, ['check', 'content']);
  const h = good(T0, { ledger: (/** @type {any[]} */ l) => { l[1].detail = `gates/001-QA.yaml@${'0'.repeat(64)}`; } });
  expectReported(good(), h, /binding gates\/001-QA\.yaml@0+ does not match its own side's file/, ['check']);
});

test('planted: a binding token or gate_record_sha256 that does not match its own side\'s file', () => {
  // the file changed after the ledger bound it (the token is a valid hash of the OLD content)
  const b = good(); b.files.set('.agents/runs/LC/gates/001-QA.yaml', { mode: 0o644, data: Buffer.from('gate: "QA"\nresult: "FAIL"\ntimestamp: "2027-01-15T08:00:02Z"\n') });
  expectReported(good(), b, /does not match its own side's file/, ['check']);
  const w = good(T0, { files: (/** @type {Record<string,string>} */ f) => { f['.agents/runs/LC/waivers/001-F1.yaml'] = f['.agents/runs/LC/waivers/001-F1.yaml'].replace(/[0-9a-f]{64}/, '1'.repeat(64)); } });
  expectReported(good(), w, /gate_record_sha256 does not match its own side's 001-QA\.yaml/, ['check']);
});

test('planted: approved_at earlier than requested_at', () => {
  const b = good(T0, { files: (/** @type {Record<string,string>} */ f) => { f['.agents/runs/LC/approvals/001-push.yaml'] = f['.agents/runs/LC/approvals/001-push.yaml'].replace(`approved_at: ${T0 + 5}`, `approved_at: ${T0 + 2}`); } });
  expectReported(good(), b, /approved_at \d+ is earlier than requested_at/, ['check']);
});

test('planted: consumed_at before approved_at', () => {
  const b = good(T0, { files: (/** @type {Record<string,string>} */ f) => { f['.agents/runs/LC/approvals/001-push.yaml'] = f['.agents/runs/LC/approvals/001-push.yaml'].replace(`consumed_at: ${T0 + 6}`, `consumed_at: ${T0 + 4}`); } });
  expectReported(good(), b, /consumed_at \d+ is before approved_at/, ['check']);
});

test('planted: a capture that is not newer than its request', () => {
  const b = good(T0, { files: (/** @type {Record<string,string>} */ f) => { f['.agents/runs/LC/approvals/001-push.yaml'] = f['.agents/runs/LC/approvals/001-push.yaml'].replace('capture_time: 4000000000', `capture_time: ${T0 + 3}`); } });
  expectReported(good(), b, /capture_time \d+ is not newer than requested_at/, ['check']);
});

test('planted: answered_epoch before asked_at, decided_at after its ledger line', () => {
  const a = good(T0, { files: (/** @type {Record<string,string>} */ f) => { f['.agents/runs/LC/questions/001.answer.md'] = f['.agents/runs/LC/questions/001.answer.md'].replace(`answered_epoch: ${T0 + 8}`, `answered_epoch: ${T0 + 6}`); } });
  expectReported(good(), a, /answered_epoch \d+ is before asked_at/, ['check']);
  const d = good(T0, { files: (/** @type {Record<string,string>} */ f) => { f['.agents/runs/LC/decisions/001-qa.decision'] = `runtime=claude\ndecided_at=${T0 + 30}\n`; } });
  expectReported(good(), d, /decided_at \d+ of 001-qa\.decision is after the epoch/, ['check']);
});

test('planted: a decreasing ledger epoch', () => {
  const b = good(T0, { ledger: (/** @type {any[]} */ l) => { l[2].epoch = T0 + 1; } });
  expectReported(good(), b, /epoch \d+ decreases/, ['check']);
});

test('planted: ts= and epoch= naming different seconds', () => {
  const b = good(T0, { ledger: (/** @type {any[]} */ l) => { l[1].ts = new Date((T0 + 3) * 1000).toISOString().slice(0, 19) + 'Z'; } });
  expectReported(good(), b, /ts=.* and epoch=\d+ name different seconds/, ['check']);
});

test('planted: a malformed ISO time (shape, impossible date, missing Z) and a malformed epoch', () => {
  for (const ts of ['2027-01-15 08:00:02', '2027-13-45T08:00:02Z', '2027-01-15T08:00:02', '2027-01-15T08:00:02.000Z']) {
    const b = good(T0, { ledger: (/** @type {any[]} */ l) => { l[1].ts = ts; } });
    expectReported(good(), b, /ts is not an ISO time|not a ledger line/, ['check']);
  }
  const e = good(T0, { ledger: (/** @type {any[]} */ l) => { l[1].epochText = '17e8'; } });
  expectReported(good(), e, /epoch is not digits/, ['check']);
  const r = good(T0, { files: (/** @type {Record<string,string>} */ f) => { f['.agents/runs/LC/gates/001-QA.yaml'] = 'timestamp: "yesterday"\n'; } });
  expectReported(good(), r, /timestamp is not an ISO time/, ['check']);
});

test('planted: a time outside the case window', () => {
  const b = toSide(synthSide(T0), [T0 + 20, T0 + 60]);
  expectReported(good(), b, /outside the case window/, ['check']);
});

test('planted: events in a different order on the two sides', () => {
  const swap = (/** @type {any[]} */ l) => { const [x, y] = [l[2], l[3]]; l[2] = { ...y, epoch: x.epoch }; l[3] = { ...x, epoch: y.epoch }; };
  expectReported(good(), good(T0, { ledger: swap }), /content .*LEDGER\.log/, ['content']);
});

test('planted: the masked times sort into a different order on the two sides (rank order)', () => {
  // side B: the request is made after the ledger line of the gate record, side A before it
  const b = toSide(synthSide(T0, { files: (/** @type {Record<string,string>} */ f) => {
    f['.agents/runs/LC/approvals/001-request-push.yaml'] = `kind: "push"\nbound: "abc"\nrequested_at: ${T0 + 1}\n`; } }), WIN);
  const d = compareSides(good(), b); assert.ok(kinds(d).includes('time-order'), formatDiffs(d));
  assert.deepEqual(rankConflicts([{ id: 'a', t: 1 }, { id: 'b', t: 1 }], [{ id: 'a', t: 5 }, { id: 'b', t: 3 }]), [], 'equal times never conflict');
});

test('process ids, temp dirs, nonces, durations, file metadata and archives are masked only in their field', () => {
  const mk = (/** @type {string} */ pid, /** @type {string} */ rnd, /** @type {string} */ nonce, /** @type {string} */ ms) => {
    const s = toSide(synthSide(T0), WIN, { tmpdir: '/var/tmp/x', outputs: [{ code: 0, stdout: `wrote /var/tmp/x/proofline-capture.${rnd}\n`, stderr: '' }] });
    const put = (/** @type {string} */ p, /** @type {string} */ c) => s.files.set(p, { mode: 0o644, data: Buffer.from(c) });
    put('.agents/local/locks/shared.lock/pid', `${pid}\n`); put('.agents/local/dispatch/m1', `role=x pid=${pid}\n`);
    put(`.agents/local/dispatch/nonce-${nonce}`, `${pid}\nrest\n`); put('.agents/runs/LC/HOOKS.log', `total_ms=${ms} max_ms=${ms} other=1\n`);
    put('.agents/local/fp-cache', `a/b|900|${ms}.5|${pid}|${ms}.6\tdeadbeef\n`); put('.agents/local/deliver/LC/PR.md', `nonce: ${nonce}\nkeep\n`);
    put(`.agents/local/intake/17000000${ms}000-${pid}.json`, '{}');
    return s;
  };
  const d = compareSides(mk('123', 'aB3xYz', 'aaaa1111', '41'), mk('98765', 'Qq9Zz1', 'bbbb2222', '999'));
  assert.equal(d.length, 0, formatDiffs(d));
  // the same masks do not hide a difference next to them
  const x = mk('123', 'aB3xYz', 'aaaa1111', '41'); x.files.set('.agents/runs/LC/HOOKS.log', { mode: 0o644, data: Buffer.from('total_ms=41 max_ms=41 other=2\n') });
  expectReported(mk('123', 'aB3xYz', 'aaaa1111', '41'), x, /content .*HOOKS\.log/);
  const y = mk('123', 'aB3xYz', 'aaaa1111', '41'); y.files.set('.agents/local/dispatch/m1', { mode: 0o644, data: Buffer.from('role=y pid=5\n') });
  expectReported(mk('123', 'aB3xYz', 'aaaa1111', '41'), y, /content .*dispatch\/m1/);
  const z = mk('123', 'aB3xYz', 'aaaa1111', '41'); z.outputs[0].stdout = 'wrote /var/tmp/x/other.aB3xYz\n';
  expectReported(mk('123', 'aB3xYz', 'aaaa1111', '41'), z, /stdout step 0/);
});

test('archives compare by member list and bytes, not by gzip bytes', async () => {
  const { gzipSync } = await import('node:zlib');
  const tar = (/** @type {string} */ name, /** @type {string} */ body) => {
    const h = Buffer.alloc(512); h.write(name, 0); h.write('0000644\0', 100); h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h[156] = 48;
    return Buffer.concat([h, Buffer.from(body), Buffer.alloc(512 - (body.length % 512 || 512)), Buffer.alloc(1024)]);
  };
  const side = (/** @type {Buffer} */ gz, /** @type {string} */ stamp) => { const s = toSide(synthSide(T0), WIN); s.files.set(`.agents/local/archive/LC/LC-${stamp}.tar.gz`, { mode: 0o644, data: gz }); return s; };
  const a = side(gzipSync(tar('LC/RUN.yaml', 'x: 1\n'), { level: 1 }), '20270115T080000Z'); const b = side(gzipSync(tar('LC/RUN.yaml', 'x: 1\n'), { level: 9 }), '20270115T080009Z');
  assert.equal(compareSides(a, b).length, 0);
  expectReported(a, side(gzipSync(tar('LC/RUN.yaml', 'x: 2\n')), '20270115T080009Z'), /content .*tar\.gz/);
  assert.match(tarMembers(gzipSync(tar('a', 'hi'))), /^0\ta\t2\t[0-9a-f]{64}$/m);
  assert.equal(sha256('a').length, 64); assert.equal(isoToEpoch('2027-01-15T08:00:02Z'), Date.UTC(2027, 0, 15, 8, 0, 2) / 1000);
});

test('fields the closed list does not name are masked only on request, and a request still checks them', () => {
  assert.ok(PENDING_APPROVAL.length >= 4, 'the fields waiting for the maintainer are listed in one place');
  const mk = (/** @type {number} */ t, /** @type {number} */ epoch = t + 2) => toSide(synthSide(t, { files: (/** @type {Record<string,string>} */ f) => {
    f['.agents/runs/LC/gates/001-QA.yaml'] += `epoch: ${epoch}\n`; } }), [t - 5, t + 60]);
  // by default the closed list does not hide it: the two correct runs differ in the epoch line
  assert.ok(compareSides(mk(T0), mk(T0 + 7)).length > 0);
  // requested: masked, as long as the epoch names the second of the record's timestamp
  const d = compareSides(mk(T0), mk(T0 + 7), ['A', 'B'], { pendingApproval: true });
  assert.ok(!d.some((x) => x.kind === 'content' && /001-QA/.test(x.where)), formatDiffs(d));
  const bad = compareSides(mk(T0), mk(T0 + 7, T0 + 12), ['A', 'B'], { pendingApproval: true });
  assert.match(formatDiffs(bad), /timestamp and epoch=\d+ name different seconds/);
});
