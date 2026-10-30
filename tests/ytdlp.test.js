import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  checkUrl, createProgress, formatArgs, normalizeYtJob, outputDir, summarizeFormats, ytdlpArgs,
} from "../native/ytdlp-lib.mjs";
import { createHost } from "../native/ffmpeg-host-lib.mjs";
import { describeYtRequest, isYtdlpSite, normalizeYtRequest } from "../src/lib/ytdlp.js";
import { loadBackground } from "./helpers/chrome-mock.js";

const WATCH = "https://www.youtube.com/watch?v=DS-raAyMxl4";

test("checkUrl accepts http(s) only", () => {
  assert.equal(checkUrl(WATCH), WATCH);
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "", "x".repeat(5000), 42]) {
    assert.throws(() => checkUrl(bad), /URL/);
  }
});

test("outputDir stays inside the root", () => {
  assert.equal(outputDir("/home/u/Downloads", "SDM/Video"), resolve("/home/u/Downloads", "SDM", "Video"));
  assert.equal(outputDir("/home/u/Downloads", ""), resolve("/home/u/Downloads"));
  for (const bad of ["../x", "SDM/../../etc", "a\\b", "a:b"]) assert.throws(() => outputDir("/home/u/Downloads", bad), /Invalid/);
});

test("normalizeYtJob validates mode, quality, container and audio format", () => {
  assert.deepEqual(normalizeYtJob({ url: WATCH, mode: "video", quality: "720", container: "mp4" }),
    { url: WATCH, mode: "video", quality: "720", container: "mp4" });
  assert.deepEqual(normalizeYtJob({ url: WATCH, mode: "audio", audioFormat: "mp3" }), { url: WATCH, mode: "audio", audioFormat: "mp3" });
  assert.throws(() => normalizeYtJob({ url: WATCH, mode: "video", quality: "999", container: "mp4" }), /quality/);
  assert.throws(() => normalizeYtJob({ url: WATCH, mode: "video", quality: "720", container: "avi" }), /video format/);
  assert.throws(() => normalizeYtJob({ url: WATCH, mode: "audio", audioFormat: "wav; rm" }), /audio format/);
  assert.throws(() => normalizeYtJob({ url: WATCH, mode: "exec" }), /Unknown/);
});

test("format args put resolution before codec preference", () => {
  assert.deepEqual(formatArgs({ mode: "video", quality: "1080", container: "mp4" }),
    ["-f", "bv*+ba/b", "-S", "res:1080,vcodec:h264,acodec:aac", "--merge-output-format", "mp4/mkv"]);
  assert.deepEqual(formatArgs({ mode: "video", quality: "best", container: "mkv" }),
    ["-f", "bv*+ba/b", "-S", "res", "--merge-output-format", "mkv"]);
  assert.deepEqual(formatArgs({ mode: "audio", audioFormat: "m4a" }), ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"]);
});

test("ytdlpArgs ignores config, never overwrites and ends with -- url", () => {
  const args = ytdlpArgs({ url: "https://x.test/-v", mode: "audio", audioFormat: "mp3" }, { dir: "/d", ffmpeg: "/bin/ffmpeg", node: "/bin/node" });
  assert.equal(args[0], "--ignore-config");
  for (const flag of ["--no-playlist", "--no-overwrites"]) assert.ok(args.includes(flag));
  assert.deepEqual(args.slice(-2), ["--", "https://x.test/-v"]);
  assert.equal(args[args.indexOf("--ffmpeg-location") + 1], "/bin/ffmpeg");
  assert.equal(args[args.indexOf("--js-runtimes") + 1], "node:/bin/node");
  assert.ok(!ytdlpArgs({ url: WATCH, mode: "audio", audioFormat: "m4a" }, { dir: "/d", ffmpeg: "ffmpeg" }).includes("--ffmpeg-location"));
  const win = ytdlpArgs({ url: WATCH, mode: "audio", audioFormat: "m4a" }, { dir: "C:\\d", ffmpeg: "C:\\ffmpeg\\bin\\ffmpeg.exe" });
  assert.equal(win[win.indexOf("--ffmpeg-location") + 1], "C:\\ffmpeg\\bin\\ffmpeg.exe");
});

test("progress parser averages parts, tracks post-processing and output path", () => {
  const p = createProgress();
  p.push("SDMF 137+140");
  assert.equal(p.push("SDMP 137 50 100").progress, Math.min(0.97, 0.25 * 0.97));
  assert.equal(p.push("SDMP 140 100 100").stage, "Downloading");
  const merge = p.push("SDMPP Merger started");
  assert.equal(merge.stage, "Merging");
  assert.equal(merge.progress, 0.97);
  assert.equal(p.push("SDMP 140 NA NA"), null);
  p.push("SDMOUT /d/Song [1080p].mp4");
  assert.equal(p.output, "/d/Song [1080p].mp4");
  assert.equal(p.formats, "137+140");
});

test("summarizeFormats groups heights and lists audio", () => {
  const s = summarizeFormats({
    id: "v", title: "T", duration: 60,
    formats: [
      { format_id: "sb0", vcodec: "images", protocol: "mhtml", height: 180 },
      { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", abr: 129, ext: "m4a", protocol: "https", filesize: 100 },
      { format_id: "251", vcodec: "none", acodec: "opus", abr: 147, ext: "webm", protocol: "https", filesize: 120 },
      { format_id: "137", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 24, protocol: "https", filesize: 1000 },
      { format_id: "399", vcodec: "av01.0.08M.08", acodec: "none", height: 1080, fps: 24, protocol: "https", filesize: 500 },
      { format_id: "270", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 24, protocol: "m3u8_native" },
      { format_id: "136", vcodec: "avc1.4D401F", acodec: "none", height: 720, fps: 24, protocol: "https" },
    ],
  });
  assert.deepEqual(s.heights.map((h) => h.height), [1080, 720]);
  assert.deepEqual(s.heights[0].codecs, ["H.264", "AV1"]);
  assert.equal(s.heights[0].size, 1000 + 120);
  assert.deepEqual(s.audio.map((a) => a.id), ["251", "140"]);
});

test("host reports a missing yt-dlp and rejects bad jobs", async () => {
  const out = [];
  const h = createHost({ ffmpeg: "/nonexistent/ffmpeg", ytdlp: "/nonexistent/yt-dlp", outputRoot: "/tmp", send: (m) => out.push(m) });
  await h.handle({ id: "p", type: "ping" });
  assert.equal(out.at(-1).ytdlp, null);
  assert.match(out.at(-1).ytdlpError, /yt-dlp was not found/);
  await h.handle({ id: "a", type: "ytDownload", url: "file:///etc/passwd", mode: "audio", audioFormat: "mp3" });
  assert.match(out.at(-1).error, /http and https/);
  await h.handle({ id: "b", type: "ytDownload", url: WATCH, mode: "audio", audioFormat: "mp3", subdir: "../../etc" });
  assert.match(out.at(-1).error, /Invalid output folder/);
  await h.handle({ id: "c", type: "ytDownload", url: WATCH, mode: "audio", audioFormat: "mp3" });
  assert.match(out.at(-1).error, /yt-dlp not found/);
});

test("extension-side helpers validate requests and detect YouTube pages", () => {
  assert.equal(isYtdlpSite(WATCH), true);
  assert.equal(isYtdlpSite("https://youtu.be/DS-raAyMxl4"), true);
  assert.equal(isYtdlpSite("https://m.youtube.com/shorts/abc"), true);
  assert.equal(isYtdlpSite("https://www.youtube.com/"), false);
  assert.equal(isYtdlpSite("https://evil.example/watch?v=x"), false);
  assert.equal(describeYtRequest(normalizeYtRequest({ mode: "video", quality: "best", container: "mkv" })), "best MKV");
  assert.equal(describeYtRequest(normalizeYtRequest({ mode: "audio", audioFormat: "m4a" })), "audio M4A");
  assert.throws(() => normalizeYtRequest({ mode: "video", quality: "720", container: "exe" }));
});

test("content scripts can start yt-dlp only for the YouTube tab they run in", async () => {
  const seen = [];
  const nativeHost = (reply) => (msg) => {
    seen.push(msg);
    if (msg.type === "ping") reply({ id: msg.id, type: "pong", version: "t", ffmpeg: "FFmpeg 7", ytdlp: "yt-dlp 1" });
    if (msg.type === "ytDownload") reply({ id: msg.id, type: "done", output: "/d/x.mp4", plan: "p" });
  };
  const m = await loadBackground({ nativeHost });

  const foreignPage = await m.sendMessage({ type: "sdm:ytDownload", mode: "audio", audioFormat: "mp3" }, m.senders.tab(7));
  assert.match(foreignPage.error, /YouTube videos only/);

  const presets = await m.sendMessage({ type: "sdm:ytPresets" }, m.senders.tab(7, WATCH));
  assert.equal(presets.result.available, true);
  assert.ok(presets.result.presets.length >= 4);

  const probe = await m.sendMessage({ type: "sdm:ytProbe", url: WATCH }, m.senders.tab(7, WATCH));
  assert.equal(probe.error, "Forbidden");

  const ok = await m.sendMessage(
    { type: "sdm:ytDownload", url: "https://evil.example/", mode: "video", quality: "720", container: "mp4" },
    m.senders.tab(7, WATCH),
  );
  assert.equal(ok.ok, true);
  const posted = () => m.calls.nativeMessages.filter((x) => x.type === "ytDownload");
  assert.equal(posted()[0].url, WATCH);
  assert.equal(posted()[0].subdir, "SDM/Video");

  await m.sendMessage({ type: "sdm:ytDownload", url: WATCH, mode: "audio", audioFormat: "m4a" });
  assert.equal(posted().at(-1).subdir, "SDM/Music");
  await m.flush();
  assert.equal(seen.filter((x) => x.type === "ytDownload").length, 2);
});