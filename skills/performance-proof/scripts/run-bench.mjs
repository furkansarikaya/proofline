#!/usr/bin/env node
// Runs one benchmark command N times in a base and a change directory (two git worktrees), interleaved in
// ABBA order (pair 1 base first, pair 2 change first, ...) so slow drift of the machine hits both sides alike.
// Writes into --out: base.csv and change.csv (run,side,value,unit,exit,started_at; value = wall time in ms),
// environment.txt (key=value: OS, CPU count, load average before and after, command, warmup runs, runs,
// order, timer, revisions, timestamps, runtime versions) and bench.log (the command's output).
// Wall time comes from the monotonic clock of this process (timer=hrtime); the cost of starting the command is inside every
// sample on both sides alike (a constant offset, not a difference).
// Usage: node run-bench.mjs --base DIR --change DIR --runs N [--warmup W] [--timeout S] --out DIR -- CMD [ARG...]
//   --warmup W   unrecorded runs per side before measuring (default 1)
//   --timeout S  per-run limit in seconds, at least 30 (default 300); a timed-out run is a failed run: its process group gets
//                TERM at the limit and KILL 5 seconds later, and the run is recorded with exit 143 (or 137)
// Exit: 0 every run exited 0; 1 a run failed (it is recorded with its exit code and is not a sample);
// 2 usage error. Installs nothing. The commands that print a runtime version come from references/ecosystems.json (this skill's own copy).
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osc, availableParallelism, cpus, loadavg, machine, release, tmpdir, type as osType } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadEcosystems } from "./ecosystems.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const POSIX = process.platform !== "win32";

export class Usage extends Error {}
const die = (msg) => { throw new Usage(`run-bench: ${msg}`); };
const isNum = (v) => /^[0-9]+$/.test(v ?? "");
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export function parseArgs(argv) {
  const o = { base: "", change: "", runs: "", warmup: "1", timeout: "300", out: "", cmd: [], help: false };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { i++; break; }
    if (["--base", "--change", "--runs", "--warmup", "--timeout", "--out"].includes(a)) {
      if (i + 1 >= argv.length) die(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else if (a === "-h" || a === "--help") { o.help = true; return o; }
    else die(`unknown argument: ${a}`);
  }
  o.cmd = argv.slice(i);
  if (o.cmd.length === 0) die("no command after --");
  const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
  if (!isDir(o.base)) die(`--base is not a directory: ${o.base}`);
  if (!isDir(o.change)) die(`--change is not a directory: ${o.change}`);
  if (o.out === "") die("--out is required");
  if (!isNum(o.runs) || Number(o.runs) < 1) die("--runs must be an integer >= 1");
  if (!isNum(o.warmup)) die("--warmup must be an integer >= 0");
  if (!isNum(o.timeout) || Number(o.timeout) < 30) die("--timeout must be an integer >= 30 (seconds)");
  return o;
}

let current = null; // the child that runs now (for a signal sent to this process)
const killGroup = (pid, sig) => { try { if (POSIX) process.kill(-pid, sig); else process.kill(pid, sig); } catch { /* gone */ } };

/**
 * Runs argv in cwd with its output appended to logFile. The command is a child in its own process group: at the limit the whole
 * group gets TERM and, graceMs later, KILL. Resolves { rc, ms }; rc is 128+signal for a signal, 127 when the program does not exist.
 */
export function runCommand({ argv, cwd, logFile, label, timeoutMs, graceMs = 5000 }) {
  appendFileSync(logFile, `== ${label}\n`);
  const fd = openSync(logFile, "a");
  const t0 = process.hrtime.bigint();
  return new Promise((done) => {
    let settled = false, timer = null, grace = null;
    const finish = (rc) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(grace); current = null;
      try { closeSync(fd); } catch { /* closed */ }
      done({ rc, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    };
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", fd, fd], detached: POSIX, windowsHide: true });
    current = child;
    child.on("error", (e) => {
      try { appendFileSync(logFile, `${argv[0]}: ${e.code === "ENOENT" ? "not found" : e.message}\n`); } catch { /* log gone */ }
      finish(e.code === "EACCES" ? 126 : 127);
    });
    child.on("close", (code, signal) => finish(code ?? 128 + (osc.signals[signal] ?? 0)));
    timer = setTimeout(() => {
      killGroup(child.pid, "SIGTERM");
      grace = setTimeout(() => killGroup(child.pid, "SIGKILL"), graceMs);
    }, timeoutMs);
  });
}

const git = (dir, args) => { const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); return r.status === 0 ? r.stdout : null; };
function rev(dir) {
  let r = (git(dir, ["rev-parse", "HEAD"]) ?? "unknown").trim() || "unknown";
  if (r !== "unknown" && (git(dir, ["status", "--porcelain"]) ?? "").trim() !== "") r += "+uncommitted";
  return r;
}
function loadAvg() {
  if (!POSIX) return "unknown";
  return loadavg().map((v) => v.toFixed(2)).join(" ");
}

function onPath(name) {
  for (const d of (process.env.PATH ?? "").split(POSIX ? ":" : ";")) { if (d === "") continue; try { if (statSync(join(d, name)).isFile()) return true; } catch { /* next */ } }
  return false;
}
/** stdout and stderr of a program as one stream in the order it wrote them (`2>&1`); null when it cannot be started. */
function combinedOutput(program, args) {
  const dir = mkdtempSync(join(tmpdir(), "proofline-ver-"));
  const file = join(dir, "out");
  const fd = openSync(file, "w");
  try {
    const r = spawnSync(program, args, { stdio: ["ignore", fd, fd], timeout: 30000, windowsHide: true });
    return r.error ? null : readFileSync(file, "utf8");
  } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
}
/** tool_version.<runtime>=<first line> for every runtime of the definition whose version command exists here. */
function toolVersions() {
  let data; try { data = loadEcosystems(join(HERE, "..", "references", "ecosystems.json")); } catch { return []; }
  const out = [];
  for (const e of data.ecosystems) {
    const name = e.runtime?.name; if (!name) continue;
    for (const c of e.runtime.local?.commands ?? []) {
      const argv = c.split(/\s+/).filter(Boolean);
      if (argv.length === 0 || !onPath(argv[0])) continue;
      const text = combinedOutput(argv[0], argv.slice(1));
      if (text === null) continue;
      out.push(`tool_version.${name}=${text.split("\n")[0]}`);
      break;
    }
  }
  return out;
}

export async function bench(o) {
  mkdirSync(o.out, { recursive: true });
  const base = resolve(o.base), change = resolve(o.change);
  const runs = Number(o.runs), warmup = Number(o.warmup), timeoutMs = Number(o.timeout) * 1000;
  const envFile = join(o.out, "environment.txt");
  const cpu = (() => { try { return availableParallelism(); } catch { return cpus().length || "unknown"; } })();
  writeFileSync(envFile, [
    `os=${osType()} ${release()} ${machine()}`, `cpu_count=${cpu}`, `load_avg_before=${loadAvg()}`, `command=${o.cmd.join(" ")}`,
    `warmup_runs=${warmup}`, `runs=${runs}`, "order=interleaved", "timer=hrtime", `timeout_s=${o.timeout}`,
    `base_dir=${base}`, `base_rev=${rev(base)}`, `change_dir=${change}`, `change_rev=${rev(change)}`,
    ...toolVersions(), `started_at=${stamp()}`, "",
  ].join("\n"));
  const log = join(o.out, "bench.log");
  writeFileSync(log, "");
  for (const s of ["base", "change"]) writeFileSync(join(o.out, `${s}.csv`), "run,side,value,unit,exit,started_at\n");
  const dirOf = (s) => (s === "base" ? base : change);
  let failed = false;
  for (let i = 1; i <= warmup; i++) {
    for (const s of ["base", "change"]) {
      const { rc } = await runCommand({ argv: o.cmd, cwd: dirOf(s), logFile: log, label: `warmup ${i} ${s}`, timeoutMs });
      if (rc !== 0) die(`warmup run ${i} on ${s} exited ${rc} (see ${log})`);
    }
  }
  for (let i = 1; i <= runs; i++) {
    for (const s of i % 2 === 1 ? ["base", "change"] : ["change", "base"]) {
      const at = stamp();
      const { rc, ms } = await runCommand({ argv: o.cmd, cwd: dirOf(s), logFile: log, label: `run ${i} ${s}`, timeoutMs });
      if (rc !== 0) failed = true;
      appendFileSync(join(o.out, `${s}.csv`), `${i},${s},${ms.toFixed(3)},ms,${rc},${at}\n`);
    }
  }
  appendFileSync(envFile, `load_avg_after=${loadAvg()}\nfinished_at=${stamp()}\n`);
  if (failed) { process.stderr.write(`run-bench: a run failed; failed runs are not samples (see ${log})\n`); return 1; }
  process.stdout.write(`run-bench: ${runs} runs per side in ${o.out}\n`);
  return 0;
}

async function main(argv) {
  try {
    const o = parseArgs(argv);
    if (o.help) { process.stdout.write(`${readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")}\n`); return 0; }
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { if (current) killGroup(current.pid, "SIGTERM"); process.exit(128 + osc.signals[sig]); });
    return await bench(o);
  } catch (e) {
    if (e instanceof Usage) { process.stderr.write(`${e.message}\n`); return 2; }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
