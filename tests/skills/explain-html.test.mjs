import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { check, MAX_BYTES } = await import(join(repo, "skills/explain-html/scripts/check-html.mjs"));
const good = readFileSync(join(repo, "fixtures/explain-html/page.html"), "utf8");
const msgs = (h, bytes) => check(h, bytes).map((f) => f.msg);

test("the fixture page passes", () => assert.deepEqual(check(good), []));

test("the writing profile copy is byte-identical to tests/shared", () =>
  assert.equal(readFileSync(join(repo, "skills/explain-html/references/WRITING.md"), "utf8"), readFileSync(join(repo, "tests/shared/writing-profile.md"), "utf8")));

test("external references are rejected in attributes, CSS and JS", () => {
  const bad = [
    '<img src="https://a.example/x.png">',
    '<a href="http://a.example/">x</a>',
    '<style>body{background:url(https://a.example/x.png)}</style>',
    '<style>@import "other.css";</style>',
    '<script>fetch("/api")</script>',
    '<script src="x.js"></script>',
    '<link rel="stylesheet" href="x.css">',
    '<script src="//cdn.example/x.js"></script>',
    '<style>body{background:url(//cdn.example/x.png)}</style>',
  ];
  for (const b of bad) assert.ok(check(good.replace("</body>", b + "</body>")).length > 0, b);
});

test("known bypasses are rejected", () => {
  const bad = [
    '<img src=a.png>',
    '<iframe src="other.html"></iframe>',
    '<object data="a.swf"></object>',
    '<video src="a.mp4"></video>',
    '<embed src="a.pdf">',
    '<style>body{background:url(a.png)}</style>',
    '<img\nsrc="a.png">',
    '<img srcset="x 1x,//evil/a.png 2x">',
    '<img srcset="a.png 1x">',
    '<a href="h&#116;tps://evil.example/">x</a>',
    '<a href="h&#x74;tps://evil.example/">x</a>',
    '<iframe src="data:text/html;base64,PGI+"></iframe>',
    '<form action="other.html"></form>',
    '<video poster="p.png"></video>',
    '<a href="other.html">x</a>',
  ];
  for (const b of bad) assert.ok(check(good.replace("</body>", b + "</body>")).length > 0, b);
});

test("inline images, fonts and fragments are allowed", () => {
  const ok = ['<img alt="" src="data:image/png;base64,AAAA">', '<a href="#top">x</a>', '<style>@font-face{src:url(data:font/woff2;base64,AAAA)}</style>'];
  for (const b of ok) assert.deepEqual(check(good.replace("</body>", b + "</body>")), [], b);
});

test("a title inside a comment does not count", () => {
  assert.deepEqual(msgs(good.replace(/<title>.*<\/title>/, "<!-- <title>x</title> -->")), ["missing or empty <title>"]);
});

test("the SVG namespace is allowed only as xmlns", () => {
  assert.deepEqual(check(good), []);
  assert.ok(check(good.replace("</body>", "<p>http://www.w3.org/2000/svg</p></body>")).length > 0);
});

test("a missing or empty title is rejected", () => {
  assert.deepEqual(msgs(good.replace(/<title>.*<\/title>/, "")), ["missing or empty <title>"]);
  assert.deepEqual(msgs(good.replace(/<title>.*<\/title>/, "<title>  </title>")), ["missing or empty <title>"]);
});

test("size limit is 500 KB", () => {
  assert.deepEqual(check(good, MAX_BYTES), []);
  assert.equal(check(good, MAX_BYTES + 1).length, 1);
});
