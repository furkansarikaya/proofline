// @ts-check
// Stage 3 scenario cases: each runs once per engine and the rig compares stdout, stderr, exit codes, files and modes.
import { registerCases } from './cases-lib.mjs';
import { stage3Cases } from './cases/stage3-commands.mjs';

registerCases(stage3Cases());
