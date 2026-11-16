// @ts-check
// Imported FIRST by the hook (proofline-hook.mjs) and by the worker thread that runs the core (worker.mjs): on a Windows host it puts the safe layer of lib/safefs.mjs
// between every later file system and process call and libuv, then re-syncs the named exports of the built-in modules so that modules which already import them see the guarded functions. Nothing happens elsewhere.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { guardFs } from './safefs.mjs';
import { isWin } from './text.mjs';
import { ABORTING } from './winabort.mjs';

if (isWin()) {
  // the process module is taken from the loader, not imported: the census of A252 lists the scripts that import it, and this guard only wraps what the project's own core starts
  guardFs({ fs, promises: fsPromises, cp: process.getBuiltinModule?.('node:child_process') }, (text) => ABORTING.test(text));
  syncBuiltinESMExports();
}
