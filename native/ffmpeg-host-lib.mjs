import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  checkUrl, describeYtJob, normalizeYtJob, outputDir, probeArgs, probeYtdlp, runYtdlp, summarizeFormats, ytdlpArgs, ytdlpVersion,
} from "./ytdlp-lib.mjs";


export const HOST_NAME = "com.sdm.ffmpeg";
export const HOST_VERSION = "1.1.0";
export const PROBE_TIMEOUT = 90000;
export const MAX_INCOMING = 64 * 1024;
export const MAX_OUTGOING = 1024 * 1024;

export const MEDIA_EXTS = new Set([
  "3gp", "aac", "avi", "flac", "flv", "m4a", "m4v", "mkv", "mov", "mp3", "mp4", "mpeg", "mpg",
  "oga", "ogg", "ogv", "opus", "ts", "wav", "weba", "webm", "wma", "wmv",
]);

const AAC = ["-c:a", "aac", "-b:a", "192k"];
const OPUS = ["-c:a", "libopus", "-b:a", "160k"];
const COPY = { name: "stream copy", codec: ["-c", "copy"] };

export const MERGE_PLANS = Object.freeze({
  mp4: [
    COPY,
    { name: "copy video, AAC audio", codec: ["-c:v", "copy", ...AAC] },
    { name: "H.264 + AAC", codec: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", ...AAC] },
  ],
  webm: [
    COPY,
    { name: "copy video, Opus audio", codec: ["-c:v", "copy", ...OPUS] },
    { name: "VP9 + Opus", codec: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", ...OPUS] },
  ],
  mkv: [COPY, { name: "copy video, AAC audio", codec: ["-c:v", "copy", ...AAC] }],
});

export const EXTRACT_PLANS = Object.freeze({
  mp3: [{ name: "MP3", codec: ["-c:a", "libmp3lame", "-q:a", "2"] }],
  m4a: [{ name: "stream copy", codec: ["-c:a", "copy"] }, { name: "AAC", codec: AAC }],
  opus: [{ name: "stream copy", codec: ["-c:a", "copy"] }, { name: "Opus", codec: OPUS }],
});

const MUX_FLAGS = { mp4: ["-movflags", "+faststart"], m4a: ["-movflags", "+faststart"] };
const BASE_ARGS = ["-hide_banner", "-nostdin", "-n", "-nostats", "-progress", "pipe:1"];

export function resolveFfmpeg(env = process.env) {
  return env.SDM_FFMPEG?.trim() || "ffmpeg";
}

export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (body.length > MAX_OUTGOING) throw new Error("Outgoing message too large");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class MessageReader {
  constructor(max = MAX_INCOMING) {
    this.buf = Buffer.alloc(0);
    this.max = max;
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > this.max) throw new Error("Incoming message too large");
      if (this.buf.length < 4 + len) break;
      out.push(JSON.parse(this.buf.subarray(4, 4 + len).toString("utf8")));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

export function mergeArgs({ video, audio, output, container }, plan) {
  return [
    ...BASE_ARGS, "-i", `file:${video}`, "-i", `file:${audio}`, "-map", "0:v:0", "-map", "1:a:0",
    ...plan.codec, ...(MUX_FLAGS[container] ?? []), `file:${output}`,
  ];
}

export function extractArgs({ input, output, format }, plan) {
  return [...BASE_ARGS, "-i", `file:${input}`, "-map", "0:a:0", ...plan.codec, ...(MUX_FLAGS[format] ?? []), `file:${output}`];
}

const TRACK_SUFFIX = /\s*\[([^\]]*?)\s*\b(?:video|audio)\]$/i;
const stemOf = (p) => basename(p, extname(p));

function stripTrack(stem) {
  const m = TRACK_SUFFIX.exec(stem);
  if (!m) return "";
  const base = stem.slice(0, m.index);
  return m[1] && base ? `${base} [${m[1]}]` : base;
}

export function mergeOutputName(video, container) {
  const stem = stemOf(video);
  return join(dirname(video), `${stripTrack(stem) || `${stem} (merged)`}.${container}`);
}

export function extractOutputName(input, format) {
  const stem = stemOf(input);
  const out = join(dirname(input), `${stripTrack(stem) || stem}.${format}`);
  return resolve(out) === resolve(input) ? join(dirname(input), `${stem} (audio).${format}`) : out;
}

const exists = (p) => stat(p).then(() => true, () => false);

export async function uniquePath(path) {
  const ext = extname(path);
  const stem = ext ? path.slice(0, -ext.length) : path;
  for (let i = 0; i < 1000; i++) {
    const p = i ? `${stem} (${i})${ext}` : path;
    if (!(await exists(p))) return p;
  }
  throw new Error("Could not find a free output name");
}

export async function checkInput(p) {
  if (typeof p !== "string" || !isAbsolute(p) || p.includes("\0")) throw new Error("Input must be an absolute file path");
  if (!MEDIA_EXTS.has(extname(p).slice(1).toLowerCase())) throw new Error(`Not a media file: ${basename(p)}`);
  const s = await stat(p).catch(() => null);
  if (!s?.isFile()) throw new Error(`File not found: ${basename(p)}`);
  return p;
}

function lastLines(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-4).join(" | ").slice(-600);
}

export function runFfmpeg(bin, args, { onProgress, signal } = {}) {
  return new Promise((resolve) => {
    let err = "";
    let out = "";
    let duration = 0;
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });

    child.stderr.on("data", (d) => {
      err += d;
      if (!duration) {
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
        if (m) duration = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1e6;
      }
      if (err.length > 20000) err = err.slice(-10000);
    });
    child.stdout.on("data", (d) => {
      out += d;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(out.slice(0, i).trim());
        out = out.slice(i + 1);
        if (m && duration && onProgress) onProgress(Math.min(1, Number(m[1]) / duration));
      }
    });
    child.on("error", (e) => {
      signal?.removeEventListener("abort", abort);
      resolve({ ok: false, missing: e.code === "ENOENT", error: e.code === "ENOENT" ? `FFmpeg not found: ${bin}` : e.message });
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      const error = lastLines(err);
      resolve({ ok: code === 0, exists: /already exists/i.test(error), error });
    });
  });
}

export function ffmpegVersion(bin) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(bin, ["-hide_banner", "-version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const v = /^ffmpeg version (\S+)/m.exec(out)?.[1];
      resolve(code === 0 && v ? `FFmpeg ${v}` : null);
    });
  });
}

export function createHost({ ffmpeg, send, ytdlp = "yt-dlp", node = "", outputRoot = "" }) {
  const jobs = new Map();
  let chain = Promise.resolve();
  let ytChain = Promise.resolve();

  const reply = (msg) => {
    try {
      send(msg);
    } catch {
      // Browser side is gone; nothing to report to.
    }
  };

  async function prepare(msg) {
    if (msg.type === "merge") {
      if (!Object.hasOwn(MERGE_PLANS, msg.container)) throw new Error("Unsupported container");
      const video = await checkInput(msg.video);
      const audio = await checkInput(msg.audio);
      if (video === audio) throw new Error("Pick two different files");
      const job = { video, audio, container: msg.container, output: await uniquePath(mergeOutputName(video, msg.container)) };
      return { output: job.output, plans: MERGE_PLANS[msg.container], args: (p) => mergeArgs(job, p) };
    }
    if (!Object.hasOwn(EXTRACT_PLANS, msg.format)) throw new Error("Unsupported audio format");
    const input = await checkInput(msg.input);
    const job = { input, format: msg.format, output: await uniquePath(extractOutputName(input, msg.format)) };
    return { output: job.output, plans: EXTRACT_PLANS[msg.format], args: (p) => extractArgs(job, p) };
  }

  async function run(msg, ctrl) {
    const { id } = msg;
    try {
      if (ctrl.signal.aborted) throw new Error("Cancelled");
      const { output, plans, args } = await prepare(msg);
      let sent = 0;
      let error = "Conversion failed";
      const onProgress = (r) => {
        const pct = Math.floor(r * 100);
        if (pct > sent) {
          sent = pct;
          reply({ id, type: "progress", progress: pct / 100 });
        }
      };
      for (const plan of plans) {
        if (ctrl.signal.aborted) break;
        const res = await runFfmpeg(ffmpeg, args(plan), { onProgress, signal: ctrl.signal });
        if (res.ok) return reply({ id, type: "done", output, plan: plan.name });
        if (!res.exists) await rm(output, { force: true }).catch(() => {});
        error = res.error || error;
        if (res.missing) break;
      }
      throw new Error(ctrl.signal.aborted ? "Cancelled" : error);
    } catch (err) {
      reply({ id, type: "error", error: String(err?.message || err) });
    } finally {
      jobs.delete(id);
    }
  }

  async function runYt(msg, ctrl) {
    const { id } = msg;
    try {
      if (ctrl.signal.aborted) throw new Error("Cancelled");
      if (!outputRoot) throw new Error("No output folder configured");
      const job = normalizeYtJob(msg);
      const dir = outputDir(outputRoot, msg.subdir);
      await mkdir(dir, { recursive: true });
      let sent = -1;
      let stage = "";
      const onProgress = (p) => {
        const pct = Math.floor(p.progress * 100);
        if (pct > sent || p.stage !== stage) {
          sent = Math.max(sent, pct);
          stage = p.stage;
          reply({ id, type: "progress", progress: pct / 100, stage });
        }
      };
      const res = await runYtdlp(ytdlp, ytdlpArgs(job, { dir, ffmpeg, node }), { onProgress, signal: ctrl.signal });
      if (ctrl.signal.aborted) throw new Error("Cancelled");
      if (!res.ok) throw new Error(res.error);
      reply({ id, type: "done", output: res.output, plan: `${describeYtJob(job)}, formats ${res.formats || "?"}` });
    } catch (err) {
      reply({ id, type: "error", error: String(err?.message || err) });
    } finally {
      jobs.delete(id);
    }
  }

  async function probe(msg) {
    const { id } = msg;
    try {
      const url = checkUrl(msg.url);
      const res = await probeYtdlp(ytdlp, probeArgs(url, { ffmpeg, node }), { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
      if (!res.ok) throw new Error(res.error);
      if (Array.isArray(res.info?.entries)) throw new Error("This URL is a playlist. Open a single video.");
      reply({ id, type: "info", info: summarizeFormats(res.info) });
    } catch (err) {
      reply({ id, type: "error", error: String(err?.message || err) });
    }
  }

  async function handle(msg) {
    const id = typeof msg?.id === "string" && msg.id.length <= 64 ? msg.id : null;
    if (!id) return reply({ id: null, type: "error", error: "Missing request id" });
    switch (msg.type) {
      case "ping": {
        const [ff, yt] = await Promise.all([ffmpegVersion(ffmpeg), ytdlpVersion(ytdlp)]);
        return reply({
          id, type: "pong", version: HOST_VERSION, ffmpeg: ff, ytdlp: yt,
          ...(ff ? {} : { error: `FFmpeg was not found or failed to run: ${ffmpeg}` }),
          ...(yt ? {} : { ytdlpError: `yt-dlp was not found or failed to run: ${ytdlp}` }),
        });
      }
      case "ytProbe":
        return probe(msg);
      case "ytDownload": {
        if (jobs.has(id)) return reply({ id, type: "error", error: "Duplicate job id" });
        const ctrl = new AbortController();
        jobs.set(id, ctrl);
        ytChain = ytChain.then(() => runYt(msg, ctrl));
        return ytChain;
      }
      case "merge":
      case "extract": {
        if (jobs.has(id)) return reply({ id, type: "error", error: "Duplicate job id" });
        const ctrl = new AbortController();
        jobs.set(id, ctrl);
        chain = chain.then(() => run(msg, ctrl));
        return chain;
      }
      case "cancel":
        jobs.get(msg.target)?.abort();
        return reply({ id, type: "cancelled", target: msg.target });
      default:
        return reply({ id, type: "error", error: `Unknown request: ${String(msg.type).slice(0, 40)}` });
    }
  }

  function shutdown() {
    for (const ctrl of jobs.values()) ctrl.abort();
    return Promise.all([chain, ytChain]);
  }

  return { handle, shutdown };
}