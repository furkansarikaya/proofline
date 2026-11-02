// @ts-check
// Behaviour of identity-test.sh sc_language_* (A171, A172, A178) as absolute Node tests (tests/legacy-port-map.tsv): run artifacts are English, a
// quotation of product text (TASK.md, the user's prompts, COMMITTED files) is exempt on word boundaries, nothing else is. The Node check reads no cache
// file at all: the "forged cache" attack of the shell version has nothing to forge.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, project, refused } from './legacy-lib.mjs';

const TR = 'Siparişleriniz başarıyla kaydedildi, teşekkürler';
const LANG_RUN = `SC_TASK_EXTRA="- AC-2: the page says \\\`${TR}\\\`" scaffold standalone no STANDARD manual; git add -A >/dev/null 2>&1 || :; git commit -qm lang-fixture >/dev/null 2>&1 || :`;
const REFUSED = 'language: run artifacts are English';
const Q = '.agents/runs/LC/QA_PLAN.md';
const put = (/** @type {string} */ d, /** @type {string} */ body) => writeFileSync(`${d}/${Q}`, `# QA plan\n\n${body}\n`);
const git = (/** @type {string} */ d, /** @type {string[]} */ ...a) => execFileSync('git', ['-C', d, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });

test('language: a Turkish sentence of TASK.md is accepted in backticks, double quotes, a ">" block, a fence and a JSON value', () => {
  const d = project(LANG_RUN);
  for (const form of [`Expect \`${TR}\` on the page.`, `Expect "${TR}" on the page.`, `> ${TR}`, `{"text": "${TR}"}`, `\`\`\`\n${TR}\n\`\`\``]) {
    put(d, form);
    accepted(A(d, ['language-check', Q]), `a quoted product sentence was refused: ${form}`);
  }
});

test('language: an invented sentence is refused in every quote form; an untracked file is no source', () => {
  const d = project(LANG_RUN);
  const other = 'Hesabınız silindi, lütfen tekrar giriş yapın şimdi';
  for (const form of [`Expect \`${other}\` on the page.`, `Expect "${other}" on the page.`, `> ${other}`, `{"text": "${other}"}`, `\`\`\`\n${other}\n\`\`\``]) {
    put(d, form);
    refused(A(d, ['language-check', Q]), `an invented sentence passed: ${form}`, REFUSED);
  }
  writeFileSync(`${d}/untracked-note.txt`, `${other}\n`);
  put(d, `Expect \`${other}\` on the page.`);
  refused(A(d, ['language-check', Q]), 'a sentence found only in an untracked file was accepted', REFUSED);
});

test('language: committed product text is quotable on word boundaries; a staged file is no source', () => {
  const d = project(LANG_RUN);
  const prod = 'Sepetiniz şu anda boş görünüyor, ürün ekleyin'; const staged = 'Ödeme sayfası açılmadı, tekrar deneyiniz lütfen şimdi';
  writeFileSync(`${d}/staged.html`, `<p>${staged}</p>\n`); git(d, 'add', 'staged.html');
  put(d, `Expect \`${staged}\` on the page.`);
  refused(A(d, ['language-check', Q]), 'a sentence found only in a STAGED file was accepted', REFUSED);
  writeFileSync(`${d}/page.html`, `<p>${prod}</p>\n`); git(d, 'add', 'page.html'); git(d, 'commit', '-qm', 'page');
  put(d, `Expect \`${prod}\` on the page.`);
  accepted(A(d, ['language-check', Q]), 'a sentence of a committed product file was refused');
  put(d, 'Expect `Sepetiniz şu anda boş` on the page.');
  accepted(A(d, ['language-check', Q]), 'a whole-word piece of a committed sentence was refused');
  put(d, 'Expect `epetiniz şu anda boş görünüyor, ürün ekleyi` on the page.');
  refused(A(d, ['language-check', Q]), 'a piece cut inside a word was accepted', REFUSED);
});

test('language: no cache file is read or written, so a sentence planted in .agents/local/language vouches for nothing; committed text still passes', () => {
  const d = project(LANG_RUN);
  const prod = 'Sepetiniz şu anda boş görünüyor, ürün ekleyin'; const forged = 'Bu cümle depoda yok, çünkü onu ben yazdım şimdi';
  writeFileSync(`${d}/page.html`, `<p>${prod}</p>\n`); git(d, 'add', 'page.html'); git(d, 'commit', '-qm', 'page');
  put(d, `Expect \`${prod}\` on the page.`);
  accepted(A(d, ['language-check', Q]), 'a committed sentence was refused');
  assert.ok(!existsSync(`${d}/.agents/local/language`), 'a committed-text cache was written');
  mkdirSync(`${d}/.agents/local/language`, { recursive: true });
  writeFileSync(`${d}/.agents/local/language/forged.corpus`, ` ${forged} `); writeFileSync(`${d}/.agents/local/language/forged.words`, `${forged.split(/[\s,]+/).join('\n')}\n`);
  put(d, `Expect \`${forged}\` on the page.`);
  refused(A(d, ['language-check', Q]), 'a sentence forged into the cache was accepted', REFUSED);
  put(d, `Expect \`${prod}\` on the page.`);
  accepted(A(d, ['language-check', Q]), 'a committed sentence was refused after the cache was forged');
});

test('language: reviews/visual-proof and reports/qa-evidence hold screen text', () => {
  const d = project(LANG_RUN);
  mkdirSync(`${d}/.agents/runs/LC/reviews/visual-proof`, { recursive: true }); mkdirSync(`${d}/.agents/runs/LC/reports/qa-evidence`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/reviews/visual-proof/report.json`, '{"screens":[{"text":"Hesabınız silindi, lütfen tekrar giriş yapın şimdi"}]}\n');
  writeFileSync(`${d}/.agents/runs/LC/reports/qa-evidence/shot.md`, '# Evidence\n\nEkranda: Hesabınız silindi, lütfen tekrar giriş yapın şimdi\n');
  accepted(A(d, ['language-check', `${d}/.agents/runs/LC/reviews/visual-proof/report.json`]), 'visual-proof output was blocked');
  accepted(A(d, ['language-check', `${d}/.agents/runs/LC/reports/qa-evidence/shot.md`]), 'qa-evidence was blocked');
});

test('language: the question block stored by ask is exempt (A178); the same text elsewhere is refused', () => {
  const d = project('scaffold standalone no STANDARD manual');
  const run = `${d}/.agents/runs/LC`;
  const trq = '1. Plan 46 kapsam yolu içeriyor; görev bölünsün mü? Önerim: her biri en fazla 15 yol içeren görevlere bölmek.\n   seçenekler: "böl" | "bölmeden devam"\n   önerilen: böl\n   neden: büyük kapsam gözden geçirmeyi ve geri almayı zorlaştırır';
  writeFileSync(`${d}/.agents/local/trq.md`, `${trq}\n`);
  accepted(A(d, ['ask', 'LC', '--file', `${d}/.agents/local/trq.md`]), 'ask refused the Turkish question block');
  accepted(A(d, ['language-check', `${run}/questions/001.md`]), 'the script\'s own Turkish question file is refused by the language check');
  mkdirSync(`${run}/results`, { recursive: true });
  writeFileSync(`${run}/results/001-implementer.result.md`, `${trq}\n`);
  refused(A(d, ['language-check', `${run}/results/001-implementer.result.md`]), 'Turkish text in a result file', REFUSED);
  writeFileSync(`${run}/PLAN.md`, `# Plan\n\n${trq}\n`);
  refused(A(d, ['language-check', `${run}/PLAN.md`]), 'Turkish text in PLAN.md', REFUSED);
  for (const deep of ['results/questions/001.md', 'reviews/a/questions/001.md', 'reports/questions/002.md']) {
    mkdirSync(`${run}/${deep.slice(0, deep.lastIndexOf('/'))}`, { recursive: true });
    writeFileSync(`${run}/${deep}`, `${trq}\n`);
    refused(A(d, ['language-check', `${run}/${deep}`]), `Turkish text in ${deep}`, REFUSED);
    refused(A(d, ['language-check', `.agents/runs/LC/${deep}`]), `Turkish text in ${deep} (relative path)`, REFUSED);
  }
  accepted(A(d, ['language-check', '.agents/runs/LC/questions/001.md']), 'the question file is refused by its relative path');
  writeFileSync(`${run}/questions/notes.md`, `${trq}\n`);
  refused(A(d, ['language-check', `${run}/questions/notes.md`]), 'Turkish text in a non-question file of questions/', REFUSED);
});

test('language: the reject message says quote the project\'s text, do not transliterate, do not ask', () => {
  const d = project('scaffold standalone no STANDARD manual');
  writeFileSync(`${d}/.agents/local/m.md`, 'Hesabınız silindi, lütfen tekrar giriş yapın şimdi\n');
  const r = A(d, ['language-check', `${d}/.agents/local/m.md`]);
  refused(r, 'unquoted Turkish passed', REFUSED);
  for (const want of ['Do NOT transliterate', 'do NOT ask the user', 'quote the text that exists in the project']) assert.ok(r.text.includes(want), `the reject message lacks: ${want}`);
  assert.match(r.out, /^language: run artifacts are English, but line 1 holds non-English text\./);
});
