// @ts-check
// A command for the process-group test of build-record (issue 266, A277 P2d): it starts a background process that connects to the local socket of the test, waits until that
// process says `up` over its standard output, and then exits 0 leaving it running. The kernel closes the connection when the background process ends, which is the event the
// test waits for (no poll of the process table). Usage: node group-holder.mjs <socket>
import { spawn } from 'node:child_process';

const [sock] = process.argv.slice(2);
const bg = spawn(process.execPath, ['-e', "require('net').connect(process.argv[1]).on('connect', () => process.stdout.write('up\\n'))", sock], { stdio: ['ignore', 'pipe', 'ignore'] });
bg.stdout.once('data', () => { bg.unref(); bg.stdout.destroy(); process.exit(0); });
