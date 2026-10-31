// @ts-check
// The scenario cases of `timeouts` and `hook-timeouts` (about three seconds per call on the shell): a file of their own, run in parallel.
import { movedCommandCases } from './cases/moved-commands.mjs';
import { isSlow, registerCases } from './cases-lib.mjs';

registerCases(movedCommandCases().filter(isSlow), { heavy: true });
