// @ts-check
// The accepted answer forms of a user-only question (A347). Question and message text are held as latin1 BYTE STRINGS by design (records.mjs readBytes), so a Turkish
// letter is two chars there; matchesAcceptedForm decodes both to real text, folds case the Turkish way (I, İ, ı, i compare equal) and keeps the negation check on bytes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedForms, matchesAcceptedForm } from '../../control-plane/agents/scripts/core/answer.mjs';

/** UTF-8 text as the core holds it (a byte string). @param {string} s */
const b = (s) => Buffer.from(s, 'utf8').toString('latin1');
/** @param {string} msg @param {string} optionsLine */
const ok = (msg, optionsLine) => matchesAcceptedForm(b(msg), ['1. Soru?', '   USER_ONLY: scope D-1', b(optionsLine)]);

const TR2 = 'seçenekler: "böl" | "devam"';
const TR = 'seçenekler: "şimdi" | "sonra"';
const EN = 'options: "report it, out of scope" | "fix it in this change"';

test('a Turkish options line is found and its forms match, in lower and upper case', () => {
  assert.ok(ok('böl', TR2));
  assert.ok(ok('BÖL', TR2));
  assert.ok(ok('Böl.', TR2));
  assert.ok(ok('  böl!', TR2));
  assert.ok(ok('böl, lütfen', TR2));
  assert.ok(ok('DEVAM', TR2));
  assert.ok(ok('böl', 'SEÇENEKLER: "böl" | "devam"'), 'the key in capitals');
  assert.ok(ok('böl', 'secenekler: "böl" | "devam"'), 'the ASCII spelling of the key');
});

test('a longer word that starts with a form is not the form: bölüm is not böl', () => {
  assert.ok(!ok('bölüm', TR2));
  assert.ok(!ok('BÖLÜM', TR2));
  assert.ok(!ok('bölge', TR2));
  assert.ok(!ok('devamı', TR2));
});

test('every Turkish letter folds: ç ğ ı İ ş ö ü and I/i', () => {
  const line = 'seçenekler: "çık" | "ığdır" | "şüphe" | "ürün" | "iyi" | "öğle"';
  for (const msg of ['ÇIK', 'çık', 'IĞDIR', 'ığdır', 'İĞDIR', 'ŞÜPHE', 'Ürün', 'İYİ', 'IYI', 'iyi', 'ÖĞLE']) assert.ok(ok(msg, line), msg);
  assert.ok(!ok('çıkış', line), 'çıkış is another word than çık');
  assert.ok(ok('FIX IT', 'options: "fix it" | "leave it"'), 'English capital I still matches');
});

test('negations and conditions after a Turkish form record nothing', () => {
  assert.ok(!ok('böl ama değil', TR2));
  assert.ok(!ok('BÖL AMA DEĞİL', TR2));
  assert.ok(!ok('böl, hayır', TR2));
  assert.ok(!ok('böl eğer olursa', TR2));
  assert.ok(!ok('böl, yerine devam', TR2));
  assert.ok(!ok('böl unless the reviewer objects', TR2));
});

test('two forms, or the other form named anywhere, give neither', () => {
  assert.ok(!ok('böl ve devam', TR2));
  assert.ok(!ok('devam ya da böl', TR2));
});

test('quoted forms, a) prefixes and backticks', () => {
  assert.ok(ok('şimdi', TR));
  assert.ok(ok('Şimdi.', TR));
  assert.ok(ok('SONRA', TR));
  assert.ok(!ok('a) böl', 'seçenekler: a) böl | b) devam'), 'the prefix a) is not part of the form');
  assert.ok(ok('böl', 'seçenekler: a) böl | b) devam'));
  assert.ok(ok('DEVAM', 'seçenekler: a) böl | b) devam'));
  assert.ok(ok('devam', 'seçenekler: `böl` | `devam`'));
  assert.ok(ok('gönder', "seçenekler: 'gönder' | 'sakla'"));
  assert.ok(ok('SAKLA', "seçenekler: 'gönder' | 'sakla'"));
});

test('English options lines keep working', () => {
  assert.ok(ok('report it, out of scope', EN));
  assert.ok(ok('Report it, out of scope', EN));
  assert.ok(ok('FIX IT IN THIS CHANGE.', EN));
  assert.ok(!ok('report it, out of scope and also fix it in this change', EN));
  assert.ok(!ok('fix it in this changes', EN));
  assert.ok(!ok('please do not fix it in this change', EN));
  assert.ok(!ok('fix it in this change but wait', EN));
  assert.ok(ok('proceed', 'Options: "proceed" | "stop"'));
});

const M = (/** @type {number} */ c) => String.fromCharCode(c);

test('no options line, and a message in decomposed Unicode', () => {
  assert.ok(!matchesAcceptedForm(b('böl'), ['1. Soru?', '   USER_ONLY: scope']));
  const decomposed = `bo${M(0x308)}l`;   // o + combining diaeresis, as a Mac keyboard may send it
  assert.equal(decomposed.length, 4);
  assert.notEqual(decomposed, 'böl');
  assert.ok(ok(decomposed, TR2), 'o + combining diaeresis equals the letter (NFC)');
  assert.ok(ok(decomposed.toUpperCase(), TR2));
  assert.ok(ok('böl', `seçenekler: "bo${M(0x308)}l" | "devam"`), 'a decomposed form in the question');
});

test('a combining mark after a form is part of the next letter, not a word boundary', () => {
  const line = 'options: "evet" | "hayır"';
  assert.ok(ok('evet', line));
  assert.ok(!ok(`evet${M(0x301)}`, line), 'e + acute makes a letter');
  assert.ok(!ok(`evek${M(0x20dd)}`, 'options: "evek" | "no"'), 'a mark that has no precomposed letter is not a boundary either');
});

test('Turkish hedges, inflected or bare, record nothing (a finite stem list, A347)', () => {
  for (const hedge of ['böl, emin değilim', 'böl değildir', 'böl, istemiyorum', 'böl yapma', 'böl, asla', 'böl fakat', 'böl ancak', 'böl, bekle', 'böl iptal', 'böl, vazgeçtim', 'böl, sanmam', 'böl mü?', 'böl?', 'böl, belki', 'BÖL, HAYIR', 'böl, bekleyin', 'böl etme', 'böl, istemem']) {
    assert.ok(!ok(hedge, TR2), hedge);
  }
  assert.ok(!ok('böl ? devam', TR2), 'a question mark anywhere');
});

test('Turkish answers that still record: the form, a full stop, a filler', () => {
  for (const yes of ['böl', 'BÖL.', 'Böl, lütfen', 'böl lütfen', 'böl!']) assert.ok(ok(yes, TR2), yes);
});

test('the English hedges are unchanged and the matcher refuses a question mark itself', () => {
  const line = 'options: "proceed" | "stop"';
  for (const hedge of ['proceed, but wait', 'proceed unless it breaks', 'proceed if possible', 'proceed?', 'proceed, maybe']) assert.ok(!ok(hedge, line), hedge);
  assert.ok(ok('proceed, thanks', line));
});

test('acceptedForms lists the forms as the question wrote them, as a byte string', () => {
  assert.deepEqual(acceptedForms(['x', b('seçenekler: a) "Böl" | "devam et"')]), [b('Böl'), b('devam et')]);
  assert.deepEqual(acceptedForms(['x']), []);
});
