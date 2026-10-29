#!/usr/bin/env node
// Writes a task's origin and the way back (A202). No dependencies. Exit codes: 0 done, 1 refused, 2 usage or read error.
//   node link-origin.mjs <task.md> --from <TASK-ID>      the task was born from another task's observation or exemption
//   node link-origin.mjs <task.md> --prd <slug>          the task was born from a PRD requirement (split mode)
//   [--tasks-dir DIR]                                    where links.tsv lives (default: the task's own folder)
// The new task gets `origin: <TASK-ID>` or `origin: prd:<slug>` in its front matter; `<tasks-dir>/links.tsv` gets one row
// `source<TAB>new-task<TAB>kind` (kind: followup | prd). The source task file is never edited: that would change its hash.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function setOrigin(text, origin) {
  const line = `origin: ${origin}`;
  const lines = text.split("\n");
  const h1 = lines.findIndex((l) => /^# Task:/.test(l));
  if (h1 < 0) throw new Error("no `# Task:` line");
  // an existing block right after the H1 (and an optional Status line): replace or add the key
  let i = h1 + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (/^\*\*Status:\*\*/.test(lines[i] || "")) { i++; while (i < lines.length && lines[i].trim() === "") i++; }
  if (lines[i] === "---") {
    const end = lines.indexOf("---", i + 1);
    if (end < 0) throw new Error("unterminated front matter");
    const k = lines.slice(i + 1, end).findIndex((l) => /^origin:/.test(l));
    if (k >= 0) lines[i + 1 + k] = line; else lines.splice(i + 1, 0, line);
    return lines.join("\n");
  }
  const at = h1 + 1;
  lines.splice(at, 0, "", "---", line, "", "---");
  return lines.join("\n");
}

export function linkOrigin(file, { from, prd, tasksDir }) {
  const text = readFileSync(file, "utf8");
  const id = /^# Task:\s+(\S+)/m.exec(text)?.[1];
  if (!id) throw new Error("the task has no `# Task: <ID>` line");
  const source = prd ? `prd:${prd}` : from;
  if (!source || (prd && from)) throw new Error("exactly one of --from and --prd");
  if (!prd && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(from)) throw new Error(`not a task id: ${from}`);
  if (prd && !/^[a-z0-9][a-z0-9-]*$/.test(prd)) throw new Error(`not a PRD slug: ${prd}`);
  writeFileSync(file, setOrigin(text, source));
  const links = join(tasksDir, "links.tsv");
  const row = [source, id, prd ? "prd" : "followup"].join("\t");
  const have = existsSync(links) ? readFileSync(links, "utf8").split("\n") : [];
  if (!have.includes(row)) appendFileSync(links, `${row}\n`);
  return { id, origin: source, links };
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const file = argv.find((a, i) => !a.startsWith("--") && !["--from", "--prd", "--tasks-dir"].includes(argv[i - 1]));
  if (!file) { console.error("usage: link-origin.mjs <task.md> (--from <TASK-ID> | --prd <slug>) [--tasks-dir DIR]"); return 2; }
  try {
    const r = linkOrigin(resolve(file), { from: opt("--from"), prd: opt("--prd"), tasksDir: resolve(opt("--tasks-dir") || dirname(resolve(file))) });
    console.log(`${r.id}: origin ${r.origin}; back link in ${r.links}`);
    return 0;
  } catch (e) { console.error(`link-origin: ${e.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
