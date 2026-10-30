import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseYouTubeStream, classifyMediaResponse, addMedia, bestYouTubeAudio, buildMediaMenu, youtubeFilename, currentYouTubeMedia,
  isYouTubeSabr,
} from "../src/lib/media.js";
import { loadBackground } from "./helpers/chrome-mock.js";

const MB = 1024 * 1024;
const yt = (params, host = "rr3---sn-abc.googlevideo.com") =>
  `https://${host}/videoplayback?${new URLSearchParams({ expire: "1", id: "o-vid1", ...params })}`;

const VIDEO = yt({ itag: "137", mime: "video/mp4", clen: String(80 * MB), range: "0-1000", rn: "4", rbuf: "0" });
const AUDIO = yt({ itag: "140", mime: "audio/mp4", clen: String(6 * MB), range: "0-999", rn: "5" });
const AUDIO_SMALL = yt({ itag: "139", mime: "audio/mp4", clen: String(2 * MB) });
const MUXED = yt({ itag: "18", mime: "video/mp4", clen: String(20 * MB) });

test("parseYouTubeStream reads itag, mime, clen and strips range params", () => {
  const v = parseYouTubeStream(VIDEO);
  assert.equal(v.kind, "video");
  assert.equal(v.ext, "mp4");
  assert.equal(v.size, 80 * MB);
  assert.deepEqual(v.youtube, { id: "o-vid1", itag: 137, track: "video", quality: "1080p" });
  const u = new URL(v.url);
  for (const p of ["range", "rn", "rbuf"]) assert.equal(u.searchParams.has(p), false, p);
  assert.equal(u.searchParams.get("itag"), "137");

  assert.equal(parseYouTubeStream(AUDIO).youtube.track, "audio");
  assert.equal(parseYouTubeStream(AUDIO).ext, "m4a");
  assert.equal(parseYouTubeStream(MUXED).youtube.track, "muxed");
  assert.equal(parseYouTubeStream(yt({ itag: "251", mime: "audio/webm" })).ext, "weba");
});

test("parseYouTubeStream rejects SABR, POST, missing itag and other hosts", () => {
  assert.equal(parseYouTubeStream(yt({ itag: "137", sabr: "1" })), null);
  assert.equal(parseYouTubeStream(VIDEO, "POST"), null);
  assert.equal(parseYouTubeStream(yt({ mime: "video/mp4" })), null);
  assert.equal(parseYouTubeStream(yt({ itag: "137" }, "evil.example.com")), null);
  assert.equal(parseYouTubeStream("https://googlevideo.com.evil.net/videoplayback?itag=137"), null);
  assert.equal(parseYouTubeStream("not a url"), null);
});

test("classifyMediaResponse uses the YouTube parser even for octet-stream segments", () => {
  const e = classifyMediaResponse({ url: VIDEO, statusCode: 200, method: "GET", responseHeaders: [{ name: "Content-Type", value: "application/vnd.yt-ump" }] });
  assert.equal(e.youtube.itag, 137);
  assert.equal(e.size, 80 * MB);
});

test("addMedia collapses YouTube requests by video id and itag", () => {
  const list = [];
  addMedia(list, parseYouTubeStream(VIDEO));
  addMedia(list, parseYouTubeStream(VIDEO.replace("range=0-1000", "range=1001-2000")));
  addMedia(list, parseYouTubeStream(AUDIO));
  assert.equal(list.length, 2);
});

test("bestYouTubeAudio picks the largest audio track for the same video", () => {
  const list = [parseYouTubeStream(AUDIO_SMALL), parseYouTubeStream(AUDIO), parseYouTubeStream(yt({ itag: "141", mime: "audio/mp4", clen: String(9 * MB), id: "other" }))];
  assert.equal(bestYouTubeAudio(list, "o-vid1").youtube.itag, 140);
  assert.equal(bestYouTubeAudio(list, "nope"), null);
});

test("currentYouTubeMedia keeps only the most recent video's streams", () => {
  const list = [];
  addMedia(list, parseYouTubeStream(yt({ itag: "137", mime: "video/mp4", id: "old" })));
  addMedia(list, parseYouTubeStream(VIDEO));
  addMedia(list, { url: "https://c.com/a.mp4", size: 5 * MB, kind: "video", ext: "mp4" });
  const ids = currentYouTubeMedia(list).map((e) => e.youtube?.id ?? "plain");
  assert.deepEqual(ids, ["plain", "o-vid1"]);
});

test("buildMediaMenu names YouTube tracks and flags paired audio", () => {
  const sniffed = [];
  addMedia(sniffed, parseYouTubeStream(AUDIO));
  addMedia(sniffed, parseYouTubeStream(VIDEO));
  const menu = buildMediaMenu(["blob:https://www.youtube.com/x"], sniffed);
  assert.deepEqual(menu.map((m) => m.name), ["YouTube 1080p · video only", "YouTube 128k · audio only"]);
  assert.match(menu[0].label, /\+ audio file/);
  assert.doesNotMatch(menu[1].label, /\+ audio file/);
});

test("youtubeFilename cleans the page title", () => {
  const v = parseYouTubeStream(VIDEO).youtube;
  assert.equal(youtubeFilename("(3) My: Clip? - YouTube", v, "mp4"), "My_ Clip_ [1080p video].mp4");
  assert.equal(youtubeFilename("", parseYouTubeStream(MUXED).youtube, "mp4"), "youtube-video [360p].mp4");
});

async function sniff(m, url) {
  await m.emit("webRequest.onHeadersReceived", { tabId: 7, type: "xmlhttprequest", method: "GET", url, statusCode: 200, responseHeaders: [] });
  await m.flush();
  await m.flush();
}

test("downloading a YouTube video-only track also queues its audio, with titled names", async () => {
  const m = await loadBackground();
  await sniff(m, AUDIO);
  await sniff(m, VIDEO);
  const sender = m.senders.tab(7, "https://www.youtube.com/watch?v=abc");
  const menu = (await m.sendMessage({ type: "pdm:getMedia", elementUrls: [] }, sender)).result;
  const res = await m.sendMessage({ type: "pdm:downloadMedia", url: menu[0].url, title: "Cats - YouTube" }, sender);
  assert.equal(res.ok, true);
  assert.equal(res.result.urls.length, 2);
  assert.equal(m.calls.downloads.length, 2);

  const names = [];
  for (const [i, d] of m.calls.downloads.entries()) {
    const s = await m.determine({ id: 50 + i, url: d.url, finalUrl: d.url, filename: "videoplayback", mime: "", byExtensionId: "pdm-test", totalBytes: 0 });
    names.push(s.filename);
  }
  assert.deepEqual(names, ["PDM/Video/Cats [1080p video].mp4", "PDM/Music/Cats [128k audio].m4a"]);
});

test("downloading a muxed YouTube stream queues a single file", async () => {
  const m = await loadBackground();
  await sniff(m, AUDIO);
  await sniff(m, MUXED);
  const sender = m.senders.tab(7, "https://www.youtube.com/watch?v=abc");
  const url = parseYouTubeStream(MUXED).url;
  const res = await m.sendMessage({ type: "pdm:downloadMedia", url, title: "Cats" }, sender);
  assert.deepEqual(res.result.urls, [url]);
});
test("isYouTubeSabr detects sabr=1 and POST videoplayback requests only", () => {
  assert.equal(isYouTubeSabr(yt({ sabr: "1", rn: "1" }), "POST"), true);
  assert.equal(isYouTubeSabr(yt({ sabr: "1" })), true);
  assert.equal(isYouTubeSabr(yt({ itag: "137" }), "POST"), true);
  assert.equal(isYouTubeSabr(VIDEO), false);
  assert.equal(isYouTubeSabr("https://example.com/videoplayback?sabr=1"), false);
  assert.equal(isYouTubeSabr("nope"), false);
});

test("SABR traffic is reported to the tab and cleared on navigation", async () => {
  const m = await loadBackground();
  const sender = m.senders.tab(7, "https://www.youtube.com/watch?v=abc");
  assert.deepEqual((await m.sendMessage({ type: "pdm:mediaStatus" }, sender)).result, { sabr: false });

  await m.emit("webRequest.onHeadersReceived", { tabId: 7, type: "xmlhttprequest", method: "POST", url: yt({ sabr: "1", rn: "1" }), statusCode: 200, responseHeaders: [] });
  await m.flush();
  await m.flush();
  assert.deepEqual((await m.sendMessage({ type: "pdm:mediaStatus" }, sender)).result, { sabr: true });
  assert.deepEqual((await m.sendMessage({ type: "pdm:getMedia", elementUrls: [] }, sender)).result, []);
  assert.ok(m.calls.tabMessages.some((x) => x.tabId === 7 && x.msg.type === "pdm:mediaFound"));
  assert.deepEqual((await m.sendMessage({ type: "pdm:mediaStatus" }, m.senders.tab(8))).result, { sabr: false });

  await m.emit("webRequest.onHeadersReceived", { tabId: 7, type: "main_frame", method: "GET", url: "https://www.youtube.com/", statusCode: 200, responseHeaders: [] });
  await m.flush();
  assert.deepEqual((await m.sendMessage({ type: "pdm:mediaStatus" }, sender)).result, { sabr: false });
});
