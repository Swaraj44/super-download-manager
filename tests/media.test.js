import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_MEDIA_BYTES, header, totalSize, cleanMediaUrl, mediaKind, classifyMediaResponse, addMedia, buildMediaMenu,
} from "../src/lib/media.js";

const h = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));
const MB = 1024 * 1024;

test("header lookup is case-insensitive", () => {
  assert.equal(header(h({ "Content-Type": "video/mp4" }), "content-type"), "video/mp4");
  assert.equal(header(undefined, "x"), "");
});

test("totalSize prefers Content-Range total for 206 responses", () => {
  assert.equal(totalSize(206, h({ "Content-Range": "bytes 0-1023/5000000", "Content-Length": 1024 })), 5000000);
  assert.equal(totalSize(200, h({ "Content-Length": 42 })), 42);
  assert.equal(totalSize(200, []), 0);
});

test("cleanMediaUrl strips range parameters and hash", () => {
  assert.equal(cleanMediaUrl("https://v.com/a.mp4?id=1&range=0-999&rn=3#t=5"), "https://v.com/a.mp4?id=1");
  assert.equal(cleanMediaUrl("not a url"), "not a url");
});

test("mediaKind uses mime, then extension", () => {
  assert.equal(mediaKind("video/webm", "webm"), "video");
  assert.equal(mediaKind("audio/mpeg", "mp3"), "audio");
  assert.equal(mediaKind("", "mkv"), "video");
  assert.equal(mediaKind("", "flac"), "audio");
  assert.equal(mediaKind("audio/mpegurl", "m3u8"), "stream");
  assert.equal(mediaKind("", "zip"), null);
});

test("classifyMediaResponse accepts video and audio responses", () => {
  const v = classifyMediaResponse({ url: "https://c.com/v/movie.mp4?range=0-1", statusCode: 200, responseHeaders: h({ "Content-Type": "video/mp4", "Content-Length": 5 * MB }) });
  assert.deepEqual(v, { url: "https://c.com/v/movie.mp4", mime: "video/mp4", ext: "mp4", size: 5 * MB, kind: "video" });
  const a = classifyMediaResponse({ url: "https://c.com/song.mp3", statusCode: 206, responseHeaders: h({ "Content-Type": "application/octet-stream", "Content-Range": `bytes 0-99/${3 * MB}` }) });
  assert.equal(a.kind, "audio");
  assert.equal(a.size, 3 * MB);
});

test("classifyMediaResponse keeps stream manifests regardless of size", () => {
  const s = classifyMediaResponse({ url: "https://c.com/live/index.m3u8", statusCode: 200, responseHeaders: h({ "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": 300 }) });
  assert.equal(s.kind, "stream");
});

test("classifyMediaResponse rejects non-media, small files, segments, errors and non-http", () => {
  const big = { "Content-Length": 5 * MB };
  const cases = [
    { url: "https://c.com/page", statusCode: 200, responseHeaders: h({ "Content-Type": "text/html", ...big }) },
    { url: "https://c.com/a.mp4", statusCode: 200, responseHeaders: h({ "Content-Type": "text/html", ...big }) },
    { url: "https://c.com/i.png", statusCode: 200, responseHeaders: h({ "Content-Type": "image/png", ...big }) },
    { url: "https://c.com/blob.bin", statusCode: 200, responseHeaders: h({ "Content-Type": "application/octet-stream", ...big }) },
    { url: "https://c.com/tiny.mp4", statusCode: 200, responseHeaders: h({ "Content-Type": "video/mp4", "Content-Length": MIN_MEDIA_BYTES - 1 }) },
    { url: "https://c.com/seg1.ts", statusCode: 200, responseHeaders: h({ "Content-Type": "video/mp2t", ...big }) },
    { url: "https://c.com/chunk-1.m4s", statusCode: 200, responseHeaders: h({ "Content-Type": "application/octet-stream", ...big }) },
    { url: "https://c.com/a.mp4", statusCode: 404, responseHeaders: h({ "Content-Type": "video/mp4", ...big }) },
    { url: "data:video/mp4,xx", statusCode: 200, responseHeaders: h({ "Content-Type": "video/mp4", ...big }) },
  ];
  for (const c of cases) assert.equal(classifyMediaResponse(c), null, c.url);
});

test("addMedia dedupes by clean URL, keeps the larger size, newest first, capped", () => {
  const list = [];
  addMedia(list, { url: "https://c.com/a.mp4?range=0-9", size: 10, kind: "video" });
  addMedia(list, { url: "https://c.com/b.mp4", size: 5, kind: "video" });
  addMedia(list, { url: "https://c.com/a.mp4?range=10-19", size: 0, kind: "video" });
  assert.deepEqual(list.map((e) => [e.url, e.size]), [["https://c.com/a.mp4", 10], ["https://c.com/b.mp4", 5]]);
  for (let i = 0; i < 10; i++) addMedia(list, { url: `https://c.com/${i}.mp4`, size: 1, kind: "video" }, 4);
  assert.equal(list.length, 4);
});

test("buildMediaMenu puts player sources first, then largest, streams last", () => {
  const sniffed = [
    { url: "https://c.com/live.m3u8", ext: "m3u8", size: 0, kind: "stream" },
    { url: "https://c.com/small.mp4", ext: "mp4", size: 2 * MB, kind: "video" },
    { url: "https://c.com/big.mp4", ext: "mp4", size: 9 * MB, kind: "video" },
    { url: "https://c.com/player.webm", ext: "webm", size: 4 * MB, kind: "video" },
  ];
  const menu = buildMediaMenu(["blob:https://c.com/x", "https://c.com/player.webm", "https://c.com/extra.mp4", "junk"], sniffed);
  assert.deepEqual(menu.map((m) => m.name), ["player.webm", "extra.mp4", "big.mp4", "small.mp4", "live.m3u8"]);
  assert.equal(menu[0].label, "WEBM · 4.0 MB · player");
  assert.equal(menu[1].label, "MP4 · size unknown · player");
  assert.equal(menu[4].kind, "stream");
  assert.match(menu[4].label, /not downloadable/);
});