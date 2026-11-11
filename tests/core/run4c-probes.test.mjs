// @ts-check
// Stage 4, package 4C: the capability probes that refuse an UNSUPPORTED result (A102, A173) as absolute Node tests (A214). The shell suite had a test seam
// (PROOFLINE_PROBE_ROOT) that replaced PATH and the application folders; there is none any more (D14): a test builds a real folder of executables and
// gives it as the PATH, and the macOS application folder is the host's own, so the cases that need "no browser" are host-aware.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { probePerformance, probeVisual } from '../../control-plane/agents/scripts/core/probes.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { project } from './legacy-lib.mjs';

const HOST_BROWSER = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Brave Browser.app/Contents/MacOS/Brave Browser']
  .some((a) => existsSync(`/Applications/${a}`));

/** @param {string} d @param {string} path */
const ctxOf = (d, path) => new Context({ env: cleanEnv({ PATH: path }), cwd: d, stdout: { write: () => true }, stderr: { write: () => true } }, `${d}/.agents/scripts/agent.sh`);
const bin = () => tempDir('probe-bin-');
/** A PATH with git and the system tools but no browser. */
const sys = () => `${bin()}:/usr/bin:/bin`;
/** @param {string} dir @param {string} name @param {number} mode */
const exe = (dir, name, mode = 0o755) => { writeFileSync(`${dir}/${name}`, '#!/bin/sh\n'); chmodSync(`${dir}/${name}`, mode); };

test('probeVisual: a Chromium-family executable on PATH is a capability; a directory, a file without the execute bit and another name are not', () => {
  const d = project('new_repo');
  const b = bin();
  exe(b, 'chromium-browser');
  assert.equal(probeVisual(ctxOf(d, b)), `browser ${b}/chromium-browser`);
  const e = bin();
  exe(e, 'google-chrome', 0o644);
  mkdirSync(`${e}/chromium`);
  exe(e, 'firefox');
  const got = probeVisual(ctxOf(d, e));
  if (HOST_BROWSER) assert.match(got, /^browser \/Applications\//); else assert.equal(got, '');
  const f = bin();
  exe(f, 'brave-browser');
  assert.equal(probeVisual(ctxOf(d, `:${f}:`)), `browser ${f}/brave-browser`, 'empty PATH entries are skipped, the others are searched');
});

test('probeVisual: an installed project browser-test dependency (from the ecosystem data) is a capability; a declared but missing one is not', () => {
  if (HOST_BROWSER) return; // the host browser is found first
  const d = project('new_repo');
  const b = bin();
  writeFileSync(`${d}/package.json`, '{"devDependencies":{"playwright":"1"}}\n');
  assert.equal(probeVisual(ctxOf(d, b)), '', 'declared but not installed');
  mkdirSync(`${d}/node_modules/playwright`, { recursive: true });
  assert.equal(probeVisual(ctxOf(d, b)), 'project browser-test dependency playwright (package.json, node_modules)');
});

/** @param {string} d */
const commit = (d) => spawnSync('sh', ['-c', 'git add -A && git commit -qm probe'], { cwd: d, env: cleanEnv({}) });

test('probePerformance: a tracked bench script, a Makefile target, a benchmark directory, a config file and a content marker are capabilities; nothing is none', () => {
  const none = project('new_repo');
  commit(none);
  assert.equal(probePerformance(ctxOf(none, sys())), '');

  const s = project('new_repo');
  writeFileSync(`${s}/package.json`, '{"name":"x","scripts":{"test":"t","benchmark":"node b.js"}}\n');
  commit(s);
  assert.equal(probePerformance(ctxOf(s, sys())), 'package.json script bench/benchmark/perf*');

  const m = project('new_repo');
  writeFileSync(`${m}/Makefile`, 'all:\n\techo\nbench:\n\techo b\n');
  commit(m);
  assert.equal(probePerformance(ctxOf(m, sys())), 'Makefile target bench/benchmark');

  const g = project('new_repo');
  writeFileSync(`${g}/lookup_test.go`, 'package x\nfunc BenchmarkLookup(b *testing.B) {}\n');
  commit(g);
  assert.match(probePerformance(ctxOf(g, sys())), /^Go func Benchmark in \*_test\.go \(lookup_test\.go\)$/);

  const u = project('new_repo');
  writeFileSync(`${u}/package.json`, '{"name":"x","scripts":{"test":"t"}}\n');
  commit(u);
  assert.equal(probePerformance(ctxOf(u, sys())), '', 'a package.json without a bench script');

  const untracked = project('new_repo');
  writeFileSync(`${untracked}/Makefile`, 'bench:\n\techo b\n');
  assert.equal(probePerformance(ctxOf(untracked, sys())), '', 'without a tracked file nothing is reported (tracked files only)');
  void symlinkSync;
});
