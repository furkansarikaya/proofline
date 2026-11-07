// @ts-check
// The guardian of a dispatched worker (A226): `node guardian.mjs <dispatcher pid> <program> [args...]`, started by proc.startLeader as the leader of the worker's
// process group. It starts the real worker in that group and kills the group when the dispatcher is gone, even by SIGKILL (the lead's own tool timeout), which runs
// no handler. The logic is runGuardian in proc.mjs, the only module that starts processes.
import { runGuardian } from './proc.mjs';

runGuardian(process.argv.slice(2));
