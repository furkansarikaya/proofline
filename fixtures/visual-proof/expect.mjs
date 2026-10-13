// Compares a measured report of the visual-proof fixture with the planted facts of EXPECTED.md.
//   node expect.mjs <report.json> <spec.md>
// Exit 0 when the measured failures are exactly the planted ones and no trap is flagged.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateReport } from "../../skills/visual-proof/scripts/validate-visual.mjs";

const [file, spec] = process.argv.slice(2);
const report = JSON.parse(readFileSync(file, "utf8"));
const problems = [];
const VPS = ["phone", "tablet", "desktop"], RENDERED = ["success", "empty", "loading"];

// Planted facts (EXPECTED.md 1-5): check, state, viewport, a selector fragment.
const planted = [];
for (const st of RENDERED) {
  planted.push(["horizontal_scroll", st, "phone", "html"], ["viewport_overflow", st, "phone", "promo-banner"]);
  for (const vp of VPS) planted.push(["contrast", st, vp, "hint"], ["touch_target", st, vp, "#clear-search"]);
}
for (const vp of VPS) planted.push(["state_rendered", "error", vp, "[data-state=error]"]);

const fails = report.measured.filter((m) => m.status === "fail");
for (const [check, state, viewport, frag] of planted) {
  if (!fails.some((m) => m.check === check && m.state === state && m.viewport === viewport && m.selector.includes(frag))) problems.push(`missed planted failure: ${check} ${state}/${viewport} ${frag}`);
}
for (const m of fails) {
  if (!planted.some(([c, s, v, f]) => m.check === c && m.state === s && m.viewport === v && m.selector.includes(f))) problems.push(`unexpected failure (false positive): ${m.id} ${m.check} ${m.state}/${m.viewport} ${m.selector}`);
}
// Traps (EXPECTED.md 7-8): the carousel and the skip link are correct.
for (const vp of ["tablet", "desktop"]) {
  if (!report.measured.some((m) => m.check === "horizontal_scroll" && m.state === "success" && m.viewport === vp && m.status === "pass")) problems.push(`trap: success/${vp} must measure horizontal_scroll as pass (the carousel scrolls inside itself)`);
}
if (fails.some((m) => /carousel|card|skip-link/.test(m.selector))) problems.push("trap flagged: carousel or skip link reported as a failure");
// Trap (EXPECTED.md 9): a focusable scroller between two links is an extra Tab stop, not a focus-order failure.
if (fails.some((m) => m.screen === "log")) problems.push("trap flagged: the log page (link, scroller, link) reported a failure");
if (report.measured.filter((m) => m.screen === "log" && m.check === "focus_order" && m.status === "pass").length !== VPS.length) problems.push("trap: log page focus_order must pass at every viewport");
if (!report.measured.some((m) => m.check === "hidden_interactive" && m.status === "pass")) problems.push("trap: hidden_interactive must pass (the skip link becomes visible on focus)");
const want = { "AC-1": "failed", "AC-2": "failed", "AC-3": "failed", "AC-4": "failed", "AC-5": "proven" };
for (const c of report.criteria) if (want[c.id] !== c.status) problems.push(`criterion ${c.id}: ${c.status}, expected ${want[c.id]}`);
if (report.result !== "FAIL") problems.push(`result ${report.result}, expected FAIL`);
// Judged items are QA's to add; everything else must already validate.
const v = validateReport(report, { root: dirname(file), specTexts: [readFileSync(spec, "utf8")] });
for (const e of v.errors.filter((e) => !/needs a judged item/.test(e))) problems.push(`validator: ${e}`);

if (problems.length) { problems.forEach((p) => console.error(`expect: ${p}`)); process.exit(1); }
console.log(`expect: visual-proof fixture ok (${fails.length} planted failures measured, traps clear)`);
