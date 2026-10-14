// Aborting measure.mjs mid-run leaves no browser process and no profile folder behind.
//   node abort-check.mjs <built fixture dir> [--no-sandbox]
// Starts a measurement of a page whose ready selector never appears (slow), waits until the browser runs,
// sends SIGTERM (then, in a second run, SIGINT) and checks the exit code, the processes and the temp folder.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MEASURE = fileURLToPath(new URL("../../skills/visual-proof/scripts/measure.mjs", import.meta.url));
const [fx, ...extra] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browsers = (dir) => execFileSync("ps", ["-axo", "command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(dir));

async function abort(signal, code) {
  const tmp = mkdtempSync(join(tmpdir(), "visual-proof-abort-"));
  try {
    const cfg = join(tmp, "slow.json");
    writeFileSync(cfg, JSON.stringify({
      class: "STANDARD", base_url: `file://${fx}/app/`,
      viewports: [{ name: "phone", width: 360, height: 740 }, { name: "desktop", width: 1280, height: 800 }],
      screens: [{ id: "slow", path: "index.html", states: [{ name: "never", ready: "#never-rendered" }] }],
    }));
    const child = spawn(process.execPath, [MEASURE, "--config", cfg, "--out", join(tmp, "out"), ...extra], { env: { ...process.env, TMPDIR: tmp }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", done = null;
    child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise((ok) => child.once("exit", (c, s) => { done = c ?? s; ok(done); }));
    // A cold browser start under load can take long: wait up to 90 s, and say why when the child ends first.
    const until = Date.now() + 90000;
    while (!(readdirSync(tmp).some((n) => n.startsWith("visual-proof-profile-")) && browsers(tmp).length)) {
      if (done !== null) throw new Error(`${signal}: measure.mjs exited ${done} before the browser ran: ${stderr.slice(-400)}`);
      if (Date.now() > until) { child.kill("SIGKILL"); await exited; throw Object.assign(new Error(`${signal}: the browser never started within 90 s: ${stderr.slice(-400)}`), { retry: true }); }
      await sleep(100);
    }
    await sleep(500);
    child.kill(signal);
    const got = await exited;
    if (got !== code) throw new Error(`${signal}: exit ${got}, expected ${code}`);
    await sleep(1000);
    const left = browsers(tmp), dirs = readdirSync(tmp).filter((n) => n.startsWith("visual-proof-profile-"));
    if (left.length || dirs.length) throw new Error(`${signal}: left ${left.length} browser processes and ${dirs.length} profile folders`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// One retry for a browser that did not start in time (load, not a leak); every other failure is final.
const once = async (signal, code) => {
  try { await abort(signal, code); } catch (e) { if (!e.retry) throw e; console.error(`abort-check: ${e.message}; retrying once`); await abort(signal, code); }
};
await once("SIGTERM", 143);
await once("SIGINT", 130);
console.log("abort-check: no browser process or profile left after SIGTERM and SIGINT");
