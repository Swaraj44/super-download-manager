import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export const QUALITIES = Object.freeze(["best", "2160", "1440", "1080", "720", "480", "360", "240", "144"]);
export const VIDEO_CONTAINERS = Object.freeze(["mp4", "mkv", "webm"]);
export const AUDIO_FORMATS = Object.freeze(["m4a", "opus", "mp3", "best"]);
export const MAX_URL = 4096;

const VIDEO_SORT = { mp4: "vcodec:h264,acodec:aac", mkv: "", webm: "ext:webm:webm" };
const MERGE_FORMAT = { mp4: "mp4/mkv", mkv: "mkv", webm: "webm/mkv" };
const AUDIO_SELECT = {
  m4a: ["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"],
  opus: ["-f", "ba[acodec=opus]/ba/b", "-x", "--audio-format", "opus"],
  mp3: ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"],
  best: ["-f", "ba/b", "-x"],
};
const PP_STAGE = { Merger: "Merging", FFmpegMerger: "Merging", ExtractAudio: "Converting audio", FFmpegExtractAudio: "Converting audio" };
const BAD_SEGMENT = /[<>:"\\|?*\u0000-\u001f\u007f]/;

export function resolveYtdlp(env = process.env) {
  return env.SDM_YTDLP?.trim() || "yt-dlp";
}

export function resolveOutputDir(env = process.env) {
  const dir = env.SDM_OUTPUT_DIR?.trim();
  return dir && isAbsolute(dir) ? dir : join(homedir(), "Downloads");
}

export function checkUrl(url) {
  if (typeof url !== "string" || !url || url.length > MAX_URL) throw new Error("Invalid URL");
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http and https URLs are supported");
  return u.href;
}

export function outputDir(base, subdir = "") {
  const root = resolve(base);
  const parts = String(subdir ?? "").split("/").filter(Boolean);
  for (const p of parts) {
    if (p === "." || p === ".." || BAD_SEGMENT.test(p)) throw new Error("Invalid output folder");
  }
  const dir = resolve(root, ...parts);
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error("Invalid output folder");
  return dir;
}

export function normalizeYtJob(msg) {
  const m = msg && typeof msg === "object" ? msg : {};
  const url = checkUrl(m.url);
  if (m.mode === "audio") {
    if (!AUDIO_FORMATS.includes(m.audioFormat)) throw new Error("Unsupported audio format");
    return { url, mode: "audio", audioFormat: m.audioFormat };
  }
  if (m.mode !== "video") throw new Error("Unknown download type");
  if (!QUALITIES.includes(m.quality)) throw new Error("Unsupported quality");
  if (!VIDEO_CONTAINERS.includes(m.container)) throw new Error("Unsupported video format");
  return { url, mode: "video", quality: m.quality, container: m.container };
}

export function describeYtJob(job) {
  if (job.mode === "audio") return job.audioFormat === "best" ? "original audio" : `${job.audioFormat.toUpperCase()} audio`;
  return `${job.quality === "best" ? "best" : `${job.quality}p`} ${job.container.toUpperCase()}`;
}

export function formatArgs(job) {
  if (job.mode === "audio") return [...AUDIO_SELECT[job.audioFormat]];
  const res = job.quality === "best" ? "res" : `res:${job.quality}`;
  const sort = [res, VIDEO_SORT[job.container]].filter(Boolean).join(",");
  return ["-f", "bv*+ba/b", "-S", sort, "--merge-output-format", MERGE_FORMAT[job.container]];
}

function commonArgs({ ffmpeg, node }) {
  return [
    "--ignore-config", "--no-playlist",
    ...(node ? ["--js-runtimes", `node:${node}`] : []),
    ...(ffmpeg && /[\\/]/.test(ffmpeg) ? ["--ffmpeg-location", ffmpeg] : []),
  ];
}

export function ytdlpArgs(job, { dir, ffmpeg, node }) {
  const template = job.mode === "audio" ? "%(title).150B.%(ext)s" : "%(title).150B [%(height)sp].%(ext)s";
  return [
    ...commonArgs({ ffmpeg, node }),
    "--no-overwrites", "--newline", "--progress", "--embed-metadata",
    ...formatArgs(job),
    "-P", dir, "-o", template,
    "--progress-template", "download:SDMP %(info.format_id)s %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s",
    "--progress-template", "postprocess:SDMPP %(progress.postprocessor)s %(progress.status)s",
    "--print", "before_dl:SDMF %(format_id)s",
    "--print", "after_move:SDMOUT %(filepath)s",
    "--no-simulate",
    "--", job.url,
  ];
}

export function probeArgs(url, { ffmpeg, node }) {
  return [...commonArgs({ ffmpeg, node }), "-J", "--", url];
}

export function createProgress() {
  const parts = new Map();
  let count = 1;
  let stage = "Downloading";
  let post = false;
  const state = { output: "", formats: "" };

  const snapshot = () => {
    let sum = 0;
    for (const v of parts.values()) sum += v;
    const dl = Math.min(1, sum / Math.max(count, parts.size, 1));
    return { progress: post ? 0.97 : Math.min(0.97, dl * 0.97), stage };
  };

  state.push = (raw) => {
    const line = String(raw).trim();
    let m;
    if ((m = /^SDMF (\S+)/.exec(line))) {
      state.formats = m[1];
      count = Math.max(1, m[1].split("+").length);
      parts.clear();
      return snapshot();
    }
    if ((m = /^SDMP (\S+) (\S+) (\S+)/.exec(line))) {
      const done = Number(m[2]);
      const total = Number(m[3]);
      if (!Number.isFinite(done) || !(total > 0)) return null;
      parts.set(m[1], Math.min(1, done / total));
      return snapshot();
    }
    if ((m = /^SDMPP (\S+) (\S+)/.exec(line))) {
      if (m[2] !== "started") return null;
      post = true;
      stage = PP_STAGE[m[1]] || "Finishing";
      return snapshot();
    }
    if (line.startsWith("SDMOUT ")) state.output = line.slice(7).trim();
    return null;
  };
  return state;
}

function errorText(text) {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const errors = lines.filter((l) => l.startsWith("ERROR:"));
  return (errors.length ? errors : lines).slice(-3).join(" | ").slice(-600);
}

function killTree(child) {
  if (child.pid && process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => child.kill("SIGTERM"));
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function spawnYtdlp(bin, args, signal) {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const abort = () => killTree(child);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  child.on("close", () => signal?.removeEventListener("abort", abort));
  child.on("error", () => signal?.removeEventListener("abort", abort));
  return child;
}

const notFound = (bin, e) => (e.code === "ENOENT" ? `yt-dlp not found: ${bin}` : e.message);

export function runYtdlp(bin, args, { onProgress, signal } = {}) {
  return new Promise((resolve) => {
    let err = "";
    let out = "";
    const progress = createProgress();
    const child = spawnYtdlp(bin, args, signal);
    const feed = (line) => {
      const p = progress.push(line);
      if (p && onProgress) onProgress(p);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        feed(out.slice(0, i));
        out = out.slice(i + 1);
      }
    });
    child.stderr.on("data", (d) => {
      err += d;
      if (err.length > 20000) err = err.slice(-10000);
    });
    child.on("error", (e) => resolve({ ok: false, missing: e.code === "ENOENT", error: notFound(bin, e) }));
    child.on("close", (code) => {
      if (out) feed(out);
      const ok = code === 0 && Boolean(progress.output);
      const fallback = code === 0 ? "yt-dlp did not report an output file" : `yt-dlp exited with code ${code}`;
      resolve({ ok, output: progress.output, formats: progress.formats, error: ok ? "" : errorText(err) || fallback });
    });
  });
}

export function probeYtdlp(bin, args, { signal, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let err = "";
    const child = spawnYtdlp(bin, args, signal);
    child.stdout.on("data", (d) => {
      size += d.length;
      if (size > maxBytes) killTree(child);
      else chunks.push(d);
    });
    child.stderr.on("data", (d) => {
      err += d;
      if (err.length > 20000) err = err.slice(-10000);
    });
    child.on("error", (e) => resolve({ ok: false, missing: e.code === "ENOENT", error: notFound(bin, e) }));
    child.on("close", (code) => {
      if (signal?.aborted) return resolve({ ok: false, error: "yt-dlp took too long to read the page" });
      if (code !== 0 || size > maxBytes) return resolve({ ok: false, error: errorText(err) || `yt-dlp exited with code ${code}` });
      try {
        resolve({ ok: true, info: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        resolve({ ok: false, error: "yt-dlp returned invalid JSON" });
      }
    });
  });
}

export function ytdlpVersion(bin) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 15000 });
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const v = out.trim().split(/\s+/)[0];
      resolve(code === 0 && v ? `yt-dlp ${v}` : null);
    });
  });
}

function codecName(vcodec) {
  const c = String(vcodec ?? "").toLowerCase();
  if (c.startsWith("avc")) return "H.264";
  if (c.startsWith("av01")) return "AV1";
  if (c.startsWith("vp09") || c.startsWith("vp9")) return "VP9";
  if (c.startsWith("hev") || c.startsWith("hvc")) return "HEVC";
  return c.split(".")[0] || "video";
}

export function summarizeFormats(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const bytes = (f) => (f.protocol === "https" ? Number(f.filesize || f.filesize_approx) || 0 : 0);
  const hasVideo = (f) => f.vcodec && f.vcodec !== "none" && f.protocol !== "mhtml";
  const audio = formats
    .filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"))
    .map((f) => ({ id: String(f.format_id), ext: f.ext, codec: String(f.acodec).split(".")[0], abr: Math.round(f.abr || f.tbr || 0), size: bytes(f) }))
    .sort((a, b) => b.abr - a.abr);
  const bestAudio = audio.find((a) => a.size)?.size || 0;
  const byHeight = new Map();
  for (const f of formats.filter(hasVideo)) {
    const height = Number(f.height);
    if (!Number.isInteger(height) || height <= 0) continue;
    const e = byHeight.get(height) || { height, fps: 0, codecs: new Set(), size: 0 };
    e.fps = Math.max(e.fps, Math.round(f.fps || 0));
    e.codecs.add(codecName(f.vcodec));
    e.size = Math.max(e.size, bytes(f));
    byHeight.set(height, e);
  }
  const heights = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map((e) => ({ height: e.height, fps: e.fps, codecs: [...e.codecs], size: e.size ? e.size + bestAudio : 0 }));
  return {
    id: String(info?.id ?? ""),
    title: String(info?.title ?? ""),
    uploader: String(info?.uploader || info?.channel || ""),
    duration: Number(info?.duration) || 0,
    extractor: String(info?.extractor_key ?? ""),
    heights,
    audio: audio.slice(0, 8),
  };
}