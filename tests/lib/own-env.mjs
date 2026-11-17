// @ts-check
// A320: a test that runs core code in its own process stands in for the entry point of the product: it hands proc.mjs the process environment, as
// proflinecli.mjs, proofline-core.mjs, guardian.mjs and the hook do (A315). Import it for the side effect, before the first call that can spawn.
import { setOwnEnv } from '../../control-plane/agents/scripts/core/proc.mjs';

setOwnEnv(process.env);
