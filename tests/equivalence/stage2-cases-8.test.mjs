// @ts-check
// Stage 2 scenario cases, part 8 of 8 (the fixture states of BUCKETS[7]): each case runs once per engine and the rig compares them.
// Until a command is moved both runs execute the shell, so this proves the rig and the cases; afterwards it is the equivalence proof.
import { BUCKETS, stage2Cases } from './cases/stage2-commands.mjs';
import { registerCases } from './cases-lib.mjs';

registerCases(stage2Cases(BUCKETS[7]));
