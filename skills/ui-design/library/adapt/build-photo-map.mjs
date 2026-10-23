#!/usr/bin/env node
// Builds adapt/photos.json: which library photo sets may be used on a commercial product, judged from the library's own
// photos.json entries only. Unknown means not usable. Deterministic, no network, no clock.
//   The file's `source` line states the licence of every photo (a photo licence that allows commercial use). A photo is
//   usable when it also names its author and a photo page on the licence holder's own site, because the credit is kept on
//   the page and in the ledger. A photo without both is excluded by id.
//   A set is usable when it keeps at least one usable photo and is not a set of identifiable people: that licence grants
//   no model release, so portraits are unknown and therefore not usable.
//   Usage: node build-photo-map.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = JSON.parse(readFileSync(join(here, "..", "photos.json"), "utf8"));
const COMMERCIAL = /unsplash licen[cs]e/i.test(lib.source || "");
const PAGE = /^https:\/\/unsplash\.com\/photos\/[A-Za-z0-9_-]+$/;
const NO_RELEASE = new Set(["people"]);

const sets = {};
let usableSets = 0;
for (const [id, s] of Object.entries(lib.sets)) {
  const excludedPhotoIds = s.photos.filter((p) => !(p.by && PAGE.test(p.page || ""))).map((p) => p.id);
  const usablePhotos = s.photos.length - excludedPhotoIds.length;
  let usable = COMMERCIAL && usablePhotos > 0;
  let reason = "entries state a licence that allows commercial use; every kept photo names its author and photo page";
  if (!COMMERCIAL) reason = "the library states no licence that allows commercial use";
  else if (NO_RELEASE.has(id)) { usable = false; reason = "identifiable people: the licence grants no model release, so commercial use is unknown"; }
  else if (usablePhotos === 0) reason = "no photo names its author and photo page";
  else if (excludedPhotoIds.length) reason += `; ${excludedPhotoIds.length} photo(s) without a verifiable author page are excluded`;
  if (usable) usableSets += 1;
  sets[id] = { usable, reason, photos: s.photos.length, usablePhotos: usable ? usablePhotos : 0, excludedPhotoIds: usable ? excludedPhotoIds : [] };
}

const out = {
  schemaVersion: 1,
  basis: "derived from photos.json by build-photo-map.mjs; the library's own source statement is the only licence evidence",
  licenceStatement: lib.source,
  rules: [
    "download and self-host the image; never hot-link the address template",
    "check the address returns an image before relying on it",
    "keep the author credit and photo page on the page and in the ledger",
    "library photos are not the project's own images and never count as existing imagery for deal",
  ],
  counts: { sets: Object.keys(sets).length, usableSets },
  sets,
};
const text = `${JSON.stringify(out, null, 2)}\n`;
const target = join(here, "photos.json");
if (process.argv[2] === "--check") {
  let cur = "";
  try { cur = readFileSync(target, "utf8"); } catch { /* missing counts as stale */ }
  if (cur !== text) { console.error("photos.json is stale: run node build-photo-map.mjs"); process.exit(1); }
} else {
  writeFileSync(target, text);
}
