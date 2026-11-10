// @ts-check
// The states `next` is recorded on in tests/core/golden/next-order.txt, in lifecycle order (the file was recorded from the shell of agent.sh by a recorder that A244 retired with the shell).
export const NEXT_STATES = ['intake-unclassified', 'intake-classified', 'intake-branched', 'intake-planned', 'gates-standalone', 'gates-frozen', 'gates-implemented', 'gates-failed'];
