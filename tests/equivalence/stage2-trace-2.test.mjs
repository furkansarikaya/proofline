// @ts-check
// Trace replay of the Stage 2 cases, part 2 of 3 (the fixture states of BUCKETS[1]); see stage2-trace-lib.mjs.
import { BUCKETS } from './cases/stage2-commands.mjs';
import { registerTraceCases } from './stage2-trace-lib.mjs';

registerTraceCases(BUCKETS[1]);
