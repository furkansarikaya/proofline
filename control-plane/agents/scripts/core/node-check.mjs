// @ts-check
// Evaluated first by proofline-core.mjs: an older Node than 22.13 stops here with exit 127 (like a missing `node`), before any other
// module is evaluated, so that a guard that needs a moved command can deny on the exit status.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`proofline: Node 22.13 or newer is required (found ${process.versions.node}); check that node on PATH is 22.13 or newer\n`);
  process.exit(127);
}
