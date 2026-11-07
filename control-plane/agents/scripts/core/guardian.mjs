// @ts-check
// The guardian of a dispatched worker (A226): `node guardian.mjs <dispatcher pid> <orphan spec JSON or -> <program> [args...]`, started by proc.startLeader as the
// leader of the worker's process group. It starts the real worker in that group and kills the group when the dispatcher is gone, even by SIGKILL (the lead's own tool
// timeout), which runs no handler. When the dispatcher held an implementer's write window it also hands a closer (`node guardian.mjs --closer <pgid> <spec>`, the same
// script, a process of its own) the job of closing that window once the group is dead (a user decision of 2026-11-07). The logic is runGuardian and runCloser in proc.mjs,
// the only module that starts processes.
import { runCloser, runGuardian } from './proc.mjs';

if (process.argv[2] === '--closer') runCloser(process.argv.slice(3));
else runGuardian(process.argv.slice(2));
