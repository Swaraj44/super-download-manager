#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeMessage, MessageReader } from "../native/ffmpeg-host-lib.mjs";

const url = process.argv[2] || "https://www.youtube.com/watch?v=DS-raAyMxl4&list=RDDS-raAyMxl4&start_radio=1";
const out = process.env.PDM_OUTPUT_DIR || mkdtempSync(join(tmpdir(), "pdm-ytdlp-"));
const ffprobe = (process.env.PDM_FFMPEG || "ffmpeg").replace(/ffmpeg$/, "ffprobe");
const host = spawn(process.execPath, [fileURLToPath(new URL("../native/pdm-ffmpeg-host.mjs", import.meta.url))], {
  env: { ...process.env, PDM_OUTPUT_DIR: out },
  stdio: ["pipe", "pipe", "inherit"],
});
const reader = new MessageReader();
const waiters = new Map();
host.stdout.on("data", (d) => {
  for (const m of reader.push(d)) {
    if (m.type === "progress") continue;
    waiters.get(m.id)?.(m);
  }
});
const call = (msg) => new Promise((resolve) => {
  waiters.set(msg.id, resolve);
  host.stdin.write(encodeMessage(msg));
});

function streams(file) {
  return new Promise((resolve) => {
    let s = "";
    const p = spawn(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,height", "-of", "csv=p=0", file]);
    p.stdout.on("data", (d) => { s += d; });
    p.on("close", () => resolve(s.trim().split("\n").join(" ; ")));
  });
}

let failed = false;
const check = (ok, text) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${text}`);
  if (!ok) failed = true;
};

const pong = await call({ id: "ping", type: "ping" });
check(Boolean(pong.ffmpeg && pong.ytdlp), `helper: ${pong.ffmpeg} / ${pong.ytdlp}`);

const info = await call({ id: "probe", type: "ytProbe", url });
check(info.type === "info", `probe: ${info.info?.title || info.error}`);
console.log(`     heights: ${info.info?.heights.map((h) => `${h.height}p(${h.codecs.join("/")})`).join(" ")}`);

const jobs = [
  { mode: "video", quality: "1080", container: "mp4", subdir: "Video", expect: /h264,video,1080 ; aac,audio/ },
  { mode: "video", quality: "480", container: "webm", subdir: "Video", expect: /vp9,video,480 ; opus,audio/ },
  { mode: "audio", audioFormat: "m4a", subdir: "Music", expect: /^aac,audio/ },
  { mode: "audio", audioFormat: "mp3", subdir: "Music", expect: /^mp3,audio/ },
];
for (const [i, j] of jobs.entries()) {
  const { expect, ...msg } = j;
  const r = await call({ id: `j${i}`, type: "ytDownload", url, ...msg });
  const s = r.output ? await streams(r.output) : "";
  check(r.type === "done" && expect.test(s), `${JSON.stringify(msg)} -> ${r.output || r.error} [${s}] (${r.plan || ""})`);
}

host.stdin.end();
console.log(`Output: ${out}`);
process.exit(failed ? 1 : 0);