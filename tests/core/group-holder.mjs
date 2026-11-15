// @ts-check
// A command for the process-group tests of build-record (issue 266, A277 P2d): it starts a background process that connects to the local socket of the test and says `up` over
// its standard output once connected; the kernel closes that connection when the background process ends, which is the event the test waits for (no poll of the process table).
//   node group-holder.mjs <socket> hold   stay in the foreground until the product stops the command at its limit
//   node group-holder.mjs <socket> exit   leave at once (exit 0) with the background process still up
import { spawn } from 'node:child_process';

const [sock, mode] = process.argv.slice(2);
const bg = spawn(process.execPath, ['-e', "require('net').connect(process.argv[1]).on('connect', () => process.stdout.write('up\\n'))", sock], { stdio: ['ignore', 'pipe', 'ignore'] });
bg.stdout.once('data', () => {
  if (mode === 'exit') { bg.unref(); bg.stdout.destroy(); process.exit(0); }
});
