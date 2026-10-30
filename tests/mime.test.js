import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMime, extFromMime, extFromFilename, extFromUrl, STREAM_EXTENSIONS,
} from "../src/lib/mime.js";

test("normalizeMime strips parameters and lowercases", () => {
  assert.equal(normalizeMime("VIDEO/MP4; charset=binary"), "video/mp4");
  assert.equal(normalizeMime(null), "");
});

test("extFromMime maps known types", () => {
  assert.equal(extFromMime("application/pdf"), "pdf");
  assert.equal(extFromMime("application/x-zip-compressed"), "zip");
  assert.equal(extFromMime("video/mp4"), "mp4");
  assert.equal(extFromMime("audio/mpeg"), "mp3");
  assert.equal(extFromMime("text/html"), "");
});

test("extFromFilename handles edge cases", () => {
  assert.equal(extFromFilename("setup.exe"), "exe");
  assert.equal(extFromFilename("/tmp/song.MP3"), "mp3");
  assert.equal(extFromFilename("archive.tar.gz"), "gz");
  assert.equal(extFromFilename(".hidden"), "");
  assert.equal(extFromFilename("noext"), "");
  assert.equal(extFromFilename("weird.!!!"), "");
});

test("extFromUrl decodes pathname", () => {
  assert.equal(extFromUrl("https://example.com/files/report%20final.pdf"), "pdf");
  assert.equal(extFromUrl("https://example.com/download?file=x.zip"), "");
  assert.equal(extFromUrl("not a url"), "");
});

test("stream manifests are flagged", () => {
  assert.ok(STREAM_EXTENSIONS.has("m3u8"));
  assert.ok(STREAM_EXTENSIONS.has("mpd"));
});