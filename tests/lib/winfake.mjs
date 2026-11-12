// @ts-check
// A fake platform tool (gh, glab, az) that Windows accepts (A263, Windows port W4). On Windows the platform resolver runs only a real `.exe` or `.com` found through PATHEXT outside the
// project, the working folder and the temporary folders (A252, by design): a shell-script `gh` is refused. So a test that needs a fake tool there builds a REAL `.exe` once per process
// from a few lines of C# with the compiler every Windows has (`csc.exe` of .NET Framework 4, under %WINDIR%): the program starts `node <script>` with its own arguments and returns the
// exit status. The product resolver, its refusal list and its spawn are exercised unchanged; nothing is injected or weakened. Off Windows nothing here is used.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE = `using System; using System.Diagnostics; using System.IO; using System.Text;
class P {
  static string Q(string a) {
    if (a.Length > 0 && a.IndexOfAny(new char[] {' ', '\\t', '"'}) < 0) return a;
    var b = new StringBuilder("\\""); int bs = 0;
    foreach (char c in a) {
      if (c == '\\\\') { bs++; continue; }
      if (c == '"') { b.Append('\\\\', bs * 2 + 1); b.Append('"'); bs = 0; continue; }
      b.Append('\\\\', bs); bs = 0; b.Append(c);
    }
    b.Append('\\\\', bs * 2); b.Append('"'); return b.ToString();
  }
  static int Main(string[] args) {
    string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string[] cfg = File.ReadAllLines(self + ".cfg");
    var sb = new StringBuilder(Q(cfg[1]));
    foreach (string a in args) sb.Append(' ').Append(Q(a));
    var psi = new ProcessStartInfo(cfg[0], sb.ToString()) { UseShellExecute = false };
    using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
  }
}
`;

/** @type {string | undefined} */
let launcher;
/** The compiled launcher, built once per process inside DIR. @param {string} dir */
function build(dir) {
  if (launcher) return launcher;
  mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'launcher.cs'); const exe = path.join(dir, 'launcher.exe');
  writeFileSync(src, SOURCE);
  const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const r = spawnSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, src], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(exe)) throw new Error(`winfake: csc failed (${r.status}): ${r.stdout}${r.stderr}${r.error ?? ''}`);
  launcher = exe;
  return exe;
}

/**
 * On win32 `BIN/NAME.exe` that runs `node SCRIPT <arguments>`; elsewhere the caller writes its own `#!/bin/sh` file. BIN must be outside every temporary folder (the caller's rule).
 * @param {string} toolRoot a folder for the one compiled launcher @param {string} bin @param {string} name @param {string} script absolute path of the Node script
 */
export function fakeExe(toolRoot, bin, name, script) {
  const exe = path.join(bin, `${name}.exe`);
  copyFileSync(build(path.join(toolRoot, 'winfake')), exe);
  writeFileSync(`${exe}.cfg`, `${process.execPath}\n${script}\n`);
  return exe;
}
