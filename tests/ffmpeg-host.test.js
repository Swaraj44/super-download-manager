import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHost, encodeMessage, extractArgs, extractOutputName, mergeArgs, mergeOutputName, MessageReader, MERGE_PLANS, uniquePath,
} from "../native/ffmpeg-host-lib.mjs";
import { loadBackground } from "./helpers/chrome-mock.js";

const FFMPEG = process.env.SDM_FFMPEG || "ffmpeg";
const HAVE_FFMPEG = spawnSync(FFMPEG, ["-hide_banner", "-version"]).status === 0;
const needs = { skip: HAVE_FFMPEG ? false : "ffmpeg not available (set SDM_FFMPEG)" };
const HOST = fileURLToPath(new URL("../native/sdm-ffmpeg-host.mjs", import.meta.url));

function ff(args) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

function streams(file) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file], { encoding: "utf8" });
  return [...r.stderr.matchAll(/Stream #\d+:\d+[^:]*: (Video|Audio): (\w+)/g)].map((m) => `${m[1].toLowerCase()}:${m[2]}`);
}

let dir;
function fixtures() {
  if (dir) return dir;
  dir = mkdtempSync(join(tmpdir(), "sdm-ffmpeg-"));
  const vsrc = ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=2"];
  const asrc = ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"];
  ff([...vsrc, "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "Cats [1080p video].mp4")]);
  ff([...asrc, "-c:a", "aac", join(dir, "Cats [128k audio].m4a")]);
  ff([...vsrc, "-c:v", "libvpx-vp9", "-b:v", "100k", join(dir, "clip.webm")]);
  ff([...vsrc, ...asrc, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, "movie.mp4")]);
  writeFileSync(join(dir, "notes.txt"), "x");
  return dir;
}

test.after(() => dir && rmSync(dir, { recursive: true, force: true }));

function collector() {
  const out = [];
  const waiters = [];
  const send = (m) => {
    out.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  };
  const wait = (pred) => new Promise((resolve) => {
    const hit = out.find(pred);
    if (hit) resolve(hit);
    else waiters.push({ pred, resolve });
  });
  return { out, send, wait };
}

const final = (id) => (m) => m.id === id && ["done", "error", "pong"].includes(m.type);

test("framing round-trips and rejects oversized messages", () => {
  const r = new MessageReader(100);
  const a = encodeMessage({ a: 1 });
  const b = encodeMessage({ b: "é" });
  const both = Buffer.concat([a, b]);
  assert.deepEqual(r.push(both.subarray(0, 5)), []);
  assert.deepEqual(r.push(both.subarray(5)), [{ a: 1 }, { b: "é" }]);
  const big = Buffer.alloc(4);
  big.writeUInt32LE(101);
  assert.throws(() => new MessageReader(100).push(big), /too large/);
});

test("argument builders use file: prefixes, no overwrite and stream maps", () => {
  const args = mergeArgs({ video: "/a/-v.mp4", audio: "/a/a.m4a", output: "/a/o.mp4", container: "mp4" }, MERGE_PLANS.mp4[0]);
  assert.ok(args.includes("-n"));
  assert.ok(args.includes("file:/a/-v.mp4"));
  assert.deepEqual(args.slice(-3), ["-movflags", "+faststart", "file:/a/o.mp4"]);
  assert.ok(args.join(" ").includes("-map 0:v:0 -map 1:a:0 -c copy"));
  const ex = extractArgs({ input: "/a/x.mp4", output: "/a/x.mp3", format: "mp3" }, { codec: ["-c:a", "libmp3lame"] });
  assert.deepEqual(ex.slice(-4), ["0:a:0", "-c:a", "libmp3lame", "file:/a/x.mp3"]);
});

test("output names drop SDM track tags and never equal the input", () => {
  assert.equal(mergeOutputName("/d/Cats [1080p video].mp4", "mp4"), join("/d", "Cats [1080p].mp4"));
  assert.equal(mergeOutputName("/d/clip.webm", "mkv"), join("/d", "clip (merged).mkv"));
  assert.equal(extractOutputName("/d/Cats [128k audio].m4a", "mp3"), join("/d", "Cats [128k].mp3"));
  assert.equal(extractOutputName("/d/song.m4a", "m4a"), join("/d", "song (audio).m4a"));
  assert.equal(extractOutputName("/d/movie.mp4", "mp3"), join("/d", "movie.mp3"));
});

test("uniquePath avoids existing files", needs, async () => {
  const d = fixtures();
  assert.equal(await uniquePath(join(d, "movie.mp4")), join(d, "movie (1).mp4"));
  assert.equal(await uniquePath(join(d, "fresh.mp4")), join(d, "fresh.mp4"));
});

test("host rejects bad input before running ffmpeg", needs, async () => {
  const d = fixtures();
  const c = collector();
  const h = createHost({ ffmpeg: FFMPEG, send: c.send });
  const cases = [
    [{ id: "1", type: "merge", video: "rel.mp4", audio: join(d, "Cats [128k audio].m4a"), container: "mp4" }, /absolute/],
    [{ id: "2", type: "merge", video: join(d, "notes.txt"), audio: join(d, "Cats [128k audio].m4a"), container: "mp4" }, /Not a media file/],
    [{ id: "3", type: "merge", video: join(d, "gone.mp4"), audio: join(d, "Cats [128k audio].m4a"), container: "mp4" }, /not found/],
    [{ id: "4", type: "merge", video: join(d, "movie.mp4"), audio: join(d, "movie.mp4"), container: "mp4" }, /different/],
    [{ id: "5", type: "merge", video: join(d, "movie.mp4"), audio: join(d, "clip.webm"), container: "../x" }, /Unsupported container/],
    [{ id: "6", type: "extract", input: join(d, "movie.mp4"), format: "toString" }, /Unsupported audio/],
    [{ id: "7", type: "rm" }, /Unknown request/],
  ];
  for (const [msg] of cases) await h.handle(msg);
  for (const [msg, re] of cases) {
    const r = await c.wait(final(msg.id));
    assert.equal(r.type, "error", msg.id);
    assert.match(r.error, re, msg.id);
  }
  await h.handle({ type: "ping" });
  assert.match(c.out.at(-1).error, /Missing request id/);
});

test("ping reports ffmpeg, or a clear error when it is missing", needs, async () => {
  const c = collector();
  await createHost({ ffmpeg: FFMPEG, send: c.send }).handle({ id: "p", type: "ping" });
  assert.match((await c.wait(final("p"))).ffmpeg, /^FFmpeg /);
  const m = collector();
  await createHost({ ffmpeg: "/nonexistent/ffmpeg", send: m.send }).handle({ id: "p", type: "ping" });
  const r = await m.wait(final("p"));
  assert.equal(r.ffmpeg, null);
  assert.match(r.error, /not found/);
});

test("merges MP4 video and M4A audio by stream copy", needs, async () => {
  const d = fixtures();
  const c = collector();
  await createHost({ ffmpeg: FFMPEG, send: c.send })
    .handle({ id: "m", type: "merge", video: join(d, "Cats [1080p video].mp4"), audio: join(d, "Cats [128k audio].m4a"), container: "mp4" });
  const r = await c.wait(final("m"));
  assert.equal(r.type, "done", r.error);
  assert.equal(r.output, join(d, "Cats [1080p].mp4"));
  assert.equal(r.plan, "stream copy");
  assert.deepEqual(streams(r.output), ["video:h264", "audio:aac"]);
  assert.ok(c.out.some((m) => m.id === "m" && m.type === "progress"));
});

test("falls back to re-encoding audio when copy is not allowed (VP9 + AAC into WebM)", needs, async () => {
  const d = fixtures();
  const c = collector();
  await createHost({ ffmpeg: FFMPEG, send: c.send })
    .handle({ id: "w", type: "merge", video: join(d, "clip.webm"), audio: join(d, "Cats [128k audio].m4a"), container: "webm" });
  const r = await c.wait(final("w"));
  assert.equal(r.type, "done", r.error);
  assert.equal(r.plan, "copy video, Opus audio");
  assert.deepEqual(streams(r.output), ["video:vp9", "audio:opus"]);
});

test("extracts MP3 and never overwrites an existing output", needs, async () => {
  const d = fixtures();
  const c = collector();
  const h = createHost({ ffmpeg: FFMPEG, send: c.send });
  await h.handle({ id: "e1", type: "extract", input: join(d, "movie.mp4"), format: "mp3" });
  const r1 = await c.wait(final("e1"));
  assert.equal(r1.type, "done", r1.error);
  assert.equal(r1.output, join(d, "movie.mp3"));
  assert.deepEqual(streams(r1.output), ["audio:mp3"]);
  await h.handle({ id: "e2", type: "extract", input: join(d, "movie.mp4"), format: "mp3" });
  assert.equal((await c.wait(final("e2"))).output, join(d, "movie (1).mp3"));
});

test("extracting from a video without audio fails cleanly and leaves no file", needs, async () => {
  const d = fixtures();
  const c = collector();
  await createHost({ ffmpeg: FFMPEG, send: c.send }).handle({ id: "x", type: "extract", input: join(d, "clip.webm"), format: "m4a" });
  const r = await c.wait(final("x"));
  assert.equal(r.type, "error");
  assert.equal(existsSync(join(d, "clip.m4a")), false);
});

test("cancel stops a queued job", needs, async () => {
  const d = fixtures();
  const c = collector();
  const h = createHost({ ffmpeg: FFMPEG, send: c.send });
  const a = h.handle({ id: "q1", type: "extract", input: join(d, "movie.mp4"), format: "opus" });
  const b = h.handle({ id: "q2", type: "extract", input: join(d, "movie.mp4"), format: "m4a" });
  await h.handle({ id: "c", type: "cancel", target: "q2" });
  await Promise.all([a, b]);
  assert.equal((await c.wait(final("q1"))).type, "done");
  assert.match((await c.wait(final("q2"))).error, /Cancelled/);
});

test("stdio host process answers framed ping", needs, async () => {
  const child = spawn(process.execPath, [HOST], { env: { ...process.env, SDM_FFMPEG: FFMPEG }, stdio: ["pipe", "pipe", "inherit"] });
  const reader = new MessageReader();
  const reply = new Promise((resolve) => child.stdout.on("data", (d) => {
    const [m] = reader.push(d);
    if (m) resolve(m);
  }));
  child.stdin.write(encodeMessage({ id: "s", type: "ping" }));
  const m = await reply;
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  assert.equal(m.type, "pong");
  assert.match(m.ffmpeg, /^FFmpeg /);
});

test("background reports a missing helper with install instructions", async () => {
  const m = await loadBackground();
  const res = await m.sendMessage({ type: "sdm:converterStatus" });
  assert.equal(res.ok, true);
  assert.equal(res.result.available, false);
  assert.match(res.result.error, /native\/install\.mjs --extension-id sdm-test/);
  assert.deepEqual(m.calls.native, ["com.sdm.ffmpeg"]);
});

test("convert messages are refused from web pages and validated", async () => {
  const m = await loadBackground();
  for (const type of ["sdm:converterStatus", "sdm:convert", "sdm:cancelConvert"]) {
    const res = await m.sendMessage({ type, op: "extract", inputId: 1, format: "mp3" }, m.senders.tab(7));
    assert.equal(res.error, "Forbidden", type);
  }
  const bad = await m.sendMessage({ type: "sdm:convert", op: "extract", inputId: 99, format: "mp3" });
  assert.match(bad.error, /not a finished file/);
});

test("background merges two finished downloads through the real host", needs, async () => {
  const d = fixtures();
  const downloadItems = [
    { id: 1, state: "complete", exists: true, filename: join(d, "Cats [1080p video].mp4") },
    { id: 2, state: "complete", exists: true, filename: join(d, "Cats [128k audio].m4a") },
    { id: 3, state: "in_progress", filename: join(d, "movie.mp4") },
  ];
  const m = await loadBackground({ downloadItems, nativeHost: (reply) => createHost({ ffmpeg: FFMPEG, send: reply }).handle });

  const status = (await m.sendMessage({ type: "sdm:converterStatus" })).result;
  assert.equal(status.available, true);

  const notDone = await m.sendMessage({ type: "sdm:convert", op: "extract", inputId: 3, format: "mp3" });
  assert.match(notDone.error, /not a finished file/);

  const started = await m.sendMessage({ type: "sdm:convert", op: "merge", videoId: 1, audioId: 2, container: "mkv" });
  assert.equal(started.result.state, "running");
  const sent = m.calls.nativeMessages.find((x) => x.type === "merge");
  assert.deepEqual([sent.video, sent.audio, sent.container], [downloadItems[0].filename, downloadItems[1].filename, "mkv"]);

  let job;
  for (let i = 0; i < 200; i++) {
    job = (await m.sendMessage({ type: "sdm:getState" })).result.converts.find((j) => j.id === started.result.id);
    if (job.state !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(job.state, "done", job.error);
  assert.equal(job.output, join(d, "Cats [1080p].mkv"));
  assert.deepEqual(streams(job.output), ["video:h264", "audio:aac"]);
});