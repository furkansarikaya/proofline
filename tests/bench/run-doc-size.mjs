// @ts-check
// Run document size (A202, item 20; in Node since A244). Not run by CI. No model: it builds a fixture run for each class with the harness fixtures (the Node core installed beside agent.sh)
// and prints the bytes of the documents the run holds, plus the bytes of the templates a model starts from.
//   node tests/bench/run-doc-size.mjs
// To compare with another version, run the script of that checkout (a checkout older than 0.0.78 has the shell form, `sh tests/bench/run-doc-size.sh`; the output is the same).
//
// Honest limit: a fixture run holds the documents the fixture helpers write (short stand-ins for what a model writes) plus what the scripts themselves add (the Facts block and, since
// A202, the summary block's Look-at lines). The model-written text is not measured; the template bytes show what each document asks the model to start from.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { A, agentsSrc, scaffold, toCodeDone, writeReport } from '../lib/harness.mjs';

const DOCS = ['TASK', 'PLAN', 'EVIDENCE', 'QA_PLAN', 'QA_REPORT', 'REVIEW', 'VERIFY', 'COMPLETION_REPORT'];
const TEMPLATES = ['PLAN', 'EVIDENCE', 'QA_PLAN', 'QA_REPORT', 'REVIEW', 'COMPLETION_REPORT'];

/** The report text. @returns {string} */
export function report() {
  const out = [`${'class'.padEnd(9)} document bytes (fixture run: documents the run holds)`];
  for (const cls of ['TRIVIAL', 'STANDARD', 'COMPLEX']) {
    const d = scaffold({ topology: 'standalone', cls });
    try { toCodeDone(d, 'standalone'); } catch { out.push(`${cls}: the fixture could not reach CODE_DONE`); continue; }
    A(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']);
    writeReport(d);
    if (A(d, ['publish-completion-report', 'LC', 'markdown']).status !== 0) { out.push(`${cls}: the fixture report was not published`); continue; }
    let total = 0; let line = '';
    for (const n of DOCS) {
      const f = path.join(d, `.agents/runs/LC/${n}.md`);
      if (!existsSync(f)) continue;
      const bytes = statSync(f).size; total += bytes; line += ` ${n}=${bytes}`;
    }
    out.push(`${cls.padEnd(9)} total=${total}  (${line} )`);
  }
  out.push('', 'templates a model starts from (control-plane/agents/templates):');
  let total = 0; let line = '';
  for (const n of TEMPLATES) {
    const f = path.join(agentsSrc, 'templates', `${n}.md`);
    if (!existsSync(f)) continue;
    const bytes = readFileSync(f).length; total += bytes; line += `  ${n}=${bytes}`;
  }
  out.push(line, `  total=${total}`);
  return `${out.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(report());
