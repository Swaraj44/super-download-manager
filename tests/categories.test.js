import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CATEGORIES, OTHER_CATEGORY, categoryFor, sanitizeSegment, buildTargetPath } from "../src/lib/categories.js";

test("every default category is non-empty and lowercase", () => {
  for (const c of DEFAULT_CATEGORIES) {
    assert.ok(c.name.length > 0);
    assert.ok(c.extensions.length > 0);
    for (const e of c.extensions) assert.match(e, /^[a-z0-9]+$/);
  }
});

test("categoryFor maps extensions to categories", () => {
  assert.equal(categoryFor("zip"), "Compressed");
  assert.equal(categoryFor("pdf"), "Documents");
  assert.equal(categoryFor("FLAC"), "Music");
  assert.equal(categoryFor("mkv"), "Video");
  assert.equal(categoryFor("exe"), "Programs");
  assert.equal(categoryFor("png"), "Images");
  assert.equal(categoryFor("xyz"), OTHER_CATEGORY);
  assert.equal(categoryFor(""), OTHER_CATEGORY);
});

test("sanitizeSegment strips dangerous characters", () => {
  assert.equal(sanitizeSegment('a<b>:"c/d\\e|f?g*h'), "a_b___c_d_e_f_g_h");
  assert.equal(sanitizeSegment("  spaced  "), "spaced");
  assert.equal(sanitizeSegment(""), "_");
  assert.equal(sanitizeSegment(null), "_");
  assert.equal(sanitizeSegment("con"), "_con");
  assert.equal(sanitizeSegment(".."), "_");
});

test("buildTargetPath composes base folder, category and filename", () => {
  assert.equal(buildTargetPath("song.mp3", "Music", { baseFolder: "PDM" }), "PDM/Music/song.mp3");
  assert.equal(buildTargetPath("song.mp3", "Music", { baseFolder: "" }), "Music/song.mp3");
  assert.equal(buildTargetPath("song.mp3", "Music", { baseFolder: "PDM", useCategoryFolders: false }), "PDM/song.mp3");
  assert.equal(
    buildTargetPath('ev"il.zip', "Compressed", { baseFolder: "a/b", useCategoryFolders: false }),
    "a/b/ev_il.zip",
  );
  assert.equal(buildTargetPath("dir/sub/file.txt", "Documents", { baseFolder: "PDM" }), "PDM/Documents/file.txt");
});