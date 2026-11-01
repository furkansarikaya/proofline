// @ts-check
// Records the golden capture fixtures from the OLD shell hook (adapters/claude/hooks/proofline-hook.sh, event `prompt`), the specification:
//   node tests/golden/capture/record.mjs
// For every prompt of corpus.mjs the hook runs in a throwaway project (a PATH shim fixes `date`, so the time is the recorded one; the pid of the
// hook is replaced by the recorded one in the file name) and the bytes it wrote are stored in <name>/: event.json, capture.json, intake.json,
// history.txt (the files the hook wrote; a prompt that must be ignored has only intake.json) and files.json (their names). Run by hand, review the diff.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { baseEnv, installMinimal, repoRoot } from '../../equivalence/fixture.mjs';
import { CORPUS, CWD, MS, PID, SECONDS, eventOf } from './corpus.mjs';

const HERE = import.meta.dirname;
const HOOK = path.join(repoRoot, 'adapters/claude/hooks/proofline-hook.sh');

const base = mkdtempSync(path.join(tmpdir(), 'pl-capture-'));
try {
  const template = path.join(base, 'template');
  mkdirSync(template);
  installMinimal(template);
  const shim = path.join(base, 'shim');
  mkdirSync(shim);
  const real = spawnSync('sh', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(path.join(shim, 'date'), `#!/bin/sh\ncase "$1" in +%s%N) echo ${MS}000000 ;; +%s) echo ${SECONDS} ;; *) exec ${real} "$@" ;; esac\n`);
  chmodSync(path.join(shim, 'date'), 0o755);
  for (const c of CORPUS) {
    const dir = path.join(base, c.name);
    cpSync(template, dir, { recursive: true });
    const env = baseEnv(dir, { PATH: `${shim}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: dir });
    delete env.PROOFLINE_NO_TTY;
    const event = eventOf(c.prompt);
    const r = spawnSync('sh', [HOOK, 'prompt', 'claude'], { cwd: dir, env, input: Buffer.from(event, 'utf8') });
    if (r.status !== 0) throw new Error(`${c.name}: the hook exited ${r.status}: ${r.stderr}`);
    const out = path.join(HERE, c.name);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'event.json'), event);
    const local = path.join(dir, '.agents/local/prompts');
    /** @type {Record<string, string>} */ const files = {};
    const intake = readdirSync(path.join(local, 'intake'));
    if (intake.length !== 1) throw new Error(`${c.name}: ${intake.length} intake files`);
    files.intake = intake[0].replace(/-\d+\.json$/, `-${PID}.json`);
    writeFileSync(path.join(out, 'intake.json'), readFileSync(path.join(local, 'intake', intake[0])));
    if (!c.ignored) {
      const cap = readdirSync(local).filter((n) => n.endsWith('.json'));
      if (cap.length !== 1) throw new Error(`${c.name}: capture files ${cap}`);
      files.capture = cap[0];
      writeFileSync(path.join(out, 'capture.json'), readFileSync(path.join(local, cap[0])));
      const hist = readdirSync(path.join(local, 'history'));
      if (hist.length !== 1) throw new Error(`${c.name}: history files ${hist}`);
      files.history = hist[0];
      writeFileSync(path.join(out, 'history.txt'), readFileSync(path.join(local, 'history', hist[0])));
    } else if (existsSync(path.join(local, 'history')) || readdirSync(local).some((n) => n.endsWith('.json'))) throw new Error(`${c.name}: an ignored prompt left a capture`);
    writeFileSync(path.join(out, 'files.json'), `${JSON.stringify(files, null, 2)}\n`);
  }
  writeFileSync(path.join(HERE, 'README'), `Recorded from adapters/claude/hooks/proofline-hook.sh (event prompt) by record.mjs; the cwd of the event is ${CWD}.\n`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
