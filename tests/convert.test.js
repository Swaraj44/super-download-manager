import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultContainer, mediaKindOf, normalizeConvertRequest, suggestPair } from "../src/lib/convert.js";
import { createNativeClient } from "../src/lib/native.js";

test("mediaKindOf classifies by extension", () => {
  assert.equal(mediaKindOf("/d/a.MP4"), "video");
  assert.equal(mediaKindOf("a.m4a"), "audio");
  assert.equal(mediaKindOf("a.zip"), null);
  assert.equal(mediaKindOf(""), null);
});

test("defaultContainer keeps codecs copyable", () => {
  assert.equal(defaultContainer("v.mp4", "a.m4a"), "mp4");
  assert.equal(defaultContainer("v.webm", "a.weba"), "webm");
  assert.equal(defaultContainer("v.webm", "a.m4a"), "mkv");
});

test("normalizeConvertRequest validates ids and formats", () => {
  assert.deepEqual(normalizeConvertRequest({ op: "merge", videoId: 1, audioId: 2, container: "mp4", extra: "x" }),
    { op: "merge", videoId: 1, audioId: 2, container: "mp4" });
  assert.deepEqual(normalizeConvertRequest({ op: "extract", inputId: 3, format: "mp3" }), { op: "extract", inputId: 3, format: "mp3" });
  assert.throws(() => normalizeConvertRequest({ op: "merge", videoId: 1, audioId: 1, container: "mp4" }), /different/);
  assert.throws(() => normalizeConvertRequest({ op: "merge", videoId: "1", audioId: 2, container: "mp4" }), /Pick/);
  assert.throws(() => normalizeConvertRequest({ op: "merge", videoId: 1, audioId: 2, container: "avi" }), /format/);
  assert.throws(() => normalizeConvertRequest({ op: "extract", inputId: 3, format: "wav" }), /format/);
  assert.throws(() => normalizeConvertRequest({ op: "rm" }), /Unknown/);
  assert.throws(() => normalizeConvertRequest(null), /Unknown/);
});

test("suggestPair prefers matching PDM YouTube track names", () => {
  const items = [
    { id: 1, filename: "/d/Other [720p video].mp4" },
    { id: 2, filename: "/d/Cats [128k audio].m4a" },
    { id: 3, filename: "/d/Cats [1080p video].mp4" },
    { id: 4, filename: "/d/notes.pdf" },
  ];
  assert.deepEqual(suggestPair(items), { videoId: 3, audioId: 2 });
  assert.deepEqual(suggestPair([{ id: 5, filename: "a.webm" }, { id: 6, filename: "b.mp3" }]), { videoId: 5, audioId: 6 });
  assert.equal(suggestPair([{ id: 5, filename: "a.webm" }]), null);
});

function fakePort() {
  const msg = [];
  const disc = [];
  const sent = [];
  return {
    sent,
    port: {
      onMessage: { addListener: (fn) => msg.push(fn) },
      onDisconnect: { addListener: (fn) => disc.push(fn) },
      postMessage: (m) => sent.push(m),
      disconnect: () => {},
    },
    reply: (m) => msg.forEach((fn) => fn(m)),
    drop: () => disc.forEach((fn) => fn()),
  };
}

test("native client routes replies and progress by id", async () => {
  const f = fakePort();
  const c = createNativeClient(() => f.port);
  const progress = [];
  const p = c.request({ type: "merge" }, { onEvent: (e) => progress.push(e.progress) });
  const id = f.sent[0].id;
  f.reply({ id: "other", type: "done" });
  f.reply({ id, type: "progress", progress: 0.5 });
  f.reply({ id, type: "done", output: "/o.mp4" });
  assert.deepEqual(await p, { id, type: "done", output: "/o.mp4" });
  assert.deepEqual(progress, [0.5]);
  assert.equal(c.connected, false);
});

test("native client rejects on error replies, disconnects and timeouts", async () => {
  const f = fakePort();
  const c = createNativeClient(() => f.port, () => "host gone");
  const a = c.request({ type: "x" });
  f.reply({ id: f.sent[0].id, type: "error", error: "boom" });
  await assert.rejects(a, /boom/);

  const b = c.request({ type: "x" });
  f.drop();
  await assert.rejects(b, /host gone/);

  const t = createNativeClient(() => fakePort().port);
  await assert.rejects(t.request({ type: "ping" }, { timeout: 10 }), /did not respond/);
});