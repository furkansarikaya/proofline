#!/usr/bin/env node
// Validates a concurrency-proof concurrency.json (see ../schema/concurrency.schema.json) and computes the
// REVIEW `concurrency` focus result mechanically.
// Usage: node validate-concurrency.mjs <concurrency.json> [--repo DIR] [--base REF] [--plan PLAN.md] [--spec FILE]...
//        [--report REPORT.md] [--rows]
//   --repo DIR     re-read every cited file:line in DIR (file exists, line exists, `code` is required on every
//                  trace step and is on that line,
//                  an `accepted_by.quote` is on its line)
//   --base REF     with --repo: every non pre_existing finding has a trace step on a line the diff
//                  REF..working tree adds or changes (untracked files count as added)
//                  and scope.candidates equals a fresh find-shared-state.mjs --repo DIR --base REF count
//   --plan/--spec  the only files an `accepted_by` may cite (verbatim quote on the cited line)
//   The agent's own labels never close a traced or reproduced finding (A93): `pre_existing` needs --repo --base
//   showing no trace step on a changed line; `closed` needs a recheck the validator re-checks (a reproduction
//   run with 0 failures whose saved copy exists next to concurrency.json, or a fix line the diff changes, in a
//   traced file, with its code); `accepted` needs a --plan/--spec citation, never the changed code.
//   --report FILE  also checks the Verdict and Summary sections of REPORT.md: no safety claim, and a PASS/FAIL
//                  word in the Verdict section equals the computed result
//   --rows         prints only the submit rows (`blocking|path:line|finding|evidence`, `info|...`)
//   valid   -> exit 0; prints "RESULT: PASS|FAIL", "CONFIDENCE: ..." and "REPRODUCTION: ...".
//   invalid -> exit 1; one line per problem on stderr.
//   usage/read error -> exit 2.
// No dependencies.
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve, isAbsolute, basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { scan, COMMENT } from "./find-shared-state.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const safeRel = (p) => isStr(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
const posInt = (v) => Number.isInteger(v) && v >= 1;

export const CATEGORIES = ["race", "deadlock", "lost_update", "double_processing", "idempotency", "retry_side_effect",
  "ordering", "redelivery", "timeout", "transaction_boundary", "lock_lifecycle"];
const STATUSES = ["open", "accepted", "closed", "pre_existing"];
const TOP = ["schema_version", "skill_version", "target", "scope", "reproduction", "findings", "unproven_risks", "judged", "verdict"];
const FINDING = ["id", "category", "title", "status", "location", "shared_state", "evidence", "trace", "reproduction", "why_not_reproduced", "accepted_by", "recheck"];
const REPRO = ["command", "runs", "failures", "observed", "saved_copy"];

// A safety claim: the phrases below outside code. Code is removed first: fenced blocks, `inline code` and a
// "double-quoted" single token without spaces (a quoted identifier); a quoted phrase with spaces is still
// prose and is scanned. Identifiers such as safeParse, is_safe or thread_safe never match (no word
// boundary); "unsafe" and "safety" never match. Negated forms ("not safe") are rejected too: the report
// states what was proven, never a safety property (say "no proven problem").
export const SAFETY_CLAIM = new RegExp([
  String.raw`thread[- ]?safe`, String.raw`race[- ]free`, String.raw`deadlock[- ]free`, String.raw`concurrency[- ]safe`,
  String.raw`race[- ]condition[- ]free`, String.raw`safe(?:ly)?`,
  String.raw`free of (?:data )?(?:races?|deadlocks?|race conditions?)`,
  String.raw`(?:can ?not|can't|cannot|impossible to) (?:race|deadlock)`,
  String.raw`no (?:data )?races?`, String.raw`guaranteed (?:correct|safe)`, String.raw`no concurrency (?:issues|problems)`,
].map((a) => String.raw`\b${a}\b`).join("|"), "i");
export const stripCode = (s) => String(s).replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/"[^"\s]*"/g, " ");
export const safetyClaim = (s) => { const m = stripCode(s).match(SAFETY_CLAIM); return m ? m[0] : null; };

export function validate(doc) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  const keys = (o, allowed, path) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) err(path, `unexpected "${k}"`); };
  const loc = (l, path) => {
    if (!isObj(l)) return err(path, "expected {file, line}");
    keys(l, ["file", "line"], path);
    if (!safeRel(l.file)) err(`${path}.file`, "expected a repository-relative path");
    if (!posInt(l.line)) err(`${path}.line`, "expected an integer >= 1");
  };
  const cite = (c, path, extra = []) => {
    if (!isObj(c)) return err(path, "expected {file, line, quote}");
    keys(c, ["file", "line", "quote", ...extra], path);
    if (!safeRel(c.file)) err(`${path}.file`, "expected a repository-relative path");
    if (!posInt(c.line)) err(`${path}.line`, "expected an integer >= 1");
    if (!isStr(c.quote)) err(`${path}.quote`, "expected the cited text");
  };
  if (!isObj(doc)) return ["document: expected a JSON object"];
  keys(doc, TOP, "document");
  if (doc.schema_version !== 1) err("schema_version", "expected 1");
  if (!isStr(doc.skill_version)) err("skill_version", "expected non-empty string");

  const t = doc.target;
  if (!isObj(t)) err("target", "expected object");
  else {
    keys(t, ["type", "name", "base", "head"], "target");
    if (!["working_tree", "branch", "pull_request", "run"].includes(t.type)) err("target.type", "expected working_tree|branch|pull_request|run");
    if (!isStr(t.name)) err("target.name", "expected non-empty string");
    if (!isStr(t.base)) err("target.base", "expected the base commit or ref");
    if (t.head !== null && !isStr(t.head)) err("target.head", "expected a commit or null (working tree)");
  }

  const s = doc.scope;
  let changed = [];
  if (!isObj(s)) err("scope", "expected object");
  else {
    keys(s, ["changed_files", "candidates", "not_reviewed"], "scope");
    if (!Array.isArray(s.changed_files) || !s.changed_files.length || !s.changed_files.every(safeRel)) err("scope.changed_files", "expected a non-empty list of repository-relative paths");
    else changed = s.changed_files;
    if (!Number.isInteger(s.candidates) || s.candidates < 0) err("scope.candidates", "expected the candidate count from find-shared-state.mjs (integer >= 0)");
    if (!Array.isArray(s.not_reviewed)) err("scope.not_reviewed", "expected array");
    else s.not_reviewed.forEach((n, i) => {
      if (!isObj(n)) return err(`scope.not_reviewed[${i}]`, "expected {path, reason}");
      keys(n, ["path", "reason"], `scope.not_reviewed[${i}]`);
      if (!safeRel(n.path)) err(`scope.not_reviewed[${i}].path`, "expected a repository-relative path");
      if (!isStr(n.reason)) err(`scope.not_reviewed[${i}].reason`, "expected non-empty string");
    });
  }

  const r = doc.reproduction;
  if (!isObj(r)) err("reproduction", "expected object: the reproduction status is always stated");
  else {
    keys(r, ["status", "runner", "worktree", "reason"], "reproduction");
    if (r.status === "ran") {
      if (!isStr(r.runner)) err("reproduction.runner", "expected the project's own test command");
      if (!isStr(r.worktree) || !isAbsolute(r.worktree) || !/^concurrency-proof-./.test(basename(r.worktree))) err("reproduction.worktree", "expected an absolute path whose last component starts with concurrency-proof-");
    } else if (r.status === "unsupported" || r.status === "none_needed") {
      if (!isStr(r.reason)) err("reproduction.reason", `status ${r.status} needs the reason`);
      if ("runner" in r || "worktree" in r) err("reproduction", `status ${r.status} carries no runner or worktree`);
    } else err("reproduction.status", "expected ran|unsupported|none_needed");
  }

  const ids = new Set();
  const idCheck = (id, re, path) => {
    if (typeof id !== "string" || !re.test(id)) return err(`${path}.id`, `expected ${re.source}`);
    if (ids.has(id)) err(`${path}.id`, `duplicate id ${id}`);
    ids.add(id);
  };
  const findings = Array.isArray(doc.findings) ? doc.findings : (err("findings", "expected array"), []);
  findings.forEach((f, i) => {
    const p = `findings[${i}]`;
    if (!isObj(f)) return err(p, "expected object");
    keys(f, FINDING, p);
    idCheck(f.id, /^C\d{3}$/, p);
    if (!CATEGORIES.includes(f.category)) err(`${p}.category`, `expected one of ${CATEGORIES.join("|")}`);
    if (!isStr(f.title)) err(`${p}.title`, "expected non-empty string");
    if (!STATUSES.includes(f.status)) err(`${p}.status`, `expected ${STATUSES.join("|")}`);
    if (!isStr(f.shared_state)) err(`${p}.shared_state`, "expected the shared state or resource the actors contend for");
    loc(f.location, `${p}.location`);
    if (f.status !== "pre_existing" && isObj(f.location) && changed.length && !changed.includes(f.location.file)) err(`${p}.location.file`, "a finding in changed code must be in scope.changed_files (else status pre_existing)");
    // trace: the concrete interleaving, always required (a reproduction without a schedule explains nothing)
    const tr = f.trace;
    if (!isObj(tr)) err(`${p}.trace`, "expected {actors, steps, outcome}");
    else {
      keys(tr, ["actors", "steps", "outcome"], `${p}.trace`);
      const actors = Array.isArray(tr.actors) ? tr.actors : [];
      if (!actors.every(isStr) || new Set(actors).size !== actors.length || actors.length < 2) err(`${p}.trace.actors`, "expected at least 2 distinct named actors");
      if (!isStr(tr.outcome)) err(`${p}.trace.outcome`, "expected the observable bad outcome of the schedule");
      const steps = Array.isArray(tr.steps) ? tr.steps : [];
      if (steps.length < 2) err(`${p}.trace.steps`, "expected at least 2 ordered steps");
      const seen = new Set();
      steps.forEach((st, j) => {
        const q = `${p}.trace.steps[${j}]`;
        if (!isObj(st)) return err(q, "expected {n, actor, file, line, action}");
        keys(st, ["n", "actor", "file", "line", "code", "action"], q);
        if (st.n !== j + 1) err(`${q}.n`, `expected ${j + 1}: steps are numbered in schedule order`);
        if (!actors.includes(st.actor)) err(`${q}.actor`, "expected one of trace.actors");
        else seen.add(st.actor);
        if (!safeRel(st.file)) err(`${q}.file`, "expected a repository-relative path");
        if (!posInt(st.line)) err(`${q}.line`, "expected an integer >= 1");
        if ("code" in st && !isStr(st.code)) err(`${q}.code`, "expected the code text on that line");
        if (!isStr(st.action)) err(`${q}.action`, "expected what the actor does at this step");
      });
      if (actors.length >= 2 && steps.length >= 2 && seen.size < 2) err(`${p}.trace.steps`, "expected steps of at least 2 different actors");
      if (actors.some((a) => isStr(a) && !seen.has(a)) && seen.size >= 2) err(`${p}.trace.actors`, "every actor takes at least one step");
      if (isObj(f.location) && steps.length && !steps.some((st) => isObj(st) && st.file === f.location.file && st.line === f.location.line)) err(`${p}.location`, "expected the location to be one of the trace steps");
    }
    if (f.evidence === "reproduced") {
      const rp = f.reproduction;
      if ("why_not_reproduced" in f) err(`${p}.why_not_reproduced`, "a reproduced finding carries no why_not_reproduced");
      if (!isObj(r) || r.status !== "ran") err(`${p}.evidence`, "reproduced requires reproduction.status ran");
      if (!isObj(rp)) err(`${p}.reproduction`, "expected object");
      else {
        keys(rp, REPRO, `${p}.reproduction`);
        if (!isStr(rp.command)) err(`${p}.reproduction.command`, "expected the command that was run");
        if (!Number.isInteger(rp.runs) || rp.runs < 2) err(`${p}.reproduction.runs`, "expected an integer >= 2 (concurrent or repeated runs)");
        if (!Number.isInteger(rp.failures) || rp.failures < 1 || rp.failures > rp.runs) err(`${p}.reproduction.failures`, "expected 1..runs runs that showed the failure");
        if (!isStr(rp.observed)) err(`${p}.reproduction.observed`, "expected the observed failure (output excerpt)");
        if (!safeRel(rp.saved_copy) || !/^evidence\//.test(rp.saved_copy)) err(`${p}.reproduction.saved_copy`, "expected a path under evidence/");
      }
    } else if (f.evidence === "traced") {
      if ("reproduction" in f) err(`${p}.reproduction`, "a traced finding carries no reproduction");
      if (!isStr(f.why_not_reproduced)) err(`${p}.why_not_reproduced`, "expected why the schedule was not reproduced (e.g. reproduction UNSUPPORTED)");
    } else err(`${p}.evidence`, "expected traced|reproduced (anything else is an unproven risk)");
    if (f.status === "accepted") {
      cite(f.accepted_by, `${p}.accepted_by`, ["symbol", "sha256"]);
      if (isObj(f.accepted_by) && "symbol" in f.accepted_by && !isStr(f.accepted_by.symbol)) err(`${p}.accepted_by.symbol`, "expected the symbol the plan names");
      if (isObj(f.accepted_by) && "sha256" in f.accepted_by && !/^[0-9a-f]{64}$/.test(f.accepted_by.sha256)) err(`${p}.accepted_by.sha256`, "expected 64 lowercase hex");
    }
    else if ("accepted_by" in f) err(`${p}.accepted_by`, "only an accepted finding cites the plan or spec");
    if (f.status === "closed") recheckShape(f.recheck, `${p}.recheck`, err);
    else if ("recheck" in f) err(`${p}.recheck`, "only a closed finding carries a recheck");
  });

  const unproven = Array.isArray(doc.unproven_risks) ? doc.unproven_risks : (err("unproven_risks", "expected array"), []);
  unproven.forEach((u, i) => {
    const p = `unproven_risks[${i}]`;
    if (!isObj(u)) return err(p, "expected object");
    keys(u, ["id", "category", "location", "reason", "why_unproven"], p);
    idCheck(u.id, /^U\d{3}$/, p);
    if (!CATEGORIES.includes(u.category)) err(`${p}.category`, `expected one of ${CATEGORIES.join("|")}`);
    loc(u.location, `${p}.location`);
    if (!isStr(u.reason)) err(`${p}.reason`, "expected non-empty string");
    if (!isStr(u.why_unproven)) err(`${p}.why_unproven`, "expected what is missing to prove it");
  });

  const judged = Array.isArray(doc.judged) ? doc.judged : (err("judged", "expected array"), []);
  judged.forEach((j, i) => {
    const p = `judged[${i}]`;
    if (!isObj(j)) return err(p, "expected object");
    keys(j, ["id", "location", "note", "violates"], p);
    idCheck(j.id, /^J\d{3}$/, p);
    loc(j.location, `${p}.location`);
    if (!isStr(j.note)) err(`${p}.note`, "expected non-empty string");
    if ("violates" in j) cite(j.violates, `${p}.violates`);
  });

  if (isObj(r) && r.status === "none_needed" && (findings.length || unproven.length)) err("reproduction.status", "none_needed only when there is no finding and no unproven risk");

  const v = doc.verdict;
  if (!isObj(v)) err("verdict", "expected {summary}");
  else {
    keys(v, ["summary"], "verdict");
    if (!isStr(v.summary)) err("verdict.summary", "expected non-empty string");
    else { const w = safetyClaim(v.summary); if (w) err("verdict.summary", `asserts safety ("${w}"): PASS means no proven problem; state what was proven`); }
  }
  return errors;
}

// A closed finding's recheck: evidence the validator can re-check, never a sentence ("looked again").
//   {kind: "reproduction", command, runs >= 2, failures: 0, observed, saved_copy: "evidence/..."}
//   {kind: "fix", file, line, code}: the changed line that removes the schedule (checked with --repo --base)
const RECHECK = { reproduction: ["kind", "command", "runs", "failures", "observed", "saved_copy", "sha256"], fix: ["kind", "file", "line", "code", "fix_token"] };
function recheckShape(rc, p, err) {
  if (!isObj(rc) || !(rc.kind in RECHECK)) return err(p, "a closed finding needs a recheck {kind: reproduction|fix, ...}: the re-run that no longer fails, or the fix line in the changed code");
  for (const k of Object.keys(rc)) if (!RECHECK[rc.kind].includes(k)) err(p, `unexpected "${k}"`);
  if (rc.kind === "reproduction") {
    if (!isStr(rc.command)) err(`${p}.command`, "expected the command that was re-run");
    if (!Number.isInteger(rc.runs) || rc.runs < 2) err(`${p}.runs`, "expected an integer >= 2");
    if (rc.failures !== 0) err(`${p}.failures`, "a recheck that closes a finding has 0 failing runs");
    if (!isStr(rc.observed)) err(`${p}.observed`, "expected the observed output excerpt");
    if (!safeRel(rc.saved_copy) || !/^evidence\//.test(rc.saved_copy)) err(`${p}.saved_copy`, "expected a path under evidence/");
    if (!/^[0-9a-f]{64}$/.test(rc.sha256 ?? "")) err(`${p}.sha256`, "expected the sha256 of the saved copy (64 lowercase hex)");
  } else {
    if ("fix_token" in rc && !isStr(rc.fix_token)) err(`${p}.fix_token`, "expected the synchronisation token the fix line adds");
    if (!safeRel(rc.file)) err(`${p}.file`, "expected a repository-relative path");
    if (!posInt(rc.line)) err(`${p}.line`, "expected an integer >= 1");
    if (!isStr(rc.code)) err(`${p}.code`, "expected the code text on the fix line");
  }
}

// Synchronisation tokens a fix line carries (case-insensitive, whole words).
export const SYNC_TOKEN = /\b(?:lock\w*|unlock|mutex\w*|rwlock|semaphore|synchronized|atomic\w*|transaction\w*|withtransaction|begin|commit|compareandset|compare_and_set|compareandswap|compare_and_swap|cas|setnx|incrby|incr|for update|on conflict|unique|upsert|idempoten\w*|idempotency_?key|serializ\w*|acquire|release|dedup\w*|version)\b/i;
// The code part of a line: a trailing // or # comment removed (shortcut: no string-literal awareness).
const codePart = (l) => String(l).replace(/\s(?:\/\/|#).*$/, "");
// The nearest line at or above n that opens a function (0 = module level); a heuristic, language-independent.
const FUNC = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)|^\s*(?:async\s+)?def\s+\w+|^\s*func\s|^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+|^\s*(?!(?:if|for|while|switch|catch|with|return|else)\b)(?:(?:public|private|protected|static|internal|async|override)\s+)*[A-Za-z_][\w<>,\[\]\s]*\([^;]*\)\s*(?:throws\s[^{]*)?\{\s*$/;
export function funcStart(lines, n) { for (let k = n; k >= 1; k--) if (FUNC.test(lines[k - 1] ?? "")) return k; return 0; }

// The agent's own labels never close a finding (A93). opts: docDir (the folder of concurrency.json), repo, base,
// refs [{path, text}] (the --plan/--spec files an acceptance may cite).
export function checkLabels(doc, { docDir = ".", repo = null, base = null, refs = [] } = {}) {
  const errors = [];
  const root = repo ? realpathSync(repo) : null;
  const changedLines = root && base ? diffLines(root, base) : null;
  const changed = new Set(doc.scope?.changed_files || []);
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  const refReal = refs.map((r) => ({ ...r, real: real(r.path) }));
  const fileText = (rel) => { try { return readFileSync(join(root, rel), "utf8").split("\n"); } catch { return null; } };
  const onChanged = (st) => changedLines?.get(st.file)?.has(st.line);
  (doc.findings || []).forEach((f, i) => {
    const p = `findings[${i}]`;
    const steps = (f.trace && f.trace.steps) || [];
    if (f.status === "pre_existing") {
      if (!changedLines) errors.push(`${p}.status: pre_existing needs --repo and --base to show that no trace step is on a changed line`);
      else if (steps.some(onChanged)) errors.push(`${p}.status: pre_existing, but trace step ${steps.find(onChanged).n} (${steps.find(onChanged).file}:${steps.find(onChanged).line}) is on a line changed since ${base}`);
    }
    if (f.status === "closed" && isObj(f.recheck)) {
      const rc = f.recheck;
      if (rc.kind === "reproduction") {
        if (doc.reproduction?.status !== "ran") errors.push(`${p}.recheck: a reproduction recheck needs reproduction.status ran`);
        const orig = f.evidence === "reproduced" && isObj(f.reproduction) ? f.reproduction : null;
        if (!orig) errors.push(`${p}.recheck: a reproduction recheck re-runs the finding's reproduction; a traced finding is closed by a fix recheck`);
        else {
          if (rc.command !== orig.command) errors.push(`${p}.recheck.command: must be the original reproduction command ${JSON.stringify(orig.command)}`);
          if (!(rc.runs >= orig.runs)) errors.push(`${p}.recheck.runs: ${rc.runs} < the original ${orig.runs} runs`);
        }
        const saved = safeRel(rc.saved_copy) ? join(docDir, rc.saved_copy) : null;
        if (!saved || !existsSync(saved)) errors.push(`${p}.recheck.saved_copy: ${rc.saved_copy} does not exist next to concurrency.json`);
        else {
          const bytes = readFileSync(saved);
          if (createHash("sha256").update(bytes).digest("hex") !== rc.sha256) errors.push(`${p}.recheck.sha256: does not match ${rc.saved_copy}`);
          if (!bytes.toString("utf8").includes(String(rc.observed).trim())) errors.push(`${p}.recheck.observed: the text is not in ${rc.saved_copy}`);
        }
      } else if (rc.kind === "fix") {
        if (!changedLines) errors.push(`${p}.recheck: a fix recheck needs --repo and --base (the fix line must be in the diff)`);
        else {
          if (!steps.some((st) => st.file === rc.file)) errors.push(`${p}.recheck.file: ${rc.file} is not a file of the traced schedule`);
          if (steps.some((st) => st.file === rc.file && st.line === rc.line)) errors.push(`${p}.recheck: ${rc.file}:${rc.line} is a step of the traced schedule, not a fix (cite the changed line that removes the interleaving)`);
          if (!changedLines.get(rc.file)?.has(rc.line)) errors.push(`${p}.recheck: ${rc.file}:${rc.line} is not a line changed since ${base}`);
          const ls = fileText(rc.file);
          const text = ls?.[rc.line - 1];
          if (text === undefined || !text.includes(String(rc.code).trim())) errors.push(`${p}.recheck: ${rc.file}:${rc.line} does not contain ${JSON.stringify(String(rc.code).trim())}`);
          else {
            const code = codePart(text);
            if (COMMENT.test(text) || !code.trim()) errors.push(`${p}.recheck: ${rc.file}:${rc.line} is a comment or blank, not a fix`);
            else if (rc.fix_token ? !code.includes(rc.fix_token) : !SYNC_TOKEN.test(code)) errors.push(`${p}.recheck: ${rc.file}:${rc.line} has no synchronisation token (lock, mutex, atomic, transaction, compare-and-set, idempotency key, unique constraint, ...)${rc.fix_token ? ` and not the stated fix_token ${JSON.stringify(rc.fix_token)}` : "; name it in fix_token when the project spells it differently"}`);
            const fs = funcStart(ls, rc.line);
            if (!steps.some((st) => st.file === rc.file && funcStart(ls, st.line) === fs)) errors.push(`${p}.recheck: ${rc.file}:${rc.line} is not inside a function of the traced schedule`);
          }
        }
      }
    }
    if (f.status === "accepted" && isObj(f.accepted_by)) {
      const a = f.accepted_by;
      if (changed.has(a.file)) { errors.push(`${p}.accepted_by: cites ${a.file}, which is changed code: only the plan or spec accepts a problem`); return; }
      if (!refReal.length) { errors.push(`${p}.accepted_by: pass --plan or --spec; an acceptance cites the plan or spec verbatim`); return; }
      const target = real(resolve(root ?? process.cwd(), a.file));
      const ref = refReal.find((r) => r.real && r.real === target);
      if (!ref) { errors.push(`${p}.accepted_by.file: ${a.file} is not one of the --plan/--spec files`); return; }
      const norm = (s) => String(s).replace(/\s+/g, " ").trim();
      const line = ref.text.split("\n")[a.line - 1];
      if (line === undefined || !norm(line).includes(norm(a.quote))) errors.push(`${p}.accepted_by: ${a.file}:${a.line} does not contain the quote verbatim`);
      // The cited line names this finding: its id, its location path:line, or a symbol on one of its steps.
      else {
        const loc = isObj(f.location) ? `${f.location.file}:${f.location.line}` : null;
        const sym = isStr(a.symbol) && line.includes(a.symbol) && steps.some((st) => String(st.code ?? "").includes(a.symbol));
        if (!line.includes(f.id) && !(loc && line.includes(loc)) && !sym) errors.push(`${p}.accepted_by: ${a.file}:${a.line} does not name the finding (${f.id}, ${loc}, or a symbol of its steps in accepted_by.symbol)`);
      }
      // Frozen: a run artifact (.agents/runs/<ID>/...; PLAN.md matched against RUN.yaml freeze plan_sha256), or,
      // outside a run, accepted_by.sha256 pins the version of the plan or spec that was read.
      const sha = createHash("sha256").update(ref.text).digest("hex");
      const rel = root && ref.real.startsWith(root + sep) ? ref.real.slice(root.length + 1) : null;
      const run = rel && /^\.agents\/runs\/[^/]+\//.exec(rel);
      if (run) {
        const frozen = basename(rel) === "PLAN.md" && /^freeze:[\s\S]*?^ {2}plan_sha256:\s*"?([0-9a-f]{64})"?/m.exec((() => { try { return readFileSync(join(root, run[0], "RUN.yaml"), "utf8"); } catch { return ""; } })());
        if (frozen && frozen[1] !== sha) errors.push(`${p}.accepted_by: ${a.file} is not the frozen PLAN.md (sha256 differs from RUN.yaml freeze plan_sha256)`);
      } else if (a.sha256 !== sha) errors.push(`${p}.accepted_by: ${a.file} is not a run artifact (.agents/runs/<ID>/): accepted_by.sha256 must pin the file read (${sha})`);
    }
  });
  for (const r of refReal) if (r.real && root && [...changed].some((c) => real(join(root, c)) === r.real)) errors.push(`--plan/--spec ${r.path} is in scope.changed_files: changed code never accepts a problem`);
  // L7: the candidate count is the scanner's, re-run here.
  if (root && base && Number.isInteger(doc.scope?.candidates)) {
    const n = scan({ repo: root, base }).candidates.length;
    if (doc.scope.candidates !== n) errors.push(`scope.candidates: ${doc.scope.candidates}, but find-shared-state.mjs --base ${base} finds ${n}`);
  }
  return errors;
}

// Re-reads cited lines in the repository; with base, checks that each finding in changed code has a trace
// step on a changed line.
export function checkRepo(doc, repo, base) {
  const errors = [];
  const root = realpathSync(repo);
  const cache = new Map();
  const lines = (file) => {
    if (cache.has(file)) return cache.get(file);
    let out = null;
    const abs = join(root, file);
    try {
      const real = realpathSync(abs);
      if ((real === root || real.startsWith(root + sep)) && statSync(real).isFile()) out = readFileSync(real, "utf8").replace(/\n$/, "").split("\n");
    } catch { out = null; }
    cache.set(file, out);
    return out;
  };
  const at = (file, line, path, text) => {
    const ls = lines(file);
    if (!ls) return errors.push(`${path}: ${file} does not exist in the repository`);
    if (line > ls.length) return errors.push(`${path}: ${file} has ${ls.length} lines, not ${line}`);
    if (text !== undefined && !ls[line - 1].includes(String(text).trim())) errors.push(`${path}: ${file}:${line} does not contain ${JSON.stringify(String(text).trim())}`);
  };
  let changedLines = null;
  if (base) changedLines = diffLines(root, base);
  (doc.findings || []).forEach((f, i) => {
    const p = `findings[${i}]`;
    const steps = (f.trace && f.trace.steps) || [];
    steps.forEach((st, j) => {
      if (!isStr(st.code)) errors.push(`${p}.trace.steps[${j}].code: required with --repo (the text on the cited line)`);
      at(st.file, st.line, `${p}.trace.steps[${j}]`, st.code);
    });
    if (f.accepted_by) at(f.accepted_by.file, f.accepted_by.line, `${p}.accepted_by`, f.accepted_by.quote);
    if (changedLines && f.status !== "pre_existing" && !steps.some((st) => changedLines.get(st.file)?.has(st.line))) {
      errors.push(`${p}: no trace step is on a line changed since ${base}: a problem outside the change is pre_existing`);
    }
  });
  (doc.unproven_risks || []).forEach((u, i) => u.location && at(u.location.file, u.location.line, `unproven_risks[${i}].location`));
  (doc.judged || []).forEach((j, i) => {
    if (j.location) at(j.location.file, j.location.line, `judged[${i}].location`);
    if (j.violates) at(j.violates.file, j.violates.line, `judged[${i}].violates`, j.violates.quote);
  });
  return errors;
}

// Map file -> Set of line numbers that the working tree adds or changes relative to base.
export function diffLines(root, base) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
  const map = new Map();
  let file = null;
  for (const l of git("diff", "-U0", "--no-color", "--no-ext-diff", base, "--").split("\n")) {
    if (l.startsWith("+++ ")) { file = l === "+++ /dev/null" ? null : l.slice(6); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && file) {
      const start = +m[1], n = m[2] === undefined ? 1 : +m[2];
      if (!map.has(file)) map.set(file, new Set());
      for (let k = 0; k < n; k++) map.get(file).add(start + k);
    }
  }
  for (const f of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
    try { map.set(f, new Set(readFileSync(join(root, f), "utf8").split("\n").map((_, k) => k + 1))); } catch { /* unreadable: not cited */ }
  }
  return map;
}

// The Verdict and Summary sections of REPORT.md (any heading level, any case, trailing colon allowed) must
// not assert safety; with the computed result, a PASS or FAIL word in the Verdict section must equal it.
export function checkReport(text, result) {
  const errors = [];
  let sec = null;
  const body = { verdict: "", summary: "" };
  for (const l of String(text).split("\n")) {
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(l);
    if (h) { const m = /^(verdict|summary)\b\s*:?\s*$/i.exec(h[1]); sec = m ? m[1].toLowerCase() : null; continue; }
    if (sec) body[sec] += l + "\n";
  }
  for (const [k, b] of Object.entries(body)) { const w = safetyClaim(b); if (w) errors.push(`REPORT.md ${k}: asserts safety ("${w}"): state what was proven`); }
  if (result) {
    const words = new Set((stripCode(body.verdict).match(/\b(PASS|FAIL)\b/g) || []));
    for (const w of words) if (w !== result) errors.push(`REPORT.md verdict: says ${w} but the computed result is ${result}`);
  }
  return errors;
}

// Gate rule: an open finding (traced or reproduced, in changed code, not accepted by the plan) or a judged
// item that violates a written criterion -> FAIL; otherwise PASS, which means "no proven problem".
export function gate(doc) {
  const open = doc.findings.filter((f) => f.status === "open");
  const violating = doc.judged.filter((j) => j.violates);
  const confidence = doc.scope.not_reviewed.length ? "low" : doc.reproduction.status === "unsupported" ? "medium" : "high";
  return { result: open.length || violating.length ? "FAIL" : "PASS", confidence, open, violating };
}

const cell = (s) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
export function rows(doc) {
  const g = gate(doc);
  const out = [];
  const sched = (f) => f.trace.steps.map((st) => `${st.n}.${st.actor}@${st.file}:${st.line}`).join(" -> ");
  for (const f of g.open) {
    const ev = f.evidence === "reproduced"
      ? `reproduced: ${f.reproduction.command}; failed ${f.reproduction.failures}/${f.reproduction.runs} runs; ${f.reproduction.observed}; schedule ${sched(f)}`
      : `traced: ${sched(f)}; ${f.trace.outcome}`;
    out.push(`blocking|${f.location.file}:${f.location.line}|${cell(`${f.id} ${f.category}: ${f.title}`)}|${cell(ev)}`);
  }
  for (const j of g.violating) out.push(`blocking|${j.location.file}:${j.location.line}|${cell(`${j.id} judged: ${j.note}`)}|${cell(`violates ${j.violates.file}:${j.violates.line} "${j.violates.quote}"`)}`);
  for (const f of doc.findings.filter((x) => x.status === "pre_existing")) out.push(`info|${f.location.file}:${f.location.line}|${cell(`${f.id} pre-existing ${f.category}: ${f.title}`)}|${cell(`${f.evidence}: ${sched(f)}`)}`);
  for (const u of doc.unproven_risks) out.push(`info|${u.location.file}:${u.location.line}|${cell(`${u.id} unproven ${u.category}: ${u.reason}`)}|${cell(`not proven: ${u.why_unproven}`)}`);
  if (doc.reproduction.status === "unsupported") out.push(`info|-|${cell(`reproduction UNSUPPORTED: ${doc.reproduction.reason}`)}|traced evidence only`);
  return out.join("\n");
}

const main = () => {
  const args = process.argv.slice(2);
  const opt = { rows: false };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--rows") opt.rows = true;
    else if (a === "--repo" || a === "--base" || a === "--report") { if (i + 1 >= args.length) { console.error(`${a} needs a value`); process.exit(2); } opt[a.slice(2)] = args[++i]; }
    else if (a === "--plan" || a === "--spec") { if (i + 1 >= args.length) { console.error(`${a} needs a value`); process.exit(2); } (opt.refs ??= []).push(args[++i]); }
    else if (a.startsWith("--")) { console.error(`unknown option ${a}`); process.exit(2); }
    else files.push(a);
  }
  if (files.length !== 1 || (opt.base && !opt.repo)) { console.error("usage: validate-concurrency.mjs <concurrency.json> [--repo DIR [--base REF]] [--plan PLAN.md] [--spec FILE]... [--report REPORT.md] [--rows]"); process.exit(2); }
  let doc, report;
  try { doc = JSON.parse(readFileSync(files[0], "utf8")); } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  if (opt.report) { try { report = readFileSync(opt.report, "utf8"); } catch (e) { console.error(`cannot read report: ${e.message}`); process.exit(2); } }
  if (opt.repo && !existsSync(opt.repo)) { console.error(`no such repository: ${opt.repo}`); process.exit(2); }
  let refs = [];
  try { refs = (opt.refs || []).map((p) => ({ path: p, text: readFileSync(p, "utf8") })); } catch (e) { console.error(`cannot read plan/spec: ${e.message}`); process.exit(2); }
  const errors = validate(doc);
  if (!errors.length && opt.repo) {
    try { errors.push(...checkRepo(doc, opt.repo, opt.base)); } catch (e) { console.error(`cannot read the repository diff: ${e.message.split("\n")[0]}`); process.exit(2); }
  }
  if (!errors.length) {
    try { errors.push(...checkLabels(doc, { docDir: resolve(files[0], ".."), repo: opt.repo, base: opt.base, refs })); } catch (e) { console.error(`cannot read the repository diff: ${e.message.split("\n")[0]}`); process.exit(2); }
  }
  if (report !== undefined) errors.push(...checkReport(report, errors.length ? null : gate(doc).result));
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  if (opt.rows) { const r = rows(doc); if (r) console.log(r); return; } // rows only, ready for `submit --findings -`
  const g = gate(doc);
  const rp = doc.reproduction;
  console.log(`RESULT: ${g.result}\nCONFIDENCE: ${g.confidence}\nREPRODUCTION: ${rp.status === "ran" ? "ran" : rp.status === "unsupported" ? `UNSUPPORTED (${rp.reason})` : `none_needed (${rp.reason})`}`);
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
