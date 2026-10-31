import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// A121-style guard (A125): GitHub, Claude Code and other runtimes parse the YAML front matter of
// SKILL.md, roles and generated agents, and the YAML/TOML the product ships. Node has no YAML parser and
// nothing may be installed, so this is a strict, dependency-free subset check for the failure class
// "plain scalar that a real parser rejects". It also checks Markdown bodies: code fences, relative links
// and anchors, table shapes, forbidden wording. Known-bad fixtures at the bottom must fail.
const REPO = new URL("../../", import.meta.url).pathname;
const DESCRIPTION_MAX = 1024; // Agent Skills limit for `description`

// ---------- YAML subset ----------
const INDICATOR_START = /^[@`%&*!|>'"{[?\-#,\]}]/;

// Returns a list of problems for one scalar text that is written as a plain (unquoted) scalar.
function plainProblems(s) {
  const p = [];
  if (/: |:$/.test(s)) p.push(`plain scalar contains ': ' (or ends with ':'): ${s.slice(0, 60)}...`);
  return p;
}

function valueProblems(v, key, verbatim = false) {
  const p = [];
  if (v === "" || v === "|" || v === ">" || /^[|>][+-]?\d?[+-]?$/.test(v)) return p;
  if (v.startsWith('"')) {
    let i = 1, closed = false;
    for (; i < v.length; i++) {
      if (v[i] === "\\") {
        if (!verbatim && !/[0abtnvfre "\/\\N_LPxuU\t]/.test(v[i + 1] || "")) p.push(`${key}: bad escape \\${v[i + 1] || ""}`);
        i++;
      } else if (v[i] === '"') { closed = true; break; }
    }
    if (!closed) p.push(`${key}: unbalanced double quote`);
    else if (v.slice(i + 1).replace(/^\s*(#.*)?$/, "") !== "") p.push(`${key}: text after closing quote`);
    return p;
  }
  if (v.startsWith("'")) {
    let i = 1, closed = false;
    for (; i < v.length; i++) {
      if (v[i] === "'") { if (v[i + 1] === "'") { i++; continue; } closed = true; break; }
    }
    if (!closed) p.push(`${key}: unbalanced single quote`);
    else if (v.slice(i + 1).replace(/^\s*(#.*)?$/, "") !== "") p.push(`${key}: text after closing quote`);
    return p;
  }
  if (v.startsWith("[") || v.startsWith("{")) {
    let depth = 0, q = null;
    for (const c of v) {
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
    }
    if (depth !== 0 || q) p.push(`${key}: unbalanced flow collection`);
    return p;
  }
  if (v.startsWith("#")) return p; // comment only
  if (INDICATOR_START.test(v) && !/^-\S/.test(v)) p.push(`${key}: plain scalar starts with indicator '${v[0]}'`);
  if (/^-\s/.test(v)) p.push(`${key}: plain scalar starts with '- '`);
  if (/ #/.test(v) && (key === "name" || key === "description")) p.push(`${key}: ' #' would cut the text as a comment`);
  for (const m of plainProblems(v.replace(/ #.*$/, ""))) p.push(`${key}: ${m}`);
  return p;
}

// Validate a YAML mapping text (front matter body or a .yaml file). Returns { problems, keys }.
// verbatim: the product's own awk reader (agent.sh config_lines) strips the outer double quotes and never
// unescapes, so a backslash inside them is literal there; a real YAML parser would reject it.
export function checkYaml(text, verbatim = false) {
  const problems = [];
  const lines = text.split("\n");
  const seen = new Map(); // indent-path -> Set of keys, per parent chain
  const stack = []; // {indent, keys:Set}
  let block = null; // {indent} of a block scalar's owner
  let plainOwner = null; // {indent,key} while reading plain continuation lines
  const top = new Set();
  lines.forEach((raw, n) => {
    const at = (m) => problems.push(`line ${n + 1}: ${m}`);
    if (/^\s*\t|^ *\t/.test(raw) && raw.trim() !== "") { at("tab used for indentation"); return; }
    if (raw.trim() === "" ) return;
    const indent = raw.match(/^ */)[0].length;
    const body = raw.trim();
    if (block) {
      if (indent > block.indent) return; // block scalar content: anything goes
      block = null;
    }
    if (body.startsWith("#")) return;
    if (plainOwner && indent > plainOwner.indent && !/^- /.test(body)) {
      // continuation line of a plain/quoted multi-line scalar
      for (const m of plainProblems(body)) at(`${plainOwner.key}: ${m}`);
      return;
    }
    plainOwner = null;
    let rest = body, isItem = false;
    if (/^- /.test(rest) || rest === "-") {
      isItem = true;
      rest = rest.slice(2).trim();
      if (rest === "") return;
    }
    const m = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#'"][^:#]*?|[^\s:#'"])\s*:(?:\s+(.*)|$)/);
    if (!m) {
      if (isItem) { for (const x of valueProblems(rest, "item")) at(x); return; }
      at(`not a 'key: value' line: ${rest.slice(0, 60)}`);
      return;
    }
    const key = m[1];
    const val = (m[2] || "").trim();
    // duplicate key tracking per indent level; a list item opens a fresh mapping at indent + 2
    const ki = isItem ? indent + 2 : indent;
    while (stack.length && stack[stack.length - 1].indent > ki) stack.pop();
    if (!stack.length || stack[stack.length - 1].indent < ki) stack.push({ indent: ki, keys: new Set() });
    else if (isItem) stack[stack.length - 1].keys = new Set();
    const level = stack[stack.length - 1];
    if (level.keys.has(key)) at(`duplicate key '${key}'`);
    level.keys.add(key);
    if (ki === 0) top.add(key);
    for (const x of valueProblems(val, key, verbatim)) at(x);
    if (/^[|>]/.test(val)) block = { indent };
    else if (val !== "" && !/^["'\[{#]/.test(val)) plainOwner = { indent: ki, key };
    else if (val.startsWith('"') || val.startsWith("'")) {
      // a multi-line quoted scalar would continue on the next lines; flagged by unbalanced quote above
    }
  });
  return { problems, keys: top };
}

// ---------- front matter ----------
export function splitFrontMatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return { error: "missing closing ---" };
  return { yaml: lines.slice(1, end).join("\n"), bodyStart: end + 1 };
}

export function checkFrontMatter(path, text) {
  const fm = splitFrontMatter(text);
  if (!fm) return [];
  if (fm.error) return [fm.error];
  const { problems, keys } = checkYaml(fm.yaml);
  const out = problems.map((x) => `front matter ${x}`);
  const isSkill = /(^|\/)skills\/[^/]+\/SKILL\.md$/.test(path);
  if (isSkill) {
    const name = fm.yaml.match(/^name:\s*(.+?)\s*$/m);
    if (!name) out.push("skill: missing name");
    else if (name[1] !== basename(dirname(path))) out.push(`skill: name '${name[1]}' differs from directory '${basename(dirname(path))}'`);
    const d = fm.yaml.match(/^description:\s*(.*)$/m);
    if (!keys.has("description") || !d) out.push("skill: missing description");
    else {
      let v = d[1].trim();
      if (v.startsWith('"') || v.startsWith("'")) v = v.slice(1, -1);
      if (v.length > DESCRIPTION_MAX) out.push(`skill: description is ${v.length} characters (limit ${DESCRIPTION_MAX})`);
      if (v === "" || /^[|>]/.test(v)) out.push("skill: description must be a one-line scalar");
    }
  }
  if (/^adapters\/claude\/agents\/.+\.md$/.test(path)) {
    for (const k of ["name", "description"]) if (!keys.has(k)) out.push(`agent: missing ${k}`);
  }
  return out;
}

// ---------- TOML ----------
export function checkToml(text) {
  const problems = [];
  const lines = text.split("\n");
  const keys = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!m) { problems.push(`line ${i + 1}: not 'key = value'`); continue; }
    const [, k, v] = m;
    if (keys.has(k)) problems.push(`line ${i + 1}: duplicate key ${k}`);
    keys.add(k);
    if (v.startsWith("'''") || v.startsWith('"""')) {
      const q = v.slice(0, 3);
      let rest = v.slice(3);
      let j = i;
      while (!rest.includes(q)) {
        j++;
        if (j >= lines.length) { problems.push(`line ${i + 1}: unterminated multi-line string`); return problems; }
        rest = lines[j];
      }
      i = j;
    } else if (v.startsWith('"')) {
      let ok = false;
      for (let c = 1; c < v.length; c++) {
        if (v[c] === "\\") { if (!/[btnfr"\\uU]/.test(v[c + 1] || "")) problems.push(`line ${i + 1}: bad escape`); c++; }
        else if (v[c] === '"') { ok = true; if (v.slice(c + 1).trim() !== "") problems.push(`line ${i + 1}: text after string`); break; }
      }
      if (!ok) problems.push(`line ${i + 1}: unterminated string`);
    } else if (v.startsWith("'")) {
      if (!/^'[^']*'\s*(#.*)?$/.test(v)) problems.push(`line ${i + 1}: bad literal string`);
    } else if (!/^(true|false|-?\d+(\.\d+)?|\[.*\])\s*(#.*)?$/.test(v)) problems.push(`line ${i + 1}: unquoted value`);
  }
  for (const k of ["name", "description", "developer_instructions"]) if (!keys.has(k)) problems.push(`missing ${k}`);
  return problems;
}

// ---------- Markdown body ----------
function stripFences(text) {
  const out = [];
  let fence = null;
  const problems = [];
  text.split("\n").forEach((line, n) => {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) { fence = { ch: m[1][0], len: m[1].length, line: n + 1 }; out.push(""); return; }
      if (m[1][0] === fence.ch && m[1].length >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) { fence = null; out.push(""); return; }
    }
    out.push(fence ? "" : line);
  });
  if (fence) problems.push(`unclosed code fence opened at line ${fence.line}`);
  return { lines: out, problems };
}

function slug(h) {
  return h.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

const anchorCache = new Map();
function anchorsOf(file, src) {
  if (!src && anchorCache.has(file)) return anchorCache.get(file);
  const set = new Set();
  const counts = new Map();
  const { lines } = stripFences(src ?? readFileSync(file, "utf8"));
  for (const l of lines) {
    const m = l.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    let s = slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    const c = counts.get(s) || 0;
    counts.set(s, c + 1);
    set.add(c ? `${s}-${c}` : s);
  }
  if (!src) anchorCache.set(file, set);
  return set;
}

export function checkMarkdown(file, text, root = REPO) {
  const rel = relative(root, file);
  const problems = [];
  const { lines, problems: fp } = stripFences(text);
  problems.push(...fp);
  const fm = splitFrontMatter(text);
  const start = fm && !fm.error ? fm.bodyStart : 0;
  let prevHeading = 0;
  let inTable = null;
  lines.forEach((line, n) => {
    if (n < start) return;
    const at = (m) => problems.push(`line ${n + 1}: ${m}`);
    const h = line.match(/^(#{1,6})\s+\S/);
    if (h) {
      if (prevHeading && h[1].length > prevHeading + 1) at(`heading jumps from level ${prevHeading} to ${h[1].length}`);
      prevHeading = h[1].length;
    }
    // tables
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (line.includes("\t")) at("tab character in table row");
      const cols = line.replace(/\\\|/g, "").replace(/`[^`]*`/g, (m) => m.replace(/\|/g, "")).trim().replace(/^\||\|$/g, "").split("|").length;
      if (inTable === null) inTable = cols;
      else if (cols !== inTable) at(`table row has ${cols} columns, header has ${inTable}`);
    } else inTable = null;
    // links
    const noCode = line.replace(/`[^`]*`/g, "");
    for (const lm of noCode.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = lm[1] || lm[2];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      if (/[<>$*{}]/.test(target)) continue; // placeholder
      const [pathPart, anchor] = target.split("#");
      const dest = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
      if (!isTracked(dest)) { at(`broken link ${target}`); continue; }
      if (anchor && dest.endsWith(".md") && statSync(dest).isFile() && !(pathPart ? anchorsOf(dest) : anchorsOf(dest, text)).has(anchor.toLowerCase())) at(`broken anchor ${target}`);
    }
    // wording
    if (!/(^|\/)tests\//.test(rel) && rel !== "CHANGELOG.md" && rel !== "docs/decisions.md") {
      // a foreign API version ("REST v2", "/api/v2/", "OAuth 2.0") is not a proofline version
      const l2 = line.replace(/(\/|REST |API |OAuth |OpenAPI |Apache |Swagger )(v2|2\.0)\b|\bv2 API/gi, "");
      if (/\b(v2|2\.0)\b/i.test(l2) && !/\b\d+\.2\.0\b|\b2\.0\.\d/.test(l2)) at("forbidden version wording v2 / 2.0");
    }
  });
  return problems;
}

// ---------- file selection ----------
const tracked = spawnSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const trackedSet = new Set(tracked);
// A link target counts only if the repository tracks it (a file, or a directory holding tracked files), as in CI.
function isTracked(abs) {
  const rel = relative(REPO, abs);
  if (rel.startsWith("..")) return existsSync(abs);
  return rel === "" || trackedSet.has(rel) || tracked.some((f) => f.startsWith(rel + "/"));
}
const mdFiles = tracked.filter((f) => f.endsWith(".md"));
const yamlFiles = tracked.filter((f) => /\.ya?ml$/.test(f));
const tomlFiles = tracked.filter((f) => f.endsWith(".toml"));

// ---------- tests ----------
test("known-bad front matter fails the check", () => {
  const bad = "---\nname: x\ndescription: Does a thing. Use when: the user asks\n---\n";
  assert.ok(checkYaml("name: x\ndescription: Does a thing. Use when: the user asks").problems.length > 0);
  assert.match(checkFrontMatter("skills/x/SKILL.md", bad).join("\n"), /plain scalar contains ': '/);
  const cases = {
    comment: "description: foo #bar",
    indicator: "a: @foo",
    backtick: "a: `foo`",
    tab: "a:\n\tb: c",
    unbalancedDouble: 'a: "foo',
    unbalancedSingle: "a: 'foo",
    afterQuote: 'a: "foo" bar',
    dup: "a: 1\na: 2",
    flow: "a: [1, 2",
    trailingColon: "a: foo:",
    badKey: "just text",
  };
  for (const [k, y] of Object.entries(cases)) assert.ok(checkYaml(y).problems.length > 0, k);
});

test("known-good YAML shapes pass", () => {
  const good = [
    'a: "Use when: yes, # ok"',
    "a: 'it''s: fine'",
    "a: plain text with a colon:nospace and a-dash",
    "a:\n  b: 1\n  c:\n    - x\n    - y: 1\n      z: 2\n    - w: 3\n  d: [1, 2]\nf: >-\n  text: with colon\n  more # hash\ng: |\n  x: y",
    "# comment\na: 1 # trailing",
  ];
  for (const y of good) assert.deepEqual(checkYaml(y).problems, [], y);
});

test("front matter checks: closing marker, skill name, description", () => {
  assert.match(checkFrontMatter("x.md", "---\na: 1\n").join(), /closing/);
  assert.match(checkFrontMatter("skills/foo/SKILL.md", "---\nname: bar\ndescription: d\n---\n").join(), /differs from directory/);
  assert.match(checkFrontMatter("skills/foo/SKILL.md", "---\nname: foo\n---\n").join(), /missing description/);
  assert.match(checkFrontMatter("skills/foo/SKILL.md", `---\nname: foo\ndescription: ${"a".repeat(1100)}\n---\n`).join(), /limit/);
  assert.deepEqual(checkFrontMatter("skills/foo/SKILL.md", '---\nname: foo\ndescription: "a: b"\n---\n'), []);
});

test("known-bad markdown fails the body check", () => {
  const f = join(REPO, "README.md");
  const t = (s) => checkMarkdown(f, s).join("\n");
  assert.match(t("# a\n\n```sh\nx\n"), /unclosed code fence/);
  assert.match(t("# a\n\n[x](no/such/file.md)\n"), /broken link/);
  assert.match(t("# a\n\n[x](#nope)\n"), /broken anchor/);
  assert.match(t("# a\n\n### c\n"), /heading jumps/);
  assert.match(t("| a | b |\n|---|---|\n| 1 | 2 | 3 |\n"), /columns/);
  assert.match(t("# a\n\nThis is v2 of it.\n"), /v2/);
  assert.equal(t("# a\n\n[x](#a) `[y](nope.md)`\n\n```\n[z](nope.md)\n```\n"), "");
});

test("known-bad TOML fails", () => {
  assert.ok(checkToml('name = "a"\ndescription = "b\ndeveloper_instructions = \'\'\'x\n\'\'\'').length > 0);
  assert.deepEqual(checkToml("name = \"a\"\ndescription = \"b: c\"\ndeveloper_instructions = '''\nx: y\n'''\n"), []);
});

test("every Markdown front matter in the repository is valid", () => {
  const bad = [];
  let n = 0;
  for (const f of mdFiles) {
    const text = readFileSync(join(REPO, f), "utf8");
    if (!text.startsWith("---\n") || f.startsWith("fixtures/") || f.startsWith("tests/")) continue;
    n++;
    for (const p of checkFrontMatter(f, text)) bad.push(`${f}: ${p}`);
  }
  assert.ok(n > 30, `expected many front matter files, saw ${n}`);
  assert.deepEqual(bad, []);
});

test("every YAML file shipped in the repository is valid", () => {
  const bad = [];
  for (const f of yamlFiles) for (const p of checkYaml(readFileSync(join(REPO, f), "utf8"), f.startsWith("control-plane/agents/") && !f.includes("/templates/")).problems) bad.push(`${f}: ${p}`);
  assert.ok(yamlFiles.length > 10);
  assert.deepEqual(bad, []);
});

test("every Codex agent TOML is valid", () => {
  const bad = [];
  for (const f of tomlFiles) for (const p of checkToml(readFileSync(join(REPO, f), "utf8"))) bad.push(`${f}: ${p}`);
  assert.ok(tomlFiles.length >= 10);
  assert.deepEqual(bad, []);
});

test("Markdown bodies: fences, relative links, anchors, tables, headings, wording", () => {
  const bad = [];
  for (const f of mdFiles) {
    if (f.startsWith("fixtures/") || f.startsWith("playground/")) continue;
    for (const p of checkMarkdown(join(REPO, f), readFileSync(join(REPO, f), "utf8"))) bad.push(`${f}: ${p}`);
  }
  assert.deepEqual(bad, []);
});

test("decision numbers cited in Markdown exist in docs/decisions.md", () => {
  const dec = readFileSync(join(REPO, "docs/decisions.md"), "utf8");
  const have = new Set([...dec.matchAll(/^- \*\*([A-Z]\d+)\./gm)].map((m) => m[1]));
  // a number above the highest present is a decision of a pending pull request: not flagged
  const maxDec = Math.max(...[...have].map((a) => Number(a.slice(1))));
  const bad = [];
  for (const f of mdFiles) {
    if (f === "CHANGELOG.md" || f.startsWith("fixtures/")) continue;
    const text = readFileSync(join(REPO, f), "utf8");
    for (const m of text.matchAll(/\bA(\d{1,3})\b/g)) if (!have.has(`A${m[1]}`) && Number(m[1]) <= maxDec) bad.push(`${f}: A${m[1]}`);
  }
  assert.deepEqual([...new Set(bad)], []);
});

// ADR 0001 section 10: the documented commands are checked against the core's command table (all 132 entries, moved or bridged), not against
// agent.sh text. The table is read through one stable function, `commandTable()`, exported by control-plane/agents/scripts/proofline-core.mjs and
// returning an array of { name, readOnly, roles }.
const COMMAND_COUNT = 132;
async function commandNames() {
  const core = await import(pathToFileURL(join(REPO, "control-plane/agents/scripts/proofline-core.mjs")).href);
  assert.equal(typeof core.commandTable, "function", "proofline-core.mjs must export commandTable()");
  const table = core.commandTable();
  assert.ok(Array.isArray(table), "commandTable() returns an array");
  for (const e of table) {
    assert.equal(typeof e.name, "string", "every entry has a name");
    assert.equal(typeof e.readOnly, "boolean", `${e.name}: readOnly is a boolean`);
    assert.ok(Array.isArray(e.roles), `${e.name}: roles is an array`);
  }
  return table.map((e) => e.name);
}

test("the core's command table has all 132 commands, each once", async () => {
  const names = await commandNames();
  assert.equal(names.length, COMMAND_COUNT);
  assert.equal(new Set(names).size, COMMAND_COUNT, "no duplicate command name");
  for (const n of names) assert.match(n, /^[a-z][a-z0-9-]*$/, n);
});

test("agent.sh subcommands named in Markdown exist in the core's command table", async () => {
  const have = new Set(await commandNames());
  const bad = [];
  for (const f of mdFiles) {
    if (f === "CHANGELOG.md" || f === "docs/decisions.md") continue; // history may name removed commands
    const text = readFileSync(join(REPO, f), "utf8");
    for (const m of [...text.matchAll(/`([^`\n]+)`/g)].flatMap((s) => [...s[1].matchAll(/\bagent\.sh ([a-z][a-z0-9-]+)/g)])) {
      if (!have.has(m[1])) bad.push(`${f}: agent.sh ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(bad)], []);
});
