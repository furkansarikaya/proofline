// `node --test tests/skills/` on Node versions that resolve a directory argument as a module
// (the test runner then starts this folder's "main"). It loads every *.test.mjs here.
// Node 18/20 find the files by recursion and run this file too: it does nothing then.
const { readdirSync } = require("node:fs");
const { basename, join } = require("node:path");
const { pathToFileURL } = require("node:url");

if (basename(process.argv[1] || "") !== "all.cjs") {
  for (const f of readdirSync(__dirname).filter((n) => n.endsWith(".test.mjs")).sort()) {
    import(pathToFileURL(join(__dirname, f)).href);
  }
}
