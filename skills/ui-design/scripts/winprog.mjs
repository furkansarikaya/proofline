// The program a child process is started as (Windows port W11, A270). One copy per skill, byte-identical (tests/ci/skill-child-process.test.mjs): a skill is a
// standalone install and shares no library. POSIX: the name is returned unchanged. Windows: libuv searches the working folder before PATH for a bare name, so a
// `git.exe` planted at the root of a cloned project would run. A bare name is resolved here through PATH and PATHEXT: drive-absolute entries only, a real `.exe` or
// `.com`, not inside the child's working folder or the current one; a `.cmd`/`.bat` shim (BatBadBut), a name that is not found or anything unsure is refused (fail
// closed: `programOf` throws). A name that has a path in it is the caller's choice and is left alone. Same rules as `resolveProgram` in the control plane's core/proc.mjs.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

const win = path.win32;
const lower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const isDrive = (p) => /^[A-Za-z]:[\\/]/.test(p) && win.isAbsolute(p);
const RUN = [".exe", ".com"], SHIM = [".cmd", ".bat"];

function names(name, pathext) {
  const own = lower(win.extname(name));
  if (RUN.includes(own) || SHIM.includes(own)) return [{ file: name, ext: own }];
  const ours = [...new Set((pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => lower(e.trim())))].filter((e) => RUN.includes(e) || SHIM.includes(e));
  return [...ours.filter((e) => RUN.includes(e)), ...ours.filter((e) => SHIM.includes(e))].map((e) => ({ file: `${name}${e}`, ext: e }));
}

/** A `refusedDir` predicate: true for a folder that is, or is under, one of DIRS (case-insensitive, `\` and `/` alike, in the given and the real spelling). */
export function refusedIn(dirs, expand) {
  const norm = (x) => lower(x.replace(/\//g, "\\").replace(/\\+$/, ""));
  const safe = (x) => { try { return expand(x); } catch { return x; } };
  const roots = [...new Set(dirs.filter((d) => d !== "").flatMap((d) => [norm(d), norm(safe(d))]))];
  return (d) => [norm(d), norm(safe(d))].some((n) => roots.some((r) => n === r || n.startsWith(`${r}\\`)));
}

/** @returns {{ program: string } | { refused: string }} PLATFORM and FSX are injectable for the tests. */
export function resolveProgram(program, env = process.env, cwd, platform = process.platform, fsx) {
  if (platform !== "win32" || /[\\/:]/.test(program)) return { program };
  const here = [cwd, process.cwd()].filter((x) => typeof x === "string" && x !== "");
  const fs = fsx ?? { isFile: (f) => statSync(f).isFile(), real: (f) => realpathSync.native(f), refusedDir: refusedIn(here, (f) => realpathSync.native(f)) };
  const no = `proofline: ${program} was not found on PATH outside the working folder as a real .exe; not started`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(program) || program.includes("..")) return { refused: no };
  for (const entry of (env.PATH ?? env.Path ?? "").split(";")) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!isDrive(dir)) continue;
    let shim = null;
    for (const { file, ext } of names(program, env.PATHEXT)) {
      const full = win.join(dir, file);
      let found = false;
      try { found = fs.isFile(full); } catch { found = false; }
      if (!found) continue;
      if (SHIM.includes(ext)) { shim ??= full; continue; }
      let real;
      try { real = fs.real(full); } catch { return { refused: no }; }
      if (!isDrive(real) || !RUN.includes(lower(win.extname(real)))) return { refused: no };
      if (fs.refusedDir(win.dirname(real)) || fs.refusedDir(dir)) return { refused: no };
      return { program: real };
    }
    if (shim !== null) return { refused: `proofline: ${program} is only a .cmd/.bat shim at ${shim}; a shim is not run (install the real ${program}.exe ahead of it on PATH)` };
  }
  return { refused: no };
}

/** The program to start for NAME (a throw when it is refused, so a caller's `try` around the spawn sees a failed start). @param {string} name @param {string} [cwd] */
export function programOf(name, cwd) {
  const r = resolveProgram(name, process.env, cwd);
  if ("refused" in r) throw new Error(r.refused);
  return r.program;
}
