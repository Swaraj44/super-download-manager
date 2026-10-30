import { extFromMime, extFromUrl, normalizeMime, STREAM_EXTENSIONS } from "./mime.js";
import { categoryFor, sanitizeSegment } from "./categories.js";
import { baseName, formatBytes } from "./format.js";

export const MIN_MEDIA_BYTES = 100 * 1024;
export const MAX_MEDIA_PER_TAB = 50;

const GENERIC_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/force-download"]);
const SEGMENT_MIMES = new Set(["video/mp2t", "audio/mp2t", "video/iso.segment", "audio/iso.segment"]);
const SEGMENT_EXTENSIONS = new Set(["ts", "m4s", "f4f"]);
const RANGE_PARAMS = ["range", "rn", "rbuf", "bytestart", "byteend", "ump", "srfvp"];

const YOUTUBE_HOST = /(^|\.)googlevideo\.com$/i;
const YOUTUBE_MUXED = new Set([17, 18, 22, 36, 43]);
const YOUTUBE_QUALITY = {
  17: "144p", 18: "360p", 22: "720p", 36: "240p", 43: "360p",
  160: "144p", 133: "240p", 134: "360p", 135: "480p", 136: "720p", 137: "1080p", 264: "1440p", 266: "2160p",
  298: "720p60", 299: "1080p60",
  278: "144p", 242: "240p", 243: "360p", 244: "480p", 247: "720p", 248: "1080p", 271: "1440p", 313: "2160p",
  302: "720p60", 303: "1080p60", 308: "1440p60", 315: "2160p60",
  394: "144p", 395: "240p", 396: "360p", 397: "480p", 398: "720p", 399: "1080p", 400: "1440p", 401: "2160p",
  139: "48k", 140: "128k", 141: "256k", 249: "50k", 250: "70k", 251: "160k",
};

export function header(headers, name) {
  const n = name.toLowerCase();
  return (Array.isArray(headers) ? headers : []).find((h) => h?.name?.toLowerCase() === n)?.value ?? "";
}

export function totalSize(statusCode, headers) {
  if (statusCode === 206) {
    const m = /\/\s*(\d+)\s*$/.exec(header(headers, "content-range"));
    if (m) return Number(m[1]);
  }
  const len = Number(header(headers, "content-length"));
  return Number.isFinite(len) && len > 0 ? len : 0;
}

export function cleanMediaUrl(url) {
  try {
    const u = new URL(url);
    for (const p of RANGE_PARAMS) u.searchParams.delete(p);
    u.hash = "";
    return u.href;
  } catch {
    return String(url ?? "");
  }
}

export function mediaKind(mime, ext) {
  const m = normalizeMime(mime);
  if (STREAM_EXTENSIONS.has(ext)) return "stream";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  const category = categoryFor(ext);
  if (category === "Video") return "video";
  if (category === "Music") return "audio";
  return null;
}

export function parseYouTubeStream(url, method = "GET") {
  if (String(method || "GET").toUpperCase() !== "GET") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!YOUTUBE_HOST.test(u.hostname) || !u.pathname.endsWith("/videoplayback")) return null;
  if (u.searchParams.get("sabr") === "1") return null;
  const itag = Number(u.searchParams.get("itag"));
  if (!Number.isInteger(itag) || itag <= 0) return null;

  const mime = normalizeMime(u.searchParams.get("mime"));
  const track = mime.startsWith("audio/") ? "audio" : YOUTUBE_MUXED.has(itag) ? "muxed" : "video";
  const ext = extFromMime(mime) || (track === "audio" ? "m4a" : "mp4");
  const clen = Number(u.searchParams.get("clen"));

  return {
    url: cleanMediaUrl(u.href),
    mime,
    ext,
    size: Number.isFinite(clen) && clen > 0 ? clen : 0,
    kind: track === "audio" ? "audio" : "video",
    youtube: { id: u.searchParams.get("id") || "", itag, track, quality: YOUTUBE_QUALITY[itag] || `itag ${itag}` },
  };
}

export function isYouTubeSabr(url, method = "GET") {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (!YOUTUBE_HOST.test(u.hostname) || !u.pathname.endsWith("/videoplayback")) return false;
  return u.searchParams.get("sabr") === "1" || String(method || "GET").toUpperCase() === "POST";
}

export function classifyMediaResponse({ url, statusCode, responseHeaders, method } = {}) {
  if (statusCode !== 200 && statusCode !== 206) return null;
  if (!/^https?:/i.test(String(url ?? ""))) return null;

  const youtube = parseYouTubeStream(url, method);
  if (youtube) return youtube;

  const mime = normalizeMime(header(responseHeaders, "content-type"));
  if (SEGMENT_MIMES.has(mime)) return null;

  const urlExt = extFromUrl(url);
  const mimeExt = extFromMime(mime);
  let ext;
  if (mime.startsWith("video/") || mime.startsWith("audio/") || STREAM_EXTENSIONS.has(mimeExt)) ext = mimeExt || urlExt;
  else if (GENERIC_MIMES.has(mime)) ext = urlExt;
  else return null;
  if (SEGMENT_EXTENSIONS.has(ext)) return null;

  const kind = mediaKind(mime, ext);
  if (!kind) return null;

  const size = totalSize(statusCode, responseHeaders);
  if (kind !== "stream" && size > 0 && size < MIN_MEDIA_BYTES) return null;

  return { url: cleanMediaUrl(url), mime, ext, size, kind };
}

export function mediaKeyOf(entry) {
  const yt = entry?.youtube;
  return yt?.id ? `yt:${yt.id}:${yt.itag}` : cleanMediaUrl(entry?.url);
}

export function addMedia(list, entry, max = MAX_MEDIA_PER_TAB) {
  const key = mediaKeyOf(entry);
  const i = list.findIndex((e) => mediaKeyOf(e) === key);
  let merged = { ...entry, url: cleanMediaUrl(entry.url) };
  if (i >= 0) {
    const prev = list[i];
    list.splice(i, 1);
    merged = { ...prev, ...merged, size: Math.max(prev.size || 0, entry.size || 0) };
  }
  list.unshift({ ...merged, at: Date.now() });
  if (list.length > max) list.length = max;
  return list;
}

export function bestYouTubeAudio(list, id) {
  let best = null;
  for (const e of Array.isArray(list) ? list : []) {
    if (e?.youtube?.track !== "audio" || e.youtube.id !== id) continue;
    if (!best || (e.size || 0) > (best.size || 0)) best = e;
  }
  return best;
}

export function youtubeName(yt) {
  const track = yt.track === "muxed" ? "video + audio" : yt.track === "video" ? "video only" : "audio only";
  return `YouTube ${yt.quality} · ${track}`;
}

export function youtubeFilename(title, yt, ext) {
  const clean = String(title ?? "").replace(/^\(\d+\)\s*/, "").replace(/\s+-\s+YouTube$/i, "").slice(0, 150);
  const base = sanitizeSegment(clean, "youtube-video");
  const tag = yt.track === "muxed" ? yt.quality : `${yt.quality} ${yt.track}`;
  return `${base} [${tag}].${ext || "mp4"}`;
}

export function describeMedia(e) {
  if (e.kind === "stream") return `${(e.ext || "stream").toUpperCase()} stream · not downloadable yet`;
  const parts = [e.ext ? e.ext.toUpperCase() : e.kind, e.size ? formatBytes(e.size) : "size unknown"];
  if (e.fromPlayer) parts.push("player");
  if (e.withAudio) parts.push("+ audio file");
  return parts.join(" · ");
}

export function currentYouTubeMedia(sniffed = []) {
  const list = Array.isArray(sniffed) ? sniffed : [];
  const id = list.find((e) => e?.youtube)?.youtube.id;
  return list.filter((e) => !e?.youtube || e.youtube.id === id);
}

export function buildMediaMenu(elementUrls = [], sniffedAll = []) {
  const sniffed = currentYouTubeMedia(sniffedAll);
  const byKey = new Map(sniffed.map((e) => [cleanMediaUrl(e.url), e]));
  const seen = new Set();
  const out = [];
  const push = (e) => {
    const key = cleanMediaUrl(e.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  for (const raw of Array.isArray(elementUrls) ? elementUrls : []) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const key = cleanMediaUrl(u.href);
    const known = byKey.get(key);
    const ext = known?.ext || extFromUrl(key);
    push({ ...(known || { url: key, ext, size: 0, kind: mediaKind("", ext) || "video" }), fromPlayer: true });
  }

  sniffed
    .filter((e) => !seen.has(cleanMediaUrl(e.url)))
    .sort((a, b) => (a.kind === "stream") - (b.kind === "stream") || (b.size || 0) - (a.size || 0))
    .forEach(push);

  return out.map((e) => {
    const withAudio = e.youtube?.track === "video" && Boolean(bestYouTubeAudio(sniffed, e.youtube.id));
    return {
      url: e.url,
      ext: e.ext,
      size: e.size || 0,
      kind: e.kind,
      fromPlayer: Boolean(e.fromPlayer),
      name: e.youtube ? youtubeName(e.youtube) : baseName("", e.url),
      label: describeMedia({ ...e, withAudio }),
    };
  });
}
