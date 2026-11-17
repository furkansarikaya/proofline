// @ts-check
// A core command run on a worker thread, so that the hook can stop WAITING for it when its time budget ends (a command in this very process cannot
// be interrupted). The hook never gives the worker anything a command line, a file or the environment could set: workerData is built by the hook.
import { parentPort, workerData } from 'node:worker_threads';

const { coreUrl, argv, io: given, cancel } = workerData;
const core = await import(coreUrl);
// this thread has its own copy of the core's proc.mjs (the same module the core imported): hand it the environment like every entry point (A315; optional, an older core has none)
(await import(new URL('./core/proc.mjs', coreUrl).href).catch(() => null))?.setOwnEnv?.(process.env);
/** @type {Buffer[]} */ const out = [];
/** @type {Buffer[]} */ const err = [];
const io = { ...given, cancel: new Int32Array(cancel), stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) } };
const status = core.run(argv, io);
parentPort?.postMessage({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
